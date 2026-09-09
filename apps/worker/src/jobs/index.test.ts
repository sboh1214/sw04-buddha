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
  createPosition,
  createUser,
  hasTestDb,
  type TestDb,
} from '@buddha/db/test';
import {
  JOB_NAMES,
  marketChannel,
  userChannel,
  type MarketRealtimeEvent,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Publish } from '../realtime.js';
import { createProcessor } from './index.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
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
    const processor = createProcessor({ db: t.db, auditDb: t.db, publish, logger });
    run = (input) => processor(job(input)) as Promise<unknown>;
  });

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }

  /** A resolving market whose dispute window closed a minute ago. */
  async function dueResolving() {
    const disputeUntil = new Date(Date.now() - MINUTE_MS);
    return createMarket(t.db, {
      status: 'resolving',
      closeAt: new Date(disputeUntil.getTime() - DAY_MS - MINUTE_MS),
      resolvedResult: 'YES',
      resolvedAt: new Date(disputeUntil.getTime() - DAY_MS),
      disputeUntil,
    });
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

  it('market.finalize with a market id returns a JSON-safe result: paidP a decimal string, settledAt ISO', async () => {
    const market = await dueResolving();
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
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
      paidP: '300',
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
    expect(logs.find((line) => line.msg === 'market finalize')).toMatchObject({ paidP: '300' });

    // A second run is the skip, and the skip is JSON as it stands.
    const again = await run({ name: JOB_NAMES.marketFinalize, data: { marketId: market.id } });
    expect(again).toEqual({ outcome: 'skipped', marketId: market.id, reason: 'not_resolving' });
    expect(() => JSON.stringify(again)).not.toThrow();
  });

  it('market.finalize scan with a failing market: JSON-safe counts, and one error line per failure', async () => {
    // A winning holder without a balance row poisons the market (market-finalize.ts throws,
    // the transaction rolls back); the scan reports it instead of failing the job.
    const poisoned = await dueResolving();
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await createPosition(t.db, { userId: alice, marketId: poisoned.id, outcome: 'YES', qty: 2 });
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, alice));
    const healthy = await dueResolving();

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
    expect((await marketRow(poisoned.id)).status).toBe('resolving');
    expect((await marketRow(healthy.id)).status).toBe('settled');

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

  it('ledger.audit runs on the audit connection and reports the mismatch count', async () => {
    await createUser(t.db, { balanceP: 10_000n });
    await expect(run({ name: JOB_NAMES.ledgerAudit })).resolves.toEqual({
      checked: 1,
      mismatches: 0,
    });
  });
});
