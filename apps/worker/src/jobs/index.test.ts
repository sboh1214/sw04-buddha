/**
 * The BullMQ handler layer (jobs/index.ts) on the docker `test` database: dispatch by job
 * name, the payload check, and the shape of what a handler hands back — BullMQ stores it as
 * JSON, and a bigint or an Error in it is exactly what this layer exists to keep out. Jobs are
 * stubs carrying the fields a handler reads, except the daily-audit retry tests which use a real
 * BullMQ queue and its configured retry options. Publishes go to a recording stub. Skips when
 * TEST_* are unset, like ledger-audit.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { schema, type Db } from '@buddha/db';
import {
  connectTestDb,
  createMarket,
  createMedia,
  createPost,
  createPosition,
  createProvisionalMarket,
  createScheduledMarket,
  createStartGrant,
  createUser,
  createWriteLimitEvent,
  hasTestDb,
  openOrderIntake,
  passMarketClose,
  resolveMarketNow,
  setReleaseSetting,
  fundMarketMakerFunds,
  mintTestPairs,
  tradeOnce,
  withLedgerGuardsOff,
  type TestDb,
} from '@buddha/db/test';
import {
  DELETED_POSTS_RETENTION_SETTING,
  JOB_NAMES,
  START_COIN_SETTING,
  marketChannel,
  userChannel,
  type MarketRealtimeEvent,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { Queue, QueueEvents, UnrecoverableError, type Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryObjectStorage } from '@buddha/storage';
import { type EnqueueFinalize } from '../market-jobs.js';
import { type Publish } from '../realtime.js';
import { BULLMQ_REDIS_OPTIONS, DEFAULT_JOB_OPTIONS, createWorker } from '../queues.js';
import { createProcessor } from './index.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type AuditOutcome = { result: typeof schema.reconciliationResults.$inferSelect };
// hasTestDb loads the root test environment before checking Redis, as market-jobs.test.ts does.
const hasRedis = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);

interface JobStub {
  name: string;
  /** Absent for a scheduler job with no template (BullMQ stores that as `{}`). */
  data?: unknown;
}

/** The fields a handler reads of a Job. */
function job(input: JobStub): Job {
  return { id: 'job-1', queueName: 'markets', ...input } as unknown as Job;
}

