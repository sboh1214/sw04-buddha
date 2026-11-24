/**
 * 관측 지표 (#96, ADR-0169) through `GET /admin/observation-metrics` against the docker `test`
 * profile, on the database's own clock. The metrics' every rule is packages/db
 * observation-metrics.test.ts's; here are the route's: admins only (401, 403), the answer's shape
 * (12 KST weeks newest first in each table, the shared week flags, `dataStart` the earliest
 * account, no field naming an account or an item), the records the real flows write counted —
 * a member onboarded and trading through the order route (첫 체결 전환), a payout's holder trading
 * after it (정산 후 재참여), posts and comments (유효 토론), and a report closed by a dismissal
 * (`POST /admin/reports/dismiss`, its `report_dismiss.reportIds`), by a hiding that closes two
 * members' reports, and by an account-restriction approval (신고 처리 시간) — the calling admin left
 * out through its grant record (95-1, records only), and reading changes no row. And #151's two
 * (ADR-0170): a watch through `PUT /me/watchlist/:marketId` is a 재방문 cohort pair its same-day
 * visit does not revisit (D excluded, 95-12), and the traders of a market judged now are 결과 조회
 * pairs a visit through `POST /me/market-visits` the same day counts (D included) — the admin's
 * own visit writing nothing. Skips when TEST_* are unset.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createComment,
  createFillRecord,
  createMarket,
  createPost,
  createSettlementRecord,
  createStartGrant,
  createProvisionalMarket,
  createUser,
  grantAdminAt,
  openOrderIntake,
  readVisits,
  settleMarketAt,
} from '@buddha/db/test';
import {
  OBSERVATION_METRICS,
  OBSERVATION_WEEKS_SHOWN,
  adminObservationMetricsSchema,
  kstDateOf,
  kstWeekStartOf,
  observationWeekFlags,
  observationWeeks,
  type AdminObservationMetrics,
  type ObservationMetric,
} from '@buddha/shared';
import { count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { SRC } from '../test/program.js';
import { discoverRoutes } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const ORIGIN = 'http://localhost:3000';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

type Res = { statusCode: number; body: string; json: <T>() => T };

/** The KST Monday of the week holding `instant`, as the answer's rows name it. */
const weekOf = (instant: Date) => kstDateOf(kstWeekStartOf(instant));

describe('the routes #96 adds (static)', () => {
  it('are the one read, nothing that writes', () => {
    const added = discoverRoutes()
      .map((route) => route.key)
      .filter((key) => /observation/.test(key));
    expect(added).toEqual(['GET /admin/observation-metrics']);
  });

  it('leaves `readObservationMetrics` to the admin service alone (95-10: no member surface)', () => {
    // Every source file of every app and package: the reader may appear in its own module and
    // its test (the package index re-exports it with `export *`), and outside packages/db only in
    // the admin service — and in the worker's purge test, which reads `visitsPurgedThrough` after
    // a visit purge (#151, ADR-0170: a test file, not a member surface).
    const root = path.resolve(SRC, '../../..');
    const skip = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'generated']);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (skip.has(entry.name)) return [];
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) ? [full] : [];
      });
    const roots = ['apps', 'packages'].flatMap((top) =>
      readdirSync(path.join(root, top), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, top, entry.name)),
    );
    const self = path.resolve(
      SRC,
      'observation-metrics/admin-observation-metrics.controller.test.ts',
    );
    const readers = roots
      .flatMap((dir) => walk(dir))
      .filter((file) => file !== self)
      .filter((file) => /\breadObservationMetrics\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
      .sort();
    expect(readers).toEqual([
      'apps/api/src/observation-metrics/observation-metrics.service.ts',
      'apps/worker/src/jobs/retention-purge.test.ts',
      'packages/db/src/observation-metrics.test.ts',
      'packages/db/src/observation-metrics.ts',
    ]);
  });
});

