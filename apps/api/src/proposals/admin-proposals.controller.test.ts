/**
 * 시장 제안 (#77), the operators' side, against the docker `test` profile: `/admin/proposals` — the
 * list and one proposal, 검토 시작, 채택 (with a draft made from the proposal, an existing market or
 * none), 반려 and the internal memo. What the owner decided (ADR-0069 decision 4 #77) is what is
 * pinned: 접수 → 검토 → 채택·반려 and 접수 → 반려 directly, never back and never again; a 반려's reason
 * from the list with an explanation, a 중복's existing market; a 채택's optional memo and its market;
 * the draft opens nothing and is not public, and sits where a market may (the operator's category
 * where the market API files a new market, #17, else the proposal's when it is a leaf or a parent
 * with no leaves, ADR-0041; never under a hidden top-level category); who and when kept
 * and shown, each move recorded in `admin_actions` with its operator; the internal memo apart from
 * the proposer. And the owner's answers of 2026-10-19: a 채택 made with no market takes one later,
 * once (a draft or an existing market, `proposal_link`), the status staying 채택; a retired wish is
 * shown as retired. And #140's: a proposal of an account its member closed is reviewed and decided
 * all the same, its proposer named by no nickname. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  closeAccount,
  completeOnboarding,
  createCategory,
  createMarket,
  createProposal,
} from '@buddha/db/test';
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

  // Every write names the admin on screen (ADR-0092): `who`'s own account unless the payload
  // names another.
  const post = (url: string, payload: object = {}, who: TestUser = admin) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/proposals${url}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...payload }),
    });
  const put = (url: string, payload: object, who: TestUser = admin) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/proposals${url}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...payload }),
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
  const adopt = (id: string, payload: object = {}, who: TestUser = admin) =>
    post(`/${id}/adopt`, payload, who);
  const reject = (id: string, payload: object, who: TestUser = admin) =>
    post(`/${id}/reject`, payload, who);
  const link = (id: string, payload: object, who: TestUser = admin) =>
    post(`/${id}/market`, payload, who);
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

  it('refuses every operator write that names another admin than the cookie’s, or none, before the proposal is read (ADR-0092)', async () => {
    const submitted = await proposal();
    const reviewing = await proposal({ status: 'reviewing' });
    const adopted = await proposal({ status: 'adopted' });
    const existing = await createMarket(t.db, { createdBy: admin.id, categoryId: category.id });
    const before = {
      proposals: await t.db.select().from(schema.marketProposals),
      markets: await t.db.select().from(schema.markets),
    };
    const pathsOf = (res: { json: <T>() => T }) =>
      (errorOf(res).details as { path: (string | number)[] }[] | undefined)?.map(
        (detail) => detail.path,
      );
    const writes = [
      (shown: object, who: TestUser) => post(`/${submitted.id}/review`, shown, who),
      (shown: object, who: TestUser) =>
        adopt(reviewing.id, { memo: '채택', market: { type: 'draft' }, ...shown }, who),
      (shown: object, who: TestUser) =>
        link(adopted.id, { market: { type: 'existing', marketId: existing.id }, ...shown }, who),
      (shown: object, who: TestUser) =>
        reject(submitted.id, { reason: 'other', explanation: '설명', ...shown }, who),
      (shown: object, who: TestUser) =>
        put(`/${adopted.id}/internal-memo`, { memo: '메모', ...shown }, who),
    ];
    for (const write of writes) {
      // The screen still shows `admin` while the tab's cookie is `second`'s.
      const refused = await write({ expectedAccountId: admin.id }, second);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(errorOf(refused).code).toBe('FORBIDDEN');
      expect(pathsOf(refused)).toEqual([['expectedAccountId']]);
      // No account at all: a validation error naming the field.
      const unnamed = await write({ expectedAccountId: undefined }, admin);
      expect(unnamed.statusCode, unnamed.body).toBe(400);
      expect(pathsOf(unnamed)).toEqual([['expectedAccountId']]);
    }
    // Nothing moved, linked, noted or made, and nothing recorded.
    expect({
      proposals: await t.db.select().from(schema.marketProposals),
      markets: await t.db.select().from(schema.markets),
    }).toEqual(before);
    expect(await actions()).toEqual([]);
    // The cookie's own account is taken, and recorded as the one who acted.
    expect(answerOf(await review(submitted.id, second)).reviewStartedBy).toMatchObject({
      id: second.id,
    });
    expect((await actions()).map((action) => [action.type, action.adminId])).toEqual([
      ['proposal_review', second.id],
    ]);
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

  it('reviews and decides a proposal whose proposer closed the account, naming the proposer by no nickname (#140)', async () => {
    // ADR-0069 decision 4 #140 «처리 중인 신고·이의·제안: 그대로 검토하고 결과를 기록한다. 탈퇴한 본인은
    // 볼 수 없다»: the closure (#140) leaves the row, the operators go on with it.
    const waiting = await proposal();
    await closeAccount(t.db, proposer.id);
    const listed = (await get('?status=submitted')).json<ListPage>();
    expect(listed.data.map((row) => [row.id, row.proposer])).toEqual([
      [waiting.id, { id: proposer.id, nickname: null }],
    ]);
    expect(answerOf(await review(waiting.id))).toMatchObject({
      status: 'reviewing',
      proposer: { id: proposer.id, nickname: null },
      reviewStartedBy: { id: admin.id },
    });
    const adopted = answerOf(await adopt(waiting.id, { memo: '채택합니다' }, second));
    expect(adopted).toMatchObject({
      status: 'adopted',
      proposer: { id: proposer.id, nickname: null },
      decidedBy: { id: second.id },
      adoption: { memo: '채택합니다', market: null },
    });
    expect((await actions()).map((row) => [row.type, row.adminId])).toEqual([
      ['proposal_review', admin.id],
      ['proposal_adopt', second.id],
    ]);
    // An operator who reviewed it and closed the account since (the role revoked first, #57-17) is
    // named by no nickname either (AdminAccountActor, #140).
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, admin.id));
    await closeAccount(t.db, admin.id);
    const read = answerOf(await get(`/${waiting.id}`, second));
    expect(read.reviewStartedBy).toEqual({ id: admin.id, nickname: null });
    expect(read.decidedBy).toEqual({ id: second.id, nickname: expect.any(String) as string });
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
    // A wish retired after it was proposed (an operator's hide, #17; written here through the
    // database) is refused as retired, not as missing: the proposal does name a category.
    const retiredWish = await proposal({ status: 'reviewing', categoryId: retired.id });
    // The screen reads it as retired (owner decision 2026-10-19: no default for the draft then).
    expect(answerOf(await get(`/${retiredWish.id}`)).category).toEqual({
      id: retired.id,
      slug: retired.slug,
      nameKo: retired.nameKo,
      isActive: false,
    });
    expect(answerOf(await get(`/${today.id}`)).category).toMatchObject({
      id: category.id,
      isActive: true,
    });
    const wishInactive = await adopt(retiredWish.id, { market: { type: 'draft' } });
    expect(wishInactive.statusCode).toBe(400);
    expect(errorOf(wishInactive)).toMatchObject({
      details: [{ path: ['market', 'categoryId'], message: 'inactive' }],
    });
    // A sub-category under a hidden top-level category is hidden with it (#17), the operator's
    // pick and the wish alike, though its own state is untouched.
    const shelved = await createCategory(t.db, { isActive: false });
    const underShelved = await createCategory(t.db, { parentId: shelved.id });
    const pickedUnder = await adopt(noCategory.id, {
      market: { type: 'draft', categoryId: underShelved.id },
    });
    expect(pickedUnder.statusCode).toBe(400);
    expect(errorOf(pickedUnder)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: ['market', 'categoryId'], message: 'parent_inactive' }],
    });
    const wishUnder = await proposal({ status: 'reviewing', categoryId: underShelved.id });
    const wishedUnder = await adopt(wishUnder.id, { market: { type: 'draft' } });
    expect(wishedUnder.statusCode).toBe(400);
    expect(errorOf(wishedUnder)).toMatchObject({
      details: [{ path: ['market', 'categoryId'], message: 'parent_inactive' }],
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
    ).toEqual(['reviewing', 'reviewing', 'reviewing', 'reviewing']);
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
    // Picked by the operator, the parent is refused as the market API refuses it since #17 (a
    // top-level category with an active sub-category holds no new market), naming the adoption's
    // field; its leaf is taken.
    const parentPicked = await adopt(parentWish.id, {
      market: { type: 'draft', categoryId: category.id },
    });
    expect(parentPicked.statusCode).toBe(400);
    expect(errorOf(parentPicked)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: ['market', 'categoryId'], message: 'subcategories' }],
    });
    expect(answerOf(await get(`/${parentWish.id}`)).status).toBe('reviewing');
    expect(
      await draftCategory(
        answerOf(await adopt(parentWish.id, { market: { type: 'draft', categoryId: leaf.id } })),
      ),
    ).toBe(leaf.id);
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
      // What the open asks of a draft (#17's open-items check), so the route below opens it.
      tags: ['금리'],
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
      payload: { expectedAccountId: admin.id },
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

  // ---- a market linked later (owner decision 2026-10-19) -----------------------------------

  it('links an existing market later, once, to a proposal adopted with none; the status stays 채택', async () => {
    const adopted = answerOf(
      await adopt((await proposal({ status: 'reviewing' })).id, { memo: '채택 사유' }),
    );
    expect(adopted).toMatchObject({
      status: 'adopted',
      adoption: { memo: '채택 사유', market: null },
      marketLinkedAt: null,
      marketLinkedBy: null,
    });
    const draft = await createMarket(t.db, {
      createdBy: admin.id,
      categoryId: category.id,
      status: 'draft',
      // What the open asks of a draft (#17's open-items check), so the route below opens it.
      tags: ['금리'],
    });
    // An unknown market is NOT_FOUND naming the field, and nothing is linked.
    const unknown = await link(adopted.id, {
      market: { type: 'existing', marketId: randomUUID() },
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown)).toMatchObject({ details: [{ path: ['market', 'marketId'] }] });
    // Another operator links it: kept with who and when, beside the 채택's own record.
    const linked = answerOf(
      await link(adopted.id, { market: { type: 'existing', marketId: draft.id } }, second),
    );
    expect(linked).toMatchObject({
      status: 'adopted',
      decidedAt: adopted.decidedAt,
      decidedBy: { id: admin.id },
      marketLinkedBy: { id: second.id },
      adoption: {
        memo: '채택 사유',
        market: { id: draft.id, slug: draft.slug, title: draft.title, status: 'draft' },
      },
    });
    expect(Date.parse(linked.marketLinkedAt!)).toBeGreaterThanOrEqual(
      Date.parse(adopted.decidedAt!),
    );
    expect(answerOf(await get(`/${adopted.id}`))).toEqual(linked);
    expect((await actions()).at(-1)).toEqual({
      adminId: second.id,
      type: 'proposal_link',
      targetType: 'market_proposal',
      targetId: adopted.id,
      payload: { marketId: draft.id, marketCreated: false },
    });
    // The proposer sees the link once the market is public, as after a 채택 with it.
    expect((await proposerView(adopted.id)).adoption).toEqual({ memo: '채택 사유', market: null });
    const opened = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${draft.id}/open`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { expectedAccountId: admin.id },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect((await proposerView(adopted.id)).adoption).toEqual({
      memo: '채택 사유',
      market: { id: draft.id, slug: draft.slug, title: draft.title },
    });
    // Once: a second link is refused naming `market`, and the first stays.
    const other = await createMarket(t.db, { createdBy: admin.id, categoryId: category.id });
    const again = await link(adopted.id, { market: { type: 'existing', marketId: other.id } });
    expect(again.statusCode).toBe(400);
    expect(errorOf(again)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: ['market'], message: 'already linked' }],
    });
    expect(answerOf(await get(`/${adopted.id}`)).adoption?.market?.id).toBe(draft.id);
    // A 채택 that came with its market takes no other either.
    const withMarket = answerOf(
      await adopt((await proposal({ status: 'reviewing' })).id, {
        market: { type: 'existing', marketId: other.id },
      }),
    );
    expect(withMarket.marketLinkedAt).toBeNull();
    const replaced = await link(withMarket.id, {
      market: { type: 'existing', marketId: draft.id },
    });
    expect(replaced.statusCode).toBe(400);
    expect(errorOf(replaced)).toMatchObject({ details: [{ path: ['market'] }] });
    expect(
      (await actions()).filter((row) => row.type === 'proposal_link').map((row) => row.targetId),
    ).toEqual([adopted.id]);
  });

  it('links only a 채택: any other status is refused naming it, and nothing is made', async () => {
    const submitted = await proposal();
    const reviewing = await proposal({ status: 'reviewing' });
    const rejected = await proposal({ status: 'rejected' });
    const retracted = await proposal({ status: 'retracted' });
    for (const row of [submitted, reviewing, rejected, retracted]) {
      for (const market of [{ type: 'draft' }, { type: 'existing', marketId: randomUUID() }]) {
        const res = await link(row.id, { market });
        expect(res.statusCode).toBe(400);
        expect(errorOf(res)).toMatchObject({
          code: 'VALIDATION_ERROR',
          details: [{ path: ['status'] }],
        });
      }
    }
    // A body without a market is no link.
    const adopted = await proposal({ status: 'adopted' });
    expect((await link(adopted.id, {})).statusCode).toBe(400);
    expect((await link(randomUUID(), { market: { type: 'draft' } })).statusCode).toBe(404);
    expect(await t.db.select().from(schema.markets)).toEqual([]);
    expect(await actions()).toEqual([]);
  });

  it('makes a draft from the proposal when it links one later, with the 채택’s defaults and refusals', async () => {
    const adopted = await proposal({
      status: 'adopted',
      categoryId: null,
      deadline: koreanDate(40),
    });
    // No category to file the draft under: refused as at the 채택, and nothing is written.
    const missing = await link(adopted.id, { market: { type: 'draft' } });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing)).toMatchObject({
      details: [{ path: ['market', 'categoryId'], message: 'required' }],
    });
    expect(await t.db.select().from(schema.markets)).toEqual([]);
    expect(answerOf(await get(`/${adopted.id}`))).toMatchObject({
      adoption: { market: null },
      marketLinkedAt: null,
    });
    const answer = answerOf(
      await link(adopted.id, { market: { type: 'draft', categoryId: category.id } }),
    );
    expect(answer).toMatchObject({
      status: 'adopted',
      marketLinkedBy: { id: admin.id },
      adoption: { market: { status: 'draft' } },
    });
    const marketId = answer.adoption!.market!.id;
    const [market] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    expect(market).toMatchObject({
      status: 'draft',
      title: adopted.question,
      rules: adopted.yesCondition,
      resolutionSource: adopted.expectedSources,
      description: adopted.background,
      categoryId: category.id,
      createdBy: admin.id,
      openAt: null,
    });
    expect(market!.closeAt.toISOString()).toBe(
      proposalDraftCloseAt(adopted.deadline).toISOString(),
    );
    expect((await actions()).map((row) => [row.type, row.payload])).toEqual([
      ['market_create', expect.anything()],
      ['proposal_link', { marketId, marketCreated: true }],
    ]);
  });

  it('lets one of two links at once win; the other is told the proposal has a market', async () => {
    const adopted = await proposal({ status: 'adopted' });
    const [a, b] = await Promise.all([
      link(adopted.id, { market: { type: 'draft' } }),
      link(adopted.id, { market: { type: 'draft' } }, second),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const lost = a.statusCode === 400 ? a : b;
    expect(errorOf(lost)).toMatchObject({ details: [{ path: ['market'] }] });
    // The loser's draft went with its transaction: one market, one link.
    expect(await t.db.select().from(schema.markets)).toHaveLength(1);
    expect((await actions()).filter((row) => row.type === 'proposal_link')).toHaveLength(1);
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
