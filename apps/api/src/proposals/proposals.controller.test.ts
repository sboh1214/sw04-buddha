/**
 * 시장 제안 (#77), the proposer's side, against the docker `test` profile: `POST /me/proposals`,
 * `GET /me/proposals`, `GET /me/proposals/:id` and `POST /me/proposals/:id/retract`. What the owner
 * decided (ADR-0069 decision 4 #77; decision 1 #57-8·#57-13; decision 2 #45-12; decision 7) is what
 * is pinned: the form (question 100, one date, YES condition 1,000, sources required, background and
 * category optional, no probability), 접수 first, the onboarding and the restrictions, five waiting
 * and three a day counted by the verified number's hash for a member (an operator's account is
 * exempt, owner decision 2026-10-19), 철회 from 접수 only (signed in is enough, whatever the
 * onboarding — owner decision 2026-10-19), the reason and the market's link (once public) shown to
 * the proposer with the time of each status, and no operator or internal memo, and nobody else's
 * proposal reachable. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createModerationAction,
  createProposal,
  createUser,
} from '@buddha/db/test';
import {
  PROPOSAL_BACKGROUND_MAX,
  PROPOSAL_LIMITS,
  proposalSchema,
  type Proposal,
  type ProposalLimitedDetails,
  type RestrictedDetails,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { ProposalRestrictions } from './proposal-restrictions.js';

const ORIGIN = 'http://localhost:3000';
const jsonHeaders = { origin: ORIGIN, 'content-type': 'application/json' };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
};
type ListPage = { data: Proposal[]; meta: { nextCursor: string | null } };

/** The Korean calendar date `days` from now, `YYYY-MM-DD`. */
function koreanDate(days = 0): string {
  return new Date(Date.now() + 9 * HOUR_MS + days * DAY_MS).toISOString().slice(0, 10);
}