describe.skipIf(!hasTestDb())('job handlers (integration)', () => {
  let t: TestDb;
  let published: { channel: string; event: MarketRealtimeEvent | UserRealtimeEvent }[];
  let enqueued: { marketId: string; resolvedAt: Date }[];
  let logs: Record<string, unknown>[];
  let run: (input: JobStub) => Promise<unknown>;
  let storage: MemoryObjectStorage;
  let deps: Parameters<typeof createProcessor>[0];

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    published = [];
    enqueued = [];
    logs = [];
    const publish: Publish = (channel, event) => {
      published.push({ channel, event });
      return Promise.resolve();
    };
    // Every level, so the scan's counts line (debug when idle) is visible too.
    const logger = pino(
      { level: 'debug' },
      { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
    );
    storage = new MemoryObjectStorage();
    const enqueueFinalize: EnqueueFinalize = (marketId, resolvedAt) => {
      enqueued.push({ marketId, resolvedAt });
      return Promise.resolve();
    };
    deps = { db: t.db, auditDb: t.db, publish, enqueueFinalize, storage, logger };
    const processor = createProcessor(deps);
    run = (input) => processor(job(input)) as Promise<unknown>;
  });

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }

  /**
   * A market judged YES and confirmed now, as the worker's confirmation leaves it (#152): its
   * judgement approved two minutes ago under a one-minute window, then `resolved` with the pending
   * step row the confirmation writes. The finalize takes it to `settling`, then `settled`.
   */
  async function judged() {
    const { market } = await createProvisionalMarket(t.db, {
      publishedAt: new Date(Date.now() - 2 * MINUTE_MS),
      disputeWindowMinutes: 1,
    });
    return (await resolveMarketNow(t.db, market.id)).market;
  }

  /** A PROVISIONAL market (#152) whose deadline passed `ago` ms ago (or is ahead, negative). */
  async function provisional(ago = MINUTE_MS) {
    const { market } = await createProvisionalMarket(t.db, {
      publishedAt: new Date(Date.now() - ago - MINUTE_MS),
      disputeWindowMinutes: 1,
    });
    return market;
  }

  async function stepOf(marketId: string) {
    const [row] = await t.db
      .select()
      .from(schema.marketSettlementSteps)
      .where(eq(schema.marketSettlementSteps.marketId, marketId));
    return row!;
  }

  /** An approved market (#78) whose scheduled open is `scheduledOpenAt` — due by default. */
  async function scheduled(scheduledOpenAt?: Date) {
    return (await createScheduledMarket(t.db, { scheduledOpenAt })).market;
  }

  it('market.open without a market id is the scan: opens what is due and returns the counts (#21)', async () => {
    const due = await scheduled();
    const future = await scheduled(new Date(Date.now() + 60 * MINUTE_MS));

    await expect(run({ name: JOB_NAMES.marketOpen, data: {} })).resolves.toEqual({
      opened: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect((await marketRow(due.id)).status).toBe('open');
    expect((await marketRow(future.id)).status).toBe('scheduled');
    expect(published).toEqual([
      {
        channel: marketChannel(due.id),
        event: expect.objectContaining({ type: 'market:status', status: 'open' }) as unknown,
      },
    ]);
    // Something was done: the counts line is at info.
    expect(logs.at(-1)).toMatchObject({ level: 30, msg: 'market open scan', opened: 1 });

    // The scheduler job of queues.ts carries no data at all; that is the scan too, and with
    // nothing left to do it reports zeros (at debug — it runs every minute).
    await expect(run({ name: JOB_NAMES.marketOpen })).resolves.toEqual({
      opened: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(logs.at(-1)).toMatchObject({ level: 20, msg: 'market open scan', opened: 0 });
  });

  it('market.open with a market id opens that market only (#21)', async () => {
    const target = await scheduled();
    const other = await scheduled();

    const result = await run({ name: JOB_NAMES.marketOpen, data: { marketId: target.id } });
    expect(result).toMatchObject({ outcome: 'opened', marketId: target.id });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect((await marketRow(target.id)).status).toBe('open');
    expect((await marketRow(other.id)).status).toBe('scheduled');
    expect(published.map((p) => p.channel)).toEqual([marketChannel(target.id)]);
    expect(logs.at(-1)).toMatchObject({ level: 30, msg: 'market open', outcome: 'opened' });

    // The delayed job's retry, or a duplicate: skipped, and the skip is JSON too.
    await expect(
      run({ name: JOB_NAMES.marketOpen, data: { marketId: target.id } }),
    ).resolves.toEqual({ outcome: 'skipped', marketId: target.id, reason: 'not_scheduled' });
  });

  it('rejects a market.open payload the schema refuses with UnrecoverableError (#21)', async () => {
    const due = await scheduled();
    const attempt = run({ name: JOB_NAMES.marketOpen, data: { marketId: 'nope' } });
    await expect(attempt).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(attempt).rejects.toThrow(/Invalid market\.open payload \(job job-1\)/);
    // Refused before any handler ran: the due market is untouched by this job.
    expect((await marketRow(due.id)).status).toBe('scheduled');
    expect(published).toEqual([]);
  });

  it('market.close without a market id is the scan: closes what is due and returns the counts', async () => {
    // One due market a person traded on (CLOSED) and one nobody did (CANCELLED, #20), the
    // traded one's deadline first.
    const admin = await createUser(t.db, { role: 'admin' });
    await openOrderIntake(t.db, { adminId: admin.user.id });
    const traded = await createMarket(t.db);
    await tradeOnce(t.db, traded.id);
    await passMarketClose(t.db, traded.id, new Date(Date.now() - 2 * MINUTE_MS));
    const due = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const future = await createMarket(t.db, { closeAt: new Date(Date.now() + MINUTE_MS) });

    await expect(run({ name: JOB_NAMES.marketClose, data: {} })).resolves.toEqual({
      closed: 1,
      cancelled: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect((await marketRow(traded.id)).status).toBe('closed');
    expect((await marketRow(due.id)).status).toBe('cancelled');
    expect((await marketRow(future.id)).status).toBe('open');
    expect(published).toEqual([
      {
        channel: marketChannel(traded.id),
        event: expect.objectContaining({ type: 'market:status', status: 'closed' }) as unknown,
      },
      {
        channel: marketChannel(due.id),
        event: expect.objectContaining({ type: 'market:status', status: 'cancelled' }) as unknown,
      },
    ]);
    expect(logs.at(-1)).toMatchObject({ level: 30, msg: 'market close scan', cancelled: 1 });

    // The scheduler job of queues.ts carries no data at all; that is the scan too, and with
    // nothing left to do it reports zeros (at debug — it runs every minute).
    await expect(run({ name: JOB_NAMES.marketClose })).resolves.toEqual({
      closed: 0,
      cancelled: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(logs.at(-1)).toMatchObject({ level: 20, msg: 'market close scan', closed: 0 });
  });

  it('a market.close scan that only cancels is reported at info (#20)', async () => {
    // Production's scan while order intake is closed: no market has a fill, so every due one is
    // cancelled and none is closed — the cancels alone make it a scan that did something.
    const due = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });

    await expect(run({ name: JOB_NAMES.marketClose })).resolves.toEqual({
      closed: 0,
      cancelled: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect((await marketRow(due.id)).status).toBe('cancelled');
    expect(logs.at(-1)).toMatchObject({
      level: 30,
      msg: 'market close scan',
      closed: 0,
      cancelled: 1,
    });
  });

  it('market.close with a market id closes that market only', async () => {
    const target = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const other = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });

    const result = await run({ name: JOB_NAMES.marketClose, data: { marketId: target.id } });
    // Nobody traded on it: the close cancels it (#20).
    expect(result).toMatchObject({ outcome: 'cancelled', marketId: target.id });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect((await marketRow(target.id)).status).toBe('cancelled');
    expect((await marketRow(other.id)).status).toBe('open');
    expect(published.map((p) => p.channel)).toEqual([marketChannel(target.id)]);

    // The delayed job's retry, or a duplicate: skipped, and the skip is JSON too.
    await expect(
      run({ name: JOB_NAMES.marketClose, data: { marketId: target.id } }),
    ).resolves.toEqual({ outcome: 'skipped', marketId: target.id, reason: 'not_open_or_paused' });
  });

  it('rejects a payload the schema refuses with UnrecoverableError (a producer bug, not a retry)', async () => {
    const open = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const attempt = run({ name: JOB_NAMES.marketClose, data: { marketId: 'nope' } });
    await expect(attempt).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(attempt).rejects.toThrow(/Invalid market\.close payload \(job job-1\)/);
    // Refused before any handler ran: the due market is untouched by this job.
    expect((await marketRow(open.id)).status).toBe('open');
    expect(published).toEqual([]);
  });

  it('rejects a job nobody handles with UnrecoverableError', async () => {
    // `market.trader_count` is a declared name with no handler yet (queues.ts); a name that
    // is not declared at all fails the same way.
    for (const name of [JOB_NAMES.marketTraderCount, 'market.explode']) {
      const attempt = run({ name, data: {} });
      await expect(attempt).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(attempt).rejects.toThrow(
        `No handler registered for job "${name}" on queue "markets"`,
      );
    }
  });

  it('market.resolve without a market id is the scan: confirms what is due, registers its finalize and returns the counts (#152)', async () => {
    const due = await provisional();
    const future = await provisional(-60 * MINUTE_MS);

    await expect(run({ name: JOB_NAMES.marketResolve, data: {} })).resolves.toEqual({
      resolved: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    const row = await marketRow(due.id);
    expect(row.status).toBe('resolved');
    expect((await marketRow(future.id)).status).toBe('provisional');
    expect(published).toEqual([
      {
        channel: marketChannel(due.id),
        event: expect.objectContaining({
          type: 'market:status',
          status: 'resolved',
          resolvedResult: 'YES',
        }) as unknown,
      },
    ]);
    expect(enqueued).toEqual([{ marketId: due.id, resolvedAt: row.resolvedAt }]);
    expect(logs.at(-1)).toMatchObject({ level: 30, msg: 'market resolve scan', resolved: 1 });

    // The scheduler job of queues.ts carries no data at all; that is the scan too, and with
    // nothing left to do it reports zeros (at debug — it runs every minute).
    await expect(run({ name: JOB_NAMES.marketResolve })).resolves.toEqual({
      resolved: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(logs.at(-1)).toMatchObject({ level: 20, msg: 'market resolve scan', resolved: 0 });
  });

  it('market.resolve with a market id confirms that market only, JSON-safe (#152)', async () => {
    const target = await provisional();
    const other = await provisional();

    const result = await run({ name: JOB_NAMES.marketResolve, data: { marketId: target.id } });
    expect(result).toMatchObject({
      outcome: 'resolved',
      marketId: target.id,
      resolvedResult: 'YES',
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect((await marketRow(target.id)).status).toBe('resolved');
    expect((await marketRow(other.id)).status).toBe('provisional');
    expect(published.map((p) => p.channel)).toEqual([marketChannel(target.id)]);
    expect(enqueued.map((entry) => entry.marketId)).toEqual([target.id]);
    expect(logs.at(-1)).toMatchObject({ level: 30, msg: 'market resolve', outcome: 'resolved' });

    // The delayed job's retry, or a duplicate: skipped, and the skip is JSON too.
    await expect(
      run({ name: JOB_NAMES.marketResolve, data: { marketId: target.id } }),
    ).resolves.toEqual({ outcome: 'skipped', marketId: target.id, reason: 'not_provisional' });
    // A payload the schema refuses is a producer bug, not a retry.
    const attempt = run({ name: JOB_NAMES.marketResolve, data: { marketId: 'nope' } });
    await expect(attempt).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(attempt).rejects.toThrow(/Invalid market\.resolve payload \(job job-1\)/);
  });

  it('market.finalize with a market id returns a JSON-safe result: paidCoin a decimal string, settledAt ISO', async () => {
    const market = await judged();
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    const maker = await fundMarketMakerFunds(t.db, market.id, 150n);
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: alice,
      noHolderId: maker,
      qty: 3,
    });

    const result = await run({ name: JOB_NAMES.marketFinalize, data: { marketId: market.id } });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result).toEqual({
      outcome: 'settled',
      marketId: market.id,
      statusEventId: expect.any(Number) as number,
      settledAt: expect.stringMatching(ISO_INSTANT) as string,
      positions: 2,
      settledAccounts: 2,
      paidAccounts: 1,
      paidCoin: '300',
    });
    // The string is the DB instant the row carries, not a re-read.
    const row = await marketRow(market.id);
    expect(result).toMatchObject({
      settledAt: row.settledAt!.toISOString(),
      statusEventId: row.statusEventId,
    });
    // settling, then settled, on the market's channel; the balance and the position on alice's.
    expect(published.map((p) => p.channel)).toEqual([
      marketChannel(market.id),
      marketChannel(market.id),
      userChannel(alice),
      userChannel(alice),
    ]);
    expect(published.slice(0, 2).map((p) => (p.event as { status?: string }).status)).toEqual([
      'settling',
      'settled',
    ]);
    // The log line went through the same conversion: pino would have thrown on the bigint.
    expect(logs.find((line) => line.msg === 'market finalize')).toMatchObject({ paidCoin: '300' });

    // A second run is the skip, and the skip is JSON as it stands.
    const again = await run({ name: JOB_NAMES.marketFinalize, data: { marketId: market.id } });
    expect(again).toEqual({ outcome: 'skipped', marketId: market.id, reason: 'not_settling' });
    expect(() => JSON.stringify(again)).not.toThrow();
  });

  it('market.finalize scan with a failing market: JSON-safe counts, and one error line per failure', async () => {
    // A winning holder the collateral cannot pay — a position the ledger never collateralised —
    // poisons the market (market-finalize.ts throws, the transaction rolls back); the scan
    // reports it instead of failing the job.
    const poisoned = await judged();
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await createPosition(t.db, { userId: alice, marketId: poisoned.id, outcome: 'YES', qty: 2 });
    const healthy = await judged();

    const result = await run({ name: JOB_NAMES.marketFinalize, data: {} });
    // toEqual, not toMatchObject: the thrown value itself must NOT be in what BullMQ stores.
    expect(result).toEqual({
      settled: 1,
      skipped: 0,
      failed: 1,
      failures: [
        {
          marketId: poisoned.id,
          message: expect.stringMatching(
            /contract supply does not match pair collateral/,
          ) as string,
        },
      ],
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    // Its payout started and stays started (ADR-0093 decision 1 item 14).
    expect((await marketRow(poisoned.id)).status).toBe('settling');
    expect((await marketRow(healthy.id)).status).toBe('settled');
    // The handler hands its logger down, and the failure record went in without needing it:
    // the step says why, and the only error line is the scan's own (below).
    expect(await stepOf(poisoned.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await stepOf(healthy.id)).toMatchObject({ status: 'done', attempts: 1 });

    const errors = logs.filter((line) => line.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: 'market finalize failed in scan',
      marketId: poisoned.id,
      err: {
        message: expect.stringMatching(/contract supply does not match pair collateral/) as string,
      },
    });
    // The counts line is promoted to info when something failed, even with nothing settled.
    expect(logs.at(-1)).toMatchObject({ level: 30, msg: 'market finalize scan', failed: 1 });
  });

  it('start_grant.pay reports JSON-safe counts, quietly while the amount is undecided (#70)', async () => {
    const { user } = await createUser(t.db);
    const grant = await createStartGrant(t.db, { userId: user.id });
    const idle = { undecided: true, paid: 0, skipped: 0, failed: 0, failures: [] };
    await expect(run({ name: JOB_NAMES.startGrantPay })).resolves.toEqual(idle);
    expect(logs.at(-1)).toMatchObject({ level: 20, msg: 'start grant payment', paid: 0 });

    const admin = (await createUser(t.db, { role: 'admin' })).user.id;
    await setReleaseSetting(t.db, {
      adminId: admin,
      key: START_COIN_SETTING.key,
      status: 'test',
      value: 10_000,
    });
    const result = await run({ name: JOB_NAMES.startGrantPay });
    expect(result).toEqual({ undecided: false, paid: 1, skipped: 0, failed: 0, failures: [] });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(logs.at(-1)).toMatchObject({ level: 30, msg: 'start grant payment', paid: 1 });
    expect(published.map((p) => p.channel)).toEqual([userChannel(user.id)]);
    const [paid] = await t.db
      .select()
      .from(schema.startGrants)
      .where(eq(schema.startGrants.id, grant.id));
    expect(paid?.amountCoin).toBe(10_000n);
  });

  it('media.orphan_cleanup reports JSON-safe counts and logs an object the store kept, keeping it queued (#46)', async () => {
    const { user } = await createUser(t.db);
    const old = new Date(Date.now() - 25 * 60 * MINUTE_MS);
    const gone = await createMedia(t.db, { ownerId: user.id, createdAt: old });
    const kept = await createMedia(t.db, { ownerId: user.id, createdAt: old });
    await storage.put(gone.storageKey, new Uint8Array([1]), 'image/webp');
    // The store refuses one key: both rows go, the refused key stays queued for a later run, and
    // the job does not fail.
    const refusing = storage.delete.bind(storage);
    storage.delete = (key) =>
      key === kept.storageKey ? Promise.reject(new Error('AccessDenied')) : refusing(key);
    const result = await run({ name: JOB_NAMES.mediaOrphanCleanup });
    expect(result).toEqual({
      queued: 2,
      removed: 1,
      failed: 1,
      failures: [{ storageKey: kept.storageKey, attempts: 1, message: 'AccessDenied' }],
      pending: 1,
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(storage.objects.has(gone.storageKey)).toBe(false);
    expect(await t.db.select().from(schema.mediaObjects)).toEqual([]);
    expect((await t.db.select().from(schema.mediaDeletions)).map((row) => row.storageKey)).toEqual([
      kept.storageKey,
    ]);
    expect(
      logs.filter((line) => line.msg === 'orphan upload object not removed; kept for retry'),
    ).toEqual([expect.objectContaining({ storageKey: kept.storageKey, attempts: 1, level: 50 })]);
    // The next run, before the refused key is due again, has nothing to do and is quiet (debug).
    expect(await run({ name: JOB_NAMES.mediaOrphanCleanup })).toEqual({
      queued: 0,
      removed: 0,
      failed: 0,
      failures: [],
      pending: 1,
    });
    expect(
      logs.filter((line) => line.msg === 'orphan upload clean-up').map((line) => line.level),
    ).toEqual([30, 20]);
  });

  it('community.records_purge reports JSON-safe counts, quiet when it deleted nothing (#187)', async () => {
    // This checks dispatch/counts, not the 25-hour boundary. Use the purge's DB clock and a full
    // hour of slack so a host/DB clock difference cannot leave this expired fixture inside it.
    const { rows } = await t.db.execute<{ expiredAt: Date }>(
      sql`SELECT clock_timestamp() - interval '26 hours' AS "expiredAt"`,
    );
    await createWriteLimitEvent(t.db, {
      action: 'comment',
      createdAt: new Date(rows[0]!.expiredAt),
    });
    await createWriteLimitEvent(t.db, { action: 'comment' });
    const result = await run({ name: JOB_NAMES.communityRecordsPurge });
    expect(result).toEqual({ writeLimitEvents: 1, linkUses: 0 });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(await t.db.select().from(schema.writeLimitEvents)).toHaveLength(1);
    expect(await run({ name: JOB_NAMES.communityRecordsPurge })).toEqual({
      writeLimitEvents: 0,
      linkUses: 0,
    });
    expect(
      logs.filter((line) => line.msg === 'community records purge').map((line) => line.level),
    ).toEqual([30, 20]);
  });

  it('retention.purge reports each kind JSON-safe and logs an object the store kept (#184)', async () => {
    const { user } = await createUser(t.db);
    const admin = (await createUser(t.db, { role: 'admin' })).user.id;
    const market = await createMarket(t.db, { createdBy: admin });
    const picture = await createMedia(t.db, { ownerId: user.id });
    await createPost(t.db, {
      marketId: market.id,
      authorId: user.id,
      imageIds: [picture.id],
      deletedAt: new Date(Date.now() - 3 * DAY_MS),
    });
    await setReleaseSetting(t.db, {
      adminId: admin,
      key: DELETED_POSTS_RETENTION_SETTING.key,
      status: 'approved',
      value: 1,
    });
    storage.delete = () => Promise.reject(new Error('AccessDenied'));
    const result = (await run({ name: JOB_NAMES.retentionPurge })) as {
      ranAt: string;
      kinds: { kind: string; status: string; periodDays: number | null; deleted: number }[];
    };
    expect(result).toEqual({
      ranAt: expect.stringMatching(ISO_INSTANT) as string,
      kinds: expect.any(Array) as unknown[],
      failed: 1,
      failures: [{ storageKey: picture.storageKey, message: 'AccessDenied' }],
      kindFailures: [],
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.kinds.find((kind) => kind.kind === 'deleted_posts')).toEqual({
      kind: 'deleted_posts',
      status: 'approved',
      periodDays: 1,
      deleted: 1,
    });
    expect(result.kinds.find((kind) => kind.kind === 'consent_records')).toEqual({
      kind: 'consent_records',
      status: 'undecided',
      periodDays: null,
      deleted: 0,
    });
    expect(logs.filter((line) => line.msg === 'retention purge object not removed')).toEqual([
      expect.objectContaining({ storageKey: picture.storageKey, level: 50 }),
    ]);
    // Daily, so always a line.
    expect(logs.filter((line) => line.msg === 'retention purge').map((line) => line.level)).toEqual(
      [30],
    );
  });

  it('retention.purge logs a kind that failed, one error line, records it and goes on (#184)', async () => {
    // The run's first transaction — the nickname holds' batch — is refused.
    let calls = 0;
    const failing = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (...args: Parameters<typeof target.transaction>) => {
            calls += 1;
            return calls === 1
              ? Promise.reject(new Error('could not serialize access'))
              : target.transaction(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const processor = createProcessor({ ...deps, db: failing });
    const result = (await processor(job({ name: JOB_NAMES.retentionPurge }))) as {
      kindFailures: unknown[];
    };
    expect(result.kindFailures).toEqual([
      { kind: 'nickname_holds', message: 'could not serialize access', recorded: true },
    ]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(logs.filter((line) => line.msg === 'retention purge kind failed')).toEqual([
      expect.objectContaining({
        kind: 'nickname_holds',
        level: 50,
        err: expect.objectContaining({ message: 'could not serialize access' }) as unknown,
      }),
    ]);
    expect(logs.filter((line) => line.msg === 'retention purge failure not recorded')).toEqual([]);
    expect(logs.filter((line) => line.msg === 'retention purge').map((line) => line.level)).toEqual(
      [30],
    );
  });

  it('retention.purge logs, on a line of its own, a failure the database would not record either (#184)', async () => {
    // The nickname holds' batch is refused, and so is every insert — the failure's record too.
    const failing = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return () => Promise.reject(new Error('could not serialize access'));
        }
        if (property === 'insert') {
          return () => ({ values: () => Promise.reject(new Error('connection lost')) });
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const processor = createProcessor({ ...deps, db: failing });
    const result = (await processor(job({ name: JOB_NAMES.retentionPurge }))) as {
      kindFailures: unknown[];
    };
    expect(result.kindFailures).toEqual([
      { kind: 'nickname_holds', message: 'could not serialize access', recorded: false },
    ]);
    expect(logs.filter((line) => line.msg === 'retention purge failure not recorded')).toEqual([
      expect.objectContaining({
        kind: 'nickname_holds',
        level: 50,
        err: expect.objectContaining({ message: 'connection lost' }) as unknown,
      }),
    ]);
    expect(await t.db.select().from(schema.retentionPurges)).toEqual([]);
  });

  it('ledger.audit uses the audit connection and reports account and supply results', async () => {
    await createUser(t.db, { balanceCoin: 10_000n });
    const unusableMainDb = new Proxy(t.db, {
      get() {
        throw new Error('daily audit must use the separate audit pool');
      },
    });
    const processor = createProcessor({ ...deps, db: unusableMainDb });
    await expect(processor(job({ name: JOB_NAMES.ledgerAudit }))).resolves.toEqual({
      checked: 2,
      passed: 2,
      mismatched: 0,
      held: 0,
      paused: 0,
      scopes: { account: 1, market: 0, supply: 1 },
      failed: 0,
      failures: [],
    });
  });

  it.skipIf(!hasRedis).each(['account', 'supply'] as const)(
    'ledger.audit finishes the other targets after a transient %s failure, then BullMQ retries it',
    async (failedScope) => {
      const first = await createUser(t.db, { balanceCoin: 100n });
      const second = await createUser(t.db, { balanceCoin: 100n });
      const firstUserId = [first.user.id, second.user.id].sort()[0]!;
      const failedKey = failedScope === 'account' ? `user:${firstUserId}` : 'supply';
      let failedOnce = false;
      const failing = new Proxy(t.db, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return (run: (tx: Tx) => Promise<AuditOutcome>) =>
              target.transaction(async (tx) => {
                const done = await run(tx);
                if (!failedOnce && done.result.targetKey === failedKey) {
                  failedOnce = true;
                  // An actual transient PostgreSQL timeout rolls back even the result row.
                  // SET LOCAL disappears with this failed transaction; all other checks proceed.
                  await tx.execute(sql`SET LOCAL statement_timeout = '1ms'`);
                  await tx.execute(sql`SELECT pg_sleep(0.1)`);
                }
                return done;
              });
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      const processor = createProcessor({ ...deps, auditDb: failing });
      const prefix = `daily-audit-retry-${randomUUID()}`;
      const connection = new Redis(process.env.TEST_REDIS_URL!, BULLMQ_REDIS_OPTIONS);
      const queue = new Queue('audit', {
        connection,
        prefix,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      const events = new QueueEvents('audit', { connection, prefix });
      let attempts = 0;
      let beforeRetry: AuditOutcome['result'][] = [];
      const worker = createWorker(
        'audit',
        async (job) => {
          attempts++;
          if (attempts === 2) beforeRetry = await t.db.select().from(schema.reconciliationResults);
          const result: unknown = await processor(job);
          return result;
        },
        connection,
        { prefix, concurrency: 1 },
      );
      try {
        await events.waitUntilReady();
        const queued = await queue.add(JOB_NAMES.ledgerAudit, {});
        const result: unknown = await queued.waitUntilFinished(events, 10_000);
        expect(result).toMatchObject({ checked: 3, passed: 3, failed: 0, mismatched: 0 });
        expect(attempts).toBe(2);
        expect(beforeRetry).toHaveLength(2);
        expect(beforeRetry.every((row) => row.targetKey !== failedKey)).toBe(true);
        expect(beforeRetry.map((row) => row.scope).sort()).toEqual(
          failedScope === 'account' ? ['account', 'supply'] : ['account', 'account'],
        );
        const stored = await queue.getJob(queued.id!);
        expect(stored?.attemptsMade).toBe(2);
        expect(stored?.opts).toMatchObject(DEFAULT_JOB_OPTIONS);
        expect(await stored?.getState()).toBe('completed');
        const records = await t.db.select().from(schema.reconciliationResults);
        expect(records).toHaveLength(5);
        expect(records.filter((row) => row.targetKey === failedKey)).toHaveLength(1);
        expect(await t.db.select().from(schema.reconciliationHolds)).toEqual([]);
        expect(logs.filter((line) => line.msg === 'ledger audit')).toEqual([
          expect.objectContaining({ level: 50, checked: 2, failed: 1, mismatched: 0 }),
          expect.objectContaining({ level: 30, checked: 3, failed: 0, mismatched: 0 }),
        ]);
        expect(published).toEqual([]);
      } finally {
        await worker.close();
        await events.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await connection.quit();
      }
    },
  );

  it('ledger.audit completes a recorded mismatch without requesting a retry', async () => {
    const { user } = await createUser(t.db, { balanceCoin: 100n });
    await withLedgerGuardsOff((client) =>
      client.query('UPDATE balances SET available_coin=available_coin+1 WHERE user_id=$1', [
        user.id,
      ]),
    );
    await expect(run({ name: JOB_NAMES.ledgerAudit })).resolves.toMatchObject({
      checked: 2,
      passed: 0,
      mismatched: 2,
      held: 1,
      failed: 0,
    });
    expect(await t.db.select().from(schema.reconciliationResults)).toHaveLength(2);
    expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(1);
  });

  it('market.audit uses the regular pool for the scan and accepts an explicit target', async () => {
    const market = await createMarket(t.db, { status: 'open' });
    const unusableAuditDb = new Proxy(t.db, {
      get() {
        throw new Error('minute audit must not wait behind the daily audit pool');
      },
    });
    const processor = createProcessor({ ...deps, auditDb: unusableAuditDb });
    const scanned: unknown = await processor(job({ name: JOB_NAMES.marketAudit }));
    expect(scanned).toMatchObject({ checked: 1, passed: 1, failed: 0 });
    const explicit: unknown = await processor(
      job({ name: JOB_NAMES.marketAudit, data: { marketId: market.id } }),
    );
    expect(explicit).toMatchObject({ marketId: market.id, passed: true, held: false });
    expect(() => JSON.stringify(explicit)).not.toThrow();
    expect(published).toEqual([]);
  });

  it('market.audit refuses malformed targets before checking any market', async () => {
    await expect(run({ name: JOB_NAMES.marketAudit, data: { marketId: 'nope' } })).rejects.toThrow(
      UnrecoverableError,
    );
    expect(await t.db.select().from(schema.reconciliationResults)).toEqual([]);
  });
});
