/**
 * 운영 대기열 (#145, ADR-0163) through `GET /admin/operations/{closing,judgements,failures}`
 * against the docker `test` profile, on the database's own clock:
 * - 마감 예정 (145-1): OPEN and PAUSED markets closing within 24h (default), 3d or 7d, nearest
 *   first, a market whose close time passed before its close ran on top as `overdue` (145-18);
 *   paged; an unknown window refused;
 * - 판정 대기·지연 (145-2, 145-11, 145-17): every CLOSED market with its stage, and a PROVISIONAL
 *   one a dispute or a correction holds past its deadline; the current episode's 지연 기록, 갱신
 *   대기, the long-delay deadline (the shared function's instant) reached on CLOSED rows only, and
 *   '지연만';
 * - 정산 실패 (145-4, 145-8, 145-14, 145-15): the public 지급 지연 set with the step's attempts and
 *   stored error, the four 처리 멈춤 stages (retryable at 지급 완료 only), failed bot recalls only;
 *   the public detail keeps `payoutDelayed` alone;
 * - AC 3: reading every list, again and again, changes no row, no status and no result;
 * - the routes are every admin's and nobody else's (#171; admin-access.test walks the rest).
 * Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCorrectionRequest,
  createDispute,
  createJudgementDelay,
  createJudgementRequest,
  createMarket,
  createProvisionalMarket,
  createSettlementStep,
  type CreateMarketInput,
} from '@buddha/db/test';
import {
  longDelayDeadline,
  type AdminAwaitingJudgementMarket,
  type AdminClosingMarket,
  type AdminOperationsFailure,
  type Market,
} from '@buddha/shared';
import { asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { discoverRoutes } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Page<T> = { data: T[]; meta: { nextCursor: string | null } };
type ErrorBody = { error: { code: string; details?: { path: (string | number)[] }[] } };

describe('the routes #145 adds (static)', () => {
  it('are the three queue reads and the one retry, nothing that sets a status or a result', () => {
    const added = discoverRoutes()
      .map((route) => route.key)
      .filter((key) => /\/admin\/operations\b|\/settlement-retries\b/.test(key))
      .sort();
    expect(added).toEqual([
      'GET /admin/operations/closing',
      'GET /admin/operations/failures',
      'GET /admin/operations/judgements',
      'POST /admin/markets/:id/settlement-retries',
    ]);
  });
});

describe.skipIf(!hasTestInfra)('운영 대기열 lists (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  /** The database clock at the start of a case: every fixture's times are relative to it. */
  let now: Date;
  const at = (ms: number) => new Date(now.getTime() + ms);

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });

  /** An admin who finished the onboarding (ADR-0072), past the guard's role cache. */
  async function makeAdmin(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await completeOnboarding(t.db, { userId: user.id });
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }

  beforeEach(async () => {
    await t.reset();
    admin = await makeAdmin();
    now = await clockTimestamp(t.db);
  });

  /** As the admin unless another cookie — or none (`null`) — is given. */
  const get = (path: string, cookie: string | null = admin.cookie) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/${path}`,
      headers: cookie === null ? {} : { cookie },
    });
  async function page<T>(path: string): Promise<Page<T>> {
    const res = await get(path);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Page<T>>();
  }
  /** Every page of a list, `limit` at a time. */
  async function walk<T>(path: string, limit: number): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 50; n += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const next: Page<T> = await page<T>(
        `${path}${sep}limit=${String(limit)}${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      rows.push(...next.data);
      if (next.meta.nextCursor === null) return rows;
      cursor = encodeURIComponent(next.meta.nextCursor);
    }
    throw new Error('walk: too many pages');
  }
  function expectInvalid(res: { statusCode: number; json: <U>() => U }, path: string) {
    expect(res.statusCode).toBe(400);
    const error = res.json<ErrorBody>().error;
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details?.[0]?.path).toEqual([path]);
  }

  /** A CLOSED market whose scheduled judgement is `judgement` (null: none, as before #22). */
  function closedMarket(judgement: Date | null, input: CreateMarketInput = {}) {
    const close = judgement === null ? at(-2 * DAY_MS) : new Date(judgement.getTime() - DAY_MS);
    return createMarket(t.db, {
      status: 'closed',
      closeAt: close,
      eventDeadline: close,
      scheduledJudgementAt: judgement,
      ...input,
    });
  }

  /** A planted market-reconciliation hold: the market's payout waits for a recovery. */
  async function holdLedger(marketId: string) {
    const [failure] = await t.db
      .insert(schema.reconciliationResults)
      .values({
        scope: 'market',
        targetKey: `market:${marketId}`,
        marketId,
        accountId: null,
        userId: null,
        source: 'manual',
        actorId: null,
        passed: false,
        checkedAt: now,
        ledgerCursor: 0,
        findings: [{ code: 'account_balance', expected: '1', actual: '0' }],
        facts: {},
      })
      .returning();
    await t.db.insert(schema.reconciliationHolds).values({
      scope: 'market',
      targetKey: `market:${marketId}`,
      marketId,
      userId: null,
      failureResultId: failure!.id,
      startedAt: now,
    });
  }

  // ---- 마감 예정 (145-1) ------------------------------------------------------------------
  it('lists OPEN and PAUSED markets closing within 24h, 3d or 7d, overdue on top (145-1, 145-18)', async () => {
    const soon = await createMarket(t.db, { closeAt: at(2 * HOUR_MS) });
    const twoDays = await createMarket(t.db, { closeAt: at(2 * DAY_MS) });
    const paused = await createMarket(t.db, { status: 'paused', closeAt: at(5 * DAY_MS) });
    await createMarket(t.db, { closeAt: at(10 * DAY_MS) });
    const overdue = await createMarket(t.db, { closeAt: at(-5 * MINUTE_MS) });
    await createMarket(t.db, { status: 'closed', closeAt: at(-HOUR_MS) });
    await createMarket(t.db, { status: 'scheduled', closeAt: at(HOUR_MS) });

    const ids = async (query: string) =>
      (await page<AdminClosingMarket>(`closing${query}`)).data.map((row) => row.id);
    // 145-1 "처음 값은 24시간이다".
    expect(await ids('')).toEqual([overdue.id, soon.id]);
    expect(await ids('?within=24h')).toEqual([overdue.id, soon.id]);
    expect(await ids('?within=3d')).toEqual([overdue.id, soon.id, twoDays.id]);
    expect(await ids('?within=7d')).toEqual([overdue.id, soon.id, twoDays.id, paused.id]);

    const [first, second] = (await page<AdminClosingMarket>('closing')).data;
    expect(first).toEqual({
      id: overdue.id,
      slug: overdue.slug,
      title: overdue.title,
      status: 'open',
      closeAt: overdue.closeAt.toISOString(),
      scheduledJudgementAt: overdue.scheduledJudgementAt?.toISOString() ?? null,
      overdue: true,
    });
    expect(second).toMatchObject({ id: soon.id, overdue: false });
    expect((await page<AdminClosingMarket>('closing?within=7d')).data[3]).toMatchObject({
      status: 'paused',
      overdue: false,
    });
    // One page at a time, the same rows in the same order.
    expect((await walk<AdminClosingMarket>('closing?within=7d', 1)).map((row) => row.id)).toEqual([
      overdue.id,
      soon.id,
      twoDays.id,
      paused.id,
    ]);

    expectInvalid(await get('closing?within=1h'), 'within');
  });

  // ---- 판정 대기·지연 (145-2, 145-11, 145-17) ---------------------------------------------
  it('lists every CLOSED market and every held PROVISIONAL one past its deadline, with stage and delay (145-2)', async () => {
    const unregistered = await closedMarket(at(-3 * DAY_MS), { longDelayDays: 14 });
    const delay = await createJudgementDelay(t.db, {
      marketId: unregistered.id,
      reason: '1차 출처의 발표가 미뤄졌다',
      recordedAt: at(-2 * DAY_MS),
    });
    const awaiting = await closedMarket(at(-2 * HOUR_MS));
    const request = await createJudgementRequest(t.db, { marketId: awaiting.id });
    const longDelayed = await closedMarket(at(-20 * DAY_MS), { longDelayDays: 14 });
    const notYet = await closedMarket(at(DAY_MS));
    const noJudgementTime = await closedMarket(null);

    const pastDeadline = () =>
      createProvisionalMarket(t.db, { publishedAt: at(-HOUR_MS), disputeWindowMinutes: 1 });
    const disputed = (await pastDeadline()).market;
    await createDispute(t.db, { marketId: disputed.id, submittedAt: at(-HOUR_MS) });
    const correcting = (await pastDeadline()).market;
    const correction = await createCorrectionRequest(t.db, {
      marketId: correcting.id,
      requestedAt: at(-30 * MINUTE_MS),
    });
    // Not listed: nothing holds it (the worker confirms it), its deadline is ahead, or it trades.
    const free = (await pastDeadline()).market;
    const early = (await createProvisionalMarket(t.db, { publishedAt: at(-MINUTE_MS) })).market;
    await createDispute(t.db, { marketId: early.id, submittedAt: at(-MINUTE_MS) });
    await createMarket(t.db, { status: 'open' });

    const { data, meta } = await page<AdminAwaitingJudgementMarket>('judgements?limit=100');
    expect(meta.nextCursor).toBeNull();
    const byId = (id: string) => data.find((row) => row.id === id);
    expect(new Set(data.map((row) => row.id))).toEqual(
      new Set([
        unregistered.id,
        awaiting.id,
        longDelayed.id,
        notYet.id,
        noJudgementTime.id,
        disputed.id,
        correcting.id,
      ]),
    );
    expect(byId(free.id)).toBeUndefined();
    expect(byId(early.id)).toBeUndefined();

    // Stage, the current 지연 기록 and 갱신 대기 (its next review, a day after it, has passed).
    expect(byId(unregistered.id)).toEqual({
      id: unregistered.id,
      slug: unregistered.slug,
      title: unregistered.title,
      status: 'closed',
      stage: 'unregistered',
      closeAt: unregistered.closeAt.toISOString(),
      scheduledJudgementAt: at(-3 * DAY_MS).toISOString(),
      disputeDeadline: null,
      judgementRequestId: null,
      holdingDisputes: 0,
      correctionPending: false,
      delay: {
        reason: '1차 출처의 발표가 미뤄졌다',
        nextReviewAt: delay.delay.nextReviewAt.toISOString(),
        recordedAt: delay.delay.recordedAt.toISOString(),
      },
      reviewOverdue: true,
      longDelayDeadline: longDelayDeadline(at(-3 * DAY_MS).toISOString(), 14),
      longDelayReached: false,
      delayed: true,
    });
    expect(byId(awaiting.id)).toMatchObject({
      stage: 'awaiting_approval',
      judgementRequestId: request.id,
      delay: null,
      reviewOverdue: false,
    });
    // ADR-0098 13: the deadline is the shared function's instant; reached on CLOSED (145-17).
    expect(byId(longDelayed.id)).toMatchObject({
      longDelayDeadline: longDelayDeadline(at(-20 * DAY_MS).toISOString(), 14),
      longDelayReached: true,
      delayed: true,
    });
    expect(byId(notYet.id)).toMatchObject({ stage: 'unregistered', delayed: false });
    expect(byId(noJudgementTime.id)).toMatchObject({
      scheduledJudgementAt: null,
      longDelayDeadline: null,
      longDelayReached: false,
      delayed: false,
    });
    expect(byId(disputed.id)).toMatchObject({
      status: 'provisional',
      stage: 'dispute_or_correction',
      holdingDisputes: 1,
      correctionPending: false,
      longDelayReached: false,
      delayed: true,
    });
    expect(byId(correcting.id)).toMatchObject({
      stage: 'dispute_or_correction',
      holdingDisputes: 0,
      correctionPending: true,
      judgementRequestId: correction.id,
      delayed: true,
    });
    // By scheduled judgement, none last (145-2 "예정 판정 시각 순").
    const order = data.map((row) => row.scheduledJudgementAt);
    const known = order.filter((value): value is string => value !== null);
    expect(known).toEqual([...known].sort());
    expect(order.at(-1)).toBeNull();

    // '지연만' keeps the delayed rows, in the same order; every page the same.
    const delayed = (
      await page<AdminAwaitingJudgementMarket>('judgements?filter=delayed&limit=100')
    ).data;
    expect(delayed.map((row) => row.id)).toEqual(
      data.filter((row) => row.delayed).map((row) => row.id),
    );
    expect(delayed.map((row) => row.id)).not.toContain(notYet.id);
    expect(delayed.map((row) => row.id)).not.toContain(noJudgementTime.id);
    expect(
      (await walk<AdminAwaitingJudgementMarket>('judgements', 2)).map((row) => row.id),
    ).toEqual(data.map((row) => row.id));
    expectInvalid(await get('judgements?filter=late'), 'filter');
  });

  // ---- 정산 실패 (145-4, 145-6, 145-8, 145-14, 145-15) -----------------------------------
  it('lists 정산 실패, the four 처리 멈춤 stages and failed bot recalls, oldest first (145-4, 145-15)', async () => {
    const settling = (resolvedAgoMs: number, steps = false) =>
      createMarket(t.db, {
        status: 'settling',
        resolvedResult: 'YES',
        resolvedAt: at(-resolvedAgoMs),
        settlementSteps: steps,
      });
    const failed = await settling(3 * HOUR_MS);
    await createSettlementStep(t.db, {
      marketId: failed.id,
      status: 'failed',
      attempts: 3,
      lastError: 'XX000 the payout failed',
    });
    const held = await settling(HOUR_MS, true);
    await holdLedger(held.id);
    // 처리 멈춤: each automatic transition due two hours ago (145-4: 30 minutes).
    const closeStuck = await createMarket(t.db, { closeAt: at(-2 * HOUR_MS) });
    const startStuck = await createMarket(t.db, {
      status: 'resolved',
      resolvedResult: 'NO',
      resolvedAt: at(-2 * HOUR_MS),
    });
    const completeStuck = await settling(2 * HOUR_MS, true);
    const confirmStuck = (
      await createProvisionalMarket(t.db, {
        publishedAt: at(-3 * HOUR_MS),
        disputeWindowMinutes: 1,
      })
    ).market;
    // Not yet: due minutes ago.
    const fresh = await settling(5 * MINUTE_MS, true);
    // SETTLED with a stale error: the past failure trail (ADR-0118 결정 8).
    const settled = await createMarket(t.db, {
      status: 'settled',
      resolvedResult: 'YES',
      settlementSteps: false,
    });
    await createSettlementStep(t.db, {
      marketId: settled.id,
      status: 'done',
      attempts: 2,
      completedAt: at(-HOUR_MS),
      lastError: 'old',
    });
    const recallFailed = await createMarket(t.db, { status: 'settled', resolvedResult: 'YES' });
    // Its `since` is when it ended (the terminal event), not the recall's moving last failure.
    const [settledEvent] = await t.db
      .insert(schema.marketEvents)
      .values({
        marketId: recallFailed.id,
        type: 'settled',
        toStatus: 'settled',
        createdAt: at(-5 * HOUR_MS),
      })
      .returning({ id: schema.marketEvents.id });
    await t.db
      .update(schema.markets)
      .set({ statusEventId: settledEvent!.id })
      .where(eq(schema.markets.id, recallFailed.id));
    const recallWaiting = await createMarket(t.db, { status: 'cancelled' });
    await t.db.insert(schema.marketMakerRecallAttempts).values([
      {
        marketId: recallFailed.id,
        attempts: 4,
        state: 'failed',
        reason: 'execution_failed',
        lastAttemptAt: at(-4 * HOUR_MS),
        lastFailureAt: at(-4 * HOUR_MS),
        lastFailureReason: 'execution_failed',
      },
      {
        marketId: recallWaiting.id,
        attempts: 2,
        state: 'waiting',
        reason: 'ledger_hold',
        lastAttemptAt: at(-HOUR_MS),
      },
    ]);

    const { data } = await page<AdminOperationsFailure>('failures?limit=100');
    const kinds = data.map((row) => [row.kind, row.id, row.retryable]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['settlement_failed', failed.id, true],
        ['settlement_failed', held.id, true],
        ['stuck', closeStuck.id, false],
        ['stuck', startStuck.id, false],
        ['stuck', completeStuck.id, true],
        ['stuck', confirmStuck.id, false],
        ['recall_failed', recallFailed.id, false],
      ]),
    );
    expect(kinds).toHaveLength(7);
    for (const absent of [fresh, settled, recallWaiting]) {
      expect(data.find((row) => row.id === absent.id)).toBeUndefined();
    }
    // Oldest problem first.
    const since = data.map((row) => row.since);
    expect(since).toEqual([...since].sort());
    expect(data[0]).toMatchObject({ id: recallFailed.id });

    const stageOf = (id: string) => {
      const row = data.find((candidate) => candidate.id === id);
      return row?.kind === 'stuck' ? row.stage : undefined;
    };
    expect([closeStuck, confirmStuck, startStuck, completeStuck].map((m) => stageOf(m.id))).toEqual(
      ['close', 'confirm', 'start', 'complete'],
    );
    expect(data.find((row) => row.id === failed.id)).toMatchObject({
      status: 'settling',
      since: at(-3 * HOUR_MS).toISOString(),
      settlement: {
        stepStatus: 'failed',
        settlementAttempts: 3,
        settlementLastError: 'XX000 the payout failed',
        ledgerHeld: false,
      },
    });
    expect(data.find((row) => row.id === held.id)).toMatchObject({
      settlement: { stepStatus: 'pending', ledgerHeld: true },
    });
    expect(data.find((row) => row.id === recallFailed.id)).toMatchObject({
      since: at(-5 * HOUR_MS).toISOString(),
      recall: {
        recallAttempts: 4,
        recallReason: 'execution_failed',
        lastFailureAt: at(-4 * HOUR_MS).toISOString(),
      },
    });
    expect((await walk<AdminOperationsFailure>('failures', 2)).map((row) => row.id)).toEqual(
      data.map((row) => row.id),
    );

    // The public detail keeps the one flag (ADR-0121): late for 정산 실패, never the error text.
    for (const [market, late] of [
      [failed, true],
      [held, true],
      [completeStuck, false],
    ] as const) {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${market.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: Market }>().data.judgingRecord.payoutDelayed, market.id).toBe(late);
      expect(res.body).not.toContain('XX000 the payout failed');
      expect(res.body).not.toMatch(/settlementAttempts|settlementLastError|recallAttempts/);
    }
  });

  // ---- AC 3 ------------------------------------------------------------------------------
  it('changes nothing however often it is read: no row, no status, no result (AC 3)', async () => {
    const delayed = await closedMarket(at(-20 * DAY_MS), { longDelayDays: 14 });
    await createJudgementDelay(t.db, {
      marketId: delayed.id,
      reason: '검토가 늦어진다',
      recordedAt: at(-3 * DAY_MS),
    });
    const overdue = await createMarket(t.db, { closeAt: at(-2 * HOUR_MS) });
    const heldJudged = (
      await createProvisionalMarket(t.db, { publishedAt: at(-HOUR_MS), disputeWindowMinutes: 1 })
    ).market;
    await createDispute(t.db, { marketId: heldJudged.id, submittedAt: at(-HOUR_MS) });
    const failed = await createMarket(t.db, {
      status: 'settling',
      resolvedResult: 'NO',
      resolvedAt: at(-2 * HOUR_MS),
      settlementSteps: false,
    });
    await createSettlementStep(t.db, { marketId: failed.id, status: 'failed', attempts: 1 });
    const resolved = await createMarket(t.db, {
      status: 'resolved',
      resolvedResult: 'YES',
      resolvedAt: at(-2 * HOUR_MS),
    });

    const snapshot = async () => ({
      markets: await t.db
        .select({
          id: schema.markets.id,
          status: schema.markets.status,
          resolvedResult: schema.markets.resolvedResult,
          statusEventId: schema.markets.statusEventId,
          updatedAt: schema.markets.updatedAt,
        })
        .from(schema.markets)
        .orderBy(asc(schema.markets.id)),
      events: (await t.db.select({ n: count() }).from(schema.marketEvents))[0]!.n,
      actions: (await t.db.select({ n: count() }).from(schema.adminActions))[0]!.n,
      steps: await t.db
        .select()
        .from(schema.marketSettlementSteps)
        .orderBy(asc(schema.marketSettlementSteps.marketId)),
      delays: (await t.db.select({ n: count() }).from(schema.marketJudgementDelays))[0]!.n,
      notifications: (await t.db.select({ n: count() }).from(schema.notifications))[0]!.n,
    });
    const before = await snapshot();
    for (let round = 0; round < 3; round += 1) {
      for (const path of [
        'closing',
        'closing?within=7d',
        'judgements',
        'judgements?filter=delayed',
        'failures',
      ]) {
        expect((await get(path)).statusCode).toBe(200);
      }
    }
    expect(await snapshot()).toEqual(before);
    // Listed as late and still what it was: 늦었다고 NO가 되지 않는다 (N03 §4).
    const judgements = (await page<AdminAwaitingJudgementMarket>('judgements?filter=delayed')).data;
    expect(judgements.find((row) => row.id === delayed.id)).toMatchObject({
      status: 'closed',
      longDelayReached: true,
    });
    for (const market of [delayed, overdue, heldJudged, failed, resolved]) {
      const row = before.markets.find((candidate) => candidate.id === market.id)!;
      expect(row.status).toBe(market.status);
    }
  });

  // ---- #171 -------------------------------------------------------------------------------
  it('answers a member 403 and no session 401 on every list (#171, ADR-0056 1-2)', async () => {
    const member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
    for (const path of ['closing', 'judgements', 'failures']) {
      expect((await get(path, member.cookie)).statusCode).toBe(403);
      expect((await get(path, null)).statusCode).toBe(401);
    }
  });
});
