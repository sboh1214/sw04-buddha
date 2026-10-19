/**
 * 시장 제안 (#77), the operators' side, against the docker `test` profile: `/admin/proposals` — the
 * list and one proposal, 검토 시작, 채택 (with a draft made from the proposal, an existing market or
 * none), 반려 and the internal memo. What the owner decided (ADR-0069 decision 4 #77) is what is
 * pinned: 접수 → 검토 → 채택·반려 and 접수 → 반려 directly, never back and never again; a 반려's reason
 * from the list with an explanation, a 중복's existing market; a 채택's optional memo and its market;
 * the draft opens nothing and is not public, and sits where a market may (the operator's category,
 * else the proposal's when it is a leaf or a parent with no leaves, ADR-0041); who and when kept
 * and shown, each move recorded in `admin_actions` with its operator; the internal memo apart from
 * the proposer. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { completeOnboarding, createCategory, createMarket, createProposal } from '@buddha/db/test';
import {
  adminProposalSchema,
  proposalDraftCloseAt,
  proposalSchema,
  type AdminProposal,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const ORIGIN = 'http://localhost:3000';
const jsonHeaders = { origin: ORIGIN, 'content-type': 'application/json' };
const DAY_MS = 24 * 60 * 60 * 1000;

type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
};
type ListPage = { data: AdminProposal[]; meta: { nextCursor: string | null } };

/** The Korean calendar date `days` from now, `YYYY-MM-DD`. */
function koreanDate(days = 0): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + days * DAY_MS).toISOString().slice(0, 10);
}

