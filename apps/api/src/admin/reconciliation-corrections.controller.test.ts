import { randomUUID } from 'node:crypto';
import { lockAdminRoles, schema } from '@buddha/db';
import {
  completeOnboarding,
  createMarket,
  createStartGrant,
  createUser,
  fundTestTreasury,
  ledgerSupply,
  mintTestPairs,
  recordLegacyCorrectionForTest,
  withLedgerGuardsOff,
} from '@buddha/db/test';
import {
  memberReconciliationCorrectionSchema,
  reconciliationCorrectionDetailSchema,
  reconciliationCorrectionRequestSchema,
  reconciliationRunSchema,
  type ReconciliationCorrectionCandidate,
  type ReconciliationCorrectionDetail,
  type UserBalanceEvent,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

const origin = 'http://localhost:3000';
const base = '/api/v1/admin/reconciliation';
const ownHistory = '/api/v1/me/reconciliation-corrections';
const internalReason = 'INTERNAL_CORRECTION_REQUEST_DO_NOT_DISCLOSE';
const approvalReason = 'INTERNAL_APPROVAL_DO_NOT_DISCLOSE';
const userReason = '원장 대사에서 확인한 Coin 내역을 바로잡았습니다.';

describe.skipIf(!hasTestInfra)('Coin correction approval and member privacy (integration)', () => {
  let t: TestApp;
  let asker: TestUser;
  let approver: TestUser;
  let member: TestUser;
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
    member = await signUpTestUser(t);
    await createStartGrant(t.db, { userId: member.id, amountCoin: 100n });
  });
  async function admin() {
    const who = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, who.id));
    await completeOnboarding(t.db, { userId: who.id });
    await t.app.get(AdminGuard).invalidate(who.id);
    return who;
  }
  const post = (path: string, who = asker, body: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: `${base}${path}`,
      headers: { origin, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...body },
    });
  const get = (path: string, who = asker) =>
    t.app.inject({ method: 'GET', url: `${base}${path}`, headers: { cookie: who.cookie } });
  const history = (who = member, query = '') =>
    t.app.inject({ method: 'GET', url: `${ownHistory}${query}`, headers: { cookie: who.cookie } });
  async function tamper(delta: number) {
    await withLedgerGuardsOff((client) =>
      client.query('UPDATE balances SET available_coin=available_coin+$1 WHERE user_id=$2', [
        delta,
        member.id,
      ]),
    );
  }
  async function audit() {
    const res = await post('/run', asker, { target: { scope: 'account', userId: member.id } });
    expect(res.statusCode, res.body).toBe(200);
    return reconciliationRunSchema.parse(res.json<{ data: unknown }>().data);
  }
  async function broken(delta = -10) {
    await tamper(delta);
    const run = await audit();
    expect(run.result.passed).toBe(false);
    const res = await get(`/results/${run.result.id}/corrections`);
    expect(res.statusCode, res.body).toBe(200);
    const detail = reconciliationCorrectionDetailSchema.parse(res.json<{ data: unknown }>().data);
    expect(detail.candidates).toHaveLength(1);
    return { detail, candidate: detail.candidates[0]!, holdId: run.hold!.id };
  }
  function body(candidate: ReconciliationCorrectionCandidate) {
    return {
      accountId: candidate.accountId,
      mode: candidate.mode,
      amountCoin: candidate.amountCoin,
      snapshotKey: candidate.snapshotKey,
      reason: internalReason,
      userReason,
    };
  }
  async function request(
    detail: ReconciliationCorrectionDetail,
    candidate = detail.candidates[0]!,
  ) {
    const res = await post(
      `/results/${detail.result.id}/correction-requests`,
      asker,
      body(candidate),
    );
    expect(res.statusCode, res.body).toBe(200);
    const value = reconciliationCorrectionDetailSchema.parse(res.json<{ data: unknown }>().data);
    return value.requests[0]!;
  }
  const decisionPath = (resultId: string, requestId: string, action = 'approve') =>
    `/results/${resultId}/correction-requests/${requestId}/${action}`;
  async function balance() {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, member.id));
    return row!;
  }
  async function fundTreasury(amountCoin: bigint) {
    await fundTestTreasury(t.db, amountCoin);
  }

  it('restores only the missing 10, preserves the old ledger and supply, and publishes once after commit', async () => {
    const { detail, candidate, holdId } = await broken();
    expect(candidate).toMatchObject({
      mode: 'restore_actual',
      amountCoin: '10',
      balanceDeltaCoin: '10',
      balanceBeforeCoin: '90',
      balanceAfterCoin: '100',
      ledgerBeforeCoin: '100',
      ledgerAfterCoin: '100',
    });
    const ledgerBefore = await t.db
      .select()
      .from(schema.ledgerEntries)
      .orderBy(schema.ledgerEntries.id);
    const asked = await request(detail);
    expect(await balance()).toMatchObject({ availableCoin: 90n, ledgerCoin: 100n });
    expect((await history()).json<{ data: unknown[] }>().data).toEqual([]);
    for (const action of ['approve', 'reject']) {
      const res = await post(decisionPath(detail.result.id, asked.id, action), asker, {
        reason: '본인 결정',
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: 'APPROVAL_NOT_ALLOWED', details: [{ message: 'requester' }] },
      });
    }
    const published: UserBalanceEvent[] = [];
    vi.spyOn(t.app.get(MarketPublisher), 'publishUser').mockImplementation(
      async (userId, event) => {
        // This connection sees only committed rows. Publishing inside the write would see none.
        expect(userId).toBe(member.id);
        expect(await t.db.select().from(schema.reconciliationCorrections)).toHaveLength(1);
        expect(event.type).toBe('user:balance');
        published.push(event as UserBalanceEvent);
      },
    );
    const res = await post(decisionPath(detail.result.id, asked.id), approver, {
      reason: approvalReason,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      reconciliationCorrectionDetailSchema.parse(res.json<{ data: unknown }>().data).requests[0]
        ?.status,
    ).toBe('approved');
    expect(await balance()).toMatchObject({
      availableCoin: 100n,
      lockedCoin: 0n,
      ledgerCoin: 100n,
    });
    expect(await t.db.select().from(schema.ledgerEntries).orderBy(schema.ledgerEntries.id)).toEqual(
      ledgerBefore,
    );
    expect(await ledgerSupply(t.db)).toEqual({
      mintedCoin: 100n,
      burnedCoin: 0n,
      heldCoin: 100n,
      carriedCoin: 100n,
    });
    const [record] = await t.db.select().from(schema.reconciliationCorrections);
    expect(record).toMatchObject({ amountCoin: 10n, ledgerEntryId: null, userReason });
    expect(record!.eventId).toBeGreaterThan(ledgerBefore.at(-1)!.id);
    expect(published).toEqual([
      {
        type: 'user:balance',
        availableCoin: '100',
        lockedCoin: '0',
        ledgerEntryId: String(record!.eventId),
        ts: record!.createdAt.toISOString(),
      },
    ]);
    const [hold] = await t.db
      .select()
      .from(schema.reconciliationHolds)
      .where(eq(schema.reconciliationHolds.id, holdId));
    expect(hold!.recoveredAt).toBeNull();
    expect((await audit()).result.passed).toBe(true);
    const repeated = await post(decisionPath(detail.result.id, asked.id), approver, {
      reason: approvalReason,
    });
    expect(repeated.statusCode).toBe(409);
    expect(published).toHaveLength(1);
    expect(await t.db.select().from(schema.reconciliationCorrections)).toHaveLength(1);
  });

  it('exposes only completed own reasons and effects, never internal evidence or actor identities', async () => {
    const { detail } = await broken();
    const asked = await request(detail);
    const approved = await post(decisionPath(detail.result.id, asked.id), approver, {
      reason: approvalReason,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const own = await history();
    expect(own.statusCode).toBe(200);
    const rows = memberReconciliationCorrectionSchema
      .array()
      .parse(own.json<{ data: unknown }>().data);
    expect(rows).toHaveLength(1);
    expect(Object.keys(own.json<{ data: Record<string, unknown>[] }>().data[0]!).sort()).toEqual(
      [
        'id',
        'eventId',
        'mode',
        'amountCoin',
        'balanceDeltaCoin',
        'balanceAfterCoin',
        'userReason',
        'createdAt',
      ].sort(),
    );
    expect(rows[0]).toMatchObject({
      mode: 'restore_actual',
      amountCoin: '10',
      balanceDeltaCoin: '10',
      balanceAfterCoin: '100',
      userReason,
    });
    for (const secret of [
      internalReason,
      approvalReason,
      asker.id,
      approver.id,
      asked.id,
      detail.candidates[0]!.snapshotKey,
    ])
      expect(own.body).not.toContain(secret);
    expect((await history(asker)).json<{ data: unknown[] }>().data).toEqual([]);
    const anonymous = await t.app.inject({ method: 'GET', url: ownHistory });
    expect(anonymous.statusCode).toBe(401);
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: member.cookie },
    });
    expect(me.json()).toMatchObject({
      data: { balance: { availableCoin: '100', lockedCoin: '0' } },
    });
  });

  it('keeps legacy correction ledger rows readable without disclosing their old audit reference or memo', async () => {
    await fundTreasury(10n);
    const internalRef = randomUUID();
    const internalMemo = 'LEGACY_INTERNAL_CORRECTION_MEMO';
    await recordLegacyCorrectionForTest({
      amountCoin: 10n,
      from: { kind: 'treasury' },
      to: { kind: 'user', userId: member.id },
      refType: 'audit_failure',
      refId: internalRef,
      idempotencyKey: randomUUID(),
      memo: internalMemo,
    });
    const [entry] = await t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.type, 'RECONCILIATION_CORRECTION'));
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/ledger',
      headers: { cookie: member.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json<{ data: Record<string, unknown>[] }>()
        .data.find((row) => row.id === String(entry!.id)),
    ).toEqual({
      id: String(entry!.id),
      type: 'RECONCILIATION_CORRECTION',
      amountCoin: '10',
      balanceAfterCoin: '110',
      refType: 'reconciliation_correction',
      refId: `legacy:${entry!.id}`,
      memo: null,
      createdAt: entry!.createdAt.toISOString(),
    });
    expect(response.body).not.toContain(internalRef);
    expect(response.body).not.toContain(internalMemo);
    expect((await history()).json<{ data: unknown[] }>().data).toEqual([]);
    expect(await t.db.select().from(schema.reconciliationCorrections)).toHaveLength(0);
  });

  it('keeps an unfunded replenishment pending, then accepts the same snapshot after funding and repeated audits', async () => {
    const { detail, candidate } = await broken(10);
    expect(candidate).toMatchObject({
      mode: 'replenish_ledger',
      amountCoin: '10',
      balanceDeltaCoin: '0',
      balanceAfterCoin: '110',
      ledgerAfterCoin: '110',
    });
    const asked = await request(detail);
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
    const refused = await post(decisionPath(detail.result.id, asked.id), approver, {
      reason: approvalReason,
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toMatchObject({
      error: {
        details: [{ path: ['reconciliationCorrection'], message: 'insufficient_treasury' }],
      },
    });
    expect(await balance()).toMatchObject({ availableCoin: 110n, ledgerCoin: 100n });
    expect(await t.db.select().from(schema.reconciliationCorrections)).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    const [stillPending] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, asked.id));
    expect(stillPending!.status).toBe('pending');
    await audit();
    await fundTreasury(10n);
    const fresh = await get(`/results/${detail.result.id}/corrections`);
    expect(
      fresh.json<{ data: ReconciliationCorrectionDetail }>().data.candidates[0]?.snapshotKey,
    ).toBe(candidate.snapshotKey);
    const completed = await post(decisionPath(detail.result.id, asked.id), approver, {
      reason: approvalReason,
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(await balance()).toMatchObject({ availableCoin: 110n, ledgerCoin: 110n });
    expect(await ledgerSupply(t.db)).toEqual({
      mintedCoin: 110n,
      burnedCoin: 0n,
      heldCoin: 110n,
      carriedCoin: 110n,
    });
    const own = await history();
    expect(own.json()).toMatchObject({
      data: [
        {
          mode: 'replenish_ledger',
          amountCoin: '10',
          balanceDeltaCoin: '0',
          balanceAfterCoin: '110',
          userReason,
        },
      ],
    });
    const ledger = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/ledger',
      headers: { cookie: member.cookie },
    });
    expect(ledger.body).toContain(userReason);
    for (const secret of [internalReason, approvalReason, asker.id, approver.id, asked.id])
      expect(ledger.body).not.toContain(secret);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed gap without committing approval and still permits rejecting the old request', async () => {
    const { detail } = await broken();
    const asked = await request(detail);
    await tamper(-1);
    const before = await balance();
    const res = await post(decisionPath(detail.result.id, asked.id), approver, {
      reason: approvalReason,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: { details: [{ message: 'stale' }] } });
    expect(await balance()).toEqual(before);
    const [pending] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, asked.id));
    expect(pending!.status).toBe('pending');
    const reject = await post(decisionPath(detail.result.id, asked.id, 'reject'), approver, {
      reason: '새 불일치로 재요청',
    });
    expect(reject.statusCode, reject.body).toBe(200);
    expect(reject.json<{ data: ReconciliationCorrectionDetail }>().data.requests[0]?.status).toBe(
      'rejected',
    );
    expect(await t.db.select().from(schema.reconciliationCorrections)).toHaveLength(0);
  });

  it.each(['fund_collateral', 'return_collateral'] as const)(
    'applies a fixed %s as a treasury transfer, without a member reason or automatic recovery',
    async (mode) => {
      const market = await createMarket(t.db, { status: 'closed' });
      const no = await createUser(t.db, { balanceCoin: 100n });
      await mintTestPairs(t.db, {
        marketId: market.id,
        yesHolderId: member.id,
        noHolderId: no.user.id,
        qty: 1,
      });
      const collateral = { kind: 'market_collateral' as const, marketId: market.id };
      if (mode === 'return_collateral') await fundTreasury(20n);
      await recordLegacyCorrectionForTest({
        amountCoin: 20n,
        from: mode === 'fund_collateral' ? collateral : { kind: 'treasury' },
        to: mode === 'fund_collateral' ? { kind: 'treasury' } : collateral,
        refType: 'audit_failure',
        refId: randomUUID(),
        idempotencyKey: randomUUID(),
      });
      const failed = await post('/run', asker, {
        target: { scope: 'market', marketId: market.id },
      });
      expect(failed.statusCode, failed.body).toBe(200);
      const run = reconciliationRunSchema.parse(failed.json<{ data: unknown }>().data);
      const preview = await get(`/results/${run.result.id}/corrections`);
      expect(preview.statusCode, preview.body).toBe(200);
      const detail = reconciliationCorrectionDetailSchema.parse(
        preview.json<{ data: unknown }>().data,
      );
      const candidate = detail.candidates.find((item) => item.mode === mode)!;
      expect(candidate).toMatchObject({
        accountKind: 'market_collateral',
        userId: null,
        amountCoin: '20',
        balanceAfterCoin: '100',
        ledgerAfterCoin: '100',
      });
      const asked = await post(`/results/${run.result.id}/correction-requests`, asker, {
        ...body(candidate),
        userReason: null,
      });
      expect(asked.statusCode, asked.body).toBe(200);
      const id = asked.json<{ data: ReconciliationCorrectionDetail }>().data.requests[0]!.id;
      const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
      const approved = await post(decisionPath(run.result.id, id), approver, {
        reason: approvalReason,
      });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(publish).not.toHaveBeenCalled();
      const [hold] = await t.db
        .select()
        .from(schema.reconciliationHolds)
        .where(eq(schema.reconciliationHolds.id, run.hold!.id));
      expect(hold!.recoveredAt).toBeNull();
      const [record] = await t.db.select().from(schema.reconciliationCorrections);
      expect(record).toMatchObject({
        mode,
        amountCoin: 20n,
        balanceAfterCoin: 100n,
        userId: null,
        userReason: null,
      });
      expect(record!.ledgerEntryId).not.toBeNull();
      expect((await history()).json<{ data: unknown[] }>().data).toEqual([]);
      const totals = await ledgerSupply(t.db);
      expect(totals.heldCoin).toBe(totals.mintedCoin - totals.burnedCoin);
      expect(totals.carriedCoin).toBe(totals.heldCoin);
    },
  );

  it('requires the exact candidate, a separate member reason and at most one pending request per account', async () => {
    const { detail, candidate } = await broken();
    for (const changed of [
      { amountCoin: '11' },
      { snapshotKey: '0'.repeat(32) },
      { userReason: null },
    ]) {
      const res = await post(`/results/${detail.result.id}/correction-requests`, asker, {
        ...body(candidate),
        ...changed,
      });
      expect(res.statusCode, res.body).toBe(400);
    }
    const responses = await Promise.all([
      post(`/results/${detail.result.id}/correction-requests`, asker, body(candidate)),
      post(`/results/${detail.result.id}/correction-requests`, approver, body(candidate)),
    ]);
    expect(responses.map((res) => res.statusCode).sort()).toEqual([200, 400]);
    const asked = responses
      .find((res) => res.statusCode === 200)!
      .json<{ data: ReconciliationCorrectionDetail }>().data.requests[0]!;
    const owner = asked.requestedBy.id === asker.id ? asker : approver;
    const other = owner === asker ? approver : asker;
    expect(
      (await post(decisionPath(detail.result.id, asked.id, 'retract'), other)).statusCode,
    ).toBe(409);
    const retract = await post(decisionPath(detail.result.id, asked.id, 'retract'), owner);
    expect(retract.statusCode, retract.body).toBe(200);
    expect(retract.json<{ data: ReconciliationCorrectionDetail }>().data.requests[0]?.status).toBe(
      'retracted',
    );
    expect(await balance()).toMatchObject({ availableCoin: 90n, ledgerCoin: 100n });
    expect(await t.db.select().from(schema.reconciliationCorrections)).toHaveLength(0);
  });

  it('applies concurrent decisions once, rolls back the loser, and publishes one event', async () => {
    const { detail } = await broken();
    const asked = await request(detail);
    const third = await admin();
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
    const decisions = await Promise.all([
      post(decisionPath(detail.result.id, asked.id), approver, { reason: '첫 검토자' }),
      post(decisionPath(detail.result.id, asked.id), third, { reason: '둘째 검토자' }),
    ]);
    expect(decisions.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    expect(await t.db.select().from(schema.reconciliationCorrections)).toHaveLength(1);
    expect(await balance()).toMatchObject({ availableCoin: 100n, ledgerCoin: 100n });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('pages pending/all requests and own completed history without crossing accounts', async () => {
    const first = await broken();
    const asked = await request(first.detail);
    expect(
      (
        await post(decisionPath(first.detail.result.id, asked.id), approver, {
          reason: approvalReason,
        })
      ).statusCode,
    ).toBe(200);
    const second = await broken(-5);
    const again = await request(second.detail);
    expect((await get('/correction-requests')).json()).toMatchObject({
      data: [{ id: again.id, status: 'pending' }],
    });
    const list = await get('/correction-requests?status=all&limit=1');
    expect(list.statusCode).toBe(200);
    const page = list.json<{ data: unknown[]; meta: { nextCursor: string } }>();
    expect(reconciliationCorrectionRequestSchema.array().parse(page.data)).toHaveLength(1);
    expect(page.meta.nextCursor).toBeTruthy();
    const next = await get(
      `/correction-requests?status=all&limit=1&cursor=${encodeURIComponent(page.meta.nextCursor)}`,
    );
    expect(next.json()).toMatchObject({
      data: [{ id: asked.id, status: 'approved' }],
      meta: { nextCursor: null },
    });
    expect(
      (
        await post(decisionPath(second.detail.result.id, again.id), approver, {
          reason: approvalReason,
        })
      ).statusCode,
    ).toBe(200);
    const firstOwn = await history(member, '?limit=1');
    const ownPage = firstOwn.json<{ data: unknown[]; meta: { nextCursor: string } }>();
    expect(ownPage.data).toHaveLength(1);
    const lastOwn = await history(
      member,
      `?limit=1&cursor=${encodeURIComponent(ownPage.meta.nextCursor)}`,
    );
    expect(lastOwn.json<{ data: unknown[] }>().data).toHaveLength(1);
    expect(lastOwn.json<{ data: unknown[] }>().data).not.toEqual(ownPage.data);
    expect(
      (await history(asker, `?cursor=${encodeURIComponent(ownPage.meta.nextCursor)}`)).json<{
        data: unknown[];
      }>().data,
    ).toEqual([]);
  });

  it('checks the displayed account before lookup and protects every new route with admin/onboarding guards', async () => {
    const { detail, candidate } = await broken();
    const asked = await request(detail);
    const routes = [
      `/results/${detail.result.id}/correction-requests`,
      ...['approve', 'reject', 'retract'].map((action) =>
        decisionPath(detail.result.id, asked.id, action),
      ),
    ];
    for (const path of routes) {
      const res = await post(path, member, { ...body(candidate), reason: internalReason });
      expect(res.statusCode, res.body).toBe(403);
    }
    for (const path of [`/results/${detail.result.id}/corrections`, '/correction-requests'])
      expect((await get(path, member)).statusCode).toBe(403);
    const changed = await post('/results/999999999/correction-requests', asker, {
      ...body(candidate),
      expectedAccountId: approver.id,
    });
    expect(changed.statusCode).toBe(403);
    expect(changed.json()).toMatchObject({ error: { details: [{ path: ['expectedAccountId'] }] } });
    const missing = await t.app.inject({
      method: 'POST',
      url: `${base}/results/${detail.result.id}/correction-requests`,
      headers: { origin, cookie: asker.cookie },
      payload: body(candidate),
    });
    expect(missing.statusCode).toBe(400);
    const unsafe = await get('/results/9007199254740993/corrections');
    expect(unsafe.statusCode).toBe(400);
    const otherResult = await audit();
    expect(
      (
        await post(decisionPath(otherResult.result.id, asked.id), approver, {
          reason: approvalReason,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rechecks the current admin role after waiting on the shared role lock', async () => {
    const { detail } = await broken();
    const asked = await request(detail);
    expect((await get('/correction-requests', approver)).statusCode).toBe(200);
    let held!: () => void;
    const ready = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release!: () => void;
    const allowCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = await t.db.$client.connect();
    const revoking = t.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      await tx
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(eq(schema.profiles.userId, approver.id));
      held();
      await allowCommit;
    });
    try {
      await ready;
      const approval = post(decisionPath(detail.result.id, asked.id), approver, {
        reason: approvalReason,
      }).then((response) => response);
      await waitForLockWaiter(client, 'correction waits for role revocation');
      release();
      await revoking;
      const denied = await approval;
      expect(denied.statusCode, denied.body).toBe(403);
    } finally {
      release();
      await revoking;
      client.release();
    }
    expect(await t.db.select().from(schema.reconciliationCorrections)).toHaveLength(0);
  });
});