describe.skipIf(!hasTestInfra)('/api/v1/me/proposals (integration)', () => {
  let t: TestApp;
  let user: TestUser;
  /** The keyed hash of `user`'s verified number: what the limits count by. */
  let phoneHash: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    vi.restoreAllMocks();
    user = await signUpTestUser(t);
    phoneHash = await onboard(user);
  });

  /** Finishes the onboarding of `who` and answers the keyed hash of its verified number. */
  async function onboard(who: TestUser, phone?: string): Promise<string> {
    await completeOnboarding(t.db, { userId: who.id, ...(phone ? { phone } : {}) });
    const [verified] = await t.db
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, who.id));
    return t.app.get(PhoneHasher).hash(verified!.phone);
  }

  const form = (overrides: Record<string, unknown> = {}, who: TestUser = user) => ({
    question: '2027년 기준금리가 3% 아래로 내려갈까?',
    deadline: koreanDate(30),
    yesCondition: '한국은행 발표에서 기준금리가 3% 미만이면 YES',
    expectedSources: '한국은행 보도자료',
    expectedAccountId: who.id,
    ...overrides,
  });
  const propose = (payload: unknown, who: TestUser = user) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/me/proposals',
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: JSON.stringify(payload),
    });
  const retract = (id: string, who: TestUser = user, expectedAccountId = who.id) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/me/proposals/${id}/retract`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId },
    });
  const get = (url: string, who: TestUser = user) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
  const one = async (id: string, who: TestUser = user) => {
    const res = await get(`/api/v1/me/proposals/${id}`, who);
    expect(res.statusCode).toBe(200);
    return proposalSchema.parse(res.json<{ data: unknown }>().data);
  };
  const rows = () =>
    t.db.select().from(schema.marketProposals).orderBy(asc(schema.marketProposals.createdAt));
  const errorOf = (res: { json: <T>() => T }) => res.json<ErrorBody>().error;

  // ---- submitting -------------------------------------------------------------------------

  it('takes the form as 접수: trimmed, an empty background none, and the number’s hash kept', async () => {
    const category = await createCategory(t.db);
    const res = await propose(
      form({
        question: '  질문입니다  ',
        background: '   ',
        categoryId: category.id,
        // Not a field of the form (N02 §10): dropped, never stored.
        probability: 70,
      }),
    );
    expect(res.statusCode).toBe(201);
    const answer = proposalSchema.parse(res.json<{ data: unknown }>().data);
    expect(answer).toMatchObject({
      question: '질문입니다',
      background: null,
      category: { id: category.id, slug: category.slug, nameKo: category.nameKo },
      status: 'submitted',
      rejection: null,
      adoption: null,
    });
    expect(answer.statusChangedAt).toBe(answer.createdAt);
    expect(res.body).not.toContain('probability');
    const [row] = await rows();
    expect(row).toMatchObject({
      id: answer.id,
      userId: user.id,
      phoneHash,
      status: 'submitted',
      question: '질문입니다',
      background: null,
    });
    expect(Object.keys(row!).some((key) => /probab/i.test(key))).toBe(false);
  });

  it('refuses a form the owner’s fields do not allow, naming the field, and writes nothing', async () => {
    const category = await createCategory(t.db, { isActive: false });
    const cases: [Record<string, unknown>, string][] = [
      [{ question: '가'.repeat(101) }, 'question'],
      [{ question: '   ' }, 'question'],
      [{ yesCondition: '가'.repeat(1_001) }, 'yesCondition'],
      // Blank once trimmed: refused here, never left to the table's CHECK (a 500).
      [{ yesCondition: '   ' }, 'yesCondition'],
      [{ expectedSources: undefined }, 'expectedSources'],
      [{ expectedSources: '   ' }, 'expectedSources'],
      // Past the column's length: refused here, never left to the database (a 500).
      [{ background: '가'.repeat(PROPOSAL_BACKGROUND_MAX + 1) }, 'background'],
      [{ deadline: '2030-13-01' }, 'deadline'],
      [{ deadline: undefined }, 'deadline'],
      // A date already past in Korea: a question whose result is known.
      [{ deadline: koreanDate(-1) }, 'deadline'],
      [{ categoryId: category.id }, 'categoryId'],
      [{ categoryId: 2_000_000_000 }, 'categoryId'],
    ];
    for (const [overrides, field] of cases) {
      const res = await propose(form(overrides));
      const error = errorOf(res);
      expect({ field, status: res.statusCode, code: error.code }).toEqual({
        field,
        status: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(JSON.stringify(error.details)).toContain(field);
    }
    expect(await rows()).toEqual([]);
    // The bounds themselves pass, and so does today in Korea.
    const ok = await propose(
      form({
        question: '가'.repeat(100),
        yesCondition: '가'.repeat(1_000),
        background: '가'.repeat(PROPOSAL_BACKGROUND_MAX),
        deadline: koreanDate(0),
      }),
    );
    expect(ok.statusCode).toBe(201);
  });

  it('keeps a proposal from an account that has not finished the onboarding (#57-8)', async () => {
    const fresh = await signUpTestUser(t);
    const res = await propose(form({}, fresh), fresh);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: 'ONBOARDING_REQUIRED',
      details: { steps: ['consent', 'verification', 'nickname'] },
    });
    expect(await rows()).toEqual([]);
  });

  it('lets an account that has not finished the onboarding read and retract its own 접수 proposal (owner decision 2026-10-19)', async () => {
    // Its 접수 proposal from before — as a member a terms revision sent back to agree again has.
    const fresh = await signUpTestUser(t);
    const own = await createProposal(t.db, { userId: fresh.id });
    expect((await get('/api/v1/me/proposals', fresh)).statusCode).toBe(200);
    expect((await one(own.id, fresh)).status).toBe('submitted');
    // Signed in is enough, as for deleting one's own post (#46).
    const res = await retract(own.id, fresh);
    expect(res.statusCode, res.body).toBe(200);
    expect(proposalSchema.parse(res.json<{ data: unknown }>().data).status).toBe('retracted');
    // Still only its own: another account's proposal is not there for it, and stays 접수.
    const others = await createProposal(t.db, { userId: user.id, phoneHash });
    const refused = await retract(others.id, fresh);
    expect(refused.statusCode).toBe(404);
    expect(errorOf(refused)).toMatchObject({ code: 'NOT_FOUND' });
    expect((await one(others.id)).status).toBe('submitted');
  });

  it('asks the restriction hook inside the submission, and writes nothing once it refuses (#139, #185)', async () => {
    const hook = t.app.get(ProposalRestrictions);
    const spy = vi
      .spyOn(hook, 'assertMayPropose')
      .mockImplementation(() =>
        Promise.reject(new AppError('FORBIDDEN', { message: 'restricted (stub)' })),
      );
    const refused = await propose(form());
    expect(refused.statusCode).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(user.id);
    expect(await rows()).toEqual([]);
    // Retracting one's own 접수 proposal is not a new proposal: the hook is not asked.
    const own = await createProposal(t.db, { userId: user.id, phoneHash });
    expect((await retract(own.id)).statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect((await propose(form())).statusCode).toBe(201);
  });

  it('answers a restriction ahead of the limits, as a guard would (#139, #185)', async () => {
    // At the waiting limit (made two days ago, so the daily one is not what is reached).
    const old = new Date(Date.now() - 2 * DAY_MS);
    for (let i = 0; i < PROPOSAL_LIMITS.pendingProposals; i += 1) {
      await createProposal(t.db, { userId: user.id, phoneHash, createdAt: old });
    }
    expect(errorOf(await propose(form()))).toMatchObject({
      code: 'PROPOSAL_LIMITED',
      details: { reason: 'pending' },
    });
    // A restriction refuses the same request first: the member is told about it, not the limit.
    const spy = vi
      .spyOn(t.app.get(ProposalRestrictions), 'assertMayPropose')
      .mockImplementation(() =>
        Promise.reject(new AppError('FORBIDDEN', { message: 'restricted (stub)' })),
      );
    const refused = await propose(form());
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused)).toMatchObject({ code: 'FORBIDDEN' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await rows()).toHaveLength(PROPOSAL_LIMITS.pendingProposals);
  });

  it('refuses a new proposal under a writing or an account restriction, naming the later-ending one, and writes nothing; 철회 stays open (#185, #139)', async () => {
    // ADR-0069 decision 4 #77 자격 «계정 제한과 작성 제한 중에는 낼 수 없다» — the real restrictions, as
    // ProposalRestrictions asks them (ADR-0085 결과 5).
    const { user: operator } = await createUser(t.db, { role: 'admin' });
    const { user: approver } = await createUser(t.db, { role: 'admin' });
    const own = await createProposal(t.db, { userId: user.id, phoneHash });
    const ends = new Date(Date.now() + 3 * DAY_MS);
    await createModerationAction(t.db, {
      type: 'writing_restriction',
      userId: user.id,
      createdBy: operator.id,
      endsAt: ends,
    });
    const underWriting = await propose(form());
    expect(underWriting.statusCode, underWriting.body).toBe(403);
    expect(errorOf(underWriting)).toEqual({
      code: 'RESTRICTED',
      message: expect.any(String) as string,
      details: { kind: 'writing', endsAt: ends.toISOString() } satisfies RestrictedDetails,
    });
    // An account restriction with no end on top: the later-ending one is what the member waits for.
    await createModerationAction(t.db, {
      type: 'account_restriction',
      userId: user.id,
      createdBy: operator.id,
      approvedBy: approver.id,
      endsAt: null,
    });
    const underBoth = await propose(form());
    expect(underBoth.statusCode).toBe(403);
    expect(errorOf(underBoth)).toMatchObject({
      code: 'RESTRICTED',
      details: { kind: 'account', endsAt: null },
    });
    expect((await rows()).map((row) => row.id)).toEqual([own.id]);
    // Taking one's own 접수 proposal back stays open under both (#45-12).
    const retracted = await retract(own.id);
    expect(retracted.statusCode, retracted.body).toBe(200);
    // An account restriction alone refuses it all the same (#57-13), with its end.
    const other = await signUpTestUser(t);
    await onboard(other);
    const accountEnds = new Date(Date.now() + 7 * DAY_MS);
    await createModerationAction(t.db, {
      type: 'account_restriction',
      userId: other.id,
      createdBy: operator.id,
      approvedBy: approver.id,
      endsAt: accountEnds,
    });
    expect(errorOf(await propose(form({}, other), other))).toMatchObject({
      code: 'RESTRICTED',
      details: { kind: 'account', endsAt: accountEnds.toISOString() },
    });
    expect(await rows()).toHaveLength(1);
  });

  it('refuses a body naming another account than the session’s, before anything is written', async () => {
    const other = await signUpTestUser(t);
    const res = await propose(form({ expectedAccountId: other.id }));
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toMatchObject({
      code: 'FORBIDDEN',
      details: [{ path: ['expectedAccountId'] }],
    });
    expect(await rows()).toEqual([]);
  });

  // ---- the limits -------------------------------------------------------------------------

  it('takes the fifth waiting proposal and refuses the sixth; decided and retracted ones do not wait', async () => {
    // Older than a day, so the daily limit has nothing to say.
    const old = new Date(Date.now() - 2 * DAY_MS);
    for (let i = 0; i < PROPOSAL_LIMITS.pendingProposals - 1; i += 1) {
      await createProposal(t.db, {
        userId: user.id,
        phoneHash,
        createdAt: new Date(old.getTime() + i),
        status: i % 2 === 0 ? 'submitted' : 'reviewing',
      });
    }
    for (const status of ['adopted', 'rejected', 'retracted'] as const) {
      await createProposal(t.db, { userId: user.id, phoneHash, createdAt: old, status });
    }
    expect((await propose(form())).statusCode).toBe(201);
    const refused = await propose(form());
    expect(refused.statusCode).toBe(429);
    expect(errorOf(refused)).toEqual({
      code: 'PROPOSAL_LIMITED',
      message: expect.any(String) as string,
      details: {
        reason: 'pending',
        limit: PROPOSAL_LIMITS.pendingProposals,
        retryAfterSeconds: null,
      } satisfies ProposalLimitedDetails,
    });
    expect(await rows()).toHaveLength(PROPOSAL_LIMITS.pendingProposals + 3);
    // One retracted makes room again.
    const [waiting] = (await rows()).filter((row) => row.status === 'submitted');
    expect((await retract(waiting!.id)).statusCode).toBe(200);
    expect((await propose(form())).statusCode).toBe(201);
  });

  it('takes three a day and refuses the fourth until the oldest leaves the 24 hours, whatever became of them', async () => {
    const now = Date.now();
    // Out of the window by a minute: does not count.
    await createProposal(t.db, {
      userId: user.id,
      phoneHash,
      status: 'retracted',
      createdAt: new Date(now - DAY_MS - 60_000),
    });
    // In it, retracted and rejected since: they count for their day.
    const oldest = new Date(now - 20 * HOUR_MS);
    await createProposal(t.db, {
      userId: user.id,
      phoneHash,
      status: 'retracted',
      createdAt: oldest,
    });
    await createProposal(t.db, {
      userId: user.id,
      phoneHash,
      status: 'rejected',
      createdAt: new Date(now - 10 * HOUR_MS),
    });
    expect((await propose(form())).statusCode).toBe(201);
    const refused = await propose(form());
    expect(refused.statusCode).toBe(429);
    const details = errorOf(refused).details as ProposalLimitedDetails;
    expect(details).toMatchObject({ reason: 'daily', limit: PROPOSAL_LIMITS.dailyProposals });
    // When the oldest of the three leaves the window (about four hours), rounded up to the minute.
    const expected = (oldest.getTime() + DAY_MS - Date.now()) / 1000;
    expect(details.retryAfterSeconds! % 60).toBe(0);
    expect(details.retryAfterSeconds!).toBeGreaterThanOrEqual(expected - 5);
    expect(details.retryAfterSeconds!).toBeLessThanOrEqual(expected + 65);
  });

  it('counts by the verified number, not the account: an account made again on the number carries on', async () => {
    // A withdrawn account's proposals on the same number (its row stays; its hash is the number's).
    const { user: former } = await createUser(t.db);
    for (let i = 0; i < PROPOSAL_LIMITS.dailyProposals; i += 1) {
      await createProposal(t.db, { userId: former.id, phoneHash, status: 'retracted' });
    }
    const refused = await propose(form());
    expect(refused.statusCode).toBe(429);
    expect((errorOf(refused).details as ProposalLimitedDetails).reason).toBe('daily');
    // Another number is counted apart.
    const other = await signUpTestUser(t);
    await onboard(other);
    expect((await propose(form({}, other), other)).statusCode).toBe(201);
  });

  it('counts the waiting ones by the verified number too: another account’s on the number hold the limit, another number’s do not', async () => {
    // A withdrawn account's five waiting proposals on the same number, older than a day so the
    // daily limit has nothing to say.
    const { user: former } = await createUser(t.db);
    const old = Date.now() - 2 * DAY_MS;
    for (let i = 0; i < PROPOSAL_LIMITS.pendingProposals; i += 1) {
      await createProposal(t.db, {
        userId: former.id,
        phoneHash,
        status: i % 2 === 0 ? 'submitted' : 'reviewing',
        createdAt: new Date(old + i),
      });
    }
    const refused = await propose(form());
    expect(refused.statusCode).toBe(429);
    expect((errorOf(refused).details as ProposalLimitedDetails).reason).toBe('pending');
    // Those five are this number's alone: a member on another number proposes as usual.
    const other = await signUpTestUser(t);
    await onboard(other);
    expect((await propose(form({}, other), other)).statusCode).toBe(201);
    expect(await rows()).toHaveLength(PROPOSAL_LIMITS.pendingProposals + 1);
  });

  it('keeps a closed account’s proposals waiting for the operators, out of its reach, and counted for its number into a new account (#140, ADR-0069 decision 7)', async () => {
    // Five waiting, older than a day; one of them through the API (the others as made before).
    const old = Date.now() - 2 * DAY_MS;
    for (let i = 0; i < PROPOSAL_LIMITS.pendingProposals - 1; i += 1) {
      await createProposal(t.db, { userId: user.id, phoneHash, createdAt: new Date(old + i) });
    }
    const last = await propose(form());
    expect(last.statusCode).toBe(201);
    const [verified] = await t.db
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, user.id));
    // 탈퇴 (#140): a waiting proposal does not refuse it (ADR-0069 decision 4 #140 «처리 중인 신고·이의·
    // 제안: 그대로 검토하고 결과를 기록한다»).
    const closed = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/closure',
      headers: { ...jsonHeaders, cookie: user.cookie },
      payload: { confirmation: '탈퇴', expectedAccountId: user.id },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    // The proposals stay as they were, the account's, waiting; the member reaches none of them.
    const kept = await rows();
    expect(kept).toHaveLength(PROPOSAL_LIMITS.pendingProposals);
    expect(kept.every((row) => row.userId === user.id && row.status === 'submitted')).toBe(true);
    expect(kept.every((row) => row.phoneHash === phoneHash)).toBe(true);
    expect((await get('/api/v1/me/proposals')).statusCode).toBe(401);
    // Signed up again on the same number (#57-17): the number's five still wait, so it waits too.
    const again = await signUpTestUser(t);
    expect(await onboard(again, verified!.phone)).toBe(phoneHash);
    const refused = await propose(form({}, again), again);
    expect(refused.statusCode).toBe(429);
    expect((errorOf(refused).details as ProposalLimitedDetails).reason).toBe('pending');
    // Its own 내 제안 is empty: the closed account's proposals are not the new account's.
    expect((await get('/api/v1/me/proposals', again)).json<ListPage>().data).toEqual([]);
  });

  it('lets an operator’s account propose past both limits, as long as it is one (owner decision 2026-10-19)', async () => {
    // At both limits: five waiting, three of them in the last 24 hours.
    const old = new Date(Date.now() - 2 * DAY_MS);
    for (let i = 0; i < PROPOSAL_LIMITS.pendingProposals; i += 1) {
      await createProposal(t.db, {
        userId: user.id,
        phoneHash,
        ...(i < PROPOSAL_LIMITS.dailyProposals ? {} : { createdAt: old }),
      });
    }
    expect((await propose(form())).statusCode).toBe(429);
    const setRole = (role: 'admin' | 'user') =>
      t.db.update(schema.profiles).set({ role }).where(eq(schema.profiles.userId, user.id));
    await setRole('admin');
    const taken = await propose(form());
    expect(taken.statusCode, taken.body).toBe(201);
    // Stored as any proposal of the number, its hash included: it counts for that number.
    const stored = (await rows()).at(-1)!;
    expect(stored).toMatchObject({ userId: user.id, phoneHash, status: 'submitted' });
    // The role is read in the submission, not from a cache: revoked, the limits are back at once.
    await setRole('user');
    const refused = await propose(form());
    expect(refused.statusCode).toBe(429);
    expect((errorOf(refused).details as ProposalLimitedDetails).reason).toBe('pending');
    expect(await rows()).toHaveLength(PROPOSAL_LIMITS.pendingProposals + 1);
  });

  it('counts two submissions at once on one number one after the other: the limit holds', async () => {
    await createProposal(t.db, { userId: user.id, phoneHash });
    const answers = await Promise.all([propose(form()), propose(form()), propose(form())]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 201, 429]);
    expect(await rows()).toHaveLength(PROPOSAL_LIMITS.dailyProposals);
  });

  // ---- 내 제안 ---------------------------------------------------------------------------

  it('lists the caller’s own proposals, newest first, page by page; another’s is NOT_FOUND', async () => {
    const other = await signUpTestUser(t);
    const theirs = await createProposal(t.db, { userId: other.id });
    const base = Date.now() - HOUR_MS;
    const mine = [];
    for (let i = 0; i < 3; i += 1) {
      mine.push(
        await createProposal(t.db, { userId: user.id, phoneHash, createdAt: new Date(base + i) }),
      );
    }
    const first = await get('/api/v1/me/proposals?limit=2');
    expect(first.statusCode).toBe(200);
    const page = first.json<ListPage>();
    expect(page.data.map((row) => row.id)).toEqual([mine[2]!.id, mine[1]!.id]);
    const second = (
      await get(`/api/v1/me/proposals?limit=2&cursor=${page.meta.nextCursor!}`)
    ).json<ListPage>();
    expect(second.data.map((row) => row.id)).toEqual([mine[0]!.id]);
    expect(second.meta.nextCursor).toBeNull();
    expect((await get(`/api/v1/me/proposals/${theirs.id}`)).statusCode).toBe(404);
    expect((await retract(theirs.id)).statusCode).toBe(404);
    const [stays] = await t.db
      .select({ status: schema.marketProposals.status })
      .from(schema.marketProposals)
      .where(eq(schema.marketProposals.id, theirs.id));
    expect(stays?.status).toBe('submitted');
  });

  it('shows the proposer the reason and the market once public — never an operator or the internal memo', async () => {
    const admin = (await createUser(t.db, { role: 'admin' })).user;
    const draft = await createMarket(t.db, { createdBy: admin.id, status: 'draft' });
    const open = await createMarket(t.db, { createdBy: admin.id });
    // A 중복 of a market not yet public: its link waits for the opening, as an adoption's does.
    const duplicateOfDraft = await createProposal(t.db, {
      userId: user.id,
      phoneHash,
      status: 'rejected',
      adminId: admin.id,
      rejectionReason: 'duplicate',
      rejectionExplanation: '준비 중인 시장과 같습니다',
      duplicateMarketId: draft.id,
    });
    const rejected = await createProposal(t.db, {
      userId: user.id,
      phoneHash,
      status: 'rejected',
      adminId: admin.id,
      rejectionReason: 'duplicate',
      rejectionExplanation: '이미 같은 시장이 있습니다',
      duplicateMarketId: open.id,
      internalMemo: '운영자끼리만',
    });
    const adopted = await createProposal(t.db, {
      userId: user.id,
      phoneHash,
      status: 'adopted',
      adminId: admin.id,
      adoptionMemo: '좋은 제안',
      marketId: draft.id,
      internalMemo: '운영자끼리만',
    });
    const seenRejected = await one(rejected.id);
    expect(seenRejected).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: 'duplicate',
        explanation: '이미 같은 시장이 있습니다',
        duplicateMarket: { id: open.id, slug: open.slug, title: open.title },
      },
      adoption: null,
    });
    // The draft is not public: no link until it opens — neither the adoption's nor the 중복's.
    expect((await one(adopted.id)).adoption).toEqual({ memo: '좋은 제안', market: null });
    expect((await one(duplicateOfDraft.id)).rejection).toEqual({
      reason: 'duplicate',
      explanation: '준비 중인 시장과 같습니다',
      duplicateMarket: null,
    });
    const beforeOpening = (await get('/api/v1/me/proposals')).body;
    for (const hidden of [draft.slug, draft.title]) expect(beforeOpening).not.toContain(hidden);
    await t.db
      .update(schema.markets)
      .set({ status: 'open', openAt: new Date() })
      .where(eq(schema.markets.id, draft.id));
    const opened = { id: draft.id, slug: draft.slug, title: draft.title };
    expect((await one(adopted.id)).adoption).toEqual({ memo: '좋은 제안', market: opened });
    expect((await one(duplicateOfDraft.id)).rejection?.duplicateMarket).toEqual(opened);
    // Nothing of the operators: who, the memo between them, the number's hash.
    const body = (await get('/api/v1/me/proposals')).body;
    for (const hidden of [admin.id, '운영자끼리만', phoneHash]) expect(body).not.toContain(hidden);
    expect(body).not.toMatch(/internalMemo|decidedBy|reviewStartedBy|phoneHash/);
  });

  it('dates each status by the move that gave it: the review start, the decision, the 철회', async () => {
    const admin = (await createUser(t.db, { role: 'admin' })).user;
    // Hours apart, so no two moves share a time and no order of the fallbacks passes by chance.
    const base = Date.now() - 10 * HOUR_MS;
    const at = (hours: number) => new Date(base + hours * HOUR_MS);
    const common = { userId: user.id, phoneHash, adminId: admin.id, createdAt: at(0) };
    const proposals = {
      submitted: await createProposal(t.db, common),
      reviewing: await createProposal(t.db, {
        ...common,
        status: 'reviewing',
        reviewStartedAt: at(1),
      }),
      adopted: await createProposal(t.db, {
        ...common,
        status: 'adopted',
        reviewStartedAt: at(1),
        decidedAt: at(2),
      }),
      rejected: await createProposal(t.db, {
        ...common,
        status: 'rejected',
        reviewStartedAt: at(1),
        decidedAt: at(3),
      }),
      rejectedDirectly: await createProposal(t.db, {
        ...common,
        status: 'rejected',
        rejectUnreviewed: true,
        decidedAt: at(4),
      }),
      retracted: await createProposal(t.db, {
        ...common,
        status: 'retracted',
        retractedAt: at(5),
      }),
    };
    const seen: Record<string, string> = {};
    for (const [name, row] of Object.entries(proposals)) {
      seen[name] = (await one(row.id)).statusChangedAt;
    }
    expect(seen).toEqual({
      submitted: at(0).toISOString(),
      reviewing: at(1).toISOString(),
      // A decision after a review: the decision's time, not the review start's.
      adopted: at(2).toISOString(),
      rejected: at(3).toISOString(),
      rejectedDirectly: at(4).toISOString(),
      retracted: at(5).toISOString(),
    });
  });

  // ---- 철회 ------------------------------------------------------------------------------

  it('retracts a 접수 proposal only, and keeps it as 철회', async () => {
    const created = proposalSchema.parse((await propose(form())).json<{ data: unknown }>().data);
    const res = await retract(created.id);
    expect(res.statusCode).toBe(200);
    const answer = proposalSchema.parse(res.json<{ data: unknown }>().data);
    expect(answer.status).toBe('retracted');
    // The time of the 철회 itself, as stored.
    const [stored] = await t.db
      .select({ retractedAt: schema.marketProposals.retractedAt })
      .from(schema.marketProposals)
      .where(eq(schema.marketProposals.id, created.id));
    expect(answer.statusChangedAt).toBe(stored!.retractedAt!.toISOString());
    // Twice, or once the review started or it was decided: refused naming the status.
    const reviewing = await createProposal(t.db, {
      userId: user.id,
      phoneHash,
      status: 'reviewing',
    });
    const adopted = await createProposal(t.db, { userId: user.id, phoneHash, status: 'adopted' });
    for (const id of [created.id, reviewing.id, adopted.id]) {
      const refused = await retract(id);
      expect(refused.statusCode).toBe(400);
      expect(errorOf(refused)).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ path: ['status'] }],
      });
    }
    // Naming another account in the body: refused before it is looked up.
    const fresh = await createProposal(t.db, { userId: user.id, phoneHash });
    const other = await signUpTestUser(t);
    expect((await retract(fresh.id, user, other.id)).statusCode).toBe(403);
    expect((await one(fresh.id)).status).toBe('submitted');
  });
});
