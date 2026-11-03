import { MARKET_STATUSES } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openScheduledMarket, type OpenScheduledMarketInput } from './market-open.js';
import { marketEvents, markets } from './schema/index.js';
import {
  createCategory,
  createMarket,
  createOpenedMarket,
  createScheduledMarket,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

const HOUR_MS = 60 * 60 * 1000;

/** Every status the open leaves alone, however due the market's times are. */
const NOT_SCHEDULED = MARKET_STATUSES.filter((status) => status !== 'scheduled');

type Opener = Pick<OpenScheduledMarketInput, 'actorId' | 'source'>;
const WORKER: Opener = { actorId: null, source: 'job' };

describe.skipIf(!hasTestDb())('openScheduledMarket (#21, docker test profile)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const eventsOf = (marketId: string) =>
    t.db
      .select()
      .from(marketEvents)
      .where(eq(marketEvents.marketId, marketId))
      .orderBy(asc(marketEvents.id));

  const rowOf = async (marketId: string) => {
    const [row] = await t.db.select().from(markets).where(eq(markets.id, marketId));
    return row!;
  };

  /**
   * As every caller opens: the market lock, the row FOR UPDATE after it, then `now` — the database
   * clock after the lock, unless a boundary case gives the instant itself.
   */
  function open(marketId: string, opener: Opener = WORKER, at?: Date) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const now = at ?? (await clockTimestamp(tx));
      return { now, result: await openScheduledMarket(tx, { market: market!, now, ...opener }) };
    });
  }

  it('opens a due SCHEDULED market as the worker, keyed and stamped at its instant', async () => {
    // The gap the submission stored stays as it is (ADR-0098 7-6).
    const { market: scheduled } = await createScheduledMarket(t.db, { leadCloseGapMinutes: 30 });
    const review = await eventsOf(scheduled.id);
    const { now, result } = await open(scheduled.id);
    expect(result.opened).toBe(true);
    if (!result.opened) return;
    const events = await eventsOf(scheduled.id);
    // The review's events untouched, and one more.
    expect(events.slice(0, -1)).toEqual(review);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        id: result.statusEventId,
        type: 'opened',
        actorId: null,
        fromStatus: 'scheduled',
        toStatus: 'open',
        payload: {
          openAt: now.toISOString(),
          closeAt: scheduled.closeAt.toISOString(),
          source: 'job',
        },
        createdAt: now,
      }),
    );
    // The row read back, and nothing in it changed but the open's four columns.
    const row = await rowOf(scheduled.id);
    expect(result.row).toEqual(row);
    expect(row).toEqual({
      ...scheduled,
      status: 'open',
      statusEventId: result.statusEventId,
      openAt: now,
      updatedAt: now,
    });
    expect(row.leadCloseGapMinutes).toBe(30);
  });

  it.each(['approval', 'reschedule'] as const)(
    'records the admin whose %s found the scheduled open come, with that source',
    async (source) => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const { market } = await createScheduledMarket(t.db);
      const { now, result } = await open(market.id, { actorId: admin.id, source });
      expect(result).toMatchObject({ opened: true, row: { status: 'open', openAt: now } });
      expect((await eventsOf(market.id)).at(-1)).toMatchObject({
        type: 'opened',
        actorId: admin.id,
        payload: { openAt: now.toISOString(), closeAt: market.closeAt.toISOString(), source },
        createdAt: now,
      });
    },
  );

  it('throws on an actor that does not match the source, writing nothing', async () => {
    // ADR-0095: a NULL actor is the worker, so the job has none and an admin's action has its own.
    const { user: admin } = await createUser(t.db, { role: 'admin' });
    const { market } = await createScheduledMarket(t.db);
    const review = await eventsOf(market.id);
    await expect(open(market.id, { actorId: admin.id, source: 'job' })).rejects.toThrow(
      'An open by job is recorded with no actor',
    );
    await expect(open(market.id, { actorId: null, source: 'approval' })).rejects.toThrow(
      'An open by approval is recorded with its admin',
    );
    expect(await eventsOf(market.id)).toEqual(review);
    expect(await rowOf(market.id)).toEqual(market);
  });

  it('skips a scheduled open still ahead, or unset, as not_due, writing nothing', async () => {
    const ahead = await createScheduledMarket(t.db, {
      scheduledOpenAt: new Date(Date.now() + HOUR_MS),
    });
    // No path leaves a SCHEDULED market without one; a row written so waits rather than opens.
    const unset = await createScheduledMarket(t.db, { scheduledOpenAt: null });
    for (const { market } of [ahead, unset]) {
      const review = await eventsOf(market.id);
      expect((await open(market.id)).result).toEqual({ opened: false, reason: 'not_due' });
      expect(await eventsOf(market.id)).toEqual(review);
      expect(await rowOf(market.id)).toEqual(market);
    }
  });

  it.each(NOT_SCHEDULED)(
    'skips a market in %s as not_scheduled, its scheduled open come and its close ahead',
    async (status) => {
      // createMarket's times: the scheduled open a minute ago, the close a week ahead.
      const market = await createMarket(t.db, { status });
      expect((await open(market.id)).result).toEqual({ opened: false, reason: 'not_scheduled' });
      expect(await eventsOf(market.id)).toEqual([]);
      expect(await rowOf(market.id)).toEqual(market);
    },
  );

  it('never opens one whose close has passed: close_passed, and it stays SCHEDULED', async () => {
    // Until an admin sends it back to a draft to fix its times (ADR-0093 decision 2 #172 item 6).
    const { market } = await createScheduledMarket(t.db, {
      closeAt: new Date(Date.now() - 60_000),
    });
    const review = await eventsOf(market.id);
    expect((await open(market.id)).result).toEqual({ opened: false, reason: 'close_passed' });
    expect(await eventsOf(market.id)).toEqual(review);
    expect(await rowOf(market.id)).toEqual(market);
  });

  it('opens at its scheduled open to the millisecond, and not a millisecond before', async () => {
    // An hour ahead of the database clock, so the open's instant follows the review's events.
    const at = new Date((await clockTimestamp(t.db)).getTime() + HOUR_MS + 123);
    const { market } = await createScheduledMarket(t.db, { scheduledOpenAt: at });
    expect((await open(market.id, WORKER, new Date(at.getTime() - 1))).result).toEqual({
      opened: false,
      reason: 'not_due',
    });
    expect((await open(market.id, WORKER, at)).result).toMatchObject({
      opened: true,
      row: { status: 'open', openAt: at, updatedAt: at },
    });
  });

  it('skips at its close to the millisecond, and opens a millisecond before it', async () => {
    const closeAt = new Date((await clockTimestamp(t.db)).getTime() + HOUR_MS + 456);
    const { market } = await createScheduledMarket(t.db, { closeAt });
    expect((await open(market.id, WORKER, closeAt)).result).toEqual({
      opened: false,
      reason: 'close_passed',
    });
    const before = new Date(closeAt.getTime() - 1);
    expect((await open(market.id, WORKER, before)).result).toMatchObject({
      opened: true,
      row: { status: 'open', openAt: before, closeAt },
    });
  });

  it('checks nothing else again: a hidden category, no tag, no rule, the lead close', async () => {
    // The approval was the last gate: a hidden category keeps its markets (ADR-0093 #172 item 1),
    // and the lead close is not judged again (ADR-0098 7-6) — here the close leads the announcement
    // by one minute against the 60 its submission stored.
    const hidden = await createCategory(t.db, { isActive: false });
    const closeAt = new Date(Date.now() + 7 * 24 * HOUR_MS);
    const { market } = await createScheduledMarket(t.db, {
      categoryId: hidden.id,
      tags: [],
      blankRuleItems: true,
      closeAt,
      scheduledAnnouncementAt: new Date(closeAt.getTime() + 60_000),
      leadCloseGapMinutes: 60,
    });
    expect((await open(market.id)).result).toMatchObject({
      opened: true,
      row: { status: 'open', categoryId: hidden.id, leadCloseGapMinutes: 60, yesCondition: '' },
    });
  });

  describe('createOpenedMarket', () => {
    it('writes the history of the review and the worker: submitted, approved, opened', async () => {
      const { market, request } = await createOpenedMarket(t.db);
      const events = await eventsOf(market.id);
      expect(events.map((event) => [event.type, event.fromStatus, event.toStatus])).toEqual([
        ['submitted', 'draft', 'review'],
        ['approved', 'review', 'scheduled'],
        ['opened', 'scheduled', 'open'],
      ]);
      const opened = events[2]!;
      expect(opened).toMatchObject({ actorId: null, payload: { source: 'job' } });
      expect(market).toMatchObject({
        status: 'open',
        statusEventId: opened.id,
        openAt: opened.createdAt,
        updatedAt: opened.createdAt,
      });
      expect(await rowOf(market.id)).toEqual(market);
      expect(request).toMatchObject({ status: 'approved', targetId: market.id });
    });

    it('throws with the reason when the market would not open', async () => {
      await expect(
        createOpenedMarket(t.db, { scheduledOpenAt: new Date(Date.now() + HOUR_MS) }),
      ).rejects.toThrow('createOpenedMarket: the market did not open (not_due)');
      await expect(
        createOpenedMarket(t.db, { closeAt: new Date(Date.now() - 60_000) }),
      ).rejects.toThrow('createOpenedMarket: the market did not open (close_passed)');
    });
  });
});
