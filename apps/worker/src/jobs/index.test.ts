/**
 * The BullMQ handler layer (jobs/index.ts) on the docker `test` database: dispatch by job
 * name, the payload check, and the shape of what a handler hands back — BullMQ stores it as
 * JSON, and a bigint or an Error in it is exactly what this layer exists to keep out. Jobs are
 * stubs carrying the fields a handler reads (a real Job needs a queue and a connection), and
 * publishes go to a recording stub: Redis is not what is under test here. Skips when TEST_* are
 * unset, like ledger-audit.test.ts.
 */
import { schema } from '@buddha/db';
import {
  connectTestDb,
  createMarket,
  createMedia,
  createPosition,
  createStartGrant,
  createUser,
  createWriteLimitEvent,
  hasTestDb,
  setReleaseSetting,
  type TestDb,
} from '@buddha/db/test';
import {
  JOB_NAMES,
  START_COIN_SETTING,
  marketChannel,
  userChannel,
  type MarketRealtimeEvent,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryObjectStorage } from '@buddha/storage';
import { type Publish } from '../realtime.js';
import { createProcessor } from './index.js';

const MINUTE_MS = 60_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
  let logs: Record<string, unknown>[];
  let run: (input: JobStub) => Promise<unknown>;
  let storage: MemoryObjectStorage;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    published = [];
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
    const processor = createProcessor({ db: t.db, auditDb: t.db, publish, storage, logger });
    run = (input) => processor(job(input)) as Promise<unknown>;
  });

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }

  /** A market judged YES a minute ago, with the pending step row the judgement writes. */
  async function judged() {
    const resolvedAt = new Date(Date.now() - MINUTE_MS);
    return createMarket(t.db, {
      status: 'resolved',
      closeAt: new Date(resolvedAt.getTime() - MINUTE_MS),
      resolvedResult: 'YES',
      resolvedAt,
    });
  }

  async function stepOf(marketId: string) {
    const [row] = await t.db
      .select()
      .from(schema.marketSettlementSteps)
      .where(eq(schema.marketSettlementSteps.marketId, marketId));
    return row!;
  }

  it('market.close without a market id is the scan: closes what is due and returns the counts', async () => {
    const due = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const future = await createMarket(t.db, { closeAt: new Date(Date.now() + MINUTE_MS) });

    await expect(run({ name: JOB_NAMES.marketClose, data: {} })).resolves.toEqual({
      closed: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect((await marketRow(due.id)).status).toBe('closed');
    expect((await marketRow(future.id)).status).toBe('open');
    expect(published).toEqual([
      {
        channel: marketChannel(due.id),
        event: expect.objectContaining({ type: 'market:status', status: 'closed' }) as unknown,
      },
    ]);

    // The scheduler job of queues.ts carries no data at all; that is the scan too, and with
    // nothing left to do it reports zeros (at debug — it runs every minute).
    await expect(run({ name: JOB_NAMES.marketClose })).resolves.toEqual({
      closed: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(logs.at(-1)).toMatchObject({ level: 20, msg: 'market close scan', closed: 0 });
  });

  it('market.close with a market id closes that market only', async () => {
    const target = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const other = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });

    const result = await run({ name: JOB_NAMES.marketClose, data: { marketId: target.id } });
    expect(result).toMatchObject({ outcome: 'closed', marketId: target.id });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect((await marketRow(target.id)).status).toBe('closed');
    expect((await marketRow(other.id)).status).toBe('open');
    expect(published.map((p) => p.channel)).toEqual([marketChannel(target.id)]);

    // The delayed job's retry, or a duplicate: skipped, and the skip is JSON too.
    await expect(
      run({ name: JOB_NAMES.marketClose, data: { marketId: target.id } }),
    ).resolves.toEqual({ outcome: 'skipped', marketId: target.id, reason: 'not_open' });
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

  it('market.finalize with a market id returns a JSON-safe result: paidCoin a decimal string, settledAt ISO', async () => {
    const market = await judged();
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await createPosition(t.db, { userId: alice, marketId: market.id, outcome: 'YES', qty: 3 });

    const result = await run({ name: JOB_NAMES.marketFinalize, data: { marketId: market.id } });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result).toEqual({
      outcome: 'settled',
      marketId: market.id,
      statusEventId: expect.any(Number) as number,
      settledAt: expect.stringMatching(ISO_INSTANT) as string,
      positions: 1,
      settledAccounts: 1,
      paidAccounts: 1,
      paidCoin: '300',
    });
    // The string is the DB instant the row carries, not a re-read.
    const row = await marketRow(market.id);
    expect(result).toMatchObject({
      settledAt: row.settledAt!.toISOString(),
      statusEventId: row.statusEventId,
    });
    expect(published.map((p) => p.channel)).toEqual([
      marketChannel(market.id),
      userChannel(alice),
      userChannel(alice),
    ]);
    // The log line went through the same conversion: pino would have thrown on the bigint.
    expect(logs.find((line) => line.msg === 'market finalize')).toMatchObject({ paidCoin: '300' });

    // A second run is the skip, and the skip is JSON as it stands.
    const again = await run({ name: JOB_NAMES.marketFinalize, data: { marketId: market.id } });
    expect(again).toEqual({ outcome: 'skipped', marketId: market.id, reason: 'not_resolved' });
    expect(() => JSON.stringify(again)).not.toThrow();
  });

  it('market.finalize scan with a failing market: JSON-safe counts, and one error line per failure', async () => {
    // A winning holder without a balance row poisons the market (market-finalize.ts throws,
    // the transaction rolls back); the scan reports it instead of failing the job.
    const poisoned = await judged();
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await createPosition(t.db, { userId: alice, marketId: poisoned.id, outcome: 'YES', qty: 2 });
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, alice));
    const healthy = await judged();

    const result = await run({ name: JOB_NAMES.marketFinalize, data: {} });
    // toEqual, not toMatchObject: the thrown value itself must NOT be in what BullMQ stores.
    expect(result).toEqual({
      settled: 1,
      skipped: 0,
      failed: 1,
      failures: [
        { marketId: poisoned.id, message: expect.stringMatching(/Balance not found/) as string },
      ],
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect((await marketRow(poisoned.id)).status).toBe('resolved');
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
      err: { message: expect.stringMatching(/Balance not found/) as string },
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
    await createWriteLimitEvent(t.db, {
      action: 'comment',
      createdAt: new Date(Date.now() - 25 * 60 * MINUTE_MS),
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

  it('ledger.audit runs on the audit connection and reports the mismatch count', async () => {
    await createUser(t.db, { balanceCoin: 10_000n });
    await expect(run({ name: JOB_NAMES.ledgerAudit })).resolves.toEqual({
      checked: 1,
      mismatches: 0,
    });
  });
});
