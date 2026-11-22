import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { lockAdminRoles, placeOrder, RECONCILIATION_NOTICES_FAILED_LOG, schema } from '@buddha/db';
import {
  completeOnboarding,
  closeTestMarket,
  createMarket,
  createMarketPause,
  createOpenedMarket,
  createScheduledMarket,
  createUser,
  createWatch,
  mintTestPairs,
  fundMarketMakerFunds,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  tradeOnce,
  withLedgerGuardsOff,
} from '@buddha/db/test';
import {
  reconciliationHoldDetailSchema,
  reconciliationRunSchema,
  type ReconciliationHoldDetail,
  type ReconciliationRun,
  type ReconciliationTarget,
} from '@buddha/shared';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

const origin = 'http://localhost:3000';
const base = '/api/v1/admin/reconciliation';

function signal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.skipIf(!hasTestInfra)('admin reconciliation (integration)', () => {
  let t: TestApp;
  let asker: TestUser;
  let approver: TestUser;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    asker = await admin();
    approver = await admin();
  });
  async function admin() {
    const account = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, account.id));
    await completeOnboarding(t.db, { userId: account.id });
    await t.app.get(AdminGuard).invalidate(account.id);
    return account;
  }
  const post = (path: string, who = asker, body: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: `${base}${path}`,
      headers: { origin, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...body },
    });
  const get = (path: string) =>
    t.app.inject({ method: 'GET', url: `${base}${path}`, headers: { cookie: asker.cookie } });
  async function run(target: ReconciliationTarget) {
    const res = await post('/run', asker, { target });
    expect(res.statusCode, `${JSON.stringify(target)} ${res.body}`).toBe(200);
    return reconciliationRunSchema.parse(res.json<{ data: ReconciliationRun }>().data);
  }
  async function tamper(userId: string, delta: number) {
    await withLedgerGuardsOff((client) =>
      client.query('UPDATE balances SET available_coin = available_coin + $1 WHERE user_id = $2', [
        delta,
        userId,
      ]),
    );
  }
  async function heldAccount() {
    const { user } = await createUser(t.db, { balanceCoin: 1_000n });
    await tamper(user.id, 1);
    const failed = await run({ scope: 'account', userId: user.id });
    expect(failed.result.passed).toBe(false);
    expect(failed.hold).not.toBeNull();
    await tamper(user.id, -1);
    const passed = await run({ scope: 'account', userId: user.id });
    expect(passed.result.passed).toBe(true);
    expect(passed.hold?.id).toBe(failed.hold?.id);
    return { userId: user.id, hold: failed.hold! };
  }
  async function request(hold: NonNullable<ReconciliationRun['hold']>) {
    const res = await post(`/holds/${hold.id}/recovery-requests`, asker, {
      failureResultId: hold.failureResultId,
      reason: '원인을 복구하고 대사 통과 확인',
    });
    expect(res.statusCode, res.body).toBe(200);
    return reconciliationHoldDetailSchema.parse(
      res.json<{ data: ReconciliationHoldDetail }>().data,
    );
  }
  const decisionPath = (holdId: string, requestId: string, action: string) =>
    `/holds/${holdId}/recovery-requests/${requestId}/${action}`;
  /** The account's notifications (#53), as the database holds them, newest first. */
  const noticesOf = (userId: string) =>
    t.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId))
      .orderBy(desc(schema.notifications.occurredAt));
  /**
   * `MarketPublisher.publishUser` watched: each `user:notification` as [account, ts, the account's
   * notifications committed when it was sent] — read on another connection, so a signal sent
   * before COMMIT would count none.
   */
  function signals() {
    const sent: [string, string, number][] = [];
    vi.spyOn(t.app.get(MarketPublisher), 'publishUser').mockImplementation(async (id, event) => {
      if (event.type === 'user:notification') {
        sent.push([id, event.ts, (await noticesOf(id)).length]);
      }
    });
    return sent;
  }

  async function brokenRecoveryMarket() {
    const { market } = await createScheduledMarket(t.db);
    await fundMarketMakerFunds(t.db, market.id, 1_000n);
    const [funds] = await t.db
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.marketId, market.id),
          eq(schema.ledgerAccounts.kind, 'market_maker_funds'),
        ),
      );
    const adjust = (delta: number) =>
      withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin = available_coin + $1 WHERE account_id = $2',
          [delta, funds!.id],
        ),
      );
    await adjust(1);
    const failed = await run({ scope: 'market', marketId: market.id });
    expect(failed.hold).not.toBeNull();
    await adjust(-1);
    expect((await run({ scope: 'market', marketId: market.id })).result.passed).toBe(true);
    const asked = await request(failed.hold!);
    // Owner-created damage after a valid request: cleanup must not need the missing assets.
    await withLedgerGuardsOff((client) =>
      client.query('DELETE FROM balances WHERE account_id = $1', [funds!.id]),
    );
    return { market, hold: failed.hold!, requestId: asked.requests[0]!.id };
  }

  it('records manual market/account/supply checks and pages evidence without creating healthy holds', async () => {
    const market = await createMarket(t.db);
    const { user } = await createUser(t.db, { balanceCoin: 123n });
    for (const target of [
      { scope: 'market', marketId: market.id },
      { scope: 'account', userId: user.id },
      { scope: 'supply' },
    ] as ReconciliationTarget[]) {
      expect(await run(target)).toMatchObject({
        result: { passed: true, source: 'manual' },
        hold: null,
      });
    }
    const first = await get('/results?limit=2');
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      data: ReconciliationRun['result'][];
      meta: { nextCursor: string };
    }>();
    expect(page.data).toHaveLength(2);
    const last = await get(`/results?limit=2&cursor=${encodeURIComponent(page.meta.nextCursor)}`);
    expect(last.json<{ data: unknown[] }>().data).toHaveLength(1);
    const filtered = await get(`/results?targetKey=${encodeURIComponent(`market:${market.id}`)}`);
    expect(filtered.json<{ data: unknown[] }>().data).toHaveLength(1);
    expect((await get('/holds')).json<{ data: unknown[] }>().data).toEqual([]);
    expect(
      await t.db
        .select()
        .from(schema.adminActions)
        .where(eq(schema.adminActions.type, 'reconciliation_run')),
    ).toHaveLength(3);
  });

  it('uses the canonical market key for a valid uppercase UUID', async () => {
    const market = await createMarket(t.db);
    const result = await run({ scope: 'market', marketId: market.id.toUpperCase() });
    expect(result.result).toMatchObject({
      marketId: market.id,
      targetKey: `market:${market.id}`,
      passed: true,
    });
    const filtered = await get(`/results?targetKey=${encodeURIComponent(`market:${market.id}`)}`);
    expect(filtered.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('rejects unknown targets and numeric identifiers that cannot survive the database boundary', async () => {
    for (const target of [
      { scope: 'market', marketId: randomUUID() },
      { scope: 'account', userId: 'missing-person' },
      { scope: 'account', accountId: '9007199254740991' },
    ]) {
      const res = await post('/run', asker, { target });
      expect(res.statusCode, res.body).toBe(404);
    }
    const unsafe = await post('/run', asker, {
      target: { scope: 'account', accountId: '9007199254740993' },
    });
    expect(unsafe.statusCode, unsafe.body).toBe(400);
    expect(await t.db.select().from(schema.reconciliationResults)).toHaveLength(0);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
  });

  it('keeps a clean account held until another admin approves a fresh check, exactly once', async () => {
    const { userId, hold } = await heldAccount();
    const asked = await request(hold);
    expect(asked.user?.id).toBe(userId);
    const id = asked.requests[0]!.id;
    for (const action of ['approve', 'reject']) {
      const self = await post(decisionPath(hold.id, id, action), asker, {
        reason: '본인 결정 거절',
      });
      expect(self.statusCode, self.body).toBe(409);
      expect(self.json()).toMatchObject({
        error: { code: 'APPROVAL_NOT_ALLOWED', details: [{ message: 'requester' }] },
      });
    }
    const res = await post(decisionPath(hold.id, id, 'approve'), approver, {
      reason: '별도 관리자 재검사 확인',
    });
    expect(res.statusCode, res.body).toBe(200);
    const recovered = res.json<{ data: ReconciliationHoldDetail }>().data;
    expect(recovered.hold.recoveredAt).not.toBeNull();
    expect(recovered.latestResult).toMatchObject({ passed: true, source: 'recovery' });
    expect(recovered.requests[0]).toMatchObject({
      status: 'approved',
      decidedBy: { id: approver.id },
    });
    expect((await get('/holds')).json<{ data: unknown[] }>().data).toEqual([]);
    expect((await get('/holds?state=all')).json<{ data: unknown[] }>().data).toHaveLength(1);
    const again = await post(decisionPath(hold.id, id, 'approve'), approver, { reason: '중복' });
    expect(again.statusCode).toBe(409);
    expect(await t.db.select().from(schema.reconciliationRecoveries)).toHaveLength(1);
  });

  it('does not approve a stale generation and permits rejecting it before a new request', async () => {
    const { userId, hold } = await heldAccount();
    const id = (await request(hold)).requests[0]!.id;
    await tamper(userId, 1);
    const failedAgain = await run({ scope: 'account', userId });
    expect(failedAgain.hold?.failureResultId).not.toBe(hold.failureResultId);
    await tamper(userId, -1);
    await run({ scope: 'account', userId });
    const stale = await post(decisionPath(hold.id, id, 'approve'), approver, { reason: '옛 요청' });
    expect(stale.statusCode, stale.body).toBe(400);
    expect(stale.json()).toMatchObject({ error: { details: [{ message: 'stale' }] } });
    const [pending] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, id));
    expect(pending?.status).toBe('pending');
    const rejected = await post(decisionPath(hold.id, id, 'reject'), approver, {
      reason: '새 실패가 발생하여 다시 요청',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const second = await request(failedAgain.hold!);
    const retracted = await post(decisionPath(hold.id, second.requests[0]!.id, 'retract'));
    expect(retracted.statusCode, retracted.body).toBe(200);
    expect(retracted.json<{ data: ReconciliationHoldDetail }>().data.requests[0]?.status).toBe(
      'retracted',
    );
    expect(await t.db.select().from(schema.reconciliationRecoveries)).toHaveLength(0);
  });

  it.each(['reject', 'retract'] as const)(
    'can %s a recovery request after a market balance disappears without changing assets or its hold',
    async (action) => {
      const { market, hold, requestId } = await brokenRecoveryMarket();
      const ledgerBefore = await t.db.select().from(schema.ledgerEntries);
      const balancesBefore = await t.db.select().from(schema.balances);
      const ordersBefore = await t.db.select().from(schema.orders);
      const holdsBefore = await t.db.select().from(schema.reconciliationHolds);
      const resultsBefore = await t.db.select().from(schema.reconciliationResults);
      const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');
      const book = vi.spyOn(t.app.get(MarketPublisher), 'publishBook');
      const response = await post(
        decisionPath(hold.id, requestId, action),
        action === 'reject' ? approver : asker,
        action === 'reject' ? { reason: '잔고 자료 손상으로 복구 요청 반려' } : {},
      );
      expect(response.statusCode, response.body).toBe(200);
      const detail = reconciliationHoldDetailSchema.parse(
        response.json<{ data: ReconciliationHoldDetail }>().data,
      );
      expect(detail.hold).toEqual(hold);
      expect(detail.market).toMatchObject({ id: market.id, status: 'scheduled' });
      expect(detail.requests[0]).toMatchObject({
        id: requestId,
        status: action === 'reject' ? 'rejected' : 'retracted',
        decidedBy: action === 'reject' ? { id: approver.id } : null,
      });
      expect(await t.db.select().from(schema.ledgerEntries)).toEqual(ledgerBefore);
      expect(await t.db.select().from(schema.balances)).toEqual(balancesBefore);
      expect(await t.db.select().from(schema.orders)).toEqual(ordersBefore);
      expect(await t.db.select().from(schema.reconciliationHolds)).toEqual(holdsBefore);
      expect(await t.db.select().from(schema.reconciliationResults)).toEqual(resultsBefore);
      expect(await t.db.select().from(schema.reconciliationRecoveries)).toEqual([]);
      expect(publish).not.toHaveBeenCalled();
      expect(book).not.toHaveBeenCalled();
      const actions = await t.db
        .select()
        .from(schema.adminActions)
        .where(eq(schema.adminActions.type, `reconciliation_recovery_${action}`));
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ targetId: hold.id, payload: { approvalId: requestId } });
    },
  );

  it('keeps cleanup authority and target checks when the recovery assets are damaged', async () => {
    const { hold, requestId } = await brokenRecoveryMarket();
    const self = await post(decisionPath(hold.id, requestId, 'reject'), asker, { reason: '본인' });
    expect(self.statusCode, self.body).toBe(409);
    expect(self.json()).toMatchObject({ error: { details: [{ message: 'requester' }] } });
    const other = await post(decisionPath(hold.id, requestId, 'retract'), approver);
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json()).toMatchObject({ error: { details: [{ message: 'not_requester' }] } });
    const foreign = await heldAccount();
    for (const action of ['reject', 'retract']) {
      const wrongHold = await post(decisionPath(foreign.hold.id, requestId, action), approver, {
        reason: '다른 보류의 요청',
      });
      expect(wrongHold.statusCode, wrongHold.body).toBe(404);
      const mismatch = await post(decisionPath(hold.id, requestId, action), approver, {
        expectedAccountId: asker.id,
        reason: '다른 계정 화면',
      });
      expect(mismatch.statusCode, mismatch.body).toBe(403);
    }
    const [pending] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, requestId));
    expect(pending?.status).toBe('pending');
    expect(await t.db.select().from(schema.reconciliationRecoveries)).toEqual([]);
  });

  it('rechecks on approval and rolls back the decision when the account broke after the request', async () => {
    const { userId, hold } = await heldAccount();
    const id = (await request(hold)).requests[0]!.id;
    await tamper(userId, 1);
    const res = await post(decisionPath(hold.id, id, 'approve'), approver, { reason: '확인' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: { details: [{ message: 'not_passed' }] } });
    const [row] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, id));
    expect(row?.status).toBe('pending');
    expect(await t.db.select().from(schema.reconciliationRecoveries)).toHaveLength(0);
    await tamper(userId, -1);
    expect(
      (await post(decisionPath(hold.id, id, 'approve'), approver, { reason: '복구 뒤 재시도' }))
        .statusCode,
    ).toBe(200);
  });

  it('binds decisions to their hold and kind, and enforces the screen account before any writes', async () => {
    const first = await heldAccount();
    const second = await heldAccount();
    const id = (await request(first.hold)).requests[0]!.id;
    const wrong = await post(decisionPath(second.hold.id, id, 'approve'), approver, {
      reason: '다른 대상',
    });
    expect(wrong.statusCode).toBe(404);
    const foreignKind = randomUUID();
    await t.db.insert(schema.approvalRequests).values({
      id: foreignKind,
      kind: 'market_review',
      targetType: 'reconciliation_hold',
      targetId: first.hold.id,
      requestedBy: asker.id,
      requestedAt: new Date(),
      requestReason: '다른 종류',
      payload: { holdId: first.hold.id, failureResultId: first.hold.failureResultId },
    });
    expect(
      (
        await post(decisionPath(first.hold.id, foreignKind, 'approve'), approver, {
          reason: '다른 종류',
        })
      ).statusCode,
    ).toBe(404);
    const before = await t.db.select().from(schema.reconciliationResults);
    const mismatch = await post('/run', approver, {
      expectedAccountId: asker.id,
      target: { scope: 'supply' },
    });
    expect(mismatch.statusCode, mismatch.body).toBe(403);
    expect(await t.db.select().from(schema.reconciliationResults)).toHaveLength(before.length);
  });

  it.each(['approve', 'reject', 'retract'] as const)(
    'revalidates the current administrator role for %s even when the route cache is stale',
    async (action) => {
      const { hold } = await heldAccount();
      const id = (await request(hold)).requests[0]!.id;
      const actor = action === 'retract' ? asker : approver;
      await get('/holds');
      // Populate the approver cache, then revoke behind it to exercise the transaction check.
      await t.app.inject({
        method: 'GET',
        url: `${base}/holds`,
        headers: { cookie: actor.cookie },
      });
      await t.db
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(eq(schema.profiles.userId, actor.id));
      const res = await post(decisionPath(hold.id, id, action), actor, { reason: '권한 없음' });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    },
  );

  it.each(['run', 'request'] as const)(
    'serialises %s with a user order and role grant without an assets-to-roles deadlock',
    async (operation) => {
      const held = operation === 'request' ? await heldAccount() : null;
      const userId = held?.userId ?? (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
      await completeOnboarding(t.db, { userId });
      await openOrderIntake(t.db, { adminId: asker.id });
      const { market } = await createOpenedMarket(t.db);
      const rolesLocked = signal();
      const updateRole = signal();
      const profileLocked = signal();
      const place = signal();
      const inspector = await t.db.$client.connect();
      // The role grant owns the roles lock; the order owns the user's profile. A reconciliation
      // must wait for roles before taking the key that the order needs. The former order was:
      // audit(key → roles), order(profile → key), grant(roles → profile), a three-party cycle.
      const grant = t.db.transaction(async (tx) => {
        await lockAdminRoles(tx, 'exclusive');
        rolesLocked.release();
        await updateRole.promise;
        await tx
          .update(schema.profiles)
          .set({ role: 'admin' })
          .where(eq(schema.profiles.userId, userId));
      });
      await rolesLocked.promise;
      const order = t.db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.userId, userId))
          .for('share');
        profileLocked.release();
        await place.promise;
        return placeOrder(tx, {
          marketId: market.id,
          ownerId: userId,
          requestId: randomUUID(),
          side: 'buy',
          outcome: 'YES',
          timeInForce: 'gtc',
          qty: 1,
          budgetCoin: null,
          limitPriceCoin: 40,
        });
      });
      await profileLocked.promise;
      const response =
        operation === 'run'
          ? post('/run', asker, { target: { scope: 'account', userId } }).then((value) => value)
          : post(`/holds/${held!.hold.id}/recovery-requests`, asker, {
              failureResultId: held!.hold.failureResultId,
              reason: '경합 중 복구 요청',
            }).then((value) => value);
      const completed = Promise.allSettled([response, order, grant]);
      try {
        await waitForLockWaiter(
          inspector,
          'reconciliation waits behind the administrator role grant',
        );
        place.release();
        updateRole.release();
        const outcomes = await completed;
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') throw outcome.reason;
        }
        const res = await response;
        expect(res.statusCode, res.body).toBe(200);
        expect((await order).kind).toBe('placed');
      } finally {
        place.release();
        updateRole.release();
        await completed;
        inspector.release();
      }
    },
  );

  it('keeps a scheduled market held after a clean audit when a reschedule makes its open due', async () => {
    const { market } = await createScheduledMarket(t.db);
    await fundMarketMakerFunds(t.db, market.id, 1_000n);
    const [funds] = await t.db
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.marketId, market.id),
          eq(schema.ledgerAccounts.kind, 'market_maker_funds'),
        ),
      );
    const adjust = (delta: number) =>
      withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin = available_coin + $1 WHERE account_id = $2',
          [delta, funds!.id],
        ),
      );
    await adjust(1);
    const failed = await run({ scope: 'market', marketId: market.id });
    expect(failed.hold).not.toBeNull();
    await adjust(-1);
    expect((await run({ scope: 'market', marketId: market.id })).result.passed).toBe(true);
    const opened = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${market.id}/reschedule`,
      headers: { origin, cookie: asker.cookie },
      payload: {
        expectedAccountId: asker.id,
        scheduledOpenAt: new Date(Math.floor(Date.now() / 60_000) * 60_000 - 120_000).toISOString(),
        reason: '개장 시각 변경',
      },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json<{ data: { status: string } }>().data.status).toBe('scheduled');
    expect(
      await t.db
        .select()
        .from(schema.marketEvents)
        .where(
          and(eq(schema.marketEvents.marketId, market.id), eq(schema.marketEvents.type, 'opened')),
        ),
    ).toHaveLength(0);
    expect(
      (await get(`/holds/${failed.hold!.id}`)).json<{ data: ReconciliationHoldDetail }>().data.hold
        .recoveredAt,
    ).toBeNull();
  });

  it('recovers a legacy held CANCELLED market, expires deferred orders once and publishes its book after commit', async () => {
    const { market } = await createOpenedMarket(t.db);
    const holder = await createUser(t.db, { balanceCoin: 1_000n });
    await completeOnboarding(t.db, { userId: holder.user.id });
    await openOrderIntake(t.db, { adminId: asker.id });
    const placed = await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: holder.user.id,
      outcome: 'YES',
      side: 'buy',
      qty: 2,
      limitPriceCoin: 60,
    });
    if (placed.kind !== 'placed' || placed.order.status !== 'open')
      throw new Error('Expected a resting order');
    const order = placed.order;
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure' });
    await passMarketClose(t.db, market.id);
    await closeTestMarket(t.db, market.id);
    const checked = await run({ scope: 'market', marketId: market.id });
    expect(checked.result.passed).toBe(true);
    expect(checked.hold?.legacyPauseId).not.toBeNull();
    const [before] = await t.db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(before?.status).toBe('open');
    const id = (await request(checked.hold!)).requests[0]!.id;
    const sent = signals();
    const publisher = t.app.get(MarketPublisher);
    const statuses = vi.spyOn(publisher, 'publishMarket');
    const books = vi.spyOn(publisher, 'publishBook').mockImplementation(async () => {
      const [committed] = await t.db
        .select()
        .from(schema.reconciliationHolds)
        .where(eq(schema.reconciliationHolds.id, checked.hold!.id));
      expect(committed?.recoveredAt).not.toBeNull();
    });
    const approved = await post(decisionPath(checked.hold!.id, id, 'approve'), approver, {
      reason: '마감 뒤 대사와 잠금 확인',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<{ data: ReconciliationHoldDetail }>().data.market?.status).toBe(
      'cancelled',
    );
    const [after] = await t.db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    const [balance] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, holder.user.id));
    expect(after?.status).toBe('expired');
    expect(balance).toMatchObject({ availableCoin: 1_000n, lockedCoin: 0n });
    expect(books).toHaveBeenCalledExactlyOnceWith([market.id], expect.any(Date));
    expect(statuses).not.toHaveBeenCalled();
    // #134 (52-5): the order's 만료 by 시장 취소, at the instant the recovery ended it, keyed by
    // the hold; signalled after COMMIT.
    const notices = await noticesOf(holder.user.id);
    expect(notices).toEqual([
      expect.objectContaining({
        type: 'orders_expired',
        category: 'trade',
        params: { marketTitle: market.title, cause: 'cancelled', orderCount: 1 },
        target: { kind: 'order', orderId: order.id },
        eventCount: 1,
        occurredAt: after!.endedAt,
        readAt: null,
      }),
    ]);
    const [key] = await t.db
      .select()
      .from(schema.notificationKeys)
      .where(eq(schema.notificationKeys.userId, holder.user.id));
    expect(key?.eventKey).toBe(`reconciliation_hold:${checked.hold!.id}`);
    expect(sent).toEqual([[holder.user.id, after!.endedAt!.toISOString(), 1]]);
    await post(decisionPath(checked.hold!.id, id, 'approve'), approver, { reason: '중복 승인' });
    expect(books).toHaveBeenCalledTimes(1);
    expect(await noticesOf(holder.user.id)).toEqual(notices);
    expect(sent).toHaveLength(1);
  });

  it('recovers a held CLOSED market: its deferred orders expire 거래 마감, one notice per member and market (#134, ADR-0158)', async () => {
    const { market } = await createOpenedMarket(t.db);
    await openOrderIntake(t.db, { adminId: asker.id });
    // A person's trade first, so the close takes the market to CLOSED, not CANCELLED (#20).
    const traded = await tradeOnce(t.db, market.id);
    const holder = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const single = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const rest = async (ownerId: string, limitPriceCoin: number) => {
      const placed = await placeTestOrder(t.db, { marketId: market.id, ownerId, limitPriceCoin });
      if (placed.kind !== 'placed' || placed.order.status !== 'open')
        throw new Error('Expected a resting order');
      return placed.order;
    };
    await rest(holder, 30);
    await rest(holder, 31);
    const lone = await rest(single, 32);
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure' });
    await passMarketClose(t.db, market.id);
    // The close of a held market keeps its orders live and notifies no expiry (G): only the
    // trade's two holders hear of the close itself, now (#54, 52-8).
    expect(await closeTestMarket(t.db, market.id)).toMatchObject({
      closed: true,
      notified: [traded.yes.userId, traded.no.userId].sort(),
      expiryNotified: 0,
    });
    const checked = await run({ scope: 'market', marketId: market.id });
    expect(checked.result.passed).toBe(true);
    const id = (await request(checked.hold!)).requests[0]!.id;
    const sent = signals();
    const approved = await post(decisionPath(checked.hold!.id, id, 'approve'), approver, {
      reason: '마감 뒤 대사와 잠금 확인',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<{ data: ReconciliationHoldDetail }>().data.market?.status).toBe('closed');
    const [ended] = await t.db.select().from(schema.orders).where(eq(schema.orders.id, lone.id));
    expect(ended).toMatchObject({ status: 'expired' });
    const params = { marketTitle: market.title, cause: 'closed' };
    expect(await noticesOf(holder)).toEqual([
      expect.objectContaining({
        type: 'orders_expired',
        params: { ...params, orderCount: 2 },
        target: { kind: 'order_history', marketId: market.id },
        occurredAt: ended!.endedAt,
      }),
    ]);
    expect(await noticesOf(single)).toEqual([
      expect.objectContaining({
        type: 'orders_expired',
        params: { ...params, orderCount: 1 },
        target: { kind: 'order', orderId: lone.id },
        occurredAt: ended!.endedAt,
      }),
    ]);
    const at = ended!.endedAt!.toISOString();
    expect([...sent].sort(([x], [y]) => x.localeCompare(y))).toEqual(
      [
        [holder, at, 1],
        [single, at, 1],
      ].sort(([x], [y]) => String(x).localeCompare(String(y))),
    );
  });

  it('automatically pauses broken markets as the system, telling its watchers and holders after COMMIT, and recovers through the existing pause approval, which tells the 재개 (#54 B′, 54-2·54-5)', async () => {
    const { market } = await createOpenedMarket(t.db);
    const yes = await createUser(t.db, { balanceCoin: 1_000n });
    const no = await createUser(t.db, { balanceCoin: 1_000n });
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: yes.user.id,
      noHolderId: no.user.id,
      qty: 2,
      yesPriceCoin: 60,
    });
    // A watcher, and the YES holder watching too: one notice each (53-4).
    const watcher = (await createUser(t.db)).user.id;
    await createWatch(t.db, { userId: watcher, marketId: market.id });
    await createWatch(t.db, { userId: yes.user.id, marketId: market.id });
    const audience = [yes.user.id, no.user.id, watcher].sort();
    const [collateral] = await t.db
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.marketId, market.id),
          eq(schema.ledgerAccounts.kind, 'market_collateral'),
        ),
      );
    const adjust = (delta: number) =>
      withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin = available_coin + $1 WHERE account_id = $2',
          [delta, collateral!.id],
        ),
      );
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');
    // `signals()`, keeping its spy for the call order.
    const sent: [string, string, number][] = [];
    const signalled = vi
      .spyOn(t.app.get(MarketPublisher), 'publishUser')
      .mockImplementation(async (id, event) => {
        if (event.type === 'user:notification') {
          sent.push([id, event.ts, (await noticesOf(id)).length]);
        }
      });
    await adjust(1);
    const response = await post('/run', asker, {
      target: { scope: 'market', marketId: market.id },
    });
    expect(response.statusCode, response.body).toBe(200);
    // The answer names nobody told and counts nobody (ADR-0064): its run and its hold alone.
    for (const id of audience) expect(response.body).not.toContain(id);
    const failed = reconciliationRunSchema.parse(response.json<{ data: ReconciliationRun }>().data);
    expect(Object.keys(response.json<{ data: object }>().data).sort()).toEqual(['hold', 'result']);
    expect(failed.result.passed).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      market.id,
      expect.objectContaining({ type: 'market:status', status: 'paused' }),
    );
    // 54-5: the system's pause is a 거래 일시 중단 like an admin's, reason 담보·원장 장애, keyed by
    // its event at the run's instant; signalled after COMMIT, after the status.
    const pausedEvent = (
      await t.db
        .select()
        .from(schema.marketEvents)
        .where(eq(schema.marketEvents.marketId, market.id))
        .orderBy(desc(schema.marketEvents.id))
    )[0]!;
    expect(pausedEvent).toMatchObject({ type: 'paused', actorId: null });
    expect(pausedEvent.createdAt.toISOString()).toBe(failed.result.checkedAt);
    const pausedNotice = {
      type: 'market_paused',
      category: 'market',
      params: { marketTitle: market.title, reason: 'ledger_failure' },
      target: { kind: 'market', slug: market.slug },
      occurredAt: pausedEvent.createdAt,
      eventCount: 1,
      readAt: null,
    };
    for (const id of audience) {
      expect(await noticesOf(id)).toEqual([expect.objectContaining(pausedNotice)]);
    }
    const keys = await t.db.select().from(schema.notificationKeys);
    expect(keys.map((key) => key.eventKey)).toEqual(
      audience.map(() => `market_event:${String(pausedEvent.id)}`),
    );
    expect([...sent].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))).toEqual(
      audience.map((id) => [id, failed.result.checkedAt, 1]),
    );
    expect(Math.min(...signalled.mock.invocationCallOrder)).toBeGreaterThan(
      publish.mock.invocationCallOrder[0]!,
    );
    const detail = await t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/markets/${market.id}`,
      headers: { cookie: asker.cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(
      detail.json<{ data: { pause: { history: { pausedBy: unknown }[] } } }>().data.pause
        .history[0]!.pausedBy,
    ).toBeNull();
    await adjust(-1);
    await run({ scope: 'market', marketId: market.id });
    const direct = await post(`/holds/${failed.hold!.id}/recovery-requests`, asker, {
      failureResultId: failed.hold!.failureResultId,
      reason: '일시 중단은 기존 승인 사용',
    });
    expect(direct.statusCode, direct.body).toBe(400);
    expect(direct.json()).toMatchObject({ error: { details: [{ message: 'paused' }] } });
    const [pause] = await t.db
      .select()
      .from(schema.marketPauses)
      .where(eq(schema.marketPauses.marketId, market.id));
    const asked = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${market.id}/pause-decisions`,
      headers: { origin, cookie: asker.cookie },
      payload: {
        expectedAccountId: asker.id,
        pauseId: pause!.id,
        path: 'resume',
        reason: '대사 통과 후 재개',
      },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const [requestRow] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.kind, 'market_pause_decision'));
    const approved = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${market.id}/pause-decisions/${requestRow!.id}/approve`,
      headers: { origin, cookie: approver.cookie },
      payload: { expectedAccountId: approver.id, reason: '최신 대사 확인' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<{ data: { status: string } }>().data.status).toBe('open');
    expect(
      (await get(`/holds/${failed.hold!.id}`)).json<{ data: ReconciliationHoldDetail }>().data.hold
        .recoveredAt,
    ).not.toBeNull();
    // Its approved 재개 (C) tells the same audience, with the ended pause's reason (52-9, 54-2).
    const [resumed] = await t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, market.id))
      .orderBy(desc(schema.marketEvents.id))
      .limit(1);
    expect(resumed!.type).toBe('resumed');
    for (const id of audience) {
      expect(await noticesOf(id)).toEqual([
        expect.objectContaining({
          type: 'market_resumed',
          params: { marketTitle: market.title, reason: 'ledger_failure' },
          target: { kind: 'market', slug: market.slug },
          occurredAt: resumed!.createdAt,
        }),
        expect.objectContaining(pausedNotice),
      ]);
    }
  });

  it('keeps the automatic pause when its notices cannot be written: none written or signalled, the fixed line logged with no id (54-6)', async () => {
    const { market } = await createOpenedMarket(t.db);
    const yes = await createUser(t.db, { balanceCoin: 1_000n });
    const no = await createUser(t.db, { balanceCoin: 1_000n });
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: yes.user.id,
      noHolderId: no.user.id,
      qty: 1,
    });
    // A slug the write path refuses (no DB CHECK holds `markets.slug`): its notices throw.
    await t.db
      .update(schema.markets)
      .set({ slug: 'Not A Slug' })
      .where(eq(schema.markets.id, market.id));
    const [collateral] = await t.db
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.marketId, market.id),
          eq(schema.ledgerAccounts.kind, 'market_collateral'),
        ),
      );
    await withLedgerGuardsOff((client) =>
      client.query(
        'UPDATE balances SET available_coin = available_coin + 1 WHERE account_id = $1',
        [collateral!.id],
      ),
    );
    const sent = signals();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failed = await run({ scope: 'market', marketId: market.id });
    expect(failed.result.passed).toBe(false);
    // The pause and the hold stand (54-6): the savepoint took only the notices back.
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id));
    expect(row!.status).toBe('paused');
    expect(failed.hold).not.toBeNull();
    expect(await t.db.select().from(schema.notifications)).toEqual([]);
    expect(await t.db.select().from(schema.notificationKeys)).toEqual([]);
    expect(sent).toEqual([]);
    expect(warn.mock.calls).toEqual([[RECONCILIATION_NOTICES_FAILED_LOG]]);
  });
});