describe.skipIf(!hasTestInfra)('/api/v1/admin/proposals (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let second: TestUser;
  let proposer: TestUser;
  let category: { id: number; slug: string; nameKo: string };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await promote(await signUpTestUser(t));
    second = await promote(await signUpTestUser(t));
    proposer = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: proposer.id });
    await t.db
      .update(schema.profiles)
      .set({ nickname: 'proposer_one' })
      .where(eq(schema.profiles.userId, proposer.id));
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  /** An admin that finished the onboarding, as /admin requires (ADR-0072). */
  async function promote(who: TestUser): Promise<TestUser> {
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, who.id));
    await completeOnboarding(t.db, { userId: who.id });
    await t.app.get(AdminGuard).invalidate(who.id);
    return who;
  }

  const proposal = (input: Partial<Parameters<typeof createProposal>[1]> = {}) =>
    createProposal(t.db, {
      userId: proposer.id,
      question: '2027년 기준금리가 3% 아래로 내려갈까?',
      yesCondition: '한국은행 발표에서 3% 미만이면 YES',
      expectedSources: '한국은행 보도자료',
      background: '최근 인하 흐름',
      categoryId: category.id,
      adminId: admin.id,
      ...input,
    });

  const post = (url: string, payload: unknown = {}, who: TestUser = admin) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/proposals${url}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: JSON.stringify(payload),
    });
  const put = (url: string, payload: unknown, who: TestUser = admin) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/proposals${url}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: JSON.stringify(payload),
    });
  const get = (url: string, who: TestUser = admin) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/proposals${url}`,
      headers: { cookie: who.cookie },
    });
  const answerOf = (res: { statusCode: number; json: <T>() => T; body: string }) => {
    expect(res.statusCode, res.body).toBe(200);
    return adminProposalSchema.parse(res.json<{ data: unknown }>().data);
  };
  const errorOf = (res: { json: <T>() => T }) => res.json<ErrorBody>().error;
  const review = (id: string, who: TestUser = admin) => post(`/${id}/review`, {}, who);
  const adopt = (id: string, payload: unknown = {}, who: TestUser = admin) =>
    post(`/${id}/adopt`, payload, who);
  const reject = (id: string, payload: unknown, who: TestUser = admin) =>
    post(`/${id}/reject`, payload, who);
  const actions = () =>
    t.db
      .select({
        adminId: schema.adminActions.adminId,
        type: schema.adminActions.type,
        targetType: schema.adminActions.targetType,
        targetId: schema.adminActions.targetId,
        payload: schema.adminActions.payload,
      })
      .from(schema.adminActions)
      .orderBy(asc(schema.adminActions.createdAt));
  const proposerView = async (id: string) => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/proposals/${id}`,
      headers: { cookie: proposer.cookie },
    });
    expect(res.statusCode).toBe(200);
    return proposalSchema.parse(res.json<{ data: unknown }>().data);
  };

  it('is the operators’ only: a member is refused on every route', async () => {
    const row = await proposal();
    for (const res of [
      await get('', proposer),
      await get(`/${row.id}`, proposer),
      await review(row.id, proposer),
      await reject(row.id, { reason: 'other', explanation: '설명' }, proposer),
      await put(`/${row.id}/internal-memo`, { memo: 'x' }, proposer),
    ]) {
      expect(res.statusCode).toBe(403);
    }
    expect((await t.db.select().from(schema.marketProposals))[0]?.status).toBe('submitted');
  });

  it('lists every proposal newest first with its proposer, or one status, page by page', async () => {
    const base = Date.now() - 60_000;
    const a = await proposal({ createdAt: new Date(base) });
    const b = await proposal({ createdAt: new Date(base + 1), status: 'reviewing' });
    const c = await proposal({ createdAt: new Date(base + 2) });
    const first = await get('?limit=2');
    expect(first.statusCode).toBe(200);
    const page = first.json<ListPage>();
    expect(page.data.map((row) => row.id)).toEqual([c.id, b.id]);
    expect(page.data[0]!.proposer).toEqual({ id: proposer.id, nickname: 'proposer_one' });
    const rest = (await get(`?limit=2&cursor=${page.meta.nextCursor!}`)).json<ListPage>();
    expect(rest.data.map((row) => row.id)).toEqual([a.id]);
    const submitted = (await get('?status=submitted')).json<ListPage>();
    expect(submitted.data.map((row) => row.id)).toEqual([c.id, a.id]);
    expect((await get(`/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('starts a review once, recording who and when, and the record of it', async () => {
    const row = await proposal();
    const answer = answerOf(await review(row.id));
    expect(answer).toMatchObject({
      status: 'reviewing',
      reviewStartedBy: { id: admin.id },
      decidedAt: null,
      decidedBy: null,
    });
    expect(answer.reviewStartedAt).not.toBeNull();
    const again = await review(row.id, second);
    expect(again.statusCode).toBe(400);
    expect(errorOf(again)).toMatchObject({ details: [{ path: ['status'] }] });
    expect(await actions()).toEqual([
      {
        adminId: admin.id,
        type: 'proposal_review',
        targetType: 'market_proposal',
        targetId: row.id,
        payload: { from: 'submitted', to: 'reviewing' },
      },
    ]);
    expect((await proposerView(row.id)).status).toBe('reviewing');
  });

  it('rejects from 접수 or 검토 with a reason and an explanation for the proposer; a 중복 names its market', async () => {
    const direct = await proposal();
    const answer = answerOf(
      await reject(direct.id, {
        reason: 'ambiguous_criteria',
        explanation: '  판정 기준이 모호합니다 ',
      }),
    );
    expect(answer).toMatchObject({
      status: 'rejected',
      reviewStartedAt: null,
      decidedBy: { id: admin.id },
      rejection: { reason: 'ambiguous_criteria', explanation: '판정 기준이 모호합니다' },
      adoption: null,
    });
    // 중복: the market is required, must exist, and is refused for any other reason.
    const reviewed = await proposal({ status: 'reviewing' });
    const existing = await createMarket(t.db, { createdBy: admin.id, categoryId: category.id });
    for (const [payload, status, field] of [
      [{ reason: 'duplicate', explanation: '중복' }, 400, 'duplicateMarketId'],
      [
        { reason: 'other', explanation: '기타', duplicateMarketId: existing.id },
        400,
        'duplicateMarketId',
      ],
      [
        { reason: 'duplicate', explanation: '중복', duplicateMarketId: randomUUID() },
        404,
        'duplicateMarketId',
      ],
      [{ reason: 'other', explanation: '   ' }, 400, 'explanation'],
      [{ reason: 'spam', explanation: '설명' }, 400, 'reason'],
    ] as const) {
      const res = await reject(reviewed.id, payload);
      expect({ status: res.statusCode, details: JSON.stringify(errorOf(res).details) }).toEqual({
        status,
        details: expect.stringContaining(field) as string,
      });
    }
    // Rejected by another operator than the one who started the review: each is recorded apart.
    const duplicate = answerOf(
      await reject(
        reviewed.id,
        {
          reason: 'duplicate',
          explanation: '이미 있는 시장입니다',
          duplicateMarketId: existing.id,
        },
        second,
      ),
    );
    expect(duplicate.reviewStartedBy).toEqual({
      id: admin.id,
      nickname: expect.any(String) as string,
    });
    expect(duplicate.decidedBy).toEqual({ id: second.id, nickname: expect.any(String) as string });
    expect(duplicate.rejection?.duplicateMarket).toMatchObject({ id: existing.id, status: 'open' });
    expect((await proposerView(reviewed.id)).rejection).toEqual({
      reason: 'duplicate',
      explanation: '이미 있는 시장입니다',
      duplicateMarket: { id: existing.id, slug: existing.slug, title: existing.title },
    });
    // Who rejected which, from what, and why — the record the brief asks for (검토 흐름·기록).
    expect(await actions()).toEqual([
      {
        adminId: admin.id,
        type: 'proposal_reject',
        targetType: 'market_proposal',
        targetId: direct.id,
        payload: {
          from: 'submitted',
          to: 'rejected',
          reason: 'ambiguous_criteria',
          explanation: '판정 기준이 모호합니다',
          duplicateMarketId: null,
        },
      },
      {
        adminId: second.id,
        type: 'proposal_reject',
        targetType: 'market_proposal',
        targetId: reviewed.id,
        payload: {
          from: 'reviewing',
          to: 'rejected',
          reason: 'duplicate',
          explanation: '이미 있는 시장입니다',
          duplicateMarketId: existing.id,
        },
      },
    ]);
  });

  it('adopts after a review only, with a draft filled from the proposal that opens nothing', async () => {
    const submitted = await proposal({ deadline: koreanDate(40) });
    expect((await adopt(submitted.id, { market: { type: 'draft' } })).statusCode).toBe(400);
    await review(submitted.id);
    const answer = answerOf(
      await adopt(submitted.id, { memo: '좋은 제안입니다', market: { type: 'draft' } }),
    );
    expect(answer).toMatchObject({
      status: 'adopted',
      decidedBy: { id: admin.id },
      adoption: { memo: '좋은 제안입니다', market: { status: 'draft' } },
      rejection: null,
    });
    const marketId = answer.adoption!.market!.id;
    const [market] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    expect(market).toMatchObject({
      status: 'draft',
      title: submitted.question,
      rules: submitted.yesCondition,
      resolutionSource: submitted.expectedSources,
      description: submitted.background,
      categoryId: category.id,
      createdBy: admin.id,
      openAt: null,
    });
    // 00:00 in Korea of the proposal's date, unless the operator gives a close time.
    expect(market!.closeAt.toISOString()).toBe(
      proposalDraftCloseAt(submitted.deadline).toISOString(),
    );
    expect((await actions()).map((row) => row.type)).toEqual([
      'proposal_review',
      'market_create',
      'proposal_adopt',
    ]);
    expect((await actions()).at(-1)).toEqual({
      adminId: admin.id,
      type: 'proposal_adopt',
      targetType: 'market_proposal',
      targetId: submitted.id,
      payload: {
        from: 'reviewing',
        to: 'adopted',
        marketId,
        marketCreated: true,
        memo: '좋은 제안입니다',
      },
    });
    // The proposer sees the memo and no market while it is a draft — no Coin, no opening.
    expect((await proposerView(submitted.id)).adoption).toEqual({
      memo: '좋은 제안입니다',
      market: null,
    });
    const balance = await t.db
      .select({ available: schema.balances.availableCoin })
      .from(schema.balances)
      .where(eq(schema.balances.userId, proposer.id));
    expect(balance[0]?.available).toBe(0n);
    // Final: nothing moves it again.
    for (const res of [
      await adopt(submitted.id),
      await review(submitted.id),
      await reject(submitted.id, { reason: 'other', explanation: '설명' }),
    ]) {
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a draft it cannot make — no category, a close time already past — and adopts nothing', async () => {
    const noCategory = await proposal({ status: 'reviewing', categoryId: null });
    const missing = await adopt(noCategory.id, { market: { type: 'draft' } });
    expect(missing.statusCode).toBe(400);
    // The screen tells the refusals of the field apart by the issue's word (`adminProposalFailure`).
    expect(errorOf(missing)).toMatchObject({
      details: [{ path: ['market', 'categoryId'], message: 'required' }],
    });
    const today = await proposal({ status: 'reviewing', deadline: koreanDate(0) });
    const past = await adopt(today.id, { market: { type: 'draft' } });
    expect(past.statusCode).toBe(400);
    expect(errorOf(past)).toMatchObject({ details: [{ path: ['market', 'closeAt'] }] });
    const retired = await createCategory(t.db, { isActive: false });
    const inactive = await adopt(noCategory.id, {
      market: { type: 'draft', categoryId: retired.id },
    });
    expect(inactive.statusCode).toBe(400);
    expect(errorOf(inactive)).toMatchObject({
      details: [{ path: ['market', 'categoryId'], message: 'inactive' }],
    });
    // A wish retired after it was proposed (only the database can retire one today) is refused as
    // retired, not as missing: the proposal does name a category.
    const retiredWish = await proposal({ status: 'reviewing', categoryId: retired.id });
    const wishInactive = await adopt(retiredWish.id, { market: { type: 'draft' } });
    expect(wishInactive.statusCode).toBe(400);
    expect(errorOf(wishInactive)).toMatchObject({
      details: [{ path: ['market', 'categoryId'], message: 'inactive' }],
    });
    // An unknown category is NOT_FOUND naming the adoption's field.
    const unknown = await adopt(noCategory.id, {
      market: { type: 'draft', categoryId: 2_000_000_000 },
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown)).toMatchObject({
      code: 'NOT_FOUND',
      details: [{ path: ['market', 'categoryId'] }],
    });
    expect(await t.db.select().from(schema.markets)).toEqual([]);
    expect(
      (await t.db.select().from(schema.marketProposals)).map((row) => row.status).sort(),
    ).toEqual(['reviewing', 'reviewing', 'reviewing']);
    // With what it lacked, given by the operator, it is made.
    const closeAt = new Date(Date.now() + 7 * DAY_MS).toISOString();
    const made = answerOf(
      await adopt(today.id, { market: { type: 'draft', categoryId: category.id, closeAt } }),
    );
    const [market] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, made.adoption!.market!.id));
    expect(market!.closeAt.toISOString()).toBe(closeAt);
  });

  it('files the draft under the operator’s category, else the proposal’s where a market may sit (ADR-0041)', async () => {
    // `category` (경제) gets a leaf: a parent that has one.
    const leaf = await createCategory(t.db, {
      slug: 'rates',
      nameKo: '금리',
      parentId: category.id,
    });
    const other = await createCategory(t.db, { slug: 'culture', nameKo: '문화' });
    const draftCategory = async (answer: AdminProposal) => {
      const [market] = await t.db
        .select({ categoryId: schema.markets.categoryId })
        .from(schema.markets)
        .where(eq(schema.markets.id, answer.adoption!.market!.id));
      return market!.categoryId;
    };
    // The operator's pick wins over the proposal's wish.
    const picked = await proposal({ status: 'reviewing', categoryId: leaf.id });
    expect(
      await draftCategory(
        answerOf(await adopt(picked.id, { market: { type: 'draft', categoryId: other.id } })),
      ),
    ).toBe(other.id);
    // A wished leaf stands in when the operator picks none.
    const leafWish = await proposal({ status: 'reviewing', categoryId: leaf.id });
    expect(
      await draftCategory(answerOf(await adopt(leafWish.id, { market: { type: 'draft' } }))),
    ).toBe(leaf.id);
    // A wished parent that has a leaf does not: refused as no category, and nothing is adopted.
    const parentWish = await proposal({ status: 'reviewing' });
    const refused = await adopt(parentWish.id, { market: { type: 'draft' } });
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: ['market', 'categoryId'], message: 'required' }],
    });
    expect(answerOf(await get(`/${parentWish.id}`)).status).toBe('reviewing');
    // Picked by the operator, the parent itself is taken: the API takes any active level.
    expect(
      await draftCategory(
        answerOf(
          await adopt(parentWish.id, { market: { type: 'draft', categoryId: category.id } }),
        ),
      ),
    ).toBe(category.id);
    // A parent whose only leaf is retired has none a market could sit on: the wish stands in.
    const lone = await createCategory(t.db, { slug: 'weather', nameKo: '날씨' });
    await createCategory(t.db, {
      slug: 'rain',
      nameKo: '강수',
      parentId: lone.id,
      isActive: false,
    });
    const loneWish = await proposal({ status: 'reviewing', categoryId: lone.id });
    expect(
      await draftCategory(answerOf(await adopt(loneWish.id, { market: { type: 'draft' } }))),
    ).toBe(lone.id);
  });

  it('adopts linking an existing market, or none; the proposer sees the link once it is public', async () => {
    const draft = await createMarket(t.db, {
      createdBy: admin.id,
      categoryId: category.id,
      status: 'draft',
    });
    const linked = await proposal({ status: 'reviewing' });
    expect(
      (await adopt(linked.id, { market: { type: 'existing', marketId: randomUUID() } })).statusCode,
    ).toBe(404);
    const answer = answerOf(
      await adopt(linked.id, { market: { type: 'existing', marketId: draft.id } }),
    );
    expect(answer.adoption).toEqual({
      memo: null,
      market: { id: draft.id, slug: draft.slug, title: draft.title, status: 'draft' },
    });
    expect((await proposerView(linked.id)).adoption?.market).toBeNull();
    // The admin opens the market (the market's own route): now the proposer sees it.
    const opened = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${draft.id}/open`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: '{}',
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect((await proposerView(linked.id)).adoption?.market).toEqual({
      id: draft.id,
      slug: draft.slug,
      title: draft.title,
    });
    // A memo of spaces is none, never left to the table's CHECK (a 500).
    const bare = await proposal({ status: 'reviewing' });
    expect(answerOf(await adopt(bare.id, { memo: '   ' })).adoption).toEqual({
      memo: null,
      market: null,
    });
    expect(
      (await actions()).filter((row) => row.type === 'proposal_adopt').map((row) => row.payload),
    ).toEqual([
      { from: 'reviewing', to: 'adopted', marketId: draft.id, marketCreated: false, memo: null },
      { from: 'reviewing', to: 'adopted', marketId: null, marketCreated: false, memo: null },
    ]);
  });

  it('keeps 반려 and 철회 final too', async () => {
    const rejected = await proposal({ status: 'rejected', rejectUnreviewed: true });
    const retracted = await proposal({ status: 'retracted' });
    for (const id of [rejected.id, retracted.id]) {
      for (const res of [
        await review(id),
        await adopt(id),
        await reject(id, { reason: 'other', explanation: '설명' }),
      ]) {
        expect(res.statusCode).toBe(400);
      }
    }
    expect(await actions()).toEqual([]);
  });

  it('lets one of a review start and the proposer’s 철회 win, never both', async () => {
    const row = await proposal();
    const [started, retracted] = await Promise.all([
      review(row.id),
      t.app.inject({
        method: 'POST',
        url: `/api/v1/me/proposals/${row.id}/retract`,
        headers: { ...jsonHeaders, cookie: proposer.cookie },
        payload: { expectedAccountId: proposer.id },
      }),
    ]);
    expect([started.statusCode, retracted.statusCode].sort()).toEqual([200, 400]);
    const [stored] = await t.db
      .select({ status: schema.marketProposals.status })
      .from(schema.marketProposals);
    expect(stored?.status).toBe(started.statusCode === 200 ? 'reviewing' : 'retracted');
  });

  it('keeps an internal memo in any status, recorded when it changes, never shown to the proposer', async () => {
    const row = await proposal({ status: 'adopted' });
    expect(
      answerOf(await put(`/${row.id}/internal-memo`, { memo: '  내부 메모  ' })).internalMemo,
    ).toBe('내부 메모');
    // The same memo again changes nothing and records nothing.
    answerOf(await put(`/${row.id}/internal-memo`, { memo: '내부 메모' }));
    expect(answerOf(await put(`/${row.id}/internal-memo`, { memo: '' })).internalMemo).toBeNull();
    expect((await actions()).map((action) => action.payload)).toEqual([
      { before: null, after: '내부 메모' },
      { before: '내부 메모', after: null },
    ]);
    await put(`/${row.id}/internal-memo`, { memo: '다시 메모' });
    const seen = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/proposals/${row.id}`,
      headers: { cookie: proposer.cookie },
    });
    expect(seen.body).not.toContain('다시 메모');
  });
});
