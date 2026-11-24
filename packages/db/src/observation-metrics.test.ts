import {
  OBSERVATION_METRICS,
  OBSERVATION_WEEKS_SHOWN,
  OBSERVATION_WINDOW_MS,
  POSITION_SETTLEMENTS_SINCE,
  kstDateOf,
  kstDatePlusDays,
  kstStartOfDate,
  kstWeekStartOf,
  nearestPercentile,
  observationWeekFlags,
  observationWeeks,
  type AdminObservationMetrics,
} from '@buddha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settleMarketPositions } from './market-settlement.js';
import { observationWeekSql, readObservationMetrics } from './observation-metrics.js';
import {
  adminActions,
  marketVisitCollection,
  marketVisits,
  marketWatchEvents,
  marketWatches,
  markets,
  postComments,
  posts,
  reports,
  user,
} from './schema/index.js';
import {
  closeAccount,
  completeOnboarding,
  createComment,
  createMarket,
  createMarketMakerAccount,
  createNotice,
  createPost,
  createReport,
  createSettlementRecord,
  createUser,
  createWatch,
  createCorrectedMarket,
  createProvisionalMarket,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { fundMarketMakerFunds, mintTestPairs } from './test/ledger.js';
import {
  actionReportsAt,
  classifyFill,
  createAdminAt,
  dismissReportsAt,
  grantAdminAt,
  revokeAdminAt,
  settleMarketAt,
} from './test/observation.js';
import { createFillRecord, createOrder } from './test/orders.js';
import { createVisit, recordVisitPurge, setVisitCollectionStart } from './test/visits.js';
import { clockTimestamp } from './tx-helpers.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

describe.skipIf(!hasTestDb())('관측 지표 reader (#96, ADR-0169; integration)', () => {
  let t: TestDb;
  /**
   * The case's base: a KST Monday 00:00 two weeks after the database clock, so every event lies
   * after the earliest account (the data start) and reads pass a later `asOf`.
   */
  let base: Date;
  const at = (ms: number) => new Date(base.getTime() + ms);
  const weekOf = (instant: Date) => kstDateOf(kstWeekStartOf(instant));
  /** The default reading instant: the fifth week after `base`, past every 168-hour window. */
  const later = () => at(4 * WEEK_MS + 2 * DAY_MS);
  const read = (asOf: Date = later()) => readObservationMetrics(t.db, { asOf });
  type Metric = (typeof OBSERVATION_METRICS)[number];
  function rowOf<M extends Metric>(
    answer: AdminObservationMetrics,
    metric: M,
    instant: Date,
  ): AdminObservationMetrics[M][number] {
    const row = answer[metric].find((week) => week.week === weekOf(instant));
    if (!row) throw new Error(`no ${metric} row for ${weekOf(instant)}`);
    return row;
  }

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    const now = await clockTimestamp(t.db);
    base = new Date(kstWeekStartOf(now).getTime() + 2 * WEEK_MS);
  });

  const member = async () => (await createUser(t.db)).user.id;
  /** A member whose onboarding finished at `startedAt` (the 첫 체결 전환 start). */
  async function onboarded(startedAt: Date): Promise<string> {
    const id = await member();
    await completeOnboarding(t.db, { userId: id, nicknameConfirmedAt: startedAt });
    return id;
  }
  const openMarket = async () => (await createMarket(t.db)).id;
  /** One fill between two owners at `createdAt` (the incoming order's owner first). */
  async function fill(marketId: string, incoming: string, resting: string, createdAt: Date) {
    return (
      await createFillRecord(t.db, {
        marketId,
        incomingOwnerId: incoming,
        restingOwnerId: resting,
        createdAt,
      })
    ).fill;
  }

  describe('weeks, 진행 중 and 자료 없음', () => {
    it('buckets in SQL exactly as kstWeekStartOf (Sunday/Monday KST, the year end)', async () => {
      const instants = [
        '2026-11-29T14:59:59.999Z', // Sun 23:59:59.999 KST → Mon 11-23
        '2026-11-29T15:00:00.000Z', // Mon 00:00:00.000 KST → Mon 11-30
        '2027-01-03T12:00:00.000Z', // Sun 2027-01-03 KST → Mon 2026-12-28
        '2026-12-27T15:00:00.000Z', // Mon 2026-12-28 00:00 KST
        '2027-01-04T14:59:59.999Z', // Mon 2027-01-04 23:59 KST
      ].map((iso) => new Date(iso));
      for (const instant of instants) {
        const { rows } = await t.db.execute<{ week: string; day: string }>(
          sql`SELECT ${observationWeekSql(sql`${instant.toISOString()}::timestamptz`)} AS week,
                     to_char((${instant.toISOString()}::timestamptz AT TIME ZONE 'Asia/Seoul')::date,
                             'YYYY-MM-DD') AS day`,
        );
        expect(rows[0]!.week, instant.toISOString()).toBe(weekOf(instant));
        // The visit-based cohorts' D (#151): the start's Korean date, as kstDateOf.
        expect(rows[0]!.day, instant.toISOString()).toBe(kstDateOf(instant));
      }
      expect(kstDateOf(new Date('2026-11-29T14:59:59.999Z'))).toBe('2026-11-29');
      expect(kstDateOf(new Date('2026-11-29T15:00:00.000Z'))).toBe('2026-11-30');
      expect(weekOf(new Date('2027-01-03T12:00:00.000Z'))).toBe('2026-12-28');
      expect(weekOf(new Date('2026-11-29T14:59:59.999Z'))).toBe('2026-11-23');
    });

    it('answers 12 weeks newest first, zero-filled, with the 진행 중 rules', async () => {
      await member();
      const asOf = later();
      const answer = await read(asOf);
      expect(answer.asOf).toBe(asOf.toISOString());
      // No collection start after the reset, and no purge: no visit cut (#151).
      expect(answer).toMatchObject({ visitsSince: null, visitsPurgedThrough: null });
      for (const metric of OBSERVATION_METRICS) {
        const rows = answer[metric];
        expect(rows).toHaveLength(OBSERVATION_WEEKS_SHOWN);
        expect(rows[0]!.week).toBe(weekOf(asOf));
        for (let index = 1; index < rows.length; index += 1) {
          expect(rows[index]!.week < rows[index - 1]!.week).toBe(true);
        }
        const progress = rows.map((row) => row.inProgress);
        const cohort = metric !== 'discussion' && metric !== 'reportHandling';
        expect(progress.slice(0, 3)).toEqual(cohort ? [true, true, false] : [true, false, false]);
      }
      expect(answer.firstFill[4]).toMatchObject({ accounts: 0, filled: 0, noData: false });
      expect(answer.reportHandling[4]).toMatchObject({
        cases: 0,
        medianMs: null,
        p90Ms: null,
        pendingTargets: 0,
      });
      expect(answer.pendingTargetsEarlier).toBe(0);
      expect(answer.revisit[4]).toMatchObject({ pairs: 0, revisited: 0, noData: false });
      expect(answer.resultView[4]).toMatchObject({ pairs: 0, viewed: 0, noData: false });
    });

    it('is 자료 없음 for weeks ending at or before the earliest account, never 진행 중', async () => {
      const first = await member();
      const [created] = await t.db
        .select({ at: user.createdAt })
        .from(user)
        .where(eq(user.id, first));
      // Read right after the account: its week and the one before are the two newest.
      const asOf = new Date(created!.at.getTime() + 1);
      const answer = await read(asOf);
      expect(answer.dataStart).toBe(created!.at.toISOString());
      const weekStart = kstWeekStartOf(created!.at);
      for (const metric of ['firstFill', 'discussion', 'revisit', 'resultView'] as const) {
        expect(answer[metric][0]).toMatchObject({ noData: false, inProgress: true });
        expect(answer[metric][1]).toMatchObject({ noData: true, inProgress: false });
        expect(answer[metric].slice(1).every((row) => row.noData)).toBe(true);
      }
      expect(answer.firstFill[0]!.week).toBe(kstDateOf(weekStart));
    });

    it('is 자료 없음 everywhere on an empty database, with no data start', async () => {
      const answer = await read();
      expect(answer.dataStart).toBeNull();
      for (const metric of OBSERVATION_METRICS) {
        expect(answer[metric].every((row) => row.noData && !row.inProgress)).toBe(true);
      }
    });

    it('cuts 정산 후 재참여 alone before 0064 was deployed (96-11)', async () => {
      const id = await member();
      await t.db
        .update(user)
        .set({ createdAt: new Date('2026-09-01T00:00:00.000Z') })
        .where(eq(user.id, id));
      const answer = await read(new Date('2026-11-20T03:00:00.000Z'));
      const cut = kstWeekStartOf(POSITION_SETTLEMENTS_SINCE);
      const after = answer.afterSettlement;
      // The week holding the deploy starts before it: 자료 없음 too.
      expect(after.find((row) => row.week === kstDateOf(cut))).toMatchObject({ noData: true });
      expect(
        after.find((row) => row.week === kstDateOf(new Date(cut.getTime() + WEEK_MS))),
      ).toMatchObject({ noData: false, inProgress: true });
      expect(after.filter((row) => !row.noData)).toHaveLength(1);
      expect(answer.firstFill.filter((row) => !row.noData).length).toBeGreaterThan(5);
    });

    it('defaults asOf to the transaction clock', async () => {
      await member();
      const before = await clockTimestamp(t.db);
      const answer = await readObservationMetrics(t.db);
      const asOf = new Date(answer.asOf).getTime();
      expect(asOf).toBeGreaterThanOrEqual(before.getTime() - 1);
      expect(asOf).toBeLessThanOrEqual(Date.now() + 1_000);
    });
  });

  describe('첫 체결 전환 (96-1)', () => {
    it('counts a fill up to 168 hours after onboarding, to the millisecond', async () => {
      const market = await openMarket();
      const start = at(HOUR_MS);
      const inside = await onboarded(start);
      const outside = await onboarded(start);
      const other = await member();
      await fill(market, inside, other, new Date(start.getTime() + OBSERVATION_WINDOW_MS - 1));
      await fill(market, outside, other, new Date(start.getTime() + OBSERVATION_WINDOW_MS));
      expect(rowOf(await read(), 'firstFill', start)).toMatchObject({ accounts: 2, filled: 1 });
    });

    it('does not count orders without a fill (AC 2)', async () => {
      const market = await openMarket();
      const start = at(HOUR_MS);
      const id = await onboarded(start);
      const placed = new Date(start.getTime() + HOUR_MS);
      await createOrder(t.db, { marketId: market, userId: id, createdAt: placed });
      await createOrder(t.db, {
        marketId: market,
        userId: id,
        status: 'cancelled',
        createdAt: placed,
      });
      await createOrder(t.db, {
        marketId: market,
        userId: id,
        timeInForce: 'ioc',
        createdAt: placed,
      });
      expect(rowOf(await read(), 'firstFill', start)).toMatchObject({ accounts: 1, filled: 0 });
    });

    it('counts a fill against the bot for the person, never the bot (95-2)', async () => {
      const market = await openMarket();
      const bot = await createMarketMakerAccount(t.db);
      const start = at(HOUR_MS);
      const incoming = await onboarded(start);
      const resting = await onboarded(start);
      await fill(market, incoming, bot, at(2 * HOUR_MS));
      await fill(market, bot, resting, at(3 * HOUR_MS));
      expect(rowOf(await read(), 'firstFill', start)).toMatchObject({ accounts: 2, filled: 2 });
    });

    it('drops a marked sole fill and counts it again once cleared, in the past week', async () => {
      const asker = await createAdminAt(t.db, { at: at(-2 * HOUR_MS) });
      const decider = await createAdminAt(t.db, { at: at(-HOUR_MS) });
      const market = await openMarket();
      const start = at(HOUR_MS);
      const id = await onboarded(start);
      const { id: fillId } = await fill(market, id, await member(), at(2 * HOUR_MS));
      const classify = (action: 'mark' | 'clear') =>
        classifyFill(t.db, {
          fillId,
          marketId: market,
          action,
          askerId: asker,
          deciderId: decider,
        });
      await classify('mark');
      expect(rowOf(await read(), 'firstFill', start)).toMatchObject({ accounts: 1, filled: 0 });
      await classify('clear');
      expect(rowOf(await read(), 'firstFill', start)).toMatchObject({ accounts: 1, filled: 1 });
    });

    it('drops fills while admin and accounts admin at the start (95-1, 결정 8의 1·10)', async () => {
      const market = await openMarket();
      const other = await member();
      const start = at(DAY_MS);
      // Admin while filling: the member's fill, then the role records around it.
      const duringFill = await onboarded(start);
      const fillAt = at(2 * DAY_MS);
      await fill(market, duringFill, other, fillAt);
      // Admin only after its fill: in the cohort, the fill counts.
      const grantedLater = await onboarded(start);
      await fill(market, grantedLater, other, at(DAY_MS + HOUR_MS));
      // Seed-shaped admin: granted, then onboarded — out of the cohort.
      const seeded = await member();
      await completeOnboarding(t.db, { userId: seeded, nicknameConfirmedAt: start });
      await grantAdminAt(t.db, seeded, at(DAY_MS - HOUR_MS));
      await grantAdminAt(t.db, grantedLater, at(DAY_MS + 2 * HOUR_MS));
      await grantAdminAt(t.db, duringFill, new Date(fillAt.getTime() - HOUR_MS));
      await revokeAdminAt(t.db, duringFill, new Date(fillAt.getTime() + HOUR_MS));
      expect(rowOf(await read(), 'firstFill', start)).toMatchObject({ accounts: 2, filled: 1 });
    });

    it('keeps a closed account, counts one intake once and buckets by the KST week', async () => {
      const market = await openMarket();
      const other = await member();
      const sunday = at(WEEK_MS - 1);
      const monday = at(WEEK_MS);
      const closed = await onboarded(sunday);
      await fill(market, closed, other, at(WEEK_MS + HOUR_MS));
      await closeAccount(t.db, closed);
      const twice = await onboarded(monday);
      const intake = at(WEEK_MS + 2 * HOUR_MS);
      await fill(market, twice, other, intake);
      await fill(market, twice, other, intake);
      const answer = await read();
      expect(rowOf(answer, 'firstFill', sunday)).toMatchObject({ accounts: 1, filled: 1 });
      expect(rowOf(answer, 'firstFill', monday)).toMatchObject({ accounts: 1, filled: 1 });
      expect(rowOf(answer, 'firstFill', at(2 * WEEK_MS))).toMatchObject({
        accounts: 0,
        filled: 0,
      });
    });

    it('reads nothing after asOf: an onboarding or a fill', async () => {
      const market = await openMarket();
      const start = at(HOUR_MS);
      const asOf = at(DAY_MS);
      const id = await onboarded(start);
      await fill(market, id, await member(), new Date(asOf.getTime() + 1));
      await onboarded(new Date(asOf.getTime() + 1));
      await onboarded(asOf);
      const row = rowOf(await read(asOf), 'firstFill', start);
      expect(row).toMatchObject({ accounts: 1, filled: 0, inProgress: true });
      expect(rowOf(await read(), 'firstFill', start)).toMatchObject({ accounts: 3, filled: 1 });
    });
  });

  describe('정산 후 재참여 (96-2)', () => {
    /**
     * A SETTLING market with `holder`'s fill in it and its losing holding's settlement record
     * (payout 0), then SETTLED at `settledAt`.
     */
    async function zeroPayout(holder: string, settledAt: Date, input: { resolvedAt?: Date } = {}) {
      const market = (
        await createMarket(t.db, {
          status: 'settling',
          resolvedResult: 'YES',
          ...(input.resolvedAt ? { resolvedAt: input.resolvedAt } : {}),
        })
      ).id;
      const fillRow = await fill(market, holder, await member(), at(-HOUR_MS));
      await createSettlementRecord(t.db, {
        marketId: market,
        userId: holder,
        outcome: 'NO',
        qty: 1,
      });
      await settleMarketAt(t.db, market, settledAt);
      return { market, fillId: fillRow.id };
    }

    it('counts a YES and NO holder once, VOID included, never the bot (real settlement)', async () => {
      const market = await createMarket(t.db, { status: 'settling', resolvedResult: 'VOID' });
      const both = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
      const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
      const bot = await fundMarketMakerFunds(t.db, market.id, 1_000n);
      await mintTestPairs(t.db, {
        marketId: market.id,
        yesHolderId: both,
        noHolderId: bot,
        qty: 2,
      });
      await mintTestPairs(t.db, {
        marketId: market.id,
        yesHolderId: yes,
        noHolderId: both,
        qty: 1,
      });
      await t.db.transaction((tx) => settleMarketPositions(tx, market.id));
      const settledAt = at(DAY_MS);
      await settleMarketAt(t.db, market.id, settledAt);
      const elsewhere = await openMarket();
      // At the payout instant itself in another market: returned; at +168h: not.
      await fill(elsewhere, yes, await member(), settledAt);
      await fill(
        elsewhere,
        both,
        await member(),
        new Date(settledAt.getTime() + OBSERVATION_WINDOW_MS),
      );
      await fill(elsewhere, bot, await member(), at(DAY_MS + HOUR_MS));
      expect(rowOf(await read(), 'afterSettlement', settledAt)).toMatchObject({
        pairs: 2,
        returned: 1,
      });
    });

    it('counts zero payouts in the payout week, not the result week', async () => {
      const holder = await member();
      const settledAt = at(WEEK_MS + HOUR_MS);
      await zeroPayout(holder, settledAt, { resolvedAt: at(WEEK_MS - HOUR_MS) });
      await fill(await openMarket(), holder, await member(), at(WEEK_MS + 2 * DAY_MS));
      const answer = await read();
      expect(rowOf(answer, 'afterSettlement', settledAt)).toMatchObject({ pairs: 1, returned: 1 });
      expect(rowOf(answer, 'afterSettlement', at(0))).toMatchObject({ pairs: 0, returned: 0 });
    });

    it('drops a pair whose every fill there is marked, and brings it back on a clear (95-3)', async () => {
      const asker = await createAdminAt(t.db, { at: at(-3 * HOUR_MS) });
      const decider = await createAdminAt(t.db, { at: at(-2 * HOUR_MS) });
      const holder = await member();
      const settledAt = at(DAY_MS);
      const { market, fillId: firstId } = await zeroPayout(holder, settledAt);
      const { id: secondId } = await fill(market, await member(), holder, at(-HOUR_MS));
      const classify = (fillId: number, action: 'mark' | 'clear') =>
        classifyFill(t.db, {
          fillId,
          marketId: market,
          action,
          askerId: asker,
          deciderId: decider,
        });
      await classify(firstId, 'mark');
      expect(rowOf(await read(), 'afterSettlement', settledAt)).toMatchObject({ pairs: 1 });
      await classify(secondId, 'mark');
      expect(rowOf(await read(), 'afterSettlement', settledAt)).toMatchObject({ pairs: 0 });
      await classify(firstId, 'clear');
      expect(rowOf(await read(), 'afterSettlement', settledAt)).toMatchObject({ pairs: 1 });
    });

    it('drops an account admin at the payout, and markets not SETTLED or after asOf', async () => {
      const admin = await member();
      const settledAt = at(DAY_MS);
      await zeroPayout(admin, settledAt);
      // A SETTLING market with records and a time but not SETTLED; a CANCELLED one likewise.
      const settling = await member();
      const pending = (await createMarket(t.db, { status: 'settling', resolvedResult: 'YES' })).id;
      await fill(pending, settling, await member(), at(-HOUR_MS));
      await createSettlementRecord(t.db, {
        marketId: pending,
        userId: settling,
        outcome: 'NO',
        qty: 1,
      });
      await t.db.update(markets).set({ settledAt }).where(eq(markets.id, pending));
      const cancelled = (await createMarket(t.db, { status: 'settling', resolvedResult: 'YES' }))
        .id;
      const cancelledHolder = await member();
      await fill(cancelled, cancelledHolder, await member(), at(-HOUR_MS));
      await createSettlementRecord(t.db, {
        marketId: cancelled,
        userId: cancelledHolder,
        outcome: 'NO',
        qty: 1,
      });
      await t.db
        .update(markets)
        .set({ status: 'cancelled', settledAt })
        .where(eq(markets.id, cancelled));
      // Sold out before the payout: a fill there and no record.
      const soldOut = await member();
      const { market } = await zeroPayout(await member(), settledAt);
      await fill(market, soldOut, await member(), at(-HOUR_MS));
      // Paid out after the read's instant.
      const asOf = at(3 * DAY_MS);
      await zeroPayout(await member(), new Date(asOf.getTime() + 1));
      await grantAdminAt(t.db, admin, new Date(settledAt.getTime() - HOUR_MS));
      expect(rowOf(await read(asOf), 'afterSettlement', settledAt)).toMatchObject({
        pairs: 1,
        returned: 0,
      });
    });
  });

  describe('유효 토론 (96-3)', () => {
    it('counts visible posts, comments and replies, their authors and markets', async () => {
      const one = await openMarket();
      const two = await openMarket();
      const writer = await member();
      const second = await member();
      const week = at(HOUR_MS);
      const post = await createPost(t.db, { marketId: one, authorId: writer, createdAt: week });
      await createPost(t.db, { marketId: two, authorId: writer, createdAt: week });
      const comment = await createComment(t.db, {
        postId: post.id,
        authorId: second,
        createdAt: at(2 * HOUR_MS),
      });
      await createComment(t.db, {
        postId: post.id,
        authorId: writer,
        parentId: comment.id,
        createdAt: at(3 * HOUR_MS),
      });
      // Deleted and hidden rows are out.
      await createPost(t.db, { marketId: two, authorId: second, createdAt: week, deletedAt: week });
      await createComment(t.db, {
        postId: post.id,
        authorId: second,
        createdAt: week,
        hiddenAt: at(4 * HOUR_MS),
      });
      await createNotice(t.db, { createdAt: week });
      expect(rowOf(await read(), 'discussion', week)).toMatchObject({
        posts: 2,
        comments: 2,
        authors: 2,
        markets: 2,
        inProgress: false,
      });
    });

    it('recounts on unhide, counts a visible comment under a hidden post, ignores a purge', async () => {
      const market = await openMarket();
      const writer = await member();
      const week = at(HOUR_MS);
      const hiddenPost = await createPost(t.db, {
        marketId: market,
        authorId: writer,
        createdAt: week,
        hiddenAt: at(2 * HOUR_MS),
      });
      await createComment(t.db, {
        postId: hiddenPost.id,
        authorId: await member(),
        createdAt: week,
      });
      expect(rowOf(await read(), 'discussion', week)).toMatchObject({
        posts: 0,
        comments: 1,
        authors: 1,
        markets: 1,
      });
      // #184's purge empties the hidden row and keeps its times.
      await t.db
        .update(posts)
        .set({
          purgedAt: at(3 * HOUR_MS),
          title: null,
          bodyText: '',
          imageIds: [],
          body: { type: 'doc', content: [] },
        })
        .where(eq(posts.id, hiddenPost.id));
      expect(rowOf(await read(), 'discussion', week)).toMatchObject({ posts: 0, comments: 1 });
      const unhidden = await createPost(t.db, {
        marketId: market,
        authorId: writer,
        createdAt: week,
        hiddenAt: at(2 * HOUR_MS),
      });
      await t.db.update(posts).set({ hiddenAt: null }).where(eq(posts.id, unhidden.id));
      expect(rowOf(await read(), 'discussion', week)).toMatchObject({
        posts: 1,
        comments: 1,
        authors: 2,
      });
    });

    it('drops what an author wrote while admin; keeps a closed author; caps at asOf', async () => {
      const market = await openMarket();
      const author = await member();
      const closed = await member();
      const grant = at(DAY_MS);
      await createPost(t.db, { marketId: market, authorId: author, createdAt: at(HOUR_MS) });
      await createPost(t.db, {
        marketId: market,
        authorId: author,
        createdAt: at(DAY_MS + HOUR_MS),
      });
      await createPost(t.db, { marketId: market, authorId: closed, createdAt: at(HOUR_MS) });
      await closeAccount(t.db, closed);
      const asOf = at(3 * DAY_MS);
      await createPost(t.db, {
        marketId: market,
        authorId: await member(),
        createdAt: new Date(asOf.getTime() + 1),
      });
      await grantAdminAt(t.db, author, grant);
      expect(rowOf(await read(asOf), 'discussion', at(0))).toMatchObject({
        posts: 2,
        authors: 2,
        inProgress: true,
      });
    });
  });

  describe('신고 처리 시간 (96-4)', () => {
    /** A post by a fresh member, the target of the reports. */
    async function target() {
      const author = await member();
      const post = await createPost(t.db, {
        marketId: await openMarket(),
        authorId: author,
        createdAt: at(-DAY_MS),
      });
      return { author, postId: post.id };
    }
    async function report(on: { author: string; postId: string }, createdAt: Date, by?: string) {
      return createReport(t.db, {
        reporterId: by ?? (await member()),
        reportedUserId: on.author,
        postId: on.postId,
        createdAt,
      });
    }

    it('counts an action over three reports as one case from the earliest', async () => {
      const operator = await createAdminAt(t.db, { at: at(-2 * DAY_MS) });
      const on = await target();
      await report(on, at(3 * HOUR_MS));
      await report(on, at(HOUR_MS));
      await report(on, at(2 * HOUR_MS));
      await actionReportsAt(t.db, {
        adminId: operator,
        userId: on.author,
        postId: on.postId,
        at: at(5 * HOUR_MS),
      });
      expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
        cases: 1,
        medianMs: 4 * HOUR_MS,
        p90Ms: 4 * HOUR_MS,
        pendingTargets: 0,
      });
    });

    it('splits one dismissal by target, and counts two closings of one target twice', async () => {
      const operator = await createAdminAt(t.db, { at: at(-2 * DAY_MS) });
      const first = await target();
      const second = await target();
      const a = await report(first, at(HOUR_MS));
      const b = await report(second, at(2 * HOUR_MS));
      await dismissReportsAt(t.db, {
        adminId: operator,
        reportIds: [a.id, b.id],
        at: at(4 * HOUR_MS),
      });
      // Reported again after the dismissal, then acted on: a second case of the same target.
      await report(first, at(5 * HOUR_MS));
      await actionReportsAt(t.db, {
        adminId: operator,
        userId: first.author,
        postId: first.postId,
        at: at(11 * HOUR_MS),
      });
      const [dismissal] = await t.db
        .select()
        .from(adminActions)
        .where(eq(adminActions.type, 'report_dismiss'));
      const [resolved] = await t.db.select().from(reports).where(eq(reports.id, a.id));
      expect(dismissal!.createdAt.getTime()).not.toBe(resolved!.resolvedAt!.getTime());
      // Durations 2h, 3h, 6h: median 3h, P90 6h (nearest-rank).
      expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
        cases: 3,
        medianMs: 3 * HOUR_MS,
        p90Ms: 6 * HOUR_MS,
      });
    });

    it('counts an account-restriction approval as one case', async () => {
      const requester = await createAdminAt(t.db, { at: at(-2 * DAY_MS) });
      const approver = await createAdminAt(t.db, { at: at(-DAY_MS) });
      const reported = await member();
      await createReport(t.db, {
        reporterId: await member(),
        reportedUserId: reported,
        createdAt: at(HOUR_MS),
      });
      await createReport(t.db, {
        reporterId: await member(),
        reportedUserId: reported,
        createdAt: at(2 * HOUR_MS),
      });
      const { reportIds } = await actionReportsAt(t.db, {
        adminId: requester,
        userId: reported,
        approvedBy: approver,
        at: at(3 * HOUR_MS),
      });
      expect(reportIds).toHaveLength(2);
      expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
        cases: 1,
        medianMs: 2 * HOUR_MS,
      });
    });

    it('leaves out reports filed while admin: the start moves, an all-admin case goes', async () => {
      const operator = await createAdminAt(t.db, { at: at(-2 * DAY_MS) });
      const filer = await createAdminAt(t.db, { at: at(-DAY_MS) });
      const mixed = await target();
      await report(mixed, at(HOUR_MS), filer);
      await report(mixed, at(2 * HOUR_MS));
      await actionReportsAt(t.db, {
        adminId: operator,
        userId: mixed.author,
        postId: mixed.postId,
        at: at(4 * HOUR_MS),
      });
      const adminOnly = await target();
      const only = await report(adminOnly, at(HOUR_MS), filer);
      await dismissReportsAt(t.db, {
        adminId: operator,
        reportIds: [only.id],
        at: at(5 * HOUR_MS),
      });
      const pendingAdminOnly = await target();
      await report(pendingAdminOnly, at(HOUR_MS), filer);
      expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
        cases: 1,
        medianMs: 2 * HOUR_MS,
        pendingTargets: 0,
      });
    });

    it('groups before the week filter: a case starts at its earliest report, wherever it lies', async () => {
      const operator = await createAdminAt(t.db, { at: at(-30 * WEEK_MS) });
      const asOf = later();
      const oldest = kstWeekStartOf(new Date(asOf.getTime() - 11 * WEEK_MS));
      const old = await target();
      await report(old, new Date(oldest.getTime() - DAY_MS));
      await report(old, at(HOUR_MS));
      await actionReportsAt(t.db, {
        adminId: operator,
        userId: old.author,
        postId: old.postId,
        at: at(2 * HOUR_MS),
      });
      const spanning = await target();
      await report(spanning, at(HOUR_MS));
      await report(spanning, at(2 * WEEK_MS));
      await actionReportsAt(t.db, {
        adminId: operator,
        userId: spanning.author,
        postId: spanning.postId,
        at: at(2 * WEEK_MS + HOUR_MS),
      });
      const answer = await read(asOf);
      expect(rowOf(answer, 'reportHandling', at(0))).toMatchObject({
        cases: 1,
        medianMs: 2 * WEEK_MS,
      });
      expect(rowOf(answer, 'reportHandling', at(2 * WEEK_MS))).toMatchObject({ cases: 0 });
      expect(answer.reportHandling.reduce((sum, row) => sum + row.cases, 0)).toBe(1);
    });

    it('recounts after retention deletes a report: the start moves, then the case goes', async () => {
      const operator = await createAdminAt(t.db, { at: at(-2 * DAY_MS) });
      const on = await target();
      const first = await report(on, at(HOUR_MS));
      const second = await report(on, at(2 * HOUR_MS));
      await dismissReportsAt(t.db, {
        adminId: operator,
        reportIds: [first.id, second.id],
        at: at(4 * HOUR_MS),
      });
      expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
        cases: 1,
        medianMs: 3 * HOUR_MS,
      });
      const urls = testDbUrls()!;
      const owner = new Client({ connectionString: urls.migrateUrl });
      await owner.connect();
      try {
        await owner.query('DELETE FROM reports WHERE id = $1', [first.id]);
        expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
          cases: 1,
          medianMs: 2 * HOUR_MS,
        });
        await owner.query('DELETE FROM reports WHERE id = $1', [second.id]);
      } finally {
        await owner.end();
      }
      expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
        cases: 0,
        medianMs: null,
      });
    });

    it('survives odd dismissal records and groups an unrecorded dismissal by its clock', async () => {
      const operator = await createAdminAt(t.db, { at: at(-2 * DAY_MS) });
      // A dangling id beside a real one, and records whose reportIds is no array.
      const named = await target();
      const listed = await report(named, at(HOUR_MS));
      const dismissed = {
        status: 'dismissed' as const,
        resolvedBy: operator,
        dismissalReason: '기각',
      };
      await t.db
        .update(reports)
        .set({ ...dismissed, resolvedAt: at(2 * HOUR_MS) })
        .where(eq(reports.id, listed.id));
      await t.db.insert(adminActions).values([
        {
          adminId: operator,
          type: 'report_dismiss',
          payload: {
            reportIds: [listed.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid'],
            reason: '기각',
          },
        },
        { adminId: operator, type: 'report_dismiss', payload: { reportIds: listed.id } },
        { adminId: operator, type: 'report_dismiss', payload: { reportIds: { id: listed.id } } },
        { adminId: operator, type: 'report_dismiss', payload: { reason: '기각' } },
      ]);
      // Dismissed with no record: one instant over two targets and two reports on one.
      const one = await target();
      const two = await target();
      const unrecorded = [
        await report(one, at(HOUR_MS)),
        await report(one, at(3 * HOUR_MS)),
        await report(two, at(2 * HOUR_MS)),
      ];
      for (const row of unrecorded) {
        await t.db
          .update(reports)
          .set({ ...dismissed, resolvedAt: at(5 * HOUR_MS) })
          .where(eq(reports.id, row.id));
      }
      // Two dismissals with no record on one target at two instants: two cases, not one.
      const three = await target();
      const before = await report(three, at(HOUR_MS));
      await t.db
        .update(reports)
        .set({ ...dismissed, resolvedAt: at(3 * HOUR_MS) })
        .where(eq(reports.id, before.id));
      const after = await report(three, at(4 * HOUR_MS));
      await t.db
        .update(reports)
        .set({ ...dismissed, resolvedAt: at(6 * HOUR_MS) })
        .where(eq(reports.id, after.id));
      // Durations 1h, 4h, 3h, 2h, 2h → median 2h, P90 4h (one merged 5h case would make 4).
      expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
        cases: 5,
        medianMs: 2 * HOUR_MS,
        p90Ms: 4 * HOUR_MS,
      });
    });

    it('is closed only when resolved before asOf; pending by target in its earliest week', async () => {
      const operator = await createAdminAt(t.db, { at: at(-30 * WEEK_MS) });
      const asOf = at(WEEK_MS + 3 * DAY_MS);
      const late = await target();
      const lateReport = await report(late, at(HOUR_MS));
      await dismissReportsAt(t.db, {
        adminId: operator,
        reportIds: [lateReport.id],
        at: new Date(asOf.getTime() + 1),
      });
      // Pending in two shown weeks: counted once, in the earlier week.
      const twice = await target();
      await report(twice, at(2 * WEEK_MS + HOUR_MS)); // after asOf: neither
      await report(twice, at(WEEK_MS + HOUR_MS));
      await report(twice, at(DAY_MS + HOUR_MS));
      const old = await target();
      const oldest = kstWeekStartOf(new Date(asOf.getTime() - 11 * WEEK_MS));
      await report(old, new Date(oldest.getTime() - 1));
      const future = await target();
      await report(future, new Date(asOf.getTime() + 1));
      const answer = await read(asOf);
      expect(rowOf(answer, 'reportHandling', at(0))).toMatchObject({
        cases: 0,
        pendingTargets: 2,
        inProgress: false,
      });
      expect(rowOf(answer, 'reportHandling', at(WEEK_MS))).toMatchObject({
        cases: 0,
        pendingTargets: 0,
        inProgress: true,
      });
      expect(answer.pendingTargetsEarlier).toBe(1);
    });

    it('takes percentile_disc as the nearest-rank percentile for n = 1…20', async () => {
      for (let n = 1; n <= 20; n += 1) {
        // A fixed, unsorted list with repeats.
        const values = Array.from({ length: n }, (_, i) => ((i * 7919) % 23) * 1_000 + (i % 3));
        const { rows } = await t.db.execute<{ median: string; p90: string }>(sql`
          SELECT (percentile_disc(0.5) WITHIN GROUP (ORDER BY v))::text AS median,
                 (percentile_disc(0.9) WITHIN GROUP (ORDER BY v))::text AS p90
            FROM unnest(${`{${values.join(',')}}`}::bigint[]) AS x(v)`);
        expect(Number(rows[0]!.median), `n=${n}`).toBe(nearestPercentile(values, 50));
        expect(Number(rows[0]!.p90), `n=${n}`).toBe(nearestPercentile(values, 90));
      }
    });

    it('computes the median and P90 of real cases like nearestPercentile', async () => {
      const operator = await createAdminAt(t.db, { at: at(-2 * DAY_MS) });
      const durations = [5, 1, 9, 3, 7, 2, 8].map((minutes) => minutes * MINUTE_MS);
      const on = await target();
      for (const [index, duration] of durations.entries()) {
        const filed = at(HOUR_MS + index * 20 * MINUTE_MS);
        const row = await report(on, filed);
        await dismissReportsAt(t.db, {
          adminId: operator,
          reportIds: [row.id],
          at: new Date(filed.getTime() + duration),
        });
      }
      expect(rowOf(await read(), 'reportHandling', at(0))).toMatchObject({
        cases: durations.length,
        medianMs: nearestPercentile(durations, 50),
        p90Ms: nearestPercentile(durations, 90),
      });
    });
  });

  describe('관심 등록 후 재방문 (151-1, #151)', () => {
    /** The Korean date `days` after the Korean date of `instant`. */
    const dayOf = (instant: Date, days: number) => kstDatePlusDays(kstDateOf(instant), days);
    const visit = (userId: string, marketId: string, date: string) =>
      createVisit(t.asOwner, { userId, marketId, date });
    const watch = (userId: string, marketId: string, watchedAt: Date) =>
      createWatch(t.db, { userId, marketId, watchedAt });
    /** An unwatch as the API writes it: the current row gone, an `unwatch` event at `at`. */
    async function unwatch(userId: string, marketId: string, at: Date) {
      await t.db.transaction(async (tx) => {
        await tx
          .delete(marketWatches)
          .where(and(eq(marketWatches.userId, userId), eq(marketWatches.marketId, marketId)));
        await tx
          .insert(marketWatchEvents)
          .values({ userId, marketId, action: 'unwatch', createdAt: at });
      });
    }

    it('counts an open from D+1 to D+7 (Korean dates), once per pair, never D or D+8 (95-12)', async () => {
      const start = at(10 * HOUR_MS); // Monday 10:00 KST
      const market = await openMarket();
      const offsets: number[][] = [[0], [1], [7], [8], [1, 3]];
      for (const days of offsets) {
        const id = await member();
        await watch(id, market, start);
        for (const n of days) await visit(id, market, dayOf(start, n));
      }
      // Another market's open is not this pair's.
      const elsewhere = await member();
      await watch(elsewhere, market, start);
      await visit(elsewhere, await openMarket(), dayOf(start, 1));
      expect(rowOf(await read(), 'revisit', start)).toMatchObject({
        pairs: 6,
        revisited: 3,
        noData: false,
        inProgress: false,
      });
    });

    it('counts an open after an unwatch, and a rewatch is no new start (151-1, 95-4)', async () => {
      const market = await openMarket();
      const start = at(10 * HOUR_MS);
      // Watch, unwatch the same day, open on D+2: counted.
      const unwatched = await member();
      await watch(unwatched, market, start);
      await unwatch(unwatched, market, at(11 * HOUR_MS));
      await visit(unwatched, market, dayOf(start, 2));
      // First watched this week, watched again next week: next week holds no pair.
      const again = await member();
      await watch(again, market, start);
      await unwatch(again, market, at(DAY_MS));
      const rewatch = at(WEEK_MS + 10 * HOUR_MS);
      await watch(again, market, rewatch);
      await visit(again, market, dayOf(rewatch, 1));
      const answer = await read();
      expect(rowOf(answer, 'revisit', start)).toMatchObject({ pairs: 2, revisited: 1 });
      expect(rowOf(answer, 'revisit', rewatch)).toMatchObject({ pairs: 0, revisited: 0 });
    });

    it('takes D as the Korean date: Sunday 23:59:59.999 and Monday 00:00 KST are two weeks', async () => {
      const market = await openMarket();
      const sunday = at(WEEK_MS - 1);
      const monday = at(WEEK_MS);
      expect(kstDateOf(sunday)).toBe(dayOf(monday, -1));
      const late = await member();
      await watch(late, market, sunday);
      // D (Sunday) is not counted; D+1 is Monday.
      await visit(late, market, dayOf(sunday, 0));
      await visit(late, market, dayOf(sunday, 1));
      const early = await member();
      await watch(early, market, monday);
      await visit(early, market, dayOf(monday, 0));
      const answer = await read();
      expect(rowOf(answer, 'revisit', sunday)).toMatchObject({ pairs: 1, revisited: 1 });
      expect(rowOf(answer, 'revisit', monday)).toMatchObject({ pairs: 1, revisited: 0 });
    });

    it('leaves out a pair whose account was admin at the first watch, for good (8의 1)', async () => {
      const market = await openMarket();
      const start = at(10 * HOUR_MS);
      // Admin at the first watch: out, though revoked and watched again later.
      const admin = await member();
      await grantAdminAt(t.db, admin, at(9 * HOUR_MS));
      await watch(admin, market, start);
      await revokeAdminAt(t.db, admin, at(11 * HOUR_MS));
      await unwatch(admin, market, at(12 * HOUR_MS));
      await watch(admin, market, at(13 * HOUR_MS));
      await visit(admin, market, dayOf(start, 2));
      // Admin only after its open on D+1: in, the open counts.
      const later = await member();
      await watch(later, market, start);
      await visit(later, market, dayOf(start, 1));
      await grantAdminAt(t.db, later, at(2 * DAY_MS + HOUR_MS));
      // The admin role with no record: a member (96-10).
      const { user: unrecorded } = await createUser(t.db, { role: 'admin' });
      await watch(unrecorded.id, market, start);
      await visit(unrecorded.id, market, dayOf(start, 3));
      expect(rowOf(await read(), 'revisit', start)).toMatchObject({ pairs: 2, revisited: 2 });
    });

    it('leaves out the bot, keeps a closed account and a member not onboarded (95-1, 결정 4)', async () => {
      const market = await openMarket();
      const start = at(10 * HOUR_MS);
      const bot = await createMarketMakerAccount(t.db);
      await watch(bot, market, start);
      // Watched, opened on D+2, then closed (its closure writes an unwatch): still counted.
      const closed = await member();
      await watch(closed, market, start);
      await visit(closed, market, dayOf(start, 2));
      await closeAccount(t.db, closed);
      // Never onboarded: in the denominator.
      const fresh = await member();
      const [profile] = await t.db
        .execute<{ confirmed: Date | null }>(
          sql`SELECT nickname_confirmed_at AS confirmed FROM profiles WHERE user_id = ${fresh}`,
        )
        .then((result) => result.rows);
      expect(profile?.confirmed).toBeNull();
      await watch(fresh, market, start);
      expect(rowOf(await read(), 'revisit', start)).toMatchObject({ pairs: 2, revisited: 1 });
    });

    it('reads nothing after asOf: a watch at or after it, an open after its Korean date', async () => {
      const market = await openMarket();
      const start = at(10 * HOUR_MS);
      const asOf = at(3 * DAY_MS + 12 * HOUR_MS); // Thursday 12:00 KST = D+3
      const onDay = await member();
      await watch(onDay, market, start);
      await visit(onDay, market, kstDateOf(asOf));
      const afterDay = await member();
      await watch(afterDay, market, start);
      await visit(afterDay, market, dayOf(asOf, 1));
      await watch(await member(), market, asOf);
      await watch(await member(), market, new Date(asOf.getTime() + 1));
      expect(rowOf(await read(asOf), 'revisit', start)).toMatchObject({
        pairs: 2,
        revisited: 1,
        inProgress: true,
      });
      expect(rowOf(await read(), 'revisit', start)).toMatchObject({ pairs: 4, revisited: 2 });
    });
  });

  describe('결과 조회 (151-2, #151)', () => {
    const dayOf = (instant: Date, days: number) => kstDatePlusDays(kstDateOf(instant), days);
    const visit = (userId: string, marketId: string, date: string) =>
      createVisit(t.asOwner, { userId, marketId, date });
    /** A CLOSED market whose close was two hours before `publishedAt`. */
    const closedMarket = async (publishedAt: Date) =>
      (
        await createMarket(t.db, {
          status: 'closed',
          closeAt: new Date(publishedAt.getTime() - 2 * HOUR_MS),
        })
      ).id;
    /** Its judgement version 1 approved at `publishedAt` (#152). */
    const publish = (marketId: string, publishedAt: Date, result: 'YES' | 'NO' | 'VOID' = 'YES') =>
      createProvisionalMarket(t.db, { marketId, publishedAt, result });

    it('counts each person who filled there, opening from D to D+7, never the bot (95-2, 95-12)', async () => {
      const start = at(10 * HOUR_MS);
      const market = await closedMarket(start);
      const before = at(7 * HOUR_MS);
      const [a, b, c, d, e] = [
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
      ];
      const bot = await createMarketMakerAccount(t.db);
      await fill(market, a, b, before);
      await fill(market, c, d, before);
      // A person's fill against the bot: the person's side only.
      await fill(market, bot, e, before);
      // Bought, then sold everything: still one who filled (151-2 "전량 매도 포함").
      await fill(market, a, b, at(8 * HOUR_MS));
      await publish(market, start);
      await visit(a, market, dayOf(start, 0));
      await visit(a, market, dayOf(start, 3)); // once per pair
      await visit(b, market, dayOf(start, 7));
      await visit(c, market, dayOf(start, 8));
      await visit(d, market, dayOf(start, -1));
      await visit(e, market, dayOf(start, 1));
      expect(rowOf(await read(), 'resultView', start)).toMatchObject({
        pairs: 5,
        viewed: 3,
        noData: false,
        inProgress: false,
      });
    });

    it('leaves out a pair whose every fill there is marked, and brings it back on a clear (95-3)', async () => {
      const asker = await createAdminAt(t.db, { at: at(-3 * HOUR_MS) });
      const decider = await createAdminAt(t.db, { at: at(-2 * HOUR_MS) });
      const start = at(10 * HOUR_MS);
      const market = await closedMarket(start);
      const sole = await member();
      const mixed = await member();
      const { id: soleFill } = await fill(market, sole, mixed, at(HOUR_MS));
      const { id: otherFill } = await fill(market, await member(), mixed, at(2 * HOUR_MS));
      await publish(market, start);
      await visit(sole, market, dayOf(start, 1));
      await visit(mixed, market, dayOf(start, 1));
      const classify = (fillId: number, action: 'mark' | 'clear') =>
        classifyFill(t.db, {
          fillId,
          marketId: market,
          action,
          askerId: asker,
          deciderId: decider,
        });
      expect(rowOf(await read(), 'resultView', start)).toMatchObject({ pairs: 3, viewed: 2 });
      await classify(soleFill, 'mark');
      // `sole` is out; `mixed` keeps its unmarked fill.
      expect(rowOf(await read(), 'resultView', start)).toMatchObject({ pairs: 2, viewed: 1 });
      await classify(otherFill, 'mark');
      expect(rowOf(await read(), 'resultView', start)).toMatchObject({ pairs: 0, viewed: 0 });
      await classify(soleFill, 'clear');
      expect(rowOf(await read(), 'resultView', start)).toMatchObject({ pairs: 2, viewed: 2 });
    });

    it('starts at version 1 only, VOID included, never a correction; leaves out an admin then', async () => {
      const start = at(10 * HOUR_MS);
      const market = await closedMarket(start);
      const holder = await member();
      const admin = await member();
      await fill(market, holder, admin, at(HOUR_MS));
      await grantAdminAt(t.db, admin, at(9 * HOUR_MS));
      await publish(market, start, 'VOID');
      await visit(holder, market, dayOf(start, 2));
      // A correction (version 2) published next week starts nothing (8의 9).
      const corrected = at(WEEK_MS + 10 * HOUR_MS);
      await createCorrectedMarket(t.db, { marketId: market, correctedAt: corrected });
      await visit(holder, market, dayOf(corrected, 1));
      const answer = await read();
      expect(rowOf(answer, 'resultView', start)).toMatchObject({ pairs: 1, viewed: 1 });
      expect(rowOf(answer, 'resultView', corrected)).toMatchObject({ pairs: 0, viewed: 0 });
    });

    it('starts nothing without a version 1 or after asOf', async () => {
      const start = at(10 * HOUR_MS);
      // Fills, no judgement: a CLOSED market, and one CANCELLED (ADR-0117: never judged).
      const unjudged = await closedMarket(start);
      await fill(unjudged, await member(), await member(), at(HOUR_MS));
      const cancelled = await closedMarket(start);
      await fill(cancelled, await member(), await member(), at(HOUR_MS));
      await t.db.update(markets).set({ status: 'cancelled' }).where(eq(markets.id, cancelled));
      // Published a millisecond after asOf.
      const asOf = at(DAY_MS);
      const lateMarket = await closedMarket(start);
      await fill(lateMarket, await member(), await member(), at(HOUR_MS));
      await publish(lateMarket, new Date(asOf.getTime() + 1));
      expect(rowOf(await read(asOf), 'resultView', start)).toMatchObject({
        pairs: 0,
        viewed: 0,
        inProgress: true,
      });
      expect(rowOf(await read(), 'resultView', start)).toMatchObject({ pairs: 2 });
    });

    it('reads no open after the Korean date of asOf, and one on it', async () => {
      const start = at(10 * HOUR_MS);
      const market = await closedMarket(start);
      const [a, b] = [await member(), await member()];
      await fill(market, a, b, at(HOUR_MS));
      await publish(market, start);
      const asOf = at(2 * DAY_MS + 9 * HOUR_MS); // Wednesday 09:00 KST = D+2
      await visit(a, market, kstDateOf(asOf));
      await visit(b, market, dayOf(asOf, 1));
      expect(rowOf(await read(asOf), 'resultView', start)).toMatchObject({ pairs: 2, viewed: 1 });
    });
  });

  describe('자료 없음 of the visit-based metrics (결정 8의 7, #151)', () => {
    /** Each visit-based metric's row and #96's 첫 체결 전환 row of the week holding `instant`. */
    const rows = (answer: AdminObservationMetrics, instant: Date) => ({
      revisit: rowOf(answer, 'revisit', instant),
      resultView: rowOf(answer, 'resultView', instant),
      firstFill: rowOf(answer, 'firstFill', instant),
    });

    it('cuts the weeks before the collection start when it is later than the data start', async () => {
      const market = await openMarket();
      const start = at(WEEK_MS + 10 * HOUR_MS);
      const id = await member();
      await createWatch(t.db, { userId: id, marketId: market, watchedAt: start });
      await createVisit(t.asOwner, {
        userId: id,
        marketId: market,
        date: kstDatePlusDays(kstDateOf(start), 1),
      });
      // Thursday of the second week: that week and every earlier one are 자료 없음.
      const since = at(WEEK_MS + 3 * DAY_MS);
      await setVisitCollectionStart(t.asOwner, since);
      let answer = await read();
      expect(answer.visitsSince).toBe(since.toISOString());
      for (const instant of [at(0), start]) {
        expect(rows(answer, instant)).toMatchObject({
          revisit: { noData: true, inProgress: false, pairs: 0, revisited: 0 },
          resultView: { noData: true, pairs: 0, viewed: 0 },
          firstFill: { noData: false },
        });
      }
      expect(rows(answer, at(2 * WEEK_MS))).toMatchObject({
        revisit: { noData: false },
        resultView: { noData: false },
      });
      // A start at a Monday 00:00 KST: that week is whole.
      await setVisitCollectionStart(t.asOwner, at(WEEK_MS));
      answer = await read();
      expect(rows(answer, start).revisit).toMatchObject({ noData: false, pairs: 1, revisited: 1 });
      expect(rows(answer, at(0)).revisit).toMatchObject({ noData: true });
      // A start before the earliest account (a database migrated before its accounts): no cut.
      await setVisitCollectionStart(t.asOwner, new Date(Date.now() - 365 * DAY_MS));
      answer = await read();
      const base96 = answer.firstFill.map((row) => row.noData);
      expect(answer.revisit.map((row) => row.noData)).toEqual(base96);
      // No start (a wiped database): no cut.
      await setVisitCollectionStart(t.asOwner, null);
      answer = await read();
      expect(answer.visitsSince).toBeNull();
      expect(answer.resultView.map((row) => row.noData)).toEqual(base96);
    });

    it('cuts a week whose window reaches the purge horizon: D+1 for 재방문, D for 결과 조회', async () => {
      await member();
      const monday = kstDateOf(at(WEEK_MS));
      const period = 10;
      /** A run whose cutoff falls on the Korean date `horizon` (the 04:30 KST run). */
      const ranAtFor = (horizon: string) =>
        new Date(kstStartOfDate(horizon).getTime() + (period * 24 + 4.5) * HOUR_MS);
      const purge = (horizon: string, count: number, outcome: 'done' | 'failed' = 'done') =>
        recordVisitPurge(t.db, { ranAt: ranAtFor(horizon), periodDays: period, count, outcome });
      const asOf = later();
      // Ignored: a run that deleted nothing, a failure, a run after asOf.
      await purge(kstDatePlusDays(monday, 3), 0);
      await purge(kstDatePlusDays(monday, 3), 0, 'failed');
      await recordVisitPurge(t.db, {
        ranAt: new Date(asOf.getTime() + 1),
        periodDays: 1,
        count: 5,
      });
      let answer = await read(asOf);
      expect(answer.visitsPurgedThrough).toBeNull();
      // Only the weeks before the earliest account, as #96's tables.
      const base96 = answer.firstFill.map((row) => row.noData);
      expect(answer.revisit.map((row) => row.noData)).toEqual(base96);
      expect(answer.resultView.map((row) => row.noData)).toEqual(base96);
      // Horizon = the week's Monday: 결과 조회 lost D of its Monday cohort; 재방문 lost nothing.
      await purge(monday, 3);
      answer = await read(asOf);
      expect(answer.visitsPurgedThrough).toBe(monday);
      expect(rows(answer, at(WEEK_MS))).toMatchObject({
        revisit: { noData: false },
        resultView: { noData: true },
        firstFill: { noData: false },
      });
      expect(rows(answer, at(0))).toMatchObject({
        revisit: { noData: true },
        resultView: { noData: true },
      });
      // Horizon = Tuesday: 재방문 lost D+1 of its Monday cohort too.
      await purge(kstDatePlusDays(monday, 1), 1);
      answer = await read(asOf);
      expect(answer.visitsPurgedThrough).toBe(kstDatePlusDays(monday, 1));
      expect(rows(answer, at(WEEK_MS))).toMatchObject({
        revisit: { noData: true },
        resultView: { noData: true },
      });
      expect(rows(answer, at(2 * WEEK_MS))).toMatchObject({
        revisit: { noData: false },
        resultView: { noData: false },
      });
      // The flags are the shared function's over the answer's coverage, week by week.
      const coverage = {
        dataStart: answer.dataStart === null ? null : new Date(answer.dataStart),
        visitsSince: null,
        visitsPurgedThrough: answer.visitsPurgedThrough,
      };
      const weeks = observationWeeks(asOf);
      for (const metric of ['revisit', 'resultView'] as const) {
        expect(
          answer[metric].map(({ noData, inProgress }) => ({ noData, inProgress })),
          metric,
        ).toEqual(weeks.map((week) => observationWeekFlags(week, metric, asOf, coverage)));
      }
    });

    it('keeps the horizon of the earlier run when its period was longer (the max cutoff date)', async () => {
      await member();
      const monday = kstDateOf(at(WEEK_MS));
      // Horizon Monday, then a later run with a longer period: horizon the Sunday before.
      await recordVisitPurge(t.db, {
        ranAt: new Date(kstStartOfDate(kstDatePlusDays(monday, 10)).getTime() + 4.5 * HOUR_MS),
        periodDays: 10,
        count: 2,
      });
      await recordVisitPurge(t.db, {
        ranAt: new Date(kstStartOfDate(kstDatePlusDays(monday, 11)).getTime() + 4.5 * HOUR_MS),
        periodDays: 12,
        count: 2,
      });
      const answer = await read();
      expect(answer.visitsPurgedThrough).toBe(monday);
    });
  });

  it('writes nothing: one read leaves every source as it was', async () => {
    const author = await member();
    await createPost(t.db, {
      marketId: await openMarket(),
      authorId: author,
      createdAt: at(HOUR_MS),
    });
    const counts = async () => ({
      actions: await t.db.$count(adminActions),
      posts: await t.db.$count(posts),
      comments: await t.db.$count(postComments),
      reports: await t.db.$count(reports),
      visits: await t.db.$count(marketVisits),
      collection: await t.db.$count(marketVisitCollection),
    });
    const before = await counts();
    await read();
    expect(await counts()).toEqual(before);
  });
});