describe.skipIf(!hasTestInfra)('관측 지표 (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  /** The database clock at the start of a case. */
  let now: Date;
  /** The next role change's instant: strictly increasing, before any onboarding of the case. */
  let nextGrant: Date;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    now = await clockTimestamp(t.db);
    nextGrant = new Date(now.getTime() - HOUR_MS);
    admin = await makeAdmin();
  });

  async function onboarded(coin = false): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    if (coin) await createStartGrant(t.db, { userId: user.id, amountCoin: 10_000n });
    return user;
  }
  /**
   * An onboarded admin with its `admin_grant` record written before its onboarding, as
   * `writeRole` and the seed write it — the metrics read who was admin from the records alone
   * (95-1, 96-10), so an admin with only `profiles.role` would count as a member.
   */
  async function makeAdmin(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await grantAdminAt(t.db, user.id, nextGrant);
    nextGrant = new Date(nextGrant.getTime() + MINUTE_MS);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await completeOnboarding(t.db, { userId: user.id });
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }

  const get = (cookie: string | null = admin.cookie) =>
    t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/observation-metrics',
      headers: cookie === null ? {} : { cookie },
    });
  const send = (url: string, payload: Record<string, unknown>, who: TestUser) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...payload }),
    });
  const order = (who: TestUser, marketId: string, body: Record<string, unknown>) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${marketId}/orders`,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        cookie: who.cookie,
      },
      payload: JSON.stringify({
        side: 'buy',
        qty: 1,
        expectedAccountId: who.id,
        ...body,
      }),
    });
  const dataOf = <T>(res: Res, status = 200): T => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json<{ data: T }>().data;
  };
  const read = async (): Promise<AdminObservationMetrics> =>
    adminObservationMetricsSchema.parse(dataOf<unknown>(await get()));
  /** The row of `metric` for the week holding `instant`. */
  function rowOf<M extends ObservationMetric>(
    answer: AdminObservationMetrics,
    metric: M,
    instant: Date,
  ): AdminObservationMetrics[M][number] {
    const row = answer[metric].find((week) => week.week === weekOf(instant));
    if (!row) throw new Error(`no ${metric} row for ${weekOf(instant)}`);
    return row;
  }
  /** Every row of `metric` but the week holding `instant`. */
  const otherRows = <M extends ObservationMetric>(
    answer: AdminObservationMetrics,
    metric: M,
    instant: Date,
  ) => answer[metric].filter((week) => week.week !== weekOf(instant));
  async function nicknameConfirmedAt(userId: string): Promise<Date> {
    const [row] = await t.db
      .select({ at: schema.profiles.nicknameConfirmedAt })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.at!;
  }
  /** The reports' earliest arrival and their one closing instant (equal across a closing). */
  async function closing(ids: string[]): Promise<{ start: Date; elapsedMs: number }> {
    const rows = await t.db
      .select({ createdAt: schema.reports.createdAt, resolvedAt: schema.reports.resolvedAt })
      .from(schema.reports)
      .where(inArray(schema.reports.id, ids));
    expect(rows).toHaveLength(ids.length);
    const ends = new Set(rows.map((row) => row.resolvedAt?.getTime()));
    expect(ends.size, 'one closing instant').toBe(1);
    const end = rows[0]!.resolvedAt!;
    const start = new Date(Math.min(...rows.map((row) => row.createdAt.getTime())));
    return { start, elapsedMs: end.getTime() - start.getTime() };
  }
  /** A member's report of a post through the report route; its id. */
  async function report(postId: string, who: TestUser): Promise<string> {
    return dataOf<{ id: string }>(
      await send(`/posts/${postId}/reports`, { reason: 'spam' }, who),
      201,
    ).id;
  }
  const rowCounts = async () => ({
    adminActions: (await t.db.select({ n: count() }).from(schema.adminActions))[0]!.n,
    reports: (await t.db.select({ n: count() }).from(schema.reports))[0]!.n,
    fills: (await t.db.select({ n: count() }).from(schema.fills))[0]!.n,
    profiles: (await t.db.select({ n: count() }).from(schema.profiles))[0]!.n,
    visits: (await readVisits(t.db)).length,
  });

  it('is every admin’s and nobody else’s: 401 without a session, 403 for a member (95-10, #171)', async () => {
    expect((await get(null)).statusCode).toBe(401);
    const member = await onboarded();
    const res = await get(member.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    expect((await get()).statusCode).toBe(200);
  });

  it('answers 12 KST weeks newest first per table with the shared flags, counts only, the admin left out by its grant record', async () => {
    const answer = await read();
    const asOf = new Date(answer.asOf);
    expect(Math.abs(asOf.getTime() - now.getTime())).toBeLessThan(60 * MINUTE_MS);
    // The earliest account: the admin, the only one.
    const [first] = await t.db
      .select({ createdAt: schema.user.createdAt })
      .from(schema.user)
      .where(eq(schema.user.id, admin.id));
    expect(answer.dataStart).toBe(first!.createdAt.toISOString());
    const dataStart = new Date(answer.dataStart!);

    const weeks = observationWeeks(asOf);
    expect(weeks).toHaveLength(OBSERVATION_WEEKS_SHOWN);
    const zeros: Record<ObservationMetric, Record<string, number | null>> = {
      firstFill: { accounts: 0, filled: 0 },
      afterSettlement: { pairs: 0, returned: 0 },
      discussion: { posts: 0, comments: 0, authors: 0, markets: 0 },
      reportHandling: { cases: 0, medianMs: null, p90Ms: null, pendingTargets: 0 },
      revisit: { pairs: 0, revisited: 0 },
      resultView: { pairs: 0, viewed: 0 },
    };
    // After the reset there is no visit collection start (the wipe empties it) and no purge
    // record: nothing is cut (ADR-0170).
    expect(answer.visitsSince).toBeNull();
    expect(answer.visitsPurgedThrough).toBeNull();
    const coverage = { dataStart, visitsSince: null, visitsPurgedThrough: null };
    for (const metric of OBSERVATION_METRICS) {
      expect(answer[metric]).toEqual(
        weeks.map((week) => ({
          week: week.week,
          ...observationWeekFlags(week, metric, asOf, coverage),
          ...zeros[metric],
        })),
      );
      // The week holding the reading: open in every table, and never 자료 없음 on this database
      // (the two visit tables too: no collection start after the reset).
      expect(answer[metric][0]).toMatchObject({ inProgress: true, noData: false });
    }
    expect(answer.pendingTargetsEarlier).toBe(0);
    // The onboarded admin is in no cohort: admin at its onboarding by its grant record (95-1).
    expect(answer.firstFill.every((week) => week.accounts === 0)).toBe(true);

    // Counts and durations of the whole service: no field naming an account, a market, a post or
    // a report (95-6, 95-10).
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          collect(inner);
        }
      }
    };
    collect(answer);
    expect([...keys].sort()).toEqual(
      [
        'accounts',
        'afterSettlement',
        'asOf',
        'authors',
        'cases',
        'comments',
        'dataStart',
        'discussion',
        'filled',
        'firstFill',
        'inProgress',
        'markets',
        'medianMs',
        'noData',
        'p90Ms',
        'pairs',
        'pendingTargets',
        'pendingTargetsEarlier',
        'posts',
        'reportHandling',
        'resultView',
        'returned',
        'revisit',
        'revisited',
        'viewed',
        'visitsPurgedThrough',
        'visitsSince',
        'week',
      ].sort(),
    );
  });

  it('counts real onboardings, trades, a payout’s holder and the discussion, and reading writes nothing', async () => {
    const a = await onboarded(true);
    const b = await onboarded(true);
    const idle = await onboarded();
    // A payout: a SETTLING market with `a`'s fill in it and `a`'s losing holding's settlement
    // record (payout 0), then SETTLED now (96-2). The other side never had a record.
    const settled = (await createMarket(t.db, { status: 'settling', resolvedResult: 'YES' })).id;
    await createFillRecord(t.db, {
      marketId: settled,
      incomingOwnerId: a.id,
      restingOwnerId: (await createUser(t.db)).user.id,
      createdAt: new Date(now.getTime() - HOUR_MS),
    });
    await createSettlementRecord(t.db, { marketId: settled, userId: a.id, outcome: 'NO', qty: 1 });
    const settledAt = await clockTimestamp(t.db);
    await settleMarketAt(t.db, settled, settledAt);

    // `a` rests a NO bid, `b` meets it with a YES buy through the order route: one fill, two
    // human sides — both filled (96-1), and `a` back after the payout (96-2).
    const market = await createMarket(t.db);
    await openOrderIntake(t.db, { adminId: admin.id });
    expect(
      (await order(a, market.id, { outcome: 'NO', timeInForce: 'gtc', limitPriceCoin: 40 }))
        .statusCode,
    ).toBe(200);
    const filledRes = await order(b, market.id, {
      outcome: 'YES',
      timeInForce: 'ioc',
      limitPriceCoin: 99,
    });
    expect(filledRes.statusCode, filledRes.body).toBe(200);
    expect(
      (
        await t.db
          .select({ n: count() })
          .from(schema.fills)
          .where(eq(schema.fills.marketId, market.id))
      )[0]!.n,
    ).toBe(1);

    // 유효 토론: a post by `a`, a comment by `b` and a reply by `a`; a hidden comment and the
    // admin's own post (admin when it wrote) left out.
    const post = await createPost(t.db, { marketId: market.id, authorId: a.id });
    const comment = await createComment(t.db, { postId: post.id, authorId: b.id });
    await createComment(t.db, { postId: post.id, authorId: a.id, parentId: comment.id });
    await createComment(t.db, { postId: post.id, authorId: idle.id, hiddenAt: new Date() });
    await createPost(t.db, { marketId: settled, authorId: admin.id });

    const before = await rowCounts();
    const answer = await read();
    const again = await read();
    expect(await rowCounts()).toEqual(before);
    expect({ ...again, asOf: answer.asOf }).toEqual(answer);

    // 첫 체결 전환: `a`, `b` and `idle` onboarded this week, `a` and `b` filled; the admin out.
    const startedAt = await nicknameConfirmedAt(a.id);
    for (const who of [b, idle])
      expect(weekOf(await nicknameConfirmedAt(who.id))).toBe(weekOf(startedAt));
    expect(rowOf(answer, 'firstFill', startedAt)).toMatchObject({ accounts: 3, filled: 2 });
    for (const week of otherRows(answer, 'firstFill', startedAt)) {
      expect(week).toMatchObject({ accounts: 0, filled: 0 });
    }
    // 정산 후 재참여: one pair, back within 168 hours of the payout.
    expect(rowOf(answer, 'afterSettlement', settledAt)).toMatchObject({
      inProgress: true,
      noData: false,
      pairs: 1,
      returned: 1,
    });
    for (const week of otherRows(answer, 'afterSettlement', settledAt)) {
      expect(week).toMatchObject({ pairs: 0, returned: 0 });
    }
    // 유효 토론: one post, two comments (a reply included), two authors, one market.
    expect(rowOf(answer, 'discussion', post.createdAt)).toMatchObject({
      posts: 1,
      comments: 2,
      authors: 2,
      markets: 1,
    });
    for (const week of otherRows(answer, 'discussion', post.createdAt)) {
      expect(week).toMatchObject({ posts: 0, comments: 0, authors: 0, markets: 0 });
    }
  });

  describe('신고 처리 시간 (96-4) from the real closings', () => {
    let author: TestUser;
    let postId: string;

    beforeEach(async () => {
      author = await onboarded();
      const market = await createMarket(t.db);
      postId = (await createPost(t.db, { marketId: market.id, authorId: author.id })).id;
    });

    it('a dismissal: pending until it, then one case from the report to the dismissal', async () => {
      const reporter = await onboarded();
      const reportId = await report(postId, reporter);
      const [filed] = await t.db
        .select({ createdAt: schema.reports.createdAt })
        .from(schema.reports)
        .where(eq(schema.reports.id, reportId));

      const pending = await read();
      expect(rowOf(pending, 'reportHandling', filed!.createdAt)).toMatchObject({
        cases: 0,
        medianMs: null,
        p90Ms: null,
        pendingTargets: 1,
      });

      const dismissed = await send(
        '/admin/reports/dismiss',
        { reportIds: [reportId], reason: '위반 아님' },
        admin,
      );
      expect(dismissed.statusCode, dismissed.body).toBe(200);
      const { start, elapsedMs } = await closing([reportId]);
      const answer = await read();
      expect(rowOf(answer, 'reportHandling', start)).toMatchObject({
        cases: 1,
        medianMs: elapsedMs,
        p90Ms: elapsedMs,
        pendingTargets: 0,
      });
      for (const week of otherRows(answer, 'reportHandling', start)) {
        expect(week).toMatchObject({ cases: 0, pendingTargets: 0 });
      }
      expect(answer.pendingTargetsEarlier).toBe(0);
    });

    it('a hiding that closes two members’ reports on the post: one case from the earlier report', async () => {
      const first = await report(postId, await onboarded());
      const second = await report(postId, await onboarded());
      const hidden = await send(
        `/admin/moderation/posts/${postId}/hide`,
        { reason: 'spam' },
        admin,
      );
      expect(hidden.statusCode, hidden.body).toBe(200);
      const { start, elapsedMs } = await closing([first, second]);
      const answer = await read();
      expect(rowOf(answer, 'reportHandling', start)).toMatchObject({
        cases: 1,
        medianMs: elapsedMs,
        p90Ms: elapsedMs,
        pendingTargets: 0,
      });
    });

    it('an account-restriction approval closing the post’s report: one case, ended at the approval', async () => {
      const reportId = await report(postId, await onboarded());
      const second = await makeAdmin();
      const request = dataOf<{ id: string }>(
        await send(
          `/admin/moderation/users/${author.id}/account-restriction`,
          {
            reason: 'multi_account',
            note: '여러 계정으로 같은 시장 거래',
            days: 7,
            subject: { type: 'post', postId },
          },
          admin,
        ),
      );
      // The request alone closes nothing: still pending.
      const asked = await read();
      expect(asked.reportHandling.reduce((sum, week) => sum + week.cases, 0)).toBe(0);
      expect(asked.reportHandling.reduce((sum, week) => sum + week.pendingTargets, 0)).toBe(1);

      const approved = await send(
        `/admin/moderation/account-restriction-requests/${request.id}/approve`,
        { reason: '증거 확인' },
        second,
      );
      expect(approved.statusCode, approved.body).toBe(200);
      const { start, elapsedMs } = await closing([reportId]);
      const answer = await read();
      expect(rowOf(answer, 'reportHandling', start)).toMatchObject({
        cases: 1,
        medianMs: elapsedMs,
        p90Ms: elapsedMs,
        pendingTargets: 0,
      });
    });
  });

  describe('the visit-based cohorts (#151, ADR-0170) from the real watch, trades and visits', () => {
    /** A visit of `marketId`'s detail as `who`, through the route the web's detail calls. */
    const visit = (who: TestUser, marketId: string) => send('/me/market-visits', { marketId }, who);
    const watch = (who: TestUser, marketId: string) =>
      t.app.inject({
        method: 'PUT',
        url: `/api/v1/me/watchlist/${marketId}`,
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
        payload: JSON.stringify({ watched: true, expectedAccountId: who.id }),
      });
    async function firstWatchOf(userId: string): Promise<Date> {
      const [event] = await t.db
        .select({ createdAt: schema.marketWatchEvents.createdAt })
        .from(schema.marketWatchEvents)
        .where(eq(schema.marketWatchEvents.userId, userId));
      return event!.createdAt;
    }

    it('a watch through the route is a 재방문 pair its same-day visit does not revisit (D excluded, 95-12); the admin’s is no pair (8의 1)', async () => {
      const member = await onboarded();
      const market = await createMarket(t.db);
      const watched = await watch(member, market.id);
      expect(watched.statusCode, watched.body).toBe(200);
      const watchedAt = await firstWatchOf(member.id);
      const visited = await visit(member, market.id);
      expect(visited.statusCode, visited.body).toBe(204);
      expect(visited.body).toBe('');
      // The admin watches and opens it too: admin at its first watch by its grant record, so no
      // pair, and its visit is not kept (151-3).
      expect((await watch(admin, market.id)).statusCode).toBe(200);
      expect((await visit(admin, market.id)).statusCode).toBe(204);
      expect(await readVisits(t.db)).toEqual([
        { userId: member.id, marketId: market.id, date: kstDateOf(watchedAt) },
      ]);

      const before = await rowCounts();
      const answer = await read();
      expect(await rowCounts()).toEqual(before);
      expect(rowOf(answer, 'revisit', watchedAt)).toMatchObject({
        inProgress: true,
        noData: false,
        pairs: 1,
        revisited: 0,
      });
      for (const week of otherRows(answer, 'revisit', watchedAt)) {
        expect(week).toMatchObject({ pairs: 0, revisited: 0 });
      }
    });

    it('the traders of a market judged now are 결과 조회 pairs; a visit on the day of the publication counts once (D included, 95-4)', async () => {
      const a = await onboarded(true);
      const b = await onboarded(true);
      const market = await createMarket(t.db);
      await openOrderIntake(t.db, { adminId: admin.id });
      expect(
        (await order(a, market.id, { outcome: 'NO', timeInForce: 'gtc', limitPriceCoin: 40 }))
          .statusCode,
      ).toBe(200);
      const filledRes = await order(b, market.id, {
        outcome: 'YES',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
      });
      expect(filledRes.statusCode, filledRes.body).toBe(200);
      // Trading ends and the judgement is approved now: version 1 published (8의 9).
      await t.db
        .update(schema.markets)
        .set({ status: 'closed' })
        .where(eq(schema.markets.id, market.id));
      const { judgement } = await createProvisionalMarket(t.db, { marketId: market.id });
      const publishedAt = judgement.publishedAt;

      const judged = await read();
      expect(rowOf(judged, 'resultView', publishedAt)).toMatchObject({
        inProgress: true,
        noData: false,
        pairs: 2,
        viewed: 0,
      });
      // `a` opens the detail twice the same day — one row (95-4) — and the admin once: not kept.
      for (const who of [a, a, admin]) {
        const res = await visit(who, market.id);
        expect(res.statusCode, res.body).toBe(204);
      }
      expect(await readVisits(t.db)).toEqual([
        { userId: a.id, marketId: market.id, date: expect.any(String) as string },
      ]);

      const before = await rowCounts();
      const answer = await read();
      expect(await rowCounts()).toEqual(before);
      expect(rowOf(answer, 'resultView', publishedAt)).toMatchObject({
        inProgress: true,
        noData: false,
        pairs: 2,
        viewed: 1,
      });
      for (const week of otherRows(answer, 'resultView', publishedAt)) {
        expect(week).toMatchObject({ pairs: 0, viewed: 0 });
      }
    });
  });
});
