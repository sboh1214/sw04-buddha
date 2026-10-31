/**
 * market.close integration test (PLAN M5 AC 1, PLAN 5.5 마감) against the docker `test`
 * profile: the database through the packages/db harness, Redis through TEST_REDIS_URL (the
 * events a close publishes are read back on a raw subscriber, as the API suites do). Skips
 * when either is unset, exactly like ledger-audit.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import { connectTestDb, createMarket, hasTestDb, type TestDb } from '@buddha/db/test';
import { MARKET_STATUSES, marketChannel } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher, createPublisherRedis, type Publish } from '../realtime.js';
import { closeDueMarkets, closeMarket } from './market-close.js';

// hasTestDb() loads the root .env first, so TEST_REDIS_URL is visible after it.
const hasTestInfra = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `received` holds `count` messages (bounded), so a lost publish fails loudly. */
async function waitForMessages(received: unknown[], count: number, what: string): Promise<void> {
  const started = Date.now();
  while (received.length < count) {
    if (Date.now() - started > 5_000) {
      throw new Error(`${what}: ${String(received.length)} of ${String(count)} received`);
    }
    await sleep(20);
  }
}

const MINUTE_MS = 60_000;

describe.skipIf(!hasTestInfra)('market.close (integration)', () => {
  let t: TestDb;
  let redis: Redis;
  let publish: Publish;

  beforeAll(async () => {
    t = await connectTestDb();
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    publish = createPublisher(redis, pino({ level: 'silent' }));
  });
  afterAll(async () => {
    await redis?.quit();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }

  async function eventsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, marketId))
      .orderBy(asc(schema.marketEvents.id));
  }

  /** A subscriber on the market's channel; messages land in the returned array. */
  async function subscribeTo(marketId: string) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(marketChannel(marketId));
    return { received, quit: () => subscriber.quit() };
  }

  it('closes a due open market: closed status, worker event, statusEventId and a published status', async () => {
    const market = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const { received, quit } = await subscribeTo(market.id);
    try {
      const result = await closeMarket(t.db, market.id, publish);
      expect(result.outcome).toBe('closed');
      if (result.outcome !== 'closed') return;

      const [event] = await eventsOf(market.id);
      expect(event).toMatchObject({
        type: 'closed',
        // The worker acted, not an admin (market_events.actor_id is null for the worker).
        actorId: null,
        // The transition it made (`transitionMarket`, #174).
        fromStatus: 'open',
        toStatus: 'closed',
        payload: { closedAt: result.closedAt.toISOString(), source: 'job' },
        createdAt: result.closedAt,
      });
      expect(result.statusEventId).toBe(event!.id);

      const row = await marketRow(market.id);
      expect(row.status).toBe('closed');
      // The ordering key of market:status is the event this transition wrote (A-M3-19).
      expect(row.statusEventId).toBe(event!.id);
      // One DB clock instant, read after the market lock, on the row and the event alike.
      expect(row.updatedAt).toEqual(result.closedAt);
      expect(result.closedAt.getTime()).toBeGreaterThanOrEqual(market.closeAt.getTime());
      // A close judges nothing.
      expect(row.resolvedResult).toBeNull();
      expect(row.resolvedAt).toBeNull();

      await waitForMessages(received, 1, 'market:status of the close');
      await sleep(100);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!)).toEqual({
        type: 'market:status',
        marketId: market.id,
        status: 'closed',
        resolvedResult: null,
        statusEventId: String(event!.id),
        ts: result.closedAt.toISOString(),
      });
    } finally {
      await quit();
    }
  });

  it('skips a market whose close time has not come (a stale delayed job after a closeAt PATCH)', async () => {
    const market = await createMarket(t.db, { closeAt: new Date(Date.now() + MINUTE_MS) });
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(closeMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_due',
      });
      const row = await marketRow(market.id);
      expect(row).toMatchObject({
        status: 'open',
        statusEventId: null,
        updatedAt: market.updatedAt,
      });
      expect(await eventsOf(market.id)).toEqual([]);
      await sleep(100);
      expect(received).toEqual([]);
    } finally {
      await quit();
    }
  });

  // Every status but `open`, `paused` included: PAUSED → CLOSED at `close_at` is #114's.
  it.each(MARKET_STATUSES.filter((status) => status !== 'open'))(
    'skips a %s market even when its close time has passed',
    async (status) => {
      const market = await createMarket(t.db, {
        status,
        closeAt: new Date(Date.now() - MINUTE_MS),
      });
      await expect(closeMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_open',
      });
      expect((await marketRow(market.id)).status).toBe(status);
      expect(await eventsOf(market.id)).toEqual([]);
    },
  );

  it('rejects an unknown market id instead of skipping it (a broken producer must be visible)', async () => {
    await expect(closeMarket(t.db, randomUUID(), publish)).rejects.toThrow(/not found/);
  });

  it('is idempotent: a second run (a duplicate job, or the scan after the delayed job) is a no-op', async () => {
    const market = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const first = await closeMarket(t.db, market.id, publish);
    expect(first.outcome).toBe('closed');
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(closeMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_open',
      });
      expect(await eventsOf(market.id)).toHaveLength(1);
      await sleep(100);
      expect(received).toEqual([]);
    } finally {
      await quit();
    }
  });

  it('scan closes every due open market, oldest deadline first, and leaves the rest alone', async () => {
    const later = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const earlier = await createMarket(t.db, { closeAt: new Date(Date.now() - 2 * MINUTE_MS) });
    const future = await createMarket(t.db, { closeAt: new Date(Date.now() + MINUTE_MS) });
    const alreadyClosed = await createMarket(t.db, {
      status: 'closed',
      closeAt: new Date(Date.now() - MINUTE_MS),
    });
    const draft = await createMarket(t.db, {
      status: 'draft',
      closeAt: new Date(Date.now() - MINUTE_MS),
    });
    const scheduled = await createMarket(t.db, {
      status: 'scheduled',
      closeAt: new Date(Date.now() - MINUTE_MS),
    });
    // Due as well, and left alone until #114 closes a paused market on schedule.
    const paused = await createMarket(t.db, {
      status: 'paused',
      closeAt: new Date(Date.now() - MINUTE_MS),
    });

    const subscribers = await Promise.all([later, earlier, future].map((m) => subscribeTo(m.id)));
    try {
      await expect(closeDueMarkets(t.db, publish)).resolves.toEqual({
        closed: 2,
        skipped: 0,
        failed: 0,
        failures: [],
      });

      expect((await marketRow(earlier.id)).status).toBe('closed');
      expect((await marketRow(later.id)).status).toBe('closed');
      expect(await marketRow(future.id)).toMatchObject({ status: 'open', statusEventId: null });
      expect((await marketRow(alreadyClosed.id)).statusEventId).toBeNull();
      expect((await marketRow(draft.id)).status).toBe('draft');
      expect((await marketRow(scheduled.id)).status).toBe('scheduled');
      expect((await marketRow(paused.id)).status).toBe('paused');

      // Each close is its own transaction, in deadline order: the earlier deadline's event
      // has the smaller id.
      const [earlierEvent] = await eventsOf(earlier.id);
      const [laterEvent] = await eventsOf(later.id);
      expect(earlierEvent!.id).toBeLessThan(laterEvent!.id);
      for (const left of [alreadyClosed, draft, scheduled, paused]) {
        expect(await eventsOf(left.id)).toEqual([]);
      }

      await waitForMessages(subscribers[0]!.received, 1, 'status of the later market');
      await waitForMessages(subscribers[1]!.received, 1, 'status of the earlier market');
      await sleep(100);
      expect(subscribers[2]!.received).toEqual([]);

      // Nothing is due any more: the next minute's scan finds nothing.
      await expect(closeDueMarkets(t.db, publish)).resolves.toEqual({
        closed: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      });
    } finally {
      await Promise.all(subscribers.map((s) => s.quit()));
    }
  });

  it('does not fail the close when the publish fails (the transaction has committed)', async () => {
    const market = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    // A publisher on a dead connection: the warn-and-swallow contract of realtime.ts is what
    // keeps a finished close out of the failed set — a retry would find `closed` and never
    // republish anyway.
    //
    // Built by the PRODUCTION factory, not by hand. A hand-rolled client could carry
    // `maxRetriesPerRequest: 0` — precisely the option the deployed connection does not have —
    // and the case would then pass whatever main.ts actually wires up. `createPublisherRedis`
    // takes its own silent logger so only `createPublisher`'s warn reaches `logs`.
    const dead = createPublisherRedis('redis://127.0.0.1:1', pino({ level: 'silent' }));
    const logs: unknown[] = [];
    const logger = pino(
      { level: 'warn' },
      { write: (line: string) => logs.push(JSON.parse(line)) },
    );
    try {
      const result = await closeMarket(t.db, market.id, createPublisher(dead, logger));
      expect(result.outcome).toBe('closed');
      expect((await marketRow(market.id)).status).toBe('closed');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        msg: 'realtime publish failed',
        channel: marketChannel(market.id),
        eventType: 'market:status',
      });
    } finally {
      dead.disconnect();
    }
  });
});
