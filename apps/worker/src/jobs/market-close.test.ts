/**
 * market.close integration test (PLAN M5 AC 1, PLAN 5.5 마감) against the docker `test`
 * profile: the database through the packages/db harness, Redis through TEST_REDIS_URL (the
 * events a close publishes are read back on a raw subscriber, as the API suites do). Skips
 * when either is unset, exactly like ledger-audit.test.ts. The close's rules — the skips that lock
 * no one, the races on the market lock, the expiry of every account type — are pinned on
 * `closeMarketAtClose` itself (packages/db market-close.test.ts); here the job around it: its
 * result, what it publishes after COMMIT, and the scan (#120, ADR-0115). A market nobody traded
 * on is cancelled by the same close (#20, ADR-0117): every case says which of the two it is, and
 * `tradeOnce` (one pair mint between two members) makes a market a CLOSED one. The members whose
 * orders the close ended (#134, ADR-0158) and its watchers and holders (#54, ADR-0159) get one
 * `user:notification` each after COMMIT; the notices' rows are pinned on the db side, here the
 * signal and the job's counts — `notifiedMembers` counts the order owners alone, never a watcher —
 * and a member's 수신 설정 filters each notice of the one call apart (#56, ADR-0162).
 */
import { randomUUID } from 'node:crypto';
import { schema, setNotificationCategory } from '@buddha/db';
import {
  balanceOf,
  checkOrderInvariants,
  connectTestDb,
  contractBook,
  createConfiguredOpenMarket,
  TEST_MM_TRADING_LIQUIDITY,
  createMarket,
  createMarketPause,
  createPauseDecision,
  createPausedMarket,
  createUser,
  createWatch,
  fundMarketMakerFunds,
  hasTestDb,
  ledgerAccountBalance,
  ledgerSupply,
  marketStatsOf,
  mintTestPairs,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  positionOf,
  setReleaseSetting,
  tradeOnce,
  type PlaceTestOrderInput,
  type TestDb,
} from '@buddha/db/test';
import {
  MARKET_NO_FILL_CANCEL_REASON,
  MARKET_STATUSES,
  ORDER_ACCEPTING_SETTING,
  USER_CHANNEL_PATTERN,
  marketChannel,
  userChannel,
} from '@buddha/shared';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher, createPublisherRedis, type Publish } from '../realtime.js';
import { CLOSABLE_STATUSES, closeDueMarkets, closeMarket } from './market-close.js';

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

  async function pausesOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketPauses)
      .where(eq(schema.marketPauses.marketId, marketId));
  }

  async function eventsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, marketId))
      .orderBy(asc(schema.marketEvents.id));
  }

  /**
   * A due OPEN market with one fill between two members (`tradeOnce`: intake opened by a fresh
   * admin, the close then moved back to `closeAt`), so its close is a CLOSED one (#20).
   */
  async function tradedMarket(closeAt = new Date(Date.now() - MINUTE_MS)) {
    const admin = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId: admin });
    const market = await createMarket(t.db, { createdBy: admin });
    await tradeOnce(t.db, market.id);
    await passMarketClose(t.db, market.id, closeAt);
    return marketRow(market.id);
  }

  /** A subscriber on the market's channel; messages land in the returned array. */
  async function subscribeTo(marketId: string) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(marketChannel(marketId));
    return { received, quit: () => subscriber.quit() };
  }

  it('closes a due open market a person traded on: closed status, worker event, statusEventId and a published status', async () => {
    const market = await tradedMarket();
    const { received, quit } = await subscribeTo(market.id);
    try {
      const result = await closeMarket(t.db, market.id, publish);
      expect(result.outcome).toBe('closed');
      if (result.outcome !== 'closed') return;

      const event = (await eventsOf(market.id)).at(-1);
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

  it('cancels a due open market nobody traded on: cancelled status, the system sentence, an empty result and a published status (#20)', async () => {
    const market = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const { received, quit } = await subscribeTo(market.id);
    try {
      const result = await closeMarket(t.db, market.id, publish);
      if (result.outcome !== 'cancelled') throw new Error(`cancelled, got ${result.outcome}`);
      expect(result).toEqual({
        outcome: 'cancelled',
        marketId: market.id,
        statusEventId: expect.any(Number) as unknown,
        closedAt: expect.any(Date) as unknown,
        expiredOrders: 0,
        heldOrders: 0,
        notifiedMembers: 0,
      });

      const [event] = await eventsOf(market.id);
      expect(event).toMatchObject({
        id: result.statusEventId,
        type: 'cancelled',
        // The worker acted (ADR-0107 결정 5 '#20·#120': automatic, no operator).
        actorId: null,
        fromStatus: 'open',
        toStatus: 'cancelled',
        payload: {
          cancelledAt: result.closedAt.toISOString(),
          source: 'job',
          reason: MARKET_NO_FILL_CANCEL_REASON,
        },
        createdAt: result.closedAt,
      });
      const row = await marketRow(market.id);
      expect(row).toMatchObject({
        status: 'cancelled',
        statusEventId: event!.id,
        updatedAt: result.closedAt,
        // The result type stays empty: no judgement, 판정 이의 or payout follows.
        resolvedResult: null,
        resolvedAt: null,
      });

      await waitForMessages(received, 1, 'market:status of the cancel');
      await sleep(100);
      // No order expired: no market:book.
      expect(received.map((m) => JSON.parse(m) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'cancelled',
          resolvedResult: null,
          statusEventId: String(event!.id),
          ts: result.closedAt.toISOString(),
        },
      ]);
    } finally {
      await quit();
    }
  });

  it('skips a market whose close time has not come (a stale delayed job after a supplement moved the close)', async () => {
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

  it('cancels a due PAUSED market nobody traded on, on schedule, and ends its pause at the close (#114, #20)', async () => {
    // ADR-0093 decision 1 #173 items 1·3: the close is not extended by the pause, and needs no
    // review or approval. A next-path request still waiting stays as it was — moot from now on.
    const closeAt = new Date(Date.now() + 3_000);
    const { market, pause } = await createPausedMarket(t.db, { closeAt });
    const waiting = await createPauseDecision(t.db, { marketId: market.id, path: 'resume' });
    await expect(closeMarket(t.db, market.id, publish)).resolves.toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'not_due',
    });
    expect(await pausesOf(market.id)).toEqual([pause]);
    await sleep(closeAt.getTime() - Date.now() + 50);

    const { received, quit } = await subscribeTo(market.id);
    try {
      const result = await closeMarket(t.db, market.id, publish);
      expect(result.outcome).toBe('cancelled');
      if (result.outcome !== 'cancelled') return;
      const event = (await eventsOf(market.id)).at(-1);
      expect(event).toMatchObject({
        id: result.statusEventId,
        type: 'cancelled',
        actorId: null,
        fromStatus: 'paused',
        toStatus: 'cancelled',
        // The worker's payload, a PAUSED market's too.
        payload: {
          cancelledAt: result.closedAt.toISOString(),
          source: 'job',
          reason: MARKET_NO_FILL_CANCEL_REASON,
        },
        createdAt: result.closedAt,
      });
      expect(await marketRow(market.id)).toMatchObject({
        status: 'cancelled',
        statusEventId: result.statusEventId,
        closeAt,
        updatedAt: result.closedAt,
      });
      // The pause ended at the close, in the same transaction: no approver, request or review.
      expect(await pausesOf(market.id)).toEqual([
        {
          ...pause,
          endKind: 'closed_at_close',
          endedAt: result.closedAt,
          endedBy: null,
          endEventId: result.statusEventId,
          endApprovalId: null,
          reviewResult: null,
        },
      ]);
      const [request] = await t.db
        .select()
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.id, waiting.id));
      expect(request).toEqual(waiting);

      await waitForMessages(received, 1, 'market:status of the close');
      expect(JSON.parse(received[0]!)).toEqual({
        type: 'market:status',
        marketId: market.id,
        status: 'cancelled',
        resolvedResult: null,
        statusEventId: String(result.statusEventId),
        ts: result.closedAt.toISOString(),
      });
    } finally {
      await quit();
    }
  });

  it('closes a due PAUSED market a person traded on before the pause, and ends its pause (#114)', async () => {
    const market = await tradedMarket(new Date(Date.now() + MINUTE_MS));
    const { pause } = await createMarketPause(t.db, { marketId: market.id });
    await passMarketClose(t.db, market.id);
    const { received, quit } = await subscribeTo(market.id);
    try {
      const result = await closeMarket(t.db, market.id, publish);
      if (result.outcome !== 'closed') throw new Error(`closed, got ${result.outcome}`);
      expect((await eventsOf(market.id)).at(-1)).toMatchObject({
        id: result.statusEventId,
        type: 'closed',
        actorId: null,
        fromStatus: 'paused',
        toStatus: 'closed',
        payload: { closedAt: result.closedAt.toISOString(), source: 'job' },
      });
      expect(await pausesOf(market.id)).toMatchObject([
        { id: pause.id, endKind: 'closed_at_close', endEventId: result.statusEventId },
      ]);
      await waitForMessages(received, 1, 'market:status of the close');
      expect(JSON.parse(received[0]!)).toMatchObject({ type: 'market:status', status: 'closed' });
    } finally {
      await quit();
    }
  });

  it('cancels a due PAUSED market written without a pause row, ending nothing', async () => {
    const market = await createMarket(t.db, {
      status: 'paused',
      closeAt: new Date(Date.now() - MINUTE_MS),
    });
    const result = await closeMarket(t.db, market.id, publish);
    expect(result).toMatchObject({ outcome: 'cancelled', marketId: market.id });
    expect(await eventsOf(market.id)).toMatchObject([
      {
        type: 'cancelled',
        fromStatus: 'paused',
        toStatus: 'cancelled',
        payload: { source: 'job' },
      },
    ]);
    expect(await pausesOf(market.id)).toEqual([]);
  });

  // Every status but `open` and `paused` (CLOSABLE_STATUSES).
  it.each(
    MARKET_STATUSES.filter((status) => !(CLOSABLE_STATUSES as readonly string[]).includes(status)),
  )('skips a %s market even when its close time has passed', async (status) => {
    const market = await createMarket(t.db, {
      status,
      closeAt: new Date(Date.now() - MINUTE_MS),
    });
    await expect(closeMarket(t.db, market.id, publish)).resolves.toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'not_open_or_paused',
    });
    expect((await marketRow(market.id)).status).toBe(status);
    expect(await eventsOf(market.id)).toEqual([]);
  });

  it('rejects an unknown market id instead of skipping it (a broken producer must be visible)', async () => {
    await expect(closeMarket(t.db, randomUUID(), publish)).rejects.toThrow(/not found/);
  });

  it('is idempotent: a second run (a duplicate job, or the scan after the delayed job) is a no-op', async () => {
    const market = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    const first = await closeMarket(t.db, market.id, publish);
    expect(first.outcome).toBe('cancelled');
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(closeMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_open_or_paused',
      });
      expect(await eventsOf(market.id)).toHaveLength(1);
      await sleep(100);
      expect(received).toEqual([]);
    } finally {
      await quit();
    }
  });

  it('scan closes every due open or paused market, oldest deadline first, and leaves the rest alone', async () => {
    const later = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    // The one a person traded on: CLOSED; the others nobody traded on: CANCELLED (#20).
    const earlier = await tradedMarket(new Date(Date.now() - 2 * MINUTE_MS));
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
    // Due as well, and closed on schedule while PAUSED (#114, ADR-0093 decision 1 #173 item 3),
    // in the deadline order with the rest: the earliest of all.
    const paused = await createMarket(t.db, {
      status: 'paused',
      closeAt: new Date(Date.now() - 3 * MINUTE_MS),
    });
    // And one still ahead stays PAUSED.
    const pausedAhead = await createMarket(t.db, {
      status: 'paused',
      closeAt: new Date(Date.now() + MINUTE_MS),
    });

    const subscribers = await Promise.all(
      [later, earlier, future, paused].map((m) => subscribeTo(m.id)),
    );
    try {
      await expect(closeDueMarkets(t.db, publish)).resolves.toEqual({
        closed: 1,
        cancelled: 2,
        skipped: 0,
        failed: 0,
        failures: [],
      });

      expect((await marketRow(earlier.id)).status).toBe('closed');
      expect((await marketRow(later.id)).status).toBe('cancelled');
      expect((await marketRow(paused.id)).status).toBe('cancelled');
      expect(await marketRow(future.id)).toMatchObject({ status: 'open', statusEventId: null });
      expect(await marketRow(pausedAhead.id)).toMatchObject({
        status: 'paused',
        statusEventId: null,
      });
      expect((await marketRow(alreadyClosed.id)).statusEventId).toBeNull();
      expect((await marketRow(draft.id)).status).toBe('draft');
      expect((await marketRow(scheduled.id)).status).toBe('scheduled');

      // Each close is its own transaction, in deadline order: the earlier deadline's event
      // has the smaller id.
      const [pausedEvent] = await eventsOf(paused.id);
      const earlierEvent = (await eventsOf(earlier.id)).at(-1);
      const [laterEvent] = await eventsOf(later.id);
      expect(pausedEvent).toMatchObject({ fromStatus: 'paused', toStatus: 'cancelled' });
      expect(earlierEvent).toMatchObject({ fromStatus: 'open', toStatus: 'closed' });
      expect(pausedEvent!.id).toBeLessThan(earlierEvent!.id);
      expect(earlierEvent!.id).toBeLessThan(laterEvent!.id);
      for (const left of [alreadyClosed, draft, scheduled, pausedAhead]) {
        expect(await eventsOf(left.id)).toEqual([]);
      }

      await waitForMessages(subscribers[0]!.received, 1, 'status of the later market');
      await waitForMessages(subscribers[1]!.received, 1, 'status of the earlier market');
      await waitForMessages(subscribers[3]!.received, 1, 'status of the paused market');
      await sleep(100);
      expect(subscribers[2]!.received).toEqual([]);

      // Nothing is due any more: the next minute's scan finds nothing.
      await expect(closeDueMarkets(t.db, publish)).resolves.toEqual({
        closed: 0,
        cancelled: 0,
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
    // keeps a finished close out of the failed set — a retry would find `cancelled` and never
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
      expect(result.outcome).toBe('cancelled');
      expect((await marketRow(market.id)).status).toBe('cancelled');
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

  describe('the expiry of the remaining orders (#120)', () => {
    let adminId: string;

    beforeEach(async () => {
      adminId = (await createUser(t.db, { role: 'admin' })).user.id;
      await openOrderIntake(t.db, { adminId });
    });

    const member = async (coin = 1_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
    // Opens a day ahead (the factory's default); the orders rest before `passMarketClose`.
    const openMarket = async () =>
      (
        await createConfiguredOpenMarket(t.db, {
          createdBy: adminId,
          liquiditySettings: TEST_MM_TRADING_LIQUIDITY,
        })
      ).id;
    async function placed(input: PlaceTestOrderInput) {
      const result = await placeTestOrder(t.db, input);
      if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
      return result.order;
    }
    const orderRow = async (id: string) =>
      (await t.db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0]!;
    const liveCount = async (marketId: string) =>
      (
        await t.db
          .select({ n: count() })
          .from(schema.orders)
          .where(
            and(
              eq(schema.orders.marketId, marketId),
              inArray(schema.orders.status, ['open', 'partially_filled']),
            ),
          )
      )[0]!.n;
    const coinOf = async (userId: string) => {
      const row = (await balanceOf(t.db, userId))!;
      return { available: row.availableCoin, locked: row.lockedCoin };
    };
    /** What an expiry never moves: the ledger, the fills and the market's contracts. */
    const books = async (marketId: string) => {
      const { yes, no, collateralCoin } = await contractBook(t.db, marketId);
      return {
        entries: (await t.db.select({ n: count() }).from(schema.ledgerEntries))[0]!.n,
        fills: (await t.db.select({ n: count() }).from(schema.fills))[0]!.n,
        supply: await ledgerSupply(t.db),
        contracts: { yes, no, collateralCoin },
      };
    };
    /**
     * Every `user:` room: the close sends nothing there but the inbox signal (#134, ADR-0158).
     * `onReceipt` runs the moment a message arrives (a read from another connection).
     */
    async function subscribeToUsers<T>(onReceipt?: (channel: string) => Promise<T>) {
      const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
      const received: { channel: string; event: unknown }[] = [];
      const seen: Promise<T>[] = [];
      subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
        received.push({ channel, event: JSON.parse(message) as unknown });
        if (onReceipt) seen.push(onReceipt(channel));
      });
      await subscriber.psubscribe(USER_CHANNEL_PATTERN);
      return { received, seen, quit: () => subscriber.quit() };
    }
    /** A member's `orders_expired` rows (#134): the close's notices. */
    const expiryNotices = (userId: string) =>
      t.db
        .select()
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.type, 'orders_expired'),
          ),
        );
    /** A member's #54 notices (ADR-0159): its `market` category rows. */
    const marketNotices = (userId: string) =>
      t.db
        .select()
        .from(schema.notifications)
        .where(
          and(eq(schema.notifications.userId, userId), eq(schema.notifications.category, 'market')),
        );
    /** Every notice of a member. */
    const noticesOf = (userId: string) =>
      t.db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    /** The signals by room, sorted: the publish order of several members is not a contract. */
    const byChannel = (received: { channel: string; event: unknown }[]) =>
      [...received].sort((x, y) => x.channel.localeCompare(y.channel));

    /**
     * A due OPEN market with three live orders of the three account kinds (the db suite's
     * construction): A's GTC NO buy 3 @ 40 partly filled (B's IOC YES buy took 1 by a pair mint),
     * C's GTC YES sell 2 @ 70 from minted pairs (a `positions.locked_qty`), and the 운영
     * 마켓메이커's GTC YES buy 2 @ 30 (a lock on the market's 마켓메이커 자금). The close is then
     * moved a minute back, the market still OPEN. Holders: A (1 NO), B (1 YES), C (3 YES) and D,
     * the other side of C's pairs (3 NO), with no order.
     */
    async function dueMarketWithOrders() {
      const marketId = await openMarket();
      const [a, b, c, d] = [await member(), await member(), await member(1_150n), await member()];
      await mintTestPairs(t.db, { marketId, yesHolderId: c, noHolderId: d, qty: 3 });
      const mm = await fundMarketMakerFunds(t.db, marketId, 1_000n);
      const partial = await placed({
        ownerId: a,
        marketId,
        outcome: 'NO',
        limitPriceCoin: 40,
        qty: 3,
      });
      await placed({ ownerId: b, marketId, timeInForce: 'ioc', limitPriceCoin: 65, qty: 1 });
      const sell = await placed({
        ownerId: c,
        marketId,
        side: 'sell',
        limitPriceCoin: 70,
        qty: 2,
      });
      const bot = await placed({ ownerId: mm, marketId, limitPriceCoin: 30, qty: 2 });
      const filled = await orderRow(partial.id);
      expect(filled).toMatchObject({ status: 'partially_filled', filledQty: 1 });
      await passMarketClose(t.db, marketId);
      return { marketId, a, b, c, d, mm, partial: filled, sell, bot };
    }

    it('expires every live order of every account type in the close, filled quantity kept, then publishes the status and one market:book', async () => {
      const due = await dueMarketWithOrders();
      const { marketId } = due;
      const before = await books(marketId);
      const bPosition = await positionOf(t.db, due.b, marketId, 'YES');
      // The fills the intake made before the close, as statistics (#121): the close keeps them.
      const stats = await marketStatsOf(t.db, marketId);
      expect(stats.tradeCount).toBeGreaterThan(0);
      const market = await subscribeTo(marketId);
      const users = await subscribeToUsers();
      try {
        const result = await closeMarket(t.db, marketId, publish);
        if (result.outcome !== 'closed') throw new Error(`closed, got ${result.outcome}`);
        expect(result).toEqual({
          outcome: 'closed',
          marketId,
          statusEventId: expect.any(Number) as unknown,
          closedAt: expect.any(Date) as unknown,
          expiredOrders: 3,
          heldOrders: 0,
          // A and C, the order owners; the 운영 마켓메이커 has no inbox (53-5). Never the holders
          // B and D, whom `market_closed` alone reached (#54: no watcher count, ADR-0064).
          notifiedMembers: 2,
        });
        // BullMQ stores the result as JSON: counts only, nothing a bigint or an owner id.
        expect(JSON.parse(JSON.stringify(result))).toEqual({
          ...result,
          closedAt: result.closedAt.toISOString(),
        });

        // Every expired row at the close's instant — the event's and the market row's.
        expect(await orderRow(due.partial.id)).toEqual({
          ...due.partial,
          status: 'expired',
          endedAt: result.closedAt,
          updatedAt: result.closedAt,
        });
        for (const id of [due.sell.id, due.bot.id]) {
          expect(await orderRow(id)).toMatchObject({
            status: 'expired',
            cancelReason: null,
            rejectReason: null,
            filledQty: 0,
            endedAt: result.closedAt,
          });
        }
        expect((await eventsOf(marketId)).at(-1)).toMatchObject({
          id: result.statusEventId,
          type: 'closed',
          payload: { closedAt: result.closedAt.toISOString(), source: 'job' },
          createdAt: result.closedAt,
        });
        expect(await marketRow(marketId)).toMatchObject({
          status: 'closed',
          statusEventId: result.statusEventId,
          updatedAt: result.closedAt,
        });
        // Every lock given back: A's remaining 2 × 40, C's 2 contracts, the 마켓메이커 자금's 60.
        expect(await liveCount(marketId)).toBe(0);
        expect(await coinOf(due.a)).toEqual({ available: 1_000n - 40n, locked: 0n });
        expect(await positionOf(t.db, due.c, marketId, 'YES')).toMatchObject({
          qty: 3,
          lockedQty: 0,
        });
        expect(
          await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId }),
        ).toMatchObject({ availableCoin: 1_000n, lockedCoin: 0n });
        expect(await positionOf(t.db, due.b, marketId, 'YES')).toEqual(bPosition);
        // No ledger entry, fill or contract move; every remaining lock is an order's.
        expect(await books(marketId)).toEqual(before);
        expect(await checkOrderInvariants(t.db)).toEqual([]);
        // No fill, so no statistic moved and no market:trade or market:tick (the list below).
        expect(await marketStatsOf(t.db, marketId)).toEqual(stats);

        await waitForMessages(market.received, 2, 'market:status and market:book of the close');
        await sleep(100);
        expect(market.received.map((m) => JSON.parse(m) as unknown)).toEqual([
          {
            type: 'market:status',
            marketId,
            status: 'closed',
            resolvedResult: null,
            statusEventId: String(result.statusEventId),
            ts: result.closedAt.toISOString(),
          },
          { type: 'market:book', marketId, ts: result.closedAt.toISOString() },
        ]);
        // No user:position or user:balance: the expiry follows #178's batch cancels (ADR-0113
        // 12-11, ADR-0115 결정 8), though C's sell lock moved; only a resting sell and an owner's
        // sell cancel send user:position (ADR-0112 결정 8, ADR-0113 결정 10). ADR-0112 10-10
        // covers balances only. The inbox signal goes one each at the close's instant to A and C,
        // whose orders it ended (#134, ADR-0158), and to the holders (#54, ADR-0159): B, whose IOC
        // order had ended at its intake, and D — A and C hold too, still one signal each. Never
        // to the bot.
        await waitForMessages(users.received, 4, 'user:notification of A, B, C and D');
        await sleep(100);
        const signal = { type: 'user:notification', ts: result.closedAt.toISOString() };
        expect(byChannel(users.received)).toEqual(
          byChannel(
            [due.a, due.b, due.c, due.d].map((id) => ({ channel: userChannel(id), event: signal })),
          ),
        );
        // 거래 마감: one notice each, leading to the one order it ended (52-4).
        for (const [owner, order] of [
          [due.a, due.partial.id],
          [due.c, due.sell.id],
        ] as const) {
          expect(await expiryNotices(owner)).toEqual([
            expect.objectContaining({
              params: expect.objectContaining({ cause: 'closed', orderCount: 1 }) as unknown,
              target: { kind: 'order', orderId: order },
              occurredAt: result.closedAt,
            }),
          ]);
        }
        // 거래 마감 to every holder, in the same call and under the same key (52-1·52-8, 53-4).
        const { title, slug } = await marketRow(marketId);
        for (const holder of [due.a, due.b, due.c, due.d]) {
          expect(await marketNotices(holder)).toEqual([
            expect.objectContaining({
              type: 'market_closed',
              category: 'market',
              params: { marketTitle: title, early: false },
              target: { kind: 'market', slug },
              occurredAt: result.closedAt,
            }),
          ]);
        }
        expect(await marketNotices(due.mm)).toEqual([]);
      } finally {
        await Promise.all([market.quit(), users.quit()]);
      }
    });

    it('publishes only after COMMIT: a subscriber that reads on receipt sees the orders expired', async () => {
      const due = await dueMarketWithOrders();
      const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
      const seen: Promise<{ type: string; statuses: string[] }>[] = [];
      subscriber.on('message', (_channel: string, message: string) => {
        const { type } = JSON.parse(message) as { type: string };
        // Read from another connection the moment the event arrives.
        seen.push(
          Promise.all([due.partial.id, due.sell.id, due.bot.id].map(orderRow)).then((rows) => ({
            type,
            statuses: rows.map((row) => row.status),
          })),
        );
      });
      await subscriber.subscribe(marketChannel(due.marketId));
      try {
        expect(await closeMarket(t.db, due.marketId, publish)).toMatchObject({
          outcome: 'closed',
          expiredOrders: 3,
        });
        await waitForMessages(seen, 2, 'both events');
        expect(await Promise.all(seen)).toEqual([
          { type: 'market:status', statuses: ['expired', 'expired', 'expired'] },
          { type: 'market:book', statuses: ['expired', 'expired', 'expired'] },
        ]);
      } finally {
        await subscriber.quit();
      }
    });

    it('says 시장 취소 when no person filled: one notice and one signal per member, after COMMIT, none for the bot (#134, #20, #54)', async () => {
      const marketId = await openMarket();
      const [a, b, w] = [await member(), await member(), await member()];
      // W only watches (#54): its notice is `market_cancelled`, and it is not an order owner.
      await createWatch(t.db, { userId: w, marketId });
      const mm = await fundMarketMakerFunds(t.db, marketId, 1_000n);
      // Nothing crosses (NO 40 + YES 30 < 100): no fill, so the close cancels the market.
      await placed({ ownerId: a, marketId, outcome: 'NO', limitPriceCoin: 40 });
      await placed({ ownerId: a, marketId, limitPriceCoin: 30 });
      const single = await placed({ ownerId: b, marketId, limitPriceCoin: 20 });
      await placed({ ownerId: mm, marketId, limitPriceCoin: 10 });
      await passMarketClose(t.db, marketId);
      const { title, slug } = await marketRow(marketId);
      // Read the recipient's notices from another connection the moment its signal arrives.
      const users = await subscribeToUsers(async (channel) => ({
        channel,
        notices: (await noticesOf(channel.slice('user:'.length))).length,
      }));
      try {
        const result = await closeMarket(t.db, marketId, publish);
        if (result.outcome !== 'cancelled') throw new Error(`cancelled, got ${result.outcome}`);
        // A and B, the order owners: the watcher W is never counted (ADR-0064, ADR-0159).
        expect(result).toMatchObject({ expiredOrders: 4, heldOrders: 0, notifiedMembers: 2 });
        expect(JSON.stringify(result)).not.toContain(w);

        await waitForMessages(users.received, 3, 'user:notification of A, B and W');
        await sleep(100);
        const signal = { type: 'user:notification', ts: result.closedAt.toISOString() };
        expect(byChannel(users.received)).toEqual(
          byChannel([a, b, w].map((id) => ({ channel: userChannel(id), event: signal }))),
        );
        // Each signal found its notice committed (ADR-0157 결정 8: after COMMIT, never inside).
        expect(
          (await Promise.all(users.seen)).sort((x, y) => x.channel.localeCompare(y.channel)),
        ).toEqual(
          [userChannel(a), userChannel(b), userChannel(w)]
            .sort((x, y) => x.localeCompare(y))
            .map((channel) => ({ channel, notices: 1 })),
        );
        // 52-5: the watcher's 시장 취소, never also a `market_closed` (ADR-0159).
        expect(await noticesOf(w)).toEqual([
          expect.objectContaining({
            type: 'market_cancelled',
            category: 'market',
            params: { marketTitle: title },
            target: { kind: 'market', slug },
            occurredAt: result.closedAt,
          }),
        ]);
        // The order owners hold nothing and do not watch: their order notice alone (52-1).
        expect(await marketNotices(a)).toEqual([]);
        expect(await marketNotices(b)).toEqual([]);
        // 52-4·52-5: 시장 취소; two orders lead to the market's history, one to the order.
        expect(await expiryNotices(a)).toEqual([
          expect.objectContaining({
            category: 'trade',
            params: { marketTitle: title, cause: 'cancelled', orderCount: 2 },
            target: { kind: 'order_history', marketId },
            mergeKey: null,
            eventCount: 1,
            occurredAt: result.closedAt,
            readAt: null,
          }),
        ]);
        expect(await expiryNotices(b)).toEqual([
          expect.objectContaining({
            params: { marketTitle: title, cause: 'cancelled', orderCount: 1 },
            target: { kind: 'order', orderId: single.id },
          }),
        ]);
        expect(await expiryNotices(mm)).toEqual([]);

        // A second run skips: no notice, no signal (nothing on a skip).
        const before = await t.db.select().from(schema.notifications);
        await expect(closeMarket(t.db, marketId, publish)).resolves.toMatchObject({
          outcome: 'skipped',
          reason: 'not_open_or_paused',
        });
        await sleep(100);
        expect(users.received).toHaveLength(3);
        expect(await t.db.select().from(schema.notifications)).toEqual(before);
      } finally {
        await users.quit();
      }
    });

    it('filters the close’s one call per notice by each member’s settings: 거래 off keeps 거래 마감, 시장 off keeps the expiry, and the count is of owners reached (#56, ADR-0162)', async () => {
      const due = await dueMarketWithOrders();
      const { marketId, a, b, c, d } = due;
      // A (order owner, NO holder): 거래 off. C (order owner, YES holder): 시장 off.
      expect(await setNotificationCategory(t.db, a, 'trade', false)).toEqual(['trade']);
      expect(await setNotificationCategory(t.db, c, 'market', false)).toEqual(['market']);
      const users = await subscribeToUsers();
      try {
        const result = await closeMarket(t.db, marketId, publish);
        if (result.outcome !== 'closed') throw new Error(`closed, got ${result.outcome}`);
        // Every order expired as always; only C's expiry notice reached anyone.
        expect(result).toMatchObject({ expiredOrders: 3, heldOrders: 0, notifiedMembers: 1 });
        expect((await orderRow(due.partial.id)).status).toBe('expired');
        expect((await orderRow(due.sell.id)).status).toBe('expired');
        // The close's notices: those at its instant (A's earlier fill notice is not one).
        const closeNotices = async (userId: string) =>
          (await noticesOf(userId))
            .filter((row) => row.occurredAt.getTime() === result.closedAt.getTime())
            .map((row) => row.type);
        expect(await closeNotices(a)).toEqual(['market_closed']);
        expect(await closeNotices(c)).toEqual(['orders_expired']);
        for (const holder of [b, d]) expect(await closeNotices(holder)).toEqual(['market_closed']);
        // One signal to each member something reached — all four here.
        await waitForMessages(users.received, 4, 'user:notification of A, B, C and D');
        await sleep(100);
        const signal = { type: 'user:notification', ts: result.closedAt.toISOString() };
        expect(byChannel(users.received)).toEqual(
          byChannel([a, b, c, d].map((id) => ({ channel: userChannel(id), event: signal }))),
        );
      } finally {
        await users.quit();
      }
    });

    it('expires the orders whatever order.accepting says (the close never reads the intake setting)', async () => {
      const marketId = await openMarket();
      const a = await member();
      const row = await placed({ ownerId: a, marketId, limitPriceCoin: 40, qty: 2 });
      await setReleaseSetting(t.db, {
        adminId,
        key: ORDER_ACCEPTING_SETTING.key,
        status: 'approved',
        value: false,
      });
      await passMarketClose(t.db, marketId);
      const result = await closeMarket(t.db, marketId, publish);
      // Resting, never filled: no trade, so the close cancels it (#20).
      expect(result).toMatchObject({ outcome: 'cancelled', expiredOrders: 1, heldOrders: 0 });
      expect(await orderRow(row.id)).toMatchObject({ status: 'expired', cancelReason: null });
      expect(await coinOf(a)).toEqual({ available: 1_000n, locked: 0n });
    });

    it("cancels a market with only the 운영 마켓메이커's resting orders while order.accepting is closed — the production effect of #20", async () => {
      // ADR-0107 결정 3 '주문 접수': while intake is closed nobody fills, so every market that
      // reaches its close is cancelled; the 마켓메이커's orders are not trading (결정 5 '#20·#120').
      const marketId = await openMarket();
      const mm = await fundMarketMakerFunds(t.db, marketId, 1_000n);
      const bot = await placed({ ownerId: mm, marketId, limitPriceCoin: 30, qty: 2 });
      const botNo = await placed({ ownerId: mm, marketId, outcome: 'NO', limitPriceCoin: 40 });
      await setReleaseSetting(t.db, {
        adminId,
        key: ORDER_ACCEPTING_SETTING.key,
        status: 'approved',
        value: false,
      });
      await passMarketClose(t.db, marketId);
      const before = await books(marketId);
      const stats = await marketStatsOf(t.db, marketId);
      const { received, quit } = await subscribeTo(marketId);
      try {
        const result = await closeMarket(t.db, marketId, publish);
        if (result.outcome !== 'cancelled') throw new Error(`cancelled, got ${result.outcome}`);
        // The 운영 마켓메이커 has no inbox: no notice, no signal (53-5).
        expect(result).toMatchObject({ expiredOrders: 2, heldOrders: 0, notifiedMembers: 0 });
        expect(await marketRow(marketId)).toMatchObject({
          status: 'cancelled',
          statusEventId: result.statusEventId,
          resolvedResult: null,
        });
        for (const id of [bot.id, botNo.id]) {
          expect(await orderRow(id)).toMatchObject({ status: 'expired', endedAt: result.closedAt });
        }
        // The 마켓메이커 자금 has its locks back and stays in the market's account (#181's).
        expect(
          await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId }),
        ).toMatchObject({ availableCoin: 1_000n, lockedCoin: 0n });
        expect(await books(marketId)).toEqual(before);
        expect(await marketStatsOf(t.db, marketId)).toEqual(stats);
        expect(await checkOrderInvariants(t.db)).toEqual([]);

        await waitForMessages(received, 2, 'market:status and market:book of the cancel');
        await sleep(100);
        expect(received.map((m) => JSON.parse(m) as unknown)).toEqual([
          {
            type: 'market:status',
            marketId,
            status: 'cancelled',
            resolvedResult: null,
            statusEventId: String(result.statusEventId),
            ts: result.closedAt.toISOString(),
          },
          { type: 'market:book', marketId, ts: result.closedAt.toISOString() },
        ]);
      } finally {
        await quit();
      }
    });

    it('skips a market whose close is ahead without touching its orders or publishing', async () => {
      const marketId = await openMarket();
      const a = await member();
      const row = await placed({ ownerId: a, marketId, limitPriceCoin: 40 });
      const { received, quit } = await subscribeTo(marketId);
      const users = await subscribeToUsers();
      try {
        await expect(closeMarket(t.db, marketId, publish)).resolves.toEqual({
          outcome: 'skipped',
          marketId,
          reason: 'not_due',
        });
        expect(await orderRow(row.id)).toEqual(row);
        expect(await coinOf(a)).toEqual({ available: 960n, locked: 40n });
        // No notice and no signal on a skip (#134).
        expect(await expiryNotices(a)).toEqual([]);
        await sleep(100);
        expect(received).toEqual([]);
        expect(users.received).toEqual([]);
      } finally {
        await Promise.all([quit(), users.quit()]);
      }
    });

    it('cancels a PAUSED market whose pause cancelled its orders: nothing to expire, no market:book', async () => {
      const marketId = await openMarket();
      const a = await member();
      const row = await placed({ ownerId: a, marketId, limitPriceCoin: 40 });
      await createMarketPause(t.db, { marketId, by: adminId });
      const cancelled = await orderRow(row.id);
      expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'paused' });
      await passMarketClose(t.db, marketId);
      const { received, quit } = await subscribeTo(marketId);
      try {
        const result = await closeMarket(t.db, marketId, publish);
        expect(result).toMatchObject({
          outcome: 'cancelled',
          expiredOrders: 0,
          heldOrders: 0,
          notifiedMembers: 0,
        });
        expect(await orderRow(row.id)).toEqual(cancelled);
        await waitForMessages(received, 1, 'market:status of the close');
        await sleep(100);
        expect(received.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual([
          'market:status',
        ]);
      } finally {
        await quit();
      }
    });

    it('cancels a ledger-held market on schedule and leaves its orders live and locked for #93, with no market:book', async () => {
      const marketId = await openMarket();
      const [a, w] = [await member(), await member()];
      await createWatch(t.db, { userId: w, marketId });
      const row = await placed({ ownerId: a, marketId, limitPriceCoin: 40, qty: 2 });
      await createMarketPause(t.db, { marketId, reason: 'ledger_failure', by: adminId });
      await passMarketClose(t.db, marketId);
      const { received, quit } = await subscribeTo(marketId);
      const users = await subscribeToUsers();
      try {
        const result = await closeMarket(t.db, marketId, publish);
        if (result.outcome !== 'cancelled') throw new Error(`cancelled, got ${result.outcome}`);
        // Nobody filled: CANCELLED, and still held (결정 4 #178 '복구 전에 마감이 오면'). The
        // live order ends at #93's recovery, which notifies its owner then (#134): nothing now.
        // The watcher hears of the close now (#54, 52-8) — and is not counted (ADR-0064).
        expect(result).toMatchObject({
          outcome: 'cancelled',
          expiredOrders: 0,
          heldOrders: 1,
          notifiedMembers: 0,
        });
        expect(await noticesOf(a)).toEqual([]);
        expect((await noticesOf(w)).map((notice) => notice.type)).toEqual(['market_cancelled']);
        expect(await marketRow(marketId)).toMatchObject({ status: 'cancelled' });
        expect(await pausesOf(marketId)).toMatchObject([
          { reason: 'ledger_failure', endKind: 'closed_at_close' },
        ]);
        expect(await orderRow(row.id)).toEqual(row);
        expect(await coinOf(a)).toEqual({ available: 920n, locked: 80n });
        await waitForMessages(received, 1, 'market:status of the close');
        await sleep(100);
        expect(received.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual([
          'market:status',
        ]);
        await waitForMessages(users.received, 1, 'user:notification of W');
        await sleep(100);
        expect(users.received).toEqual([
          {
            channel: userChannel(w),
            event: { type: 'user:notification', ts: result.closedAt.toISOString() },
          },
        ]);
      } finally {
        await Promise.all([quit(), users.quit()]);
      }
    });

    it('scan: each due market with orders publishes its own market:book once', async () => {
      const first = await openMarket();
      const second = await openMarket();
      const a = await member();
      for (const marketId of [first, second]) {
        await placed({ ownerId: a, marketId, limitPriceCoin: 40 });
        await placed({ ownerId: a, marketId, limitPriceCoin: 30 });
        await passMarketClose(t.db, marketId);
      }
      const subscribers = await Promise.all([first, second].map((id) => subscribeTo(id)));
      try {
        await expect(closeDueMarkets(t.db, publish)).resolves.toEqual({
          closed: 0,
          cancelled: 2,
          skipped: 0,
          failed: 0,
          failures: [],
        });
        for (const [i, marketId] of [first, second].entries()) {
          expect(await liveCount(marketId)).toBe(0);
          const { received } = subscribers[i]!;
          await waitForMessages(received, 2, `both events of market ${String(i)}`);
        }
        await sleep(100);
        for (const { received } of subscribers) {
          expect(received.map((m) => (JSON.parse(m) as { type: string }).type)).toEqual([
            'market:status',
            'market:book',
          ]);
        }
        expect(await coinOf(a)).toEqual({ available: 1_000n, locked: 0n });
      } finally {
        await Promise.all(subscribers.map((s) => s.quit()));
      }
    });

    it('keeps the expiry when every publish fails: the close committed, one warning per event', async () => {
      const marketId = await openMarket();
      const a = await member();
      const row = await placed({ ownerId: a, marketId, limitPriceCoin: 40 });
      // A watcher too: two members signalled for one event, still one line naming neither (#54).
      const w = await member();
      await createWatch(t.db, { userId: w, marketId });
      await passMarketClose(t.db, marketId);
      const dead = createPublisherRedis('redis://127.0.0.1:1', pino({ level: 'silent' }));
      const logs: unknown[] = [];
      const logger = pino(
        { level: 'warn' },
        { write: (line: string) => logs.push(JSON.parse(line)) },
      );
      try {
        const result = await closeMarket(t.db, marketId, createPublisher(dead, logger));
        expect(result).toMatchObject({
          outcome: 'cancelled',
          expiredOrders: 1,
          notifiedMembers: 1,
        });
        expect(await orderRow(row.id)).toMatchObject({ status: 'expired' });
        // The notice committed with the close; only its signal was lost (the REST read has it).
        expect(await expiryNotices(a)).toHaveLength(1);
        expect(logs).toMatchObject([
          {
            msg: 'realtime publish failed',
            channel: marketChannel(marketId),
            eventType: 'market:status',
          },
          {
            msg: 'realtime publish failed',
            channel: marketChannel(marketId),
            eventType: 'market:book',
          },
          {
            // A member's channel by its kind alone (#54, ADR-0159; ADR-0064).
            msg: 'realtime publish failed',
            channel: 'user',
            eventType: 'user:notification',
          },
        ]);
        for (const id of [a, w]) expect(JSON.stringify(logs)).not.toContain(id);
      } finally {
        dead.disconnect();
      }
    });
  });
});
