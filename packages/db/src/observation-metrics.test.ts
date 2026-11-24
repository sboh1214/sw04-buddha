import {
  OBSERVATION_WEEKS_SHOWN,
  OBSERVATION_WINDOW_MS,
  POSITION_SETTLEMENTS_SINCE,
  kstDateOf,
  kstWeekStartOf,
  nearestPercentile,
  type AdminObservationMetrics,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settleMarketPositions } from './market-settlement.js';
import { observationWeekSql, readObservationMetrics } from './observation-metrics.js';
import { adminActions, markets, postComments, posts, reports, user } from './schema/index.js';
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
  type Metric = 'firstFill' | 'afterSettlement' | 'discussion' | 'reportHandling';
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
        const { rows } = await t.db.execute<{ week: string }>(
          sql`SELECT ${observationWeekSql(sql`${instant.toISOString()}::timestamptz`)} AS week`,
        );
        expect(rows[0]!.week, instant.toISOString()).toBe(weekOf(instant));
      }
      expect(weekOf(new Date('2027-01-03T12:00:00.000Z'))).toBe('2026-12-28');
      expect(weekOf(new Date('2026-11-29T14:59:59.999Z'))).toBe('2026-11-23');
    });

    it('answers 12 weeks newest first, zero-filled, with the 진행 중 rules', async () => {
      await member();
      const asOf = later();
      const answer = await read(asOf);
      expect(answer.asOf).toBe(asOf.toISOString());
      for (const metric of [
        'firstFill',
        'afterSettlement',
        'discussion',
        'reportHandling',
      ] as const) {
        const rows = answer[metric];
        expect(rows).toHaveLength(OBSERVATION_WEEKS_SHOWN);
        expect(rows[0]!.week).toBe(weekOf(asOf));
        for (let index = 1; index < rows.length; index += 1) {
          expect(rows[index]!.week < rows[index - 1]!.week).toBe(true);
        }
        const progress = rows.map((row) => row.inProgress);
        const cohort = metric === 'firstFill' || metric === 'afterSettlement';
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
      for (const metric of ['firstFill', 'discussion'] as const) {
        expect(answer[metric][0]).toMatchObject({ noData: false, inProgress: true });
        expect(answer[metric][1]).toMatchObject({ noData: true, inProgress: false });
        expect(answer[metric].slice(1).every((row) => row.noData)).toBe(true);
      }
      expect(answer.firstFill[0]!.week).toBe(kstDateOf(weekStart));
    });

    it('is 자료 없음 everywhere on an empty database, with no data start', async () => {
      const answer = await read();
      expect(answer.dataStart).toBeNull();
      for (const metric of [
        'firstFill',
        'afterSettlement',
        'discussion',
        'reportHandling',
      ] as const) {
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
    });
    const before = await counts();
    await read();
    expect(await counts()).toEqual(before);
  });
});
