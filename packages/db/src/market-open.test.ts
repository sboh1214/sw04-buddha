import {
  DEFAULT_JUDGEMENT_TIME_ZONE,
  MARKET_STATUSES,
  marketRuleContentSchema,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openScheduledMarket, type OpenScheduledMarketInput } from './market-open.js';
import { marketEvents, marketRuleVersions, markets } from './schema/index.js';
import {
  createCategory,
  createMarket,
  createOpenedMarket,
  createScheduledMarket,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import * as txClock from './tx-helpers.js';
import { prepareMarketMakerOpening } from './test/ledger.js';
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

  /** A market's rule versions (#80), v1 first. */
  const versionsOf = (marketId: string) =>
    t.db
      .select()
      .from(marketRuleVersions)
      .where(eq(marketRuleVersions.marketId, marketId))
      .orderBy(asc(marketRuleVersions.version));

  /**
   * As every caller opens: the market lock, the row FOR UPDATE after it, then `now` — the database
   * clock after the lock, unless a boundary case gives the instant itself.
   */
  async function open(marketId: string, opener: Opener = WORKER, at?: Date) {
    const initial = await rowOf(marketId);
    if (initial.status === 'scheduled' && initial.currentLiquidityVersion !== null)
      await prepareMarketMakerOpening(t.db, marketId);
    // Boundary examples fix every application DB-clock read, including the new final asset wait;
    // ordinary cases below use real Postgres time and assert the actual open is no earlier.
    const clock = at ? vi.spyOn(txClock, 'clockTimestamp').mockResolvedValue(at) : null;
    try {
      return await t.db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        const [market] = await tx
          .select()
          .from(markets)
          .where(eq(markets.id, marketId))
          .for('update');
        const now = at ?? (await clockTimestamp(tx));
        const result = await openScheduledMarket(tx, { market: market!, now, ...opener });
        if (result.opened)
          expect(result.row.openAt!.getTime()).toBeGreaterThanOrEqual(now.getTime());
        return { now: result.opened ? result.row.openAt! : now, result };
      });
    } finally {
      clock?.mockRestore();
    }
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
    // The row read back, including the private liquidity version pinned by the open.
    const row = await rowOf(scheduled.id);
    expect(result.row).toEqual(row);
    expect(row).toEqual({
      ...scheduled,
      status: 'open',
      statusEventId: result.statusEventId,
      openAt: now,
      updatedAt: now,
      ruleVersion: 1,
      openedLiquidityVersion: 1,
    });
    expect(row.leadCloseGapMinutes).toBe(30);
  });

  it('records rule v1 in the open: the content the review locked, by the worker, at the open', async () => {
    // #80, ADR-0101 (ADR-0093 decision 2 #172 item 6): the full text of the version items, read
    // back from the row and its sources, made by no one (the job) at the open's instant.
    const fallbackSources = [
      { name: '대체 하나', url: 'https://example.org/1' },
      { name: '대체 둘', url: 'https://example.org/2' },
    ];
    const { market: scheduled } = await createScheduledMarket(t.db, { fallbackSources });
    expect(scheduled.ruleVersion).toBeNull();
    expect(await versionsOf(scheduled.id)).toEqual([]);
    const { now, result } = await open(scheduled.id);
    expect(result).toMatchObject({ opened: true, ruleVersion: 1, row: { ruleVersion: 1 } });
    const [v1, ...more] = await versionsOf(scheduled.id);
    expect(more).toEqual([]);
    expect(v1).toEqual({
      marketId: scheduled.id,
      version: 1,
      content: {
        title: scheduled.title,
        description: scheduled.description,
        yesCondition: scheduled.yesCondition,
        noCondition: scheduled.noCondition,
        eventDeadline: scheduled.eventDeadline!.toISOString(),
        primarySource: {
          name: expect.stringMatching(/^테스트 출처 /) as unknown,
          url: 'https://example.com/source',
        },
        fallbackSources,
        fallbackCondition: scheduled.fallbackCondition,
        longDelayDays: 14,
        delayHandling: scheduled.delayHandling,
        scheduledOpenAt: scheduled.scheduledOpenAt!.toISOString(),
        closeAt: scheduled.closeAt.toISOString(),
        scheduledAnnouncementAt: null,
        scheduledJudgementAt: scheduled.scheduledJudgementAt!.toISOString(),
        judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
      },
      changedItems: [],
      reason: null,
      settlementImpact: null,
      approvalId: null,
      requestedBy: null,
      createdBy: null,
      createdAt: now,
    });
    // The shape the API answers it in, as stored.
    expect(marketRuleContentSchema.parse(v1!.content)).toEqual(v1!.content);
    // The `opened` event is its record: no event of its own (the review's two and the open).
    expect((await eventsOf(scheduled.id)).map((event) => event.type)).toEqual([
      'submitted',
      'approved',
      'opened',
    ]);
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
      // That admin made v1 (#80), at the open.
      expect(await versionsOf(market.id)).toMatchObject([
        { version: 1, createdBy: admin.id, createdAt: now, approvalId: null, requestedBy: null },
      ]);
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
    expect(await versionsOf(market.id)).toEqual([]);
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
      expect(await versionsOf(market.id)).toEqual([]);
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
      expect(await versionsOf(market.id)).toEqual([]);
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
    expect(await versionsOf(market.id)).toEqual([]);
  });

  it('writes no second v1: a second run is not_scheduled, and the open is one transaction', async () => {
    // #80: v1 is written after the transition, in the opened branch alone, so a repeat finds the
    // market OPEN and writes nothing — not a second version, nor a primary-key failure.
    const { market } = await createScheduledMarket(t.db);
    const first = await open(market.id);
    expect(first.result.opened).toBe(true);
    const opened = await rowOf(market.id);
    const versions = await versionsOf(market.id);
    expect((await open(market.id)).result).toEqual({ opened: false, reason: 'not_scheduled' });
    expect(await rowOf(market.id)).toEqual(opened);
    expect(await versionsOf(market.id)).toEqual(versions);
    expect(versions.map((version) => version.version)).toEqual([1]);

    // A v1 that cannot be written takes the open with it: here a stray version row, which only a
    // writer outside the open could leave, makes the insert fail (23505) — the market stays
    // SCHEDULED with no `opened` event and no version of its own.
    const { market: other } = await createScheduledMarket(t.db);
    await t.db.insert(marketRuleVersions).values({ ...versions[0]!, marketId: other.id });
    const review = await eventsOf(other.id);
    await expect(open(other.id)).rejects.toSatisfy(
      (error) => (error as { cause?: { code?: string } }).cause?.code === '23505',
    );
    expect(await rowOf(other.id)).toEqual(other);
    expect(await eventsOf(other.id)).toEqual(review);
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
      ruleVersion: 1,
    });
    // And v1 keeps the blanks as they are (#80): the content of a market with no rule written.
    const [v1] = await versionsOf(market.id);
    expect(v1?.content).toMatchObject({
      description: null,
      yesCondition: '',
      noCondition: '',
      eventDeadline: null,
      primarySource: null,
      fallbackSources: [],
      fallbackCondition: '',
      longDelayDays: null,
      delayHandling: '',
      scheduledAnnouncementAt: new Date(closeAt.getTime() + 60_000).toISOString(),
    });
    expect(marketRuleContentSchema.safeParse(v1?.content).success).toBe(true);
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
      // And rule v1 (#80): the market at version 1, its row made by no one at the open.
      expect(market.ruleVersion).toBe(1);
      expect(await versionsOf(market.id)).toMatchObject([
        { version: 1, createdBy: null, createdAt: opened.createdAt, changedItems: [] },
      ]);
    });

    it('throws with the reason when the market would not open', async () => {
      await expect(
        createOpenedMarket(t.db, { scheduledOpenAt: new Date(Date.now() + HOUR_MS) }),
      ).rejects.toThrow('createOpenedMarket: the market did not open (not_due)');
      await expect(
        createOpenedMarket(t.db, { closeAt: new Date(Date.now() - 60_000) }),
      ).rejects.toThrow('createOpenedMarket: the market did not open (close_passed)');
      expect(await t.db.select().from(marketRuleVersions)).toEqual([]);
    });
  });
});
