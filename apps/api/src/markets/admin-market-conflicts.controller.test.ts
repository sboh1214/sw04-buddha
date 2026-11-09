import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createDispute,
  createFill,
  createJudgementRequest,
  createMarket,
  createProvisionalMarket,
} from '@buddha/db/test';
import {
  adminMarketConflictsSchema,
  adminMarketConflictWriteSchema,
  type AdminMarket,
  type AdminMarketConflicts,
} from '@buddha/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalService } from '../approvals/approval.service.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

describe.skipIf(!hasTestInfra)('market interests and decision eligibility (#143)', () => {
  let t: TestApp;
  let first: TestUser, second: TestUser, third: TestUser;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  async function member(admin = false) {
    const person = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: person.id });
    if (admin)
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, person.id));
    await t.app.get(AdminGuard).invalidate(person.id);
    return person;
  }
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    first = await member(true);
    second = await member(true);
    third = await member(true);
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/release-settings/market.dispute_window',
      headers: { origin: 'http://localhost:3000', cookie: first.cookie },
      payload: {
        expectedAccountId: first.id,
        status: 'test',
        value: 1440,
        reason: '시험 이의 기간',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
  const url = (id: string) => `/api/v1/admin/markets/${id}`;
  const post = (path: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: path,
      headers: { origin: 'http://localhost:3000', cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const declare = (id: string, who = first, reason = '가족이 사건의 당사자입니다.') =>
    post(`${url(id)}/conflicts`, who, { reason });
  const registration = (extra: Record<string, unknown> = {}) => ({
    noConflictConfirmed: true,
    result: 'VOID',
    source: null,
    voidReason: '사건을 판정할 수 없습니다.',
    evidence: {
      links: ['https://example.org/evidence'],
      collectedAt: new Date(Date.now() - 60_000).toISOString(),
    },
    description: '출처와 사건의 범위를 확인했습니다.',
    ...extra,
  });
  const read = (response: { json: <T>() => T }) => {
    const data = response.json<{
      data: AdminMarketConflicts | { conflicts: AdminMarketConflicts };
    }>().data;
    return 'conflicts' in data
      ? adminMarketConflictWriteSchema.parse(data).conflicts
      : adminMarketConflictsSchema.parse(data);
  };
  const closed = () =>
    createMarket(t.db, {
      createdBy: first.id,
      status: 'closed',
      closeAt: new Date(Date.now() - 86_400_000),
    });
  const requests = (id: string) =>
    t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, 'market_judgement'),
          eq(schema.approvalRequests.targetId, id),
        ),
      );
  const conflictActions = (id: string) =>
    t.db
      .select()
      .from(schema.adminActions)
      .where(
        and(
          eq(schema.adminActions.type, 'market_conflict_declare'),
          eq(schema.adminActions.targetId, id),
        ),
      );

  it('keeps only the first self-declaration, with its admin-only identity and audit', async () => {
    const market = await closed();
    const pair = await Promise.all([declare(market.id), declare(market.id)]);
    for (const response of pair) expect(response.statusCode, response.body).toBe(200);
    const answer = read(pair[0]);
    expect(answer.operator).toMatchObject({ userId: first.id, hasFill: false, conflicted: true });
    expect(answer.declarations).toHaveLength(1);
    expect(read(await declare(market.id, first, '나중의 다른 사유'))).toEqual(answer);
    expect(await conflictActions(market.id)).toHaveLength(1);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `${url(market.id)}/conflicts`,
          headers: { cookie: second.cookie },
        })
      ).statusCode,
    ).toBe(200);
    const visitor = await t.app.inject({ method: 'GET', url: `${url(market.id)}/conflicts` });
    expect(visitor.statusCode).toBe(401);
    const outsider = await member();
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `${url(market.id)}/conflicts`,
          headers: { cookie: outsider.cookie },
        })
      ).statusCode,
    ).toBe(403);
    const publicAnswer = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${market.id}` });
    expect(publicAnswer.body).not.toContain('가족이 사건의 당사자입니다.');
    expect(publicAnswer.body).not.toContain(first.id);
  });

  it('validates reason and session identity, and declares only the signed-in administrator', async () => {
    const market = await closed();
    for (const reason of ['', ' ', '가'.repeat(501)])
      expect((await declare(market.id, first, reason)).statusCode).toBe(400);
    expect(
      (
        await post(`${url(market.id)}/conflicts`, first, {
          reason: '관계',
          expectedAccountId: second.id,
        })
      ).statusCode,
    ).toBe(403);
    expect(await conflictActions(market.id)).toEqual([]);
    const accepted = await post(`${url(market.id)}/conflicts`, first, {
      reason: '가'.repeat(500),
      userId: second.id,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(read(accepted).operator.declaration?.declaredBy.id).toBe(first.id);
    expect(read(accepted).declarations[0]?.reason).toHaveLength(500);
  });

  it('requires an explicit confirmation for registration, approval and both dispute decisions', async () => {
    const market = await closed();
    const pending = await createJudgementRequest(t.db, { marketId: market.id, by: first.id });
    const provisional = await createProvisionalMarket(t.db, {
      registeredBy: first.id,
      approvedBy: second.id,
    });
    const disputed = await createDispute(t.db, { marketId: provisional.market.id });
    const paths = [
      { path: `${url(market.id)}/judgements`, who: third, body: registration() },
      {
        path: `${url(market.id)}/judgements/${pending.id}/approve`,
        who: second,
        body: { reason: '확인', eventDeadlineConfirmed: true },
      },
      ...['accept', 'dismiss'].map((action) => ({
        path: `${url(provisional.market.id)}/disputes/${disputed.dispute.id}/${action}`,
        who: third,
        body: { reason: '근거 확인' },
      })),
    ];
    for (const entry of paths)
      for (const noConflictConfirmed of [undefined, false]) {
        const response = await post(entry.path, entry.who, { ...entry.body, noConflictConfirmed });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.body).toContain('noConflictConfirmed');
      }
    expect((await requests(market.id))[0]?.status).toBe('pending');
  });

  it('uses historical fills and declarations to exclude registrants, approvers and all alternative deciders', async () => {
    const market = await closed();
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, third.id));
    await createFill(t.db, { marketId: market.id, userId: third.id, amountCoin: 50n });
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, third.id));
    await t.app.get(AdminGuard).invalidate(third.id);
    const own = read(
      await t.app.inject({
        method: 'GET',
        url: `${url(market.id)}/conflicts`,
        headers: { cookie: third.cookie },
      }),
    );
    expect(own.operator).toMatchObject({ hasFill: true, conflicted: true, declaration: null });
    const forbidden = await post(`${url(market.id)}/judgements`, third, registration());
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect(forbidden.body).toContain('market_conflict');
    await declare(market.id, second);
    const noDecider = await post(`${url(market.id)}/judgements`, first, registration());
    expect(noDecider.statusCode, noDecider.body).toBe(409);
    expect(noDecider.body).toContain('no_decider');
    const pending = await createJudgementRequest(t.db, { marketId: market.id, by: first.id });
    for (const who of [second, third]) {
      const response = await post(`${url(market.id)}/judgements/${pending.id}/approve`, who, {
        noConflictConfirmed: true,
        reason: '확인',
        eventDeadlineConfirmed: true,
      });
      expect(response.statusCode, response.body).toBe(403);
    }
    // Rejection remains available for cleaning up a request despite a declared interest.
    expect(
      (
        await post(`${url(market.id)}/judgements/${pending.id}/reject`, second, {
          reason: '다른 등록으로 정리',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('retracts its own pending first judgement atomically and never reverses an approved result', async () => {
    const market = await closed();
    const registered = await post(`${url(market.id)}/judgements`, first, registration());
    expect(registered.statusCode, registered.body).toBe(200);
    const [request] = await requests(market.id);
    const response = await declare(market.id);
    expect(response.statusCode, response.body).toBe(200);
    expect((await requests(market.id))[0]?.status).toBe('retracted');
    expect(
      adminMarketConflictWriteSchema.parse(response.json<{ data: unknown }>().data).market.judgement
        .pending,
    ).toBeNull();
    expect(
      (
        await post(`${url(market.id)}/judgements/${request!.id}/approve`, second, {
          noConflictConfirmed: true,
          reason: '확인',
          eventDeadlineConfirmed: true,
        })
      ).statusCode,
    ).toBe(409);
    const [action] = await t.db
      .select()
      .from(schema.adminActions)
      .where(
        and(
          eq(schema.adminActions.type, 'market_judgement_retract'),
          eq(schema.adminActions.targetId, market.id),
        ),
      );
    expect(action?.payload?.conflictDeclarationId).toBe(read(response).operator.declaration?.id);
    const published = await createProvisionalMarket(t.db, {
      registeredBy: first.id,
      approvedBy: second.id,
    });
    expect((await declare(published.market.id)).statusCode).toBe(200);
    expect(
      (
        await t.db.select().from(schema.markets).where(eq(schema.markets.id, published.market.id))
      )[0]?.judgementVersion,
    ).toBe(1);
    expect((await requests(published.market.id))[0]?.status).toBe('approved');
  });

  it('reopens accepted disputes when a declaration retracts a pending correction', async () => {
    const { market } = await createProvisionalMarket(t.db, {
      registeredBy: first.id,
      approvedBy: second.id,
    });
    const { dispute } = await createDispute(t.db, {
      marketId: market.id,
      status: 'accepted',
      decidedBy: third.id,
    });
    const corrected = await post(
      `${url(market.id)}/judgements`,
      first,
      registration({ correction: { baseVersion: 1, reason: '판정 정정' } }),
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    const schedule = vi.spyOn(t.app.get(MarketJobs), 'scheduleResolve');
    const declared = await declare(market.id);
    expect(declared.statusCode, declared.body).toBe(200);
    const snapshot = adminMarketConflictWriteSchema.parse(
      declared.json<{ data: unknown }>().data,
    ).market;
    expect(snapshot.judgement.pending).toBeNull();
    expect(snapshot.disputes.items.find((row) => row.id === dispute.id)?.status).toBe('pending');
    const [after] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, market.id));
    expect(after).toMatchObject({
      status: 'provisional',
      judgementVersion: 1,
      correctionPending: false,
      disputeHoldCount: 1,
    });
    expect(
      (
        await t.db
          .select()
          .from(schema.marketDisputes)
          .where(eq(schema.marketDisputes.id, dispute.id))
      )[0]?.status,
    ).toBe('pending');
    expect(schedule).not.toHaveBeenCalled();
    await declare(market.id, second);
    const decision = await post(`${url(market.id)}/disputes/${dispute.id}/dismiss`, second, {
      noConflictConfirmed: true,
      reason: '이해관계가 있으므로 결정 불가',
    });
    expect(decision.statusCode).toBe(403);
  });

  it('schedules overdue confirmation only after declaration and correction retraction commit', async () => {
    const { market } = await createProvisionalMarket(t.db, {
      registeredBy: first.id,
      approvedBy: second.id,
      publishedAt: new Date(Date.now() - 120_000),
      disputeWindowMinutes: 1,
    });
    const corrected = await post(
      `${url(market.id)}/judgements`,
      first,
      registration({ correction: { baseVersion: 1, reason: '판정 정정' } }),
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    const schedule = vi
      .spyOn(t.app.get(MarketJobs), 'scheduleResolve')
      .mockImplementation(async (id) => {
        const [committed] = await t.db
          .select()
          .from(schema.markets)
          .where(eq(schema.markets.id, id));
        expect(committed?.correctionPending).toBe(false);
        expect(await conflictActions(id)).toHaveLength(1);
        expect((await requests(id)).find((row) => row.status === 'pending')).toBeUndefined();
      });
    const declared = await declare(market.id);
    expect(declared.statusCode, declared.body).toBe(200);
    expect(schedule).toHaveBeenCalledTimes(1);
    await declare(market.id);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('rolls back declaration and audit if its pending retraction fails', async () => {
    const market = await closed();
    const pending = await createJudgementRequest(t.db, { marketId: market.id, by: first.id });
    vi.spyOn(t.app.get(ApprovalService), 'retract').mockRejectedValueOnce(
      new Error('retraction failed'),
    );
    expect((await declare(market.id)).statusCode).toBe(500);
    expect(await t.db.select().from(schema.marketConflictDeclarations)).toEqual([]);
    expect(await conflictActions(market.id)).toEqual([]);
    expect((await requests(market.id)).find((row) => row.id === pending.id)?.status).toBe(
      'pending',
    );
  });

  it('records confirmation on successful registration, approval and dispute decision', async () => {
    const market = await closed();
    const registered = await post(`${url(market.id)}/judgements`, first, registration());
    expect(registered.statusCode, registered.body).toBe(200);
    const [pending] = await requests(market.id);
    expect(pending?.payload?.noConflictConfirmed).toBe(true);
    const approved = await post(`${url(market.id)}/judgements/${pending!.id}/approve`, second, {
      noConflictConfirmed: true,
      eventDeadlineConfirmed: true,
      reason: '근거 확인',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const answer = approved.json<{ data: AdminMarket }>().data;
    const { dispute } = await createDispute(t.db, { marketId: answer.id });
    const decision = await post(`${url(answer.id)}/disputes/${dispute.id}/dismiss`, third, {
      noConflictConfirmed: true,
      reason: '원문 일치',
    });
    expect(decision.statusCode, decision.body).toBe(200);
    const actions = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, market.id));
    for (const type of [
      'market_judgement_request',
      'market_judgement_approve',
      'market_dispute_dismiss',
    ])
      expect(actions.find((row) => row.type === type)?.payload?.noConflictConfirmed).toBe(true);
  });
});
