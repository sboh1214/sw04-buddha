/**
 * 정산 다시 시도 (#145, ADR-0163; 145-7 "1인, 사유 필수 … 매 분 자동 재시도와 같은 검사를 하고,
 * 지급액이나 검사를 바꾸지 못한다", 145-14 "지급 중(SETTLING)만"; #173 14항; ADR-0118) through
 * `POST /admin/markets/:id/settlement-retries` against the docker `test` profile:
 * - a settling market whose payout failed on a ledger hold, recovered through the real
 *   reconciliation routes, settles at the retry: the market SETTLED by the shared core (the
 *   `finalized` event's actor null), one `market_settlement_retry` `{reason, outcome: 'settled'}`
 *   written before the `finalized` event and the `market_settled` notices, the worker's publishes
 *   and the bot recall asked for;
 * - a still-held market answers 200 `failed` with the step's error and attempts read back, the
 *   action `{reason, outcome: 'failed', error}`, nothing paid and the market still settling —
 *   extra body keys (a skip, an amount) reaching nothing;
 * - a settling market without a result is a recorded failure, as the worker's own case;
 * - refusals record nothing: not settling (400 `status`), unknown (404), another admin on screen
 *   (403), an admin revoked while the request waited for the market lock (403, the role re-read
 *   in the transaction), a lock wait or lost connection before the attempt (409
 *   TRANSACTION_BUSY), and a failed record (500, the attempt not recorded at all);
 * - no double payout (N01 §10 "정산 재시도 중복 지급 없음", N03 §7 "반복 실행해도 한 번만
 *   지급한다"): a done coin step only reconciles and settles, a second retry is refused, two
 *   concurrent retries pay once, and a COMMIT whose acknowledgement was lost is answered `settled`
 *   by the request's own row (Q-C), never recorded as a failure.
 * Skips when TEST_* are unset.
 */
import { lockMarket, schema, settleMarketPositions } from '@buddha/db';
import type * as DbModule from '@buddha/db';
import { completeOnboarding, createMarket, createUser, mintTestPairs } from '@buddha/db/test';
import {
  SETTLEMENT_STEP_ERROR_MAX,
  adminSettlementRetryBodySchema,
  type AdminSettlementRetryResult,
  type MarketResult,
} from '@buddha/shared';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { bodyKeysOf, discoverRoutes } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';
import { SETTLEMENT_RETRY_UNRECORDED_LOG } from './settlement-retry.service.js';

/**
 * Faults planted in the shared core's two entry points the API calls, for the branches a real
 * database reaches only under load: a throw before the attempt (a lock wait that gave up, a lost
 * connection), a throw after the real attempt ran (an error text of any length), a failure record
 * that cannot be written, and — with the transaction spy below — a COMMIT whose acknowledgement is
 * lost. Everything else runs the real functions.
 */
const faults = vi.hoisted(() => ({
  beforeAttempt: null as Error | null,
  /** Thrown after the real attempt, inside its transaction, so the attempt rolls back. */
  afterAttempt: null as Error | null,
  recordFails: false,
  /** Set when the real retry body ran in the current transaction (for the lost acknowledgement). */
  ranRetry: false,
}));
vi.mock('@buddha/db', async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    retrySettlingMarket: async (...args: Parameters<typeof actual.retrySettlingMarket>) => {
      if (faults.beforeAttempt !== null) {
        const error = faults.beforeAttempt;
        faults.beforeAttempt = null;
        throw error;
      }
      const attempt = await actual.retrySettlingMarket(...args);
      if (faults.afterAttempt !== null) {
        const error = faults.afterAttempt;
        faults.afterAttempt = null;
        throw error;
      }
      faults.ranRetry = true;
      return attempt;
    },
    recordSettlementFailure: async (...args: Parameters<typeof actual.recordSettlementFailure>) => {
      if (faults.recordFails) {
        faults.recordFails = false;
        throw new Error('the record transaction failed');
      }
      return actual.recordSettlementFailure(...args);
    },
  };
});

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const REASON = '대사 보류를 복구했으니 지급을 다시 시도한다.';
/** A well-formed market id that names no market. */
const NO_MARKET = '3d9a1c7e-5b2f-4e8a-9c0d-1e2f3a4b5c6d';

