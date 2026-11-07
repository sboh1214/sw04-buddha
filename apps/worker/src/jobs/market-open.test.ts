/**
 * market.open integration test (#21, ADR-0100) against the docker `test` profile, as
 * market-close.test.ts: the database through the packages/db harness, Redis through
 * TEST_REDIS_URL (the events an open publishes are read back on a raw subscriber). What the open
 * judges and writes — rule v1 included (#80) — is `openScheduledMarket`'s, tested in packages/db
 * (market-open.test.ts); this covers the worker's transaction around it, the publish, and the
 * scan's selection and order. Skips when either is unset, exactly like ledger-audit.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import {
  NO_MARKET_STATS,
  connectTestDb,
  createMarket,
  createScheduledMarket,
  hasTestDb,
  marketStatsOf,
  type TestDb,
} from '@buddha/db/test';
import { MARKET_STATUSES, marketChannel } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher, createPublisherRedis, type Publish } from '../realtime.js';
import { openDueMarkets, openMarket } from './market-open.js';

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
const HOUR_MS = 60 * MINUTE_MS;

describe.skipIf(!hasTestInfra)('market.open (integration)', () => {
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

  /** The market's rule versions (#80), v1 first. */
  async function versionsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketRuleVersions)
      .where(eq(schema.marketRuleVersions.marketId, marketId))
      .orderBy(asc(schema.marketRuleVersions.version));
  }

  /** A subscriber on the market's channel; messages land in the returned array. */
  async function subscribeTo(marketId: string) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(marketChannel(marketId));
    return { received, quit: () => subscriber.quit() };
  }

  /** An approved market (#78) whose scheduled open is `scheduledOpenAt` — due by default. */
  async function scheduled(scheduledOpenAt?: Date) {
    return (await createScheduledMarket(t.db, { scheduledOpenAt })).market;
  }

  it('opens a due scheduled market: open status, worker event, open_at, statusEventId and a published status', async () => {
    const market = await scheduled();
    const { received, quit } = await subscribeTo(market.id);
    try {
      const result = await openMarket(t.db, market.id, publish);
      expect(result.outcome).toBe('opened');
      if (result.outcome !== 'opened') return;

      const events = await eventsOf(market.id);
      expect(events.map((event) => event.type)).toEqual(['submitted', 'approved', 'opened']);
      const event = events.at(-1)!;
      expect(event).toMatchObject({
        // The worker acted, not an admin (market_events.actor_id is null for the worker).
        actorId: null,
        fromStatus: 'scheduled',
        toStatus: 'open',
        payload: {
          openAt: result.openedAt.toISOString(),
          closeAt: market.closeAt.toISOString(),
          source: 'job',
        },
        createdAt: result.openedAt,
      });
      expect(result.statusEventId).toBe(event.id);

      const row = await marketRow(market.id);
      expect(row.status).toBe('open');
      // The ordering key of market:status is the event this transition wrote (A-M3-19).
      expect(row.statusEventId).toBe(event.id);
      // One DB clock instant, read after the market lock, on the row and the event alike.
      expect(row.openAt).toEqual(result.openedAt);
      expect(row.updatedAt).toEqual(result.openedAt);
      expect(result.openedAt.getTime()).toBeGreaterThanOrEqual(market.scheduledOpenAt!.getTime());
      // The open moves no other time and keeps what the submission stored.
      expect(row).toMatchObject({
        scheduledOpenAt: market.scheduledOpenAt,
        closeAt: market.closeAt,
        leadCloseGapMinutes: market.leadCloseGapMinutes,
      });
      // Rule v1 in the same transaction (#80, ADR-0101; ADR-0093 decision 2 #172 item 6): the
      // market at version 1, its row made by the worker (null) at the open's instant, holding the
      // content the review locked — and no event of its own (the list above).
      expect(row.ruleVersion).toBe(1);
      // The open is no fill: no 시장가격, no point, nothing counted (#121; the 50% is no price).
      expect(await marketStatsOf(t.db, market.id)).toEqual(NO_MARKET_STATS);
      const versions = await versionsOf(market.id);
      expect(versions).toEqual([
        expect.objectContaining({
          version: 1,
          createdBy: null,
          createdAt: result.openedAt,
          changedItems: [],
          approvalId: null,
          reason: null,
        }),
      ]);
      expect(versions[0]!.content).toMatchObject({
        title: market.title,
        yesCondition: market.yesCondition,
        scheduledOpenAt: market.scheduledOpenAt!.toISOString(),
        closeAt: market.closeAt.toISOString(),
      });

      await waitForMessages(received, 1, 'market:status of the open');
      await sleep(100);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!)).toEqual({
        type: 'market:status',
        marketId: market.id,
        status: 'open',
        resolvedResult: null,
        statusEventId: String(event.id),
        ts: result.openedAt.toISOString(),
      });
    } finally {
      await quit();
    }
  });

  it('skips a market whose scheduled open has not come (a stale delayed job after a reschedule)', async () => {
    const market = await scheduled(new Date(Date.now() + HOUR_MS));
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(openMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_due',
      });
      expect(await marketRow(market.id)).toEqual(market);
      expect((await eventsOf(market.id)).map((event) => event.type)).toEqual([
        'submitted',
        'approved',
      ]);
      expect(await versionsOf(market.id)).toEqual([]);
      await sleep(100);
      expect(received).toEqual([]);
    } finally {
      await quit();
    }
  });

  it('skips a scheduled market with no scheduled open: it waits rather than opening with no time', async () => {
    const market = await createMarket(t.db, { status: 'scheduled', scheduledOpenAt: null });
    await expect(openMarket(t.db, market.id, publish)).resolves.toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'not_due',
    });
    expect((await marketRow(market.id)).status).toBe('scheduled');
    expect(await eventsOf(market.id)).toEqual([]);
  });

  // Every status but `scheduled`: a draft (sent back by an admin), one under review, and every
  // status past the open — a job that fires after the approval or a reschedule opened it.
  it.each(MARKET_STATUSES.filter((status) => status !== 'scheduled'))(
    'skips a %s market even when its scheduled open has passed',
    async (status) => {
      const market = await createMarket(t.db, { status });
      expect(market.scheduledOpenAt!.getTime()).toBeLessThan(Date.now());
      await expect(openMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_scheduled',
      });
      expect(await marketRow(market.id)).toEqual(market);
      expect(await eventsOf(market.id)).toEqual([]);
    },
  );

  it('never opens a market whose close has come: it stays scheduled for an admin to send back (ADR-0093 #172 item 6)', async () => {
    const market = (
      await createScheduledMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) })
    ).market;
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(openMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'close_passed',
      });
      expect(await marketRow(market.id)).toEqual(market);
      expect((await eventsOf(market.id)).map((event) => event.type)).toEqual([
        'submitted',
        'approved',
      ]);
      expect(await versionsOf(market.id)).toEqual([]);
      await sleep(100);
      expect(received).toEqual([]);
    } finally {
      await quit();
    }
  });

  it('rejects an unknown market id instead of skipping it (a broken producer must be visible)', async () => {
    await expect(openMarket(t.db, randomUUID(), publish)).rejects.toThrow(/not found/);
  });

  it('is idempotent: a second run (a duplicate job, or the scan after the delayed job) is a no-op', async () => {
    const market = await scheduled();
    const first = await openMarket(t.db, market.id, publish);
    expect(first.outcome).toBe('opened');
    const opened = await marketRow(market.id);
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(openMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_scheduled',
      });
      expect(await marketRow(market.id)).toEqual(opened);
      expect((await eventsOf(market.id)).filter((event) => event.type === 'opened')).toHaveLength(
        1,
      );
      // Nor a second v1 (#80): the repeat finds the market OPEN before it writes anything.
      expect((await versionsOf(market.id)).map((version) => version.version)).toEqual([1]);
      await sleep(100);
      expect(received).toEqual([]);
    } finally {
      await quit();
    }
  });

  it('scan opens every due scheduled market, earliest scheduled open first, and leaves the rest alone', async () => {
    const later = await scheduled(new Date(Date.now() - MINUTE_MS));
    const earlier = await scheduled(new Date(Date.now() - 2 * MINUTE_MS));
    const future = await scheduled(new Date(Date.now() + HOUR_MS));
    // Due, but its close has come: not even read, so it never holds a slot of the batch.
    const closePassed = await createMarket(t.db, {
      status: 'scheduled',
      closeAt: new Date(Date.now() - MINUTE_MS),
    });
    const noScheduledOpen = await createMarket(t.db, {
      status: 'scheduled',
      scheduledOpenAt: null,
    });
    // Due by their times, in a status the open does not take.
    const draft = await createMarket(t.db, { status: 'draft' });
    const review = await createMarket(t.db, { status: 'review' });
    const open = await createMarket(t.db, { status: 'open' });
    const left = [future, closePassed, noScheduledOpen, draft, review, open];

    const subscribers = await Promise.all([later, earlier, future].map((m) => subscribeTo(m.id)));
    try {
      // `skipped: 0`: the market whose close has come was not examined at all.
      await expect(openDueMarkets(t.db, publish)).resolves.toEqual({
        opened: 2,
        skipped: 0,
        failed: 0,
        failures: [],
      });

      expect((await marketRow(earlier.id)).status).toBe('open');
      expect((await marketRow(later.id)).status).toBe('open');
      for (const market of left) {
        expect(await marketRow(market.id)).toEqual(market);
      }

      // Each open is its own transaction, in scheduled-open order: the earlier one's event has
      // the smaller id.
      const [earlierEvent] = (await eventsOf(earlier.id)).filter((e) => e.type === 'opened');
      const [laterEvent] = (await eventsOf(later.id)).filter((e) => e.type === 'opened');
      expect(earlierEvent!.id).toBeLessThan(laterEvent!.id);
      expect(earlierEvent).toMatchObject({ actorId: null, payload: { source: 'job' } });
      expect((await eventsOf(future.id)).map((event) => event.type)).toEqual([
        'submitted',
        'approved',
      ]);
      for (const market of [closePassed, noScheduledOpen, draft, review, open]) {
        expect(await eventsOf(market.id)).toEqual([]);
      }
      // A version for each market it opened, none for the rest (#80).
      for (const market of [earlier, later]) {
        expect((await versionsOf(market.id)).map((version) => version.createdBy)).toEqual([null]);
      }
      for (const market of left) expect(await versionsOf(market.id)).toEqual([]);

      await waitForMessages(subscribers[0]!.received, 1, 'status of the later market');
      await waitForMessages(subscribers[1]!.received, 1, 'status of the earlier market');
      await sleep(100);
      expect(subscribers[2]!.received).toEqual([]);

      // Nothing is due any more: the next minute's scan finds nothing.
      await expect(openDueMarkets(t.db, publish)).resolves.toEqual({
        opened: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      });
    } finally {
      await Promise.all(subscribers.map((s) => s.quit()));
    }
  });

  it('does not fail the open when the publish fails (the transaction has committed)', async () => {
    const market = await scheduled();
    // A publisher on a dead connection, built by the PRODUCTION factory as in
    // market-close.test.ts: the warn-and-swallow contract of realtime.ts keeps a finished open out
    // of the failed set — a retry would find `open` and never republish anyway.
    const dead = createPublisherRedis('redis://127.0.0.1:1', pino({ level: 'silent' }));
    const logs: unknown[] = [];
    const logger = pino(
      { level: 'warn' },
      { write: (line: string) => logs.push(JSON.parse(line)) },
    );
    try {
      const result = await openMarket(t.db, market.id, createPublisher(dead, logger));
      expect(result.outcome).toBe('opened');
      expect((await marketRow(market.id)).status).toBe('open');
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