type ErrorBody = {
  error: { code: string; details?: { path: (string | number)[]; message: string }[] };
};
type Res = { statusCode: number; json: <U>() => U; body: string };

describe('the 정산 다시 시도 route (static)', () => {
  it('takes the reason and the admin on screen, nothing else (145-7)', () => {
    const [route] = discoverRoutes().filter(
      (candidate) => candidate.key === 'POST /admin/markets/:id/settlement-retries',
    );
    expect(route).toBeDefined();
    expect([...bodyKeysOf(route!)].sort()).toEqual(['expectedAccountId', 'reason']);
    // No skip, amount, status or result can reach the payout: unknown keys are stripped.
    const parsed = adminSettlementRetryBodySchema.parse({
      reason: `  ${REASON}  `,
      expectedAccountId: NO_MARKET,
      skipReconciliation: true,
      payout: 1,
      status: 'settled',
    });
    expect(parsed).toEqual({ reason: REASON, expectedAccountId: NO_MARKET });
  });
});

describe.skipIf(!hasTestInfra)('정산 다시 시도 (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let other: TestUser;
  let publishMarket: MockInstance<MarketPublisher['publishMarket']>;
  let publishUser: MockInstance<MarketPublisher['publishUser']>;
  let recall: MockInstance<MarketJobs['recallMarketMaker']>;

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
    faults.beforeAttempt = null;
    faults.afterAttempt = null;
    faults.recordFails = false;
    faults.ranRetry = false;
    await t.reset();
    admin = await makeAdmin();
    other = await makeAdmin();
    publishMarket = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');
    publishUser = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
    recall = vi.spyOn(t.app.get(MarketJobs), 'recallMarketMaker').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const retry = (marketId: string, who: TestUser = admin, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${marketId}/settlement-retries`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { reason: REASON, expectedAccountId: who.id, ...payload },
    });
  const post = (url: string, who: TestUser, payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const dataOf = (res: Res) => res.json<{ data: AdminSettlementRetryResult }>().data;

  /** A SETTLING market with two holders of three pairs, its `coin` step pending. */
  async function settlingMarket(result: MarketResult | null = 'YES') {
    const market = await createMarket(t.db, {
      status: 'settling',
      resolvedResult: result,
      judgementVersion: null,
    });
    const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: yes,
      noHolderId: no,
      qty: 3,
      yesPriceCoin: 60,
    });
    return { market, yes, no };
  }

  /** A failed market reconciliation's hold: the payout refuses until it is recovered. */
  async function holdLedger(marketId: string): Promise<{ holdId: string; failureId: number }> {
    return t.db.transaction(async (tx) => {
      const at = await clockTimestamp(tx);
      const [failure] = await tx
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
          checkedAt: at,
          ledgerCursor: 0,
          findings: [{ code: 'account_balance', expected: '1', actual: '0' }],
          facts: {},
        })
        .returning();
      const [hold] = await tx
        .insert(schema.reconciliationHolds)
        .values({
          scope: 'market',
          targetKey: `market:${marketId}`,
          marketId,
          userId: null,
          failureResultId: failure!.id,
          startedAt: at,
        })
        .returning();
      return { holdId: hold!.id, failureId: failure!.id };
    });
  }

  const marketOf = async (id: string) =>
    (await t.db.select().from(schema.markets).where(eq(schema.markets.id, id)))[0]!;
  const stepOf = async (id: string) =>
    (
      await t.db
        .select()
        .from(schema.marketSettlementSteps)
        .where(eq(schema.marketSettlementSteps.marketId, id))
    )[0];
  const retriesOf = (id: string) =>
    t.db
      .select()
      .from(schema.adminActions)
      .where(
        and(
          eq(schema.adminActions.targetId, id),
          eq(schema.adminActions.type, 'market_settlement_retry'),
        ),
      )
      .orderBy(asc(schema.adminActions.createdAt));
  const eventsOf = (id: string) =>
    t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, id))
      .orderBy(asc(schema.marketEvents.id));
  const settledNoticesOf = (userIds: string[]) =>
    t.db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.type, 'market_settled'),
          inArray(schema.notifications.userId, userIds),
        ),
      );
  const books = async (id: string) => ({
    entries: await t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.marketId, id))
      .orderBy(asc(schema.ledgerEntries.id)),
    balances: await t.db.select().from(schema.balances).orderBy(asc(schema.balances.accountId)),
    records: await t.db
      .select()
      .from(schema.positionSettlements)
      .where(eq(schema.positionSettlements.marketId, id))
      .orderBy(asc(schema.positionSettlements.outcome)),
  });
  /** What a refused request must leave as it was. */
  const writtenFor = async (id: string) => ({
    market: await marketOf(id),
    step: await stepOf(id),
    events: (await eventsOf(id)).length,
    actions: (await t.db.select({ n: count() }).from(schema.adminActions))[0]!.n,
    books: await books(id),
  });

  function expectRefused(res: Res, status: number, code: string): ErrorBody['error'] {
    expect({ status: res.statusCode, code: res.json<ErrorBody>().error.code }).toEqual({
      status,
      code,
    });
    return res.json<ErrorBody>().error;
  }

  it('settles a market whose hold was recovered: the shared core, the row first, the worker’s publishes', async () => {
    const { market, yes, no } = await settlingMarket();
    const { holdId, failureId } = await holdLedger(market.id);

    // Held: the attempt runs, fails on the hold and is recorded (145-6 시도 횟수·마지막 오류).
    const failed = await retry(market.id);
    expect(failed.statusCode).toBe(200);
    expect(dataOf(failed)).toMatchObject({ outcome: 'failed', settlementAttempts: 1 });
    expect((await marketOf(market.id)).status).toBe('settling');

    // The cause fixed through the real routes: a clean check, then another admin's recovery.
    const run = await post('/api/v1/admin/reconciliation/run', admin, {
      target: { scope: 'market', marketId: market.id },
    });
    expect(run.statusCode).toBe(200);
    const requested = await post(
      `/api/v1/admin/reconciliation/holds/${holdId}/recovery-requests`,
      admin,
      { failureResultId: String(failureId), reason: '대사가 다시 맞아 보류를 푼다.' },
    );
    expect(requested.statusCode).toBe(200);
    const requestId = requested.json<{ data: { requests: { id: string }[] } }>().data.requests[0]!
      .id;
    const approved = await post(
      `/api/v1/admin/reconciliation/holds/${holdId}/recovery-requests/${requestId}/approve`,
      other,
      { reason: '확인했다.' },
    );
    expect(approved.statusCode).toBe(200);
    publishMarket.mockClear();
    publishUser.mockClear();
    recall.mockClear();

    const res = await retry(market.id);
    expect(res.statusCode).toBe(200);
    const after = await marketOf(market.id);
    expect(after.status).toBe('settled');
    expect(dataOf(res)).toEqual({ outcome: 'settled', statusEventId: String(after.statusEventId) });
    // The transition is the payout's own (actor null); the operator is the retry row.
    const finalized = (await eventsOf(market.id)).filter((event) => event.type === 'finalized');
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({ actorId: null, id: after.statusEventId });
    const rows = await retriesOf(market.id);
    expect(rows.map((row) => [row.adminId, row.payload])).toEqual([
      [admin.id, expect.objectContaining({ reason: REASON, outcome: 'failed' })],
      [admin.id, { reason: REASON, outcome: 'settled' }],
    ]);
    const settledRow = rows[1]!;
    expect(settledRow).toMatchObject({ targetType: 'market', targetId: market.id });
    expect(settledRow.createdAt.getTime()).toBeLessThanOrEqual(finalized[0]!.createdAt.getTime());
    // The step counts both attempts; its earlier error stays as the past trail (ADR-0118 결정 8).
    expect(await stepOf(market.id)).toMatchObject({ status: 'done', attempts: 2 });
    // One notice per holder, after the row: the core's notices stay the transaction's last call.
    const notices = await settledNoticesOf([yes, no]);
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice.createdAt.getTime()).toBeGreaterThanOrEqual(settledRow.createdAt.getTime());
    }
    // The worker's publishes: the status, the winner's balance, both positions, both signals.
    expect(publishMarket).toHaveBeenCalledTimes(1);
    expect(publishMarket).toHaveBeenCalledWith(
      market.id,
      expect.objectContaining({
        type: 'market:status',
        status: 'settled',
        resolvedResult: 'YES',
        statusEventId: String(after.statusEventId),
      }),
    );
    const sent = publishUser.mock.calls.map(([userId, event]) => [userId, event.type]);
    expect(sent).toEqual(
      expect.arrayContaining([
        [yes, 'user:balance'],
        [yes, 'user:position'],
        [no, 'user:position'],
        [yes, 'user:notification'],
        [no, 'user:notification'],
      ]),
    );
    expect(sent).toHaveLength(5);
    expect(recall).toHaveBeenCalledWith(market.id);
  });

  it('answers a still-held market 200 failed, records the attempt and pays nothing; extra keys reach nothing', async () => {
    const { market } = await settlingMarket();
    await holdLedger(market.id);
    const before = await books(market.id);
    const res = await retry(market.id, admin, {
      skipReconciliation: true,
      payout: 1,
      status: 'settled',
    });
    expect(res.statusCode).toBe(200);
    const step = await stepOf(market.id);
    expect(step).toMatchObject({ status: 'failed', attempts: 1 });
    expect(step!.lastError).toMatch(/ledger/i);
    expect(dataOf(res)).toEqual({
      outcome: 'failed',
      settlementLastError: step!.lastError,
      settlementAttempts: 1,
    });
    const [row, ...rest] = await retriesOf(market.id);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ adminId: admin.id, targetType: 'market', targetId: market.id });
    expect(row!.payload).toEqual({ reason: REASON, outcome: 'failed', error: step!.lastError });
    // The action and the step share the failure record's one instant.
    expect(row!.createdAt).toEqual(step!.updatedAt);
    expect(await books(market.id)).toEqual(before);
    expect((await marketOf(market.id)).status).toBe('settling');
    expect((await eventsOf(market.id)).filter((e) => e.type === 'finalized')).toEqual([]);
    expect(publishMarket).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();

    // A second attempt counts on the same step (145-6 시도 횟수).
    const again = await retry(market.id);
    expect(dataOf(again)).toMatchObject({ outcome: 'failed', settlementAttempts: 2 });
    expect(await retriesOf(market.id)).toHaveLength(2);
  });

  it('records a settling market without a result as a failed attempt (the worker’s own case)', async () => {
    const market = await createMarket(t.db, {
      status: 'settling',
      resolvedResult: null,
      judgementVersion: null,
    });
    const res = await retry(market.id);
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)).toEqual({
      outcome: 'failed',
      settlementLastError: expect.stringMatching(/without a result/) as string,
      settlementAttempts: 1,
    });
    const [row] = await retriesOf(market.id);
    expect(row!.payload).toMatchObject({ outcome: 'failed' });
  });

  it('cuts the recorded error to the step’s limit, on the step and on the retry row', async () => {
    const { market } = await settlingMarket();
    await t.db
      .update(schema.marketSettlementSteps)
      .set({ status: 'failed', attempts: 4 })
      .where(eq(schema.marketSettlementSteps.marketId, market.id));
    const before = await books(market.id);
    // The real attempt runs and pays out, then a long error rolls it all back.
    faults.afterAttempt = new Error('x'.repeat(SETTLEMENT_STEP_ERROR_MAX + 500));
    const res = await retry(market.id);
    expect(res.statusCode).toBe(200);
    const cut = 'x'.repeat(SETTLEMENT_STEP_ERROR_MAX);
    expect(dataOf(res)).toEqual({
      outcome: 'failed',
      settlementLastError: cut,
      settlementAttempts: 5,
    });
    expect(await stepOf(market.id)).toMatchObject({
      status: 'failed',
      attempts: 5,
      lastError: cut,
    });
    const [row, ...rest] = await retriesOf(market.id);
    expect(rest).toEqual([]);
    expect(row!.payload).toEqual({ reason: REASON, outcome: 'failed', error: cut });
    expect(await books(market.id)).toEqual(before);
    expect((await marketOf(market.id)).status).toBe('settling');
  });

  it('refuses a market that is not settling and records nothing (145-14)', async () => {
    for (const status of ['settled', 'resolved', 'closed', 'open'] as const) {
      const market = await createMarket(t.db, {
        status,
        resolvedResult: status === 'open' || status === 'closed' ? null : 'YES',
      });
      const before = await writtenFor(market.id);
      const error = expectRefused(await retry(market.id), 400, 'VALIDATION_ERROR');
      expect(error.details).toEqual([{ path: ['status'], message: 'not settling' }]);
      expect(await writtenFor(market.id)).toEqual(before);
    }
    expect(publishMarket).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
  });

  it('refuses an unknown market, another admin on screen and a missing reason, recording nothing', async () => {
    expectRefused(await retry(NO_MARKET), 404, 'NOT_FOUND');
    const { market } = await settlingMarket();
    const before = await writtenFor(market.id);
    expectRefused(await retry(market.id, admin, { expectedAccountId: other.id }), 403, 'FORBIDDEN');
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const error = expectRefused(
        await retry(market.id, admin, { reason }),
        400,
        'VALIDATION_ERROR',
      );
      expect(error.details?.[0]?.path).toEqual(['reason']);
    }
    expect(await writtenFor(market.id)).toEqual(before);
  });

  it('re-reads the role in the transaction: an admin revoked while it waited is refused (#171)', async () => {
    const { market } = await settlingMarket();
    const before = await writtenFor(market.id);
    const holder = await t.db.$client.connect();
    let pending: Promise<Res> | undefined;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [market.id]);
      pending = retry(market.id);
      await waitForLockWaiter(holder, 'the retry on its market lock');
      await t.db
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(eq(schema.profiles.userId, admin.id));
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [market.id]);
      holder.release();
    }
    expectRefused(await pending, 403, 'FORBIDDEN');
    expect(await writtenFor(market.id)).toEqual(before);
  });

  it('answers TRANSACTION_BUSY for a lock wait or a lost connection before the attempt, recording nothing (Q-B)', async () => {
    const { market } = await settlingMarket();
    const before = await writtenFor(market.id);
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    for (const error of [
      new Error('Failed query: select pg_advisory_xact_lock', { cause: timeout }),
      Object.assign(new Error('could not obtain lock'), { code: '55P03' }),
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      // pg's client-side read timeout: how a 30 s wait on the market lock ends in practice.
      new Error('Failed query: select pg_advisory_xact_lock', {
        cause: new Error('Query read timeout'),
      }),
      new Error('timeout exceeded when trying to connect'),
      new Error('Connection terminated unexpectedly'),
    ]) {
      faults.beforeAttempt = error;
      expectRefused(await retry(market.id), 409, 'TRANSACTION_BUSY');
    }
    // Anything else before the attempt answers as itself: a 500, nothing recorded either.
    faults.beforeAttempt = new Error('something else');
    expectRefused(await retry(market.id), 500, 'INTERNAL');
    expect(await writtenFor(market.id)).toEqual(before);
  });

  it('answers 500 when the attempt ran and could not be recorded: nothing of it is kept', async () => {
    const { market } = await settlingMarket();
    await holdLedger(market.id);
    const before = await writtenFor(market.id);
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    faults.recordFails = true;
    expectRefused(await retry(market.id), 500, 'INTERNAL');
    expect(await writtenFor(market.id)).toEqual(before);
    expect(await retriesOf(market.id)).toEqual([]);
    // One fixed line naming the market alone: no admin, reason or error text (ADR-0064).
    const lines = logged.mock.calls.map(([line]) => String(line));
    expect(lines).toContain(`${SETTLEMENT_RETRY_UNRECORDED_LOG} (market ${market.id})`);
    for (const line of lines) {
      expect(line).not.toContain(admin.id);
      expect(line).not.toContain(REASON);
    }
  });

  it('never pays twice: a done coin step only reconciles and settles; a second retry is refused (N01 §10)', async () => {
    const { market, yes, no } = await settlingMarket();
    // The coin step paid and committed; its completion reconciliation failed (ADR-0118 결정 8).
    const first = await t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      return settleMarketPositions(tx, market.id);
    });
    await t.db
      .update(schema.marketSettlementSteps)
      .set({ status: 'done', attempts: 1, completedAt: first.at, lastError: 'reconcile failed' })
      .where(eq(schema.marketSettlementSteps.marketId, market.id));
    const paid = await books(market.id);
    expect(paid.records).toHaveLength(2);

    const res = await retry(market.id);
    expect(dataOf(res)).toMatchObject({ outcome: 'settled' });
    expect((await marketOf(market.id)).status).toBe('settled');
    // Balances, ledger rows and payout records as the first payout left them.
    expect(await books(market.id)).toEqual(paid);
    expect(await stepOf(market.id)).toMatchObject({ status: 'done', attempts: 1 });
    // This run paid nothing, so it published no balance or position.
    expect(publishUser.mock.calls.map(([, event]) => event.type)).toEqual([
      'user:notification',
      'user:notification',
    ]);

    const second = await retry(market.id);
    expect(expectRefused(second, 400, 'VALIDATION_ERROR').details).toEqual([
      { path: ['status'], message: 'not settling' },
    ]);
    expect(await books(market.id)).toEqual(paid);
    expect(await retriesOf(market.id)).toHaveLength(1);
    expect(await settledNoticesOf([yes, no])).toHaveLength(2);
  });

  it('serializes two concurrent retries: one pays, the other is refused (one row, one payout)', async () => {
    const { market, yes, no } = await settlingMarket();
    const answers = await Promise.all([retry(market.id, admin), retry(market.id, other)]);
    const outcomes = answers
      .map((res) =>
        res.statusCode === 200
          ? dataOf(res).outcome
          : `${String(res.statusCode)} ${res.json<ErrorBody>().error.details?.[0]?.message ?? ''}`,
      )
      .sort();
    expect(outcomes).toEqual(['400 not settling', 'settled']);
    expect(await retriesOf(market.id)).toHaveLength(1);
    expect((await eventsOf(market.id)).filter((e) => e.type === 'finalized')).toHaveLength(1);
    const { entries, records } = await books(market.id);
    expect(records).toHaveLength(2);
    expect(entries.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT')).toHaveLength(1);
    expect(await settledNoticesOf([yes, no])).toHaveLength(2);
    expect(recall).toHaveBeenCalledTimes(1);
  });

  it('answers settled when the payout committed and only its acknowledgement was lost (Q-C)', async () => {
    const { market } = await settlingMarket();
    const real = t.db.transaction.bind(t.db);
    let lost = 0;
    vi.spyOn(t.db, 'transaction').mockImplementation(async (...args: Parameters<typeof real>) => {
      faults.ranRetry = false;
      const result = await real(...args);
      if (faults.ranRetry) {
        faults.ranRetry = false;
        lost += 1;
        throw new Error('Connection terminated unexpectedly');
      }
      return result;
    });
    const res = await retry(market.id);
    expect(res.statusCode).toBe(200);
    const after = await marketOf(market.id);
    expect(after.status).toBe('settled');
    expect(dataOf(res)).toEqual({ outcome: 'settled', statusEventId: String(after.statusEventId) });
    // The request's one row, settled; no failure written on the step or as a second row.
    const rows = await retriesOf(market.id);
    expect(rows.map((row) => row.payload)).toEqual([{ reason: REASON, outcome: 'settled' }]);
    expect(await stepOf(market.id)).toMatchObject({ status: 'done', attempts: 1, lastError: null });
    // The payout's own COMMIT landed and its answer was lost: the request never held the run's
    // events, so it publishes none; the recall is still asked for.
    expect(lost).toBe(1);
    expect(publishMarket).not.toHaveBeenCalled();
    expect(recall).toHaveBeenCalledWith(market.id);
  });
});
