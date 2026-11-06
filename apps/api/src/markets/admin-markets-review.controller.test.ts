/**
 * 개설 검수 (#78, ADR-0099; ADR-0093 decision 1 #173 items 1·12, decision 2 #172 items 4·5·6·12·13,
 * decision 3 '#78 수정 기록의 사유' and '#21 앞당긴 개장') through the admin routes against the docker
 * `test` profile: the submission behind the open-items check and a close still ahead, with its
 * `market_review` request and the lead-close gap it stores; the approval and the 반려 by an admin
 * other than the creator, the editors and the submitter, the checklist complete, the gate and the
 * close checked again; the 되돌리기 from REVIEW (retracted by the submitter, rejected by anyone
 * else) and from SCHEDULED; the scheduled open moved with a reason; the 검수 대기 queue; the content
 * locked in REVIEW and SCHEDULED; `AdminMarket.review`; the admin on screen (ADR-0092); an approval
 * and a 되돌리기 at once; and what is published. The open (#21, ADR-0100): an approval or a
 * reschedule that finds the scheduled open come opens the market at once, and the `market.open`
 * and `market.close` jobs the approval, the reschedule and the 되돌리기 register or cancel
 * (inspected with a BullMQ Queue on the test Redis, as the worker sees them); no route opens a
 * market otherwise. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createMarketInReview,
  createScheduledMarket,
  setReleaseSetting,
  TEST_PRICE_PROTECTION_TICKS,
} from '@buddha/db/test';
import {
  PRICE_PROTECTION_TICKS_SETTING,
  JOB_NAMES,
  MARKET_REVIEW_APPROVAL_KIND,
  MARKET_REVIEW_CHECKLIST,
  MARKET_REVIEW_REQUEST_REASON,
  REVIEW_CHECKLIST_INCOMPLETE,
  floorToMinute,
  marketChannel,
  marketCloseJobId,
  marketOpenJobId,
  type AdminMarket,
  type AdminMarketReviewItem,
  type Market,
  type MarketStatus,
  type PriceSeries,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MARKETS_QUEUE } from '../jobs/market-jobs.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { discoverRoutes } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A well-formed request id that names no request. */
const NO_REQUEST = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
const DAY_MS = 24 * HOUR_MS;

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: (string | number)[]; message: string }[];
  };
};
type QueuePage = { data: AdminMarketReviewItem[]; meta: { nextCursor: string | null } };
type Res = { statusCode: number; json: <U>() => U };

/** An ISO instant, `ms` from the epoch. */
const iso = (ms: number) => new Date(ms).toISOString();
/** A whole minute a week ahead: the close the tests' drafts start from. */
const week = () => floorToMinute(Date.now()) + 7 * DAY_MS;

describe.skipIf(!hasTestInfra)('admin market review (integration)', () => {
  let t: TestApp;
  /** The worker's view of the `markets` queue: a plain Queue on its own client. */
  let inspector: Redis;
  let jobQueue: Queue;
  /** Creates the drafts and, unless a test says otherwise, submits them. */
  let creator: TestUser;
  let second: TestUser;
  let third: TestUser;
  let category: { id: number; slug: string };
  /** Keeps every draft's YES condition its own, so no two are each other's 중복 by accident. */
  let drafts = 0;

  beforeAll(async () => {
    t = await createTestApp();
    inspector = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    jobQueue = new Queue(MARKETS_QUEUE, { connection: inspector });
  });
  afterAll(async () => {
    await jobQueue?.close();
    await inspector?.quit();
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
    // Jobs are keyed by market and instant, so nothing of an earlier test can collide; the queue
    // is still emptied so what a test finds there is what it registered.
    await jobQueue.obliterate({ force: true });
    creator = await makeAdmin();
    second = await makeAdmin();
    third = await makeAdmin();
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    // The 가격 보호 폭 default the test environment enters (#119, ADR-0107 결과 3): a market copies
    // it at creation and its review submission needs one (OPEN_ITEMS_MISSING priceProtection).
    await setReleaseSetting(t.db, {
      adminId: creator.id,
      key: PRICE_PROTECTION_TICKS_SETTING.key,
      status: 'test',
      value: TEST_PRICE_PROTECTION_TICKS,
    });
  });

  // Every write names the admin on screen (ADR-0092): `who`'s own account unless the payload
  // names another.
  const post = (url: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const patch = (url: string, who: TestUser, payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'PATCH',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const get = (url: string, who: TestUser = creator) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;
  const submit = (id: string, who: TestUser = creator) => post(`${marketUrl(id)}/submit`, who);
  /** The request a decision names (`requestId`): the pending one, or an id no market has. */
  const pendingId = async (marketId: string) =>
    (await requestsFor(marketId)).find((row) => row.status === 'pending')?.id ?? NO_REQUEST;
  const approve = async (id: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    post(`${marketUrl(id)}/approve`, who, {
      requestId: await pendingId(id),
      checklist: [...MARKET_REVIEW_CHECKLIST],
      reason: '검수 통과',
      ...payload,
    });
  const reject = async (id: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    post(`${marketUrl(id)}/reject`, who, {
      requestId: await pendingId(id),
      rejectReason: 'ambiguity',
      reason: 'YES 조건의 기준이 모호하다',
      ...payload,
    });
  const revert = (id: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    post(`${marketUrl(id)}/revert`, who, { reason: '규칙을 고친다', ...payload });
  const reschedule = (id: string, who: TestUser, payload: Record<string, unknown>) =>
    post(`${marketUrl(id)}/reschedule`, who, { reason: '발표 일정이 당겨졌다', ...payload });
  const queue = (query = '', who: TestUser = creator) =>
    get(`/api/v1/admin/market-reviews${query}`, who);
  const publicDetail = (id: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1/markets/${id}` });

  /**
   * A complete draft's body closing at `closeMs` (a whole minute): every rule item, the scheduled
   * open two days before the close (still ahead: the submission does not ask it), 사건 기한 a day
   * after the close and the judgement a day after that, the zone, no announcement ('없음') and a
   * tag.
   */
  const draftBody = (closeMs: number, overrides: Record<string, unknown> = {}) => {
    drafts += 1;
    return {
      title: `기준금리 3% 이하로 인하? ${String(drafts)}`,
      description: '한국은행 금융통화위원회는 해마다 여덟 번 기준금리를 정한다.',
      yesCondition: `사건 기한까지 한국은행이 기준금리를 3% 이하로 내리면 YES. (${String(drafts)})`,
      noCondition: '사건 기한까지 3% 이하로 내리지 않으면 NO.',
      eventDeadline: iso(closeMs + DAY_MS),
      primarySource: { name: '한국은행 보도자료', url: 'https://www.bok.or.kr' },
      longDelayDays: 14,
      delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정한다.',
      categoryId: category.id,
      scheduledOpenAt: iso(closeMs - 2 * DAY_MS),
      closeAt: iso(closeMs),
      scheduledJudgementAt: iso(closeMs + 2 * DAY_MS),
      judgementTimeZone: 'Asia/Seoul',
      tags: ['검수'],
      ...overrides,
    };
  };

  const data = <T>(res: Res) => res.json<{ data: T }>().data;
  const detail = (res: Res) => data<AdminMarket>(res);
  const errorOf = (res: Res) => res.json<ErrorBody>().error;

  /** A draft closing at `closeMs`, made through the route by `who` (the creator by default). */
  async function createDraft(
    overrides: Record<string, unknown> = {},
    who: TestUser = creator,
    closeMs = week(),
  ): Promise<AdminMarket> {
    const res = await post('/api/v1/admin/markets', who, draftBody(closeMs, overrides));
    expect(res.statusCode).toBe(201);
    return detail(res);
  }
  /** A draft made and submitted through the routes. */
  async function submitted(
    overrides: Record<string, unknown> = {},
    who: TestUser = creator,
    closeMs = week(),
  ): Promise<AdminMarket> {
    const draft = await createDraft(overrides, who, closeMs);
    const res = await submit(draft.id, who);
    expect(res.statusCode).toBe(200);
    return detail(res);
  }
  /** A market submitted by the creator and approved by the third admin, through the routes. */
  async function scheduled(overrides: Record<string, unknown> = {}): Promise<AdminMarket> {
    const review = await submitted(overrides);
    const res = await approve(review.id, third);
    expect(res.statusCode).toBe(200);
    return detail(res);
  }

  /** The release setting `market.lead_close_gap` as an admin enters it (a test value). */
  async function setGap(value: number) {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/release-settings/market.lead_close_gap',
      headers: { ...jsonHeaders, cookie: creator.cookie },
      payload: { status: 'test', value, reason: '선행 마감 시험값', expectedAccountId: creator.id },
    });
    expect(res.statusCode).toBe(200);
  }

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }
  async function eventsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, marketId))
      .orderBy(asc(schema.marketEvents.id));
  }
  /** The market's admin records, oldest first, without the create and the edits. */
  async function reviewActionsFor(marketId: string) {
    const rows = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, marketId))
      .orderBy(asc(schema.adminActions.createdAt));
    return rows.filter((row) => row.type !== 'market_create' && row.type !== 'market_update');
  }
  async function requestsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.targetId, marketId))
      .orderBy(asc(schema.approvalRequests.requestedAt));
  }
  const nicknameOf = async (user: TestUser) => {
    const [profile] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    return profile!.nickname;
  };
  const actorOf = async (user: TestUser) => ({ id: user.id, nickname: await nicknameOf(user) });

  function expectRefused(res: Res, status: number, code: string, path: (string | number)[]) {
    expect({ status: res.statusCode, code: errorOf(res).code }).toEqual({ status, code });
    expect(errorOf(res).details?.[0]?.path).toEqual(path);
  }
  /** The `status` refusal every review write gives a status it does not take. */
  function expectWrongStatus(res: Res, status: MarketStatus) {
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      code: 'VALIDATION_ERROR',
      message: `Market is ${status}`,
      details: [{ path: ['status'], message: `market is ${status}` }],
    });
  }
  function expectNotAllowed(
    res: Res,
    reason: 'creator' | 'editor' | 'requester' | 'decided' | 'retracted',
  ) {
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('APPROVAL_NOT_ALLOWED');
    expect(errorOf(res).details).toEqual([{ path: ['request'], message: reason }]);
  }

  /** The ids of the jobs waiting in the `markets` queue, sorted. */
  async function jobIds() {
    const jobs = await jobQueue.getJobs(['delayed', 'waiting', 'active']);
    return jobs.map((job) => job.id).sort();
  }

  /** Subscribes to the market's channel for the length of `body`. */
  async function listening(marketId: string, body: (received: string[]) => Promise<void>) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel, message) => received.push(message));
    await subscriber.subscribe(marketChannel(marketId));
    try {
      await body(received);
    } finally {
      await subscriber.quit();
    }
  }

  // --- submission -----------------------------------------------------------------------------
  it('submits a complete draft: the request, the event, the record and the gap it checked; the content locks and nothing is public', async () => {
    await setGap(30);
    const close = week();
    const draft = await createDraft(
      { scheduledAnnouncementAt: iso(close + HOUR_MS) },
      creator,
      close,
    );
    expect(draft.leadCloseGapMinutes).toBe(30);
    await listening(draft.id, async (received) => {
      const res = await submit(draft.id);
      expect(res.statusCode).toBe(200);
      const shown = detail(res);
      expect(shown).toMatchObject({
        status: 'review',
        leadCloseGapMinutes: 30,
        missingOpenItems: [],
      });

      const [request] = await requestsFor(draft.id);
      expect(request).toMatchObject({
        kind: MARKET_REVIEW_APPROVAL_KIND,
        targetType: 'market',
        targetId: draft.id,
        payload: { title: draft.title },
        requestedBy: creator.id,
        requestReason: MARKET_REVIEW_REQUEST_REASON,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
      });
      const events = await eventsFor(draft.id);
      const event = events.at(-1)!;
      expect(event).toMatchObject({
        type: 'submitted',
        actorId: creator.id,
        fromStatus: 'draft',
        toStatus: 'review',
        payload: { approvalId: request!.id, leadCloseGapMinutes: 30 },
      });
      // One instant: the request's, the event's, the record's and the row's.
      expect(event.createdAt).toEqual(request!.requestedAt);
      const row = await marketRow(draft.id);
      expect(row).toMatchObject({
        status: 'review',
        leadCloseGapMinutes: 30,
        statusEventId: event.id,
      });
      expect(row.updatedAt).toEqual(event.createdAt);
      const [action] = await reviewActionsFor(draft.id);
      expect(action).toMatchObject({
        adminId: creator.id,
        type: 'market_submit',
        targetType: 'market',
        payload: { approvalId: request!.id, after: { status: 'review', leadCloseGapMinutes: 30 } },
      });
      expect(action!.createdAt).toEqual(event.createdAt);

      expect(shown.review).toEqual({
        pending: {
          requestId: request!.id,
          requestedBy: await actorOf(creator),
          requestedAt: request!.requestedAt.toISOString(),
        },
        createdBy: await actorOf(creator),
        editors: [],
        sameCondition: [],
        log: [
          {
            type: 'submitted',
            actor: await actorOf(creator),
            at: event.createdAt.toISOString(),
            fromStatus: 'draft',
            toStatus: 'review',
            reason: null,
            rejectReason: null,
            checklist: null,
            scheduledOpenBefore: null,
            scheduledOpenAfter: null,
          },
        ],
      });
      // The detail read on the pool says the same.
      expect(detail(await get(marketUrl(draft.id))).review).toEqual(shown.review);

      // A market in REVIEW is not public, and nothing told a viewer about it.
      expect((await publicDetail(draft.id)).statusCode).toBe(404);
      await sleep(100);
      expect(received).toEqual([]);
    });

    // Locked (#172 item 6 (a)): no edit, no second submission.
    expectWrongStatus(await patch(marketUrl(draft.id), creator, { title: '바꾼 질문' }), 'review');
    expectWrongStatus(await submit(draft.id, second), 'review');
    expect(await requestsFor(draft.id)).toHaveLength(1);
  });

  it('refuses a submission the open-items check finds wanting, then a past close, and any status but a draft — writing nothing', async () => {
    // Untagged: OPEN_ITEMS_MISSING with open's details, before the close is looked at.
    const untagged = await createDraft({ tags: [] });
    const missing = await submit(untagged.id);
    expect(missing.statusCode).toBe(422);
    expect(errorOf(missing)).toEqual({
      code: 'OPEN_ITEMS_MISSING',
      message: 'The market misses what it needs to open: tags',
      details: [{ path: ['tags'], message: 'required' }],
    });
    const passed = await createMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      tags: ['검수'],
      status: 'draft',
      closeAt: new Date(floorToMinute(Date.now()) - MINUTE_MS),
    });
    const late = await submit(passed.id);
    expect(late.statusCode).toBe(400);
    expect(errorOf(late)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'closeAt must be in the future',
      details: [{ path: ['closeAt'], message: 'must be in the future' }],
    });
    const open = await createMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      tags: ['검수'],
    });
    expectWrongStatus(await submit(open.id), 'open');
    for (const id of [untagged.id, passed.id, open.id]) {
      expect(await requestsFor(id)).toEqual([]);
      expect((await eventsFor(id)).map((event) => event.type)).not.toContain('submitted');
      expect(await reviewActionsFor(id)).toEqual([]);
    }
    expect((await marketRow(untagged.id)).status).toBe('draft');
    expect((await marketRow(passed.id)).status).toBe('draft');
    expect((await submit(randomUUID())).statusCode).toBe(404);
  });

  // --- approval -------------------------------------------------------------------------------
  it('approves by an admin who neither created, edited nor submitted it, with the gap the submission stored; public as scheduled', async () => {
    await setGap(30);
    const close = week();
    const review = await submitted(
      { scheduledAnnouncementAt: iso(close + HOUR_MS) },
      creator,
      close,
    );
    // The setting moved on: the approval checks with the 30 minutes the submission stored, which
    // the close still keeps (an hour before the announcement), not with the 120 now in force.
    await setGap(120);
    await listening(review.id, async (received) => {
      const res = await approve(review.id, third, {
        checklist: [...MARKET_REVIEW_CHECKLIST].reverse(),
        reason: '  검수 통과  ',
      });
      expect(res.statusCode).toBe(200);
      const shown = detail(res);
      expect(shown).toMatchObject({
        status: 'scheduled',
        leadCloseGapMinutes: 30,
        missingOpenItems: [],
      });
      expect(shown.review.pending).toBeNull();

      const [request] = await requestsFor(review.id);
      expect(request).toMatchObject({
        status: 'approved',
        decidedBy: third.id,
        decisionReason: '검수 통과',
      });
      const event = (await eventsFor(review.id)).at(-1)!;
      const approval = {
        approvalId: request!.id,
        checklist: [...MARKET_REVIEW_CHECKLIST],
        reason: '검수 통과',
      };
      expect(event).toMatchObject({
        type: 'approved',
        actorId: third.id,
        fromStatus: 'review',
        toStatus: 'scheduled',
        payload: approval,
      });
      expect(event.createdAt).toEqual(request!.decidedAt);
      const [, action] = await reviewActionsFor(review.id);
      expect(action).toMatchObject({
        adminId: third.id,
        type: 'market_approve',
        payload: approval,
      });
      expect(action!.createdAt).toEqual(event.createdAt);
      expect(shown.review.log.map((entry) => [entry.type, entry.actor?.id])).toEqual([
        ['approved', third.id],
        ['submitted', creator.id],
      ]);
      expect(shown.review.log[0]).toMatchObject({
        checklist: [...MARKET_REVIEW_CHECKLIST],
        reason: '검수 통과',
        rejectReason: null,
      });

      // SCHEDULED is public (#173 item 12): the status is published with the transition's key.
      await waitForMessages(received, 1, 'market:status of the approval');
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        marketId: review.id,
        status: 'scheduled',
        statusEventId: String(event.id),
      });
      const pub = await publicDetail(review.id);
      expect(pub.statusCode).toBe(200);
      expect(data<Market>(pub).status).toBe('scheduled');
    });
    expect(data<AdminMarketReviewItem[]>(await queue())).toEqual([]);
    // Approved once: a second approval finds the market scheduled.
    expectWrongStatus(await approve(review.id, second), 'scheduled');
  });

  it('refuses the creator, an editor from an earlier cycle and the submitter, in that order; another admin decides', async () => {
    const draft = await createDraft();
    // The second admin edits the creator's draft: an editor from here on, every cycle.
    expect((await patch(marketUrl(draft.id), second, { title: '고친 질문' })).statusCode).toBe(200);
    expect((await submit(draft.id)).statusCode).toBe(200);

    // The creator submitted it too: `creator` comes first.
    expectNotAllowed(await approve(draft.id, creator), 'creator');
    expectNotAllowed(await reject(draft.id, creator), 'creator');
    expectNotAllowed(await approve(draft.id, second), 'editor');
    expectNotAllowed(await reject(draft.id, second), 'editor');
    // The third admin rejects; then submits it again and is its submitter.
    expect((await reject(draft.id, third)).statusCode).toBe(200);
    expect((await submit(draft.id, third)).statusCode).toBe(200);
    expectNotAllowed(await approve(draft.id, third), 'requester');
    expectNotAllowed(await reject(draft.id, third), 'requester');
    // The edit was before the first submission: still an editor.
    expectNotAllowed(await approve(draft.id, second), 'editor');
    expectNotAllowed(await approve(draft.id, creator), 'creator');

    const shown = detail(await get(marketUrl(draft.id)));
    expect(shown.review).toMatchObject({
      pending: { requestedBy: await actorOf(third) },
      createdBy: await actorOf(creator),
      editors: [await actorOf(second)],
    });
    const requests = await requestsFor(draft.id);
    expect(requests.map((request) => [request.status, request.decidedBy])).toEqual([
      ['rejected', third.id],
      ['pending', null],
    ]);

    const fourth = await makeAdmin();
    const res = await approve(draft.id, fourth);
    expect(res.statusCode).toBe(200);
    expect(detail(res).status).toBe('scheduled');
    expect((await requestsFor(draft.id)).at(-1)).toMatchObject({
      status: 'approved',
      decidedBy: fourth.id,
    });
  });

  it('decides only the request its admin reviewed: a market sent back and submitted again is a new one', async () => {
    // Codex review of #78: a dialog left open on one submission must not approve or reject the
    // next one, whose content its admin never saw.
    const review = await submitted();
    const [first] = await requestsFor(review.id);
    // Its submitter's 되돌리기 retracts the request; submitted again, the market holds a new one.
    expect((await revert(review.id, creator)).statusCode).toBe(200);
    expect((await submit(review.id)).statusCode).toBe(200);
    expectNotAllowed(await approve(review.id, third, { requestId: first!.id }), 'retracted');
    expectNotAllowed(await reject(review.id, third, { requestId: first!.id }), 'retracted');
    // Another admin's 되돌리기 rejects it: 'decided'.
    const second = (await requestsFor(review.id)).at(-1)!;
    expect((await revert(review.id, await makeAdmin())).statusCode).toBe(200);
    expect((await submit(review.id)).statusCode).toBe(200);
    expectNotAllowed(await approve(review.id, third, { requestId: second.id }), 'decided');
    // No request of this market's review, or none named at all.
    expectRefused(
      await approve(review.id, third, { requestId: NO_REQUEST }),
      400,
      'VALIDATION_ERROR',
      ['requestId'],
    );
    expectRefused(
      await reject(review.id, third, { requestId: undefined }),
      400,
      'VALIDATION_ERROR',
      ['requestId'],
    );
    expect((await marketRow(review.id)).status).toBe('review');
    expect((await requestsFor(review.id)).map((row) => row.status)).toEqual([
      'retracted',
      'rejected',
      'pending',
    ]);
    // The pending one decides, named in any casing (the body lower-cases it, as it is stored).
    const pending = await pendingId(review.id);
    expect((await approve(review.id, third, { requestId: pending.toUpperCase() })).statusCode).toBe(
      200,
    );
  });

  it('refuses an incomplete checklist and a blank reason before anything is read', async () => {
    const { market, request } = await createMarketInReview(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
    });
    const draft = await createMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      status: 'draft',
    });
    const missingOne = MARKET_REVIEW_CHECKLIST.slice(1);
    for (const [payload, path, message] of [
      [{ checklist: missingOne }, ['checklist'], REVIEW_CHECKLIST_INCOMPLETE],
      [{ checklist: [] }, ['checklist'], REVIEW_CHECKLIST_INCOMPLETE],
      [
        { checklist: [...MARKET_REVIEW_CHECKLIST, 'knownResult'] },
        ['checklist'],
        REVIEW_CHECKLIST_INCOMPLETE,
      ],
      [{ checklist: [...missingOne, 'botBudget'] }, ['checklist', 6], undefined],
      [{ reason: '   ' }, ['reason'], undefined],
      [{ reason: 'x'.repeat(501) }, ['reason'], undefined],
    ] as const) {
      // On a draft too: the body is refused before the market is read.
      for (const id of [market.id, draft.id]) {
        const res = await approve(id, third, payload);
        expectRefused(res, 400, 'VALIDATION_ERROR', [...path]);
        if (message !== undefined) expect(errorOf(res).details?.[0]?.message).toBe(message);
      }
    }
    expect((await requestsFor(market.id)).map((row) => row.status)).toEqual(['pending']);
    expect((await marketRow(market.id)).status).toBe('review');
    expect((await eventsFor(market.id)).map((event) => event.type)).toEqual(['submitted']);
    expect(await reviewActionsFor(market.id)).toEqual([]);
    expect((await requestsFor(market.id))[0]!.id).toBe(request.id);
  });

  it('checks the open-items check and the close again at the approval', async () => {
    const review = await submitted();
    // The category is hidden after the submission: the approval refuses it, and nothing moves.
    await t.db
      .update(schema.categories)
      .set({ isActive: false })
      .where(eq(schema.categories.id, category.id));
    const hidden = await approve(review.id, third);
    expect(hidden.statusCode).toBe(422);
    expect(errorOf(hidden)).toMatchObject({
      code: 'OPEN_ITEMS_MISSING',
      details: [{ path: ['category'], message: 'inactive' }],
    });
    expect(detail(await get(marketUrl(review.id))).missingOpenItems).toEqual(['category']);
    expect((await requestsFor(review.id)).map((row) => row.status)).toEqual(['pending']);
    expect((await marketRow(review.id)).status).toBe('review');
    // A 반려 asks for neither.
    expect((await reject(review.id, third)).statusCode).toBe(200);

    await t.db
      .update(schema.categories)
      .set({ isActive: true })
      .where(eq(schema.categories.id, category.id));
    // Submitted before its close, which passed while it waited: sent back to fix the times.
    const { market: late } = await createMarketInReview(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      closeAt: new Date(floorToMinute(Date.now()) - MINUTE_MS),
    });
    const past = await approve(late.id, third);
    expectRefused(past, 400, 'VALIDATION_ERROR', ['closeAt']);
    expect(errorOf(past).details?.[0]?.message).toBe('must be in the future');
    // The decision ran and was rolled back with the rest.
    expect((await requestsFor(late.id)).map((row) => [row.status, row.decidedBy])).toEqual([
      ['pending', null],
    ]);
    expect((await marketRow(late.id)).status).toBe('review');
    expect(await reviewActionsFor(late.id)).toEqual([]);
    expect((await revert(late.id, second)).statusCode).toBe(200);
  });

  it('refuses the approval of a market submitted with no 가격 보호 폭, the default entered (ADR-0112 결정 5)', async () => {
    // Submitted before #119: the approval reads the stored width, never the default in its place.
    const { market: legacy } = await createMarketInReview(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      withoutPriceProtection: true,
    });
    expect(legacy.priceProtectionTicks).toBeNull();
    // Its admin detail shows none and names it missing — the default stands in for a draft only.
    expect(detail(await get(`/api/v1/admin/markets/${legacy.id}`, third))).toMatchObject({
      status: 'review',
      priceProtectionTicks: null,
      missingOpenItems: ['priceProtection'],
    });
    const refused = await approve(legacy.id, third);
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused)).toMatchObject({
      code: 'OPEN_ITEMS_MISSING',
      details: [{ path: ['priceProtection'] }],
    });
    expect((await requestsFor(legacy.id)).map((row) => [row.status, row.decidedBy])).toEqual([
      ['pending', null],
    ]);
    const row = await marketRow(legacy.id);
    expect(row).toMatchObject({ status: 'review', priceProtectionTicks: null });
    expect(await reviewActionsFor(legacy.id)).toEqual([]);
    // The owner's procedure (docs/OPERATIONS.md '주문 접수'): sent back, and submitted again.
    expect((await revert(legacy.id, second)).statusCode).toBe(200);
    expect((await submit(legacy.id, creator)).statusCode).toBe(200);
    expect(await marketRow(legacy.id)).toMatchObject({
      status: 'review',
      priceProtectionTicks: TEST_PRICE_PROTECTION_TICKS,
    });
  });

  // --- 반려 -----------------------------------------------------------------------------------
  it('rejects with a reason from the list and a description, back to a draft with the gap cleared', async () => {
    await setGap(30);
    const close = week();
    const review = await submitted(
      { scheduledAnnouncementAt: iso(close + HOUR_MS) },
      creator,
      close,
    );
    expectRefused(
      await reject(review.id, third, { rejectReason: 'botBudget' }),
      400,
      'VALIDATION_ERROR',
      ['rejectReason'],
    );
    expectRefused(await reject(review.id, third, { reason: '' }), 400, 'VALIDATION_ERROR', [
      'reason',
    ]);
    await setGap(120);
    await listening(review.id, async (received) => {
      const res = await reject(review.id, third, {
        rejectReason: 'duplicate',
        reason: '같은 조건의 시장이 이미 거래 중이다',
      });
      expect(res.statusCode).toBe(200);
      const shown = detail(res);
      // The gap is cleared: the draft is held to the setting in force, which its lead close fails.
      expect(shown).toMatchObject({
        status: 'draft',
        leadCloseGapMinutes: 120,
        missingOpenItems: ['leadClose'],
      });
      expect((await marketRow(review.id)).leadCloseGapMinutes).toBeNull();
      const [request] = await requestsFor(review.id);
      expect(request).toMatchObject({
        status: 'rejected',
        decidedBy: third.id,
        decisionReason: '같은 조건의 시장이 이미 거래 중이다',
      });
      const rejection = {
        approvalId: request!.id,
        rejectReason: 'duplicate',
        reason: '같은 조건의 시장이 이미 거래 중이다',
      };
      const event = (await eventsFor(review.id)).at(-1)!;
      expect(event).toMatchObject({
        type: 'rejected',
        actorId: third.id,
        fromStatus: 'review',
        toStatus: 'draft',
        payload: rejection,
      });
      expect(event.createdAt).toEqual(request!.decidedAt);
      const [, action] = await reviewActionsFor(review.id);
      expect(action).toMatchObject({
        adminId: third.id,
        type: 'market_reject',
        payload: rejection,
      });
      // The creator reads it in the 검수 기록 (no notification).
      expect(shown.review.log[0]).toEqual({
        type: 'rejected',
        actor: await actorOf(third),
        at: event.createdAt.toISOString(),
        fromStatus: 'review',
        toStatus: 'draft',
        reason: '같은 조건의 시장이 이미 거래 중이다',
        rejectReason: 'duplicate',
        checklist: null,
        scheduledOpenBefore: null,
        scheduledOpenAfter: null,
      });
      // A draft is not public before or after: nothing is published.
      await sleep(100);
      expect(received).toEqual([]);
    });
    // A draft again: edited, then submitted again.
    expect((await patch(marketUrl(review.id), creator, { title: '다시 쓴 질문' })).statusCode).toBe(
      200,
    );
    expectWrongStatus(await reject(review.id, third), 'draft');
  });

  // --- 되돌리기 --------------------------------------------------------------------------------
  it('sends a market in review back: its submitter retracts the request, anyone else rejects it', async () => {
    const review = await submitted();
    const own = await revert(review.id, creator, { reason: '  배경을 고친다 ' });
    expect(own.statusCode).toBe(200);
    expect(detail(own)).toMatchObject({ status: 'draft', review: { pending: null } });
    const [retracted] = await requestsFor(review.id);
    expect(retracted).toMatchObject({ status: 'retracted', decidedBy: null, decisionReason: null });
    let event = (await eventsFor(review.id)).at(-1)!;
    expect(event).toMatchObject({
      type: 'reverted',
      actorId: creator.id,
      fromStatus: 'review',
      toStatus: 'draft',
      payload: { approvalId: retracted!.id, reason: '배경을 고친다' },
    });
    expect(event.createdAt).toEqual(retracted!.retractedAt);
    expect((await reviewActionsFor(review.id)).at(-1)).toMatchObject({
      adminId: creator.id,
      type: 'market_revert',
      payload: { approvalId: retracted!.id, reason: '배경을 고친다', from: 'review' },
    });
    // A draft again: the creator edits it and submits it again.
    expect((await patch(marketUrl(review.id), creator, { title: '고친 질문' })).statusCode).toBe(
      200,
    );
    expect((await submit(review.id)).statusCode).toBe(200);

    // Anyone else's 되돌리기 rejects the request with its reason, the creator's included were it
    // not the submitter's: here the second admin's.
    const others = await revert(review.id, second, { reason: '발표 일정이 바뀌었다' });
    expect(others.statusCode).toBe(200);
    const [, rejected] = await requestsFor(review.id);
    expect(rejected).toMatchObject({
      status: 'rejected',
      decidedBy: second.id,
      decisionReason: '발표 일정이 바뀌었다',
      retractedAt: null,
    });
    event = (await eventsFor(review.id)).at(-1)!;
    expect(event).toMatchObject({
      type: 'reverted',
      actorId: second.id,
      payload: { approvalId: rejected!.id, reason: '발표 일정이 바뀌었다' },
    });
    expect(event.createdAt).toEqual(rejected!.decidedAt);
    expect(
      detail(others).review.log.map((entry) => [entry.type, entry.actor?.id, entry.reason]),
    ).toEqual([
      ['reverted', second.id, '발표 일정이 바뀌었다'],
      ['submitted', creator.id, null],
      ['reverted', creator.id, '배경을 고친다'],
      ['submitted', creator.id, null],
    ]);
    // A 되돌리기 edits nothing: the editors are the creator alone, by the edit in between.
    expect(detail(others).review.editors).toEqual([await actorOf(creator)]);
    expectRefused(await revert(review.id, second, { reason: ' ' }), 400, 'VALIDATION_ERROR', [
      'reason',
    ]);
    expectWrongStatus(await revert(review.id, second), 'draft');
  });

  it('sends a scheduled market back: the approval stays as decided and the market leaves the public', async () => {
    const market = await scheduled();
    const [approved] = await requestsFor(market.id);
    await listening(market.id, async (received) => {
      // The creator may: a 되돌리기 is open to every admin.
      const res = await revert(market.id, creator, { reason: '판정 기준을 고친다' });
      expect(res.statusCode).toBe(200);
      const shown = detail(res);
      expect(shown.status).toBe('draft');
      expect(await requestsFor(market.id)).toEqual([approved]);
      const event = (await eventsFor(market.id)).at(-1)!;
      expect(event).toMatchObject({
        type: 'reverted',
        actorId: creator.id,
        fromStatus: 'scheduled',
        toStatus: 'draft',
        payload: { approvalId: approved!.id, reason: '판정 기준을 고친다' },
      });
      expect((await reviewActionsFor(market.id)).at(-1)).toMatchObject({
        type: 'market_revert',
        payload: { approvalId: approved!.id, reason: '판정 기준을 고친다', from: 'scheduled' },
      });
      expect((await marketRow(market.id)).leadCloseGapMinutes).toBeNull();
      // Public → hidden: the status goes out with its new key, and a viewer's refetch finds no
      // market.
      await waitForMessages(received, 1, 'market:status of the 되돌리기');
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        marketId: market.id,
        status: 'draft',
        statusEventId: String(event.id),
      });
      expect((await publicDetail(market.id)).statusCode).toBe(404);
    });
    // Sent back twice from one approval: never — the market is a draft.
    expectWrongStatus(await revert(market.id, creator), 'draft');
    // Edited and submitted again, it is a new request.
    expect((await submit(market.id)).statusCode).toBe(200);
    expect((await requestsFor(market.id)).map((row) => row.status)).toEqual([
      'approved',
      'pending',
    ]);
  });

  // --- the scheduled open ---------------------------------------------------------------------
  it('moves a scheduled market’s open with a reason, checks the order again and moves its open job', async () => {
    const market = await scheduled();
    const close = Date.parse(market.closeAt);
    const before = market.scheduledOpenAt!;
    const unchanged = await reschedule(market.id, second, {
      scheduledOpenAt: new Date(before).toISOString().replace('.000Z', 'Z'),
    });
    expect(unchanged.statusCode).toBe(400);
    expect(errorOf(unchanged)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'The scheduled open is unchanged',
      details: [{ path: ['scheduledOpenAt'], message: 'unchanged' }],
    });
    for (const at of [close, close + 30_000, close + DAY_MS]) {
      const late = await reschedule(market.id, second, { scheduledOpenAt: iso(at) });
      expect(late.statusCode).toBe(400);
      expect(errorOf(late)).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'The market times are out of order: openBeforeClose',
        details: [
          { path: ['scheduledOpenAt'], message: 'must be before closeAt' },
          { path: ['closeAt'], message: 'must be after scheduledOpenAt' },
        ],
      });
    }
    expectRefused(await reschedule(market.id, second, { reason: '' }), 400, 'VALIDATION_ERROR', [
      'scheduledOpenAt',
    ]);
    expectRefused(
      await reschedule(market.id, second, { scheduledOpenAt: iso(close - DAY_MS), reason: ' ' }),
      400,
      'VALIDATION_ERROR',
      ['reason'],
    );
    expect(await reviewActionsFor(market.id)).toHaveLength(2);

    // The approval registered the open job under the stored instant (#21).
    expect(await jobQueue.getJob(marketOpenJobId(market.id, new Date(before)))).toBeDefined();
    // Earlier, still ahead: the market stays SCHEDULED and its open job moves (a past instant opens
    // it at once, below).
    const earlier = iso(close - 3 * DAY_MS);
    await listening(market.id, async (received) => {
      const res = await reschedule(market.id, second, { scheduledOpenAt: earlier });
      expect(res.statusCode).toBe(200);
      const shown = detail(res);
      expect(shown).toMatchObject({
        status: 'scheduled',
        scheduledOpenAt: earlier,
        statusEventId: market.statusEventId,
      });
      const event = (await eventsFor(market.id)).at(-1)!;
      const change = { before, after: earlier, reason: '발표 일정이 당겨졌다' };
      expect(event).toMatchObject({
        type: 'open_rescheduled',
        actorId: second.id,
        fromStatus: null,
        toStatus: null,
        payload: change,
      });
      expect((await reviewActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: second.id,
        type: 'market_reschedule',
        payload: change,
      });
      expect(event.createdAt.toISOString()).toBe(shown.updatedAt);
      // The scheduled open is content (#172 item 7): its mover is an editor from here on.
      expect(shown.review.editors).toEqual([await actorOf(second)]);
      expect(shown.review.log[0]).toEqual({
        type: 'open_rescheduled',
        actor: await actorOf(second),
        at: event.createdAt.toISOString(),
        fromStatus: null,
        toStatus: null,
        reason: '발표 일정이 당겨졌다',
        rejectReason: null,
        checklist: null,
        scheduledOpenBefore: before,
        scheduledOpenAfter: earlier,
      });
      // The status again with the unchanged key, as an edit of an open market: viewers refetch.
      await waitForMessages(received, 1, 'market:status of the reschedule');
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        status: 'scheduled',
        statusEventId: market.statusEventId,
        ts: shown.updatedAt,
      });
      expect(data<Market>(await publicDetail(market.id)).scheduledOpenAt).toBe(earlier);
      // The job of the instant it moved from is gone; one waits for the new instant, delayed from
      // the change's own instant on the database clock (#21, ADR-0100).
      expect(await jobQueue.getJob(marketOpenJobId(market.id, new Date(before)))).toBeUndefined();
      const moved = await jobQueue.getJob(marketOpenJobId(market.id, new Date(earlier)));
      expect(moved).toMatchObject({ name: JOB_NAMES.marketOpen, data: { marketId: market.id } });
      expect(moved!.delay).toBe(Date.parse(earlier) - event.createdAt.getTime());
    });

    // SCHEDULED only.
    const review = await submitted();
    expectWrongStatus(
      await reschedule(review.id, second, { scheduledOpenAt: iso(close - DAY_MS) }),
      'review',
    );
    const draft = await createDraft();
    expectWrongStatus(
      await reschedule(draft.id, second, { scheduledOpenAt: iso(close - DAY_MS) }),
      'draft',
    );

    // A close already passed: back to a draft instead (#172 item 6), as the approval refuses it.
    const lapsed = await scheduled();
    const past = floorToMinute(Date.now()) - HOUR_MS;
    await t.db
      .update(schema.markets)
      .set({ scheduledOpenAt: new Date(past - HOUR_MS), closeAt: new Date(past) })
      .where(eq(schema.markets.id, lapsed.id));
    const passed = await reschedule(lapsed.id, second, {
      scheduledOpenAt: iso(past - 2 * HOUR_MS),
    });
    expect(passed.statusCode).toBe(400);
    expect(errorOf(passed)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'closeAt must be in the future',
      details: [{ path: ['closeAt'], message: 'must be in the future' }],
    });
    expect((await reviewActionsFor(lapsed.id)).map((row) => row.type)).toEqual([
      'market_submit',
      'market_approve',
    ]);
    // The mover of the open above may not decide the next cycle's review: an editor.
    expect((await revert(market.id, creator, { reason: '판정 기준을 고친다' })).statusCode).toBe(
      200,
    );
    expect((await submit(market.id)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, second), 'editor');
  });

  // --- the open (#21) -------------------------------------------------------------------------
  it('opens a market approved past its scheduled open at once: its approver opens it, one status is published, the close job and no open job', async () => {
    await setGap(30);
    const close = week();
    const passed = iso(floorToMinute(Date.now()) - MINUTE_MS);
    // The submission does not ask the scheduled open: one already passed is submitted as any.
    const review = await submitted(
      { scheduledOpenAt: passed, scheduledAnnouncementAt: iso(close + HOUR_MS) },
      creator,
      close,
    );
    // The open checks neither the lead close again nor stores another gap (ADR-0098 7-6).
    await setGap(120);
    await listening(review.id, async (received) => {
      const res = await approve(review.id, third);
      expect(res.statusCode).toBe(200);
      const shown = detail(res);
      const [request] = await requestsFor(review.id);
      const decidedAt = request!.decidedAt!;
      const events = await eventsFor(review.id);
      expect(
        events.map((event) => [event.type, event.actorId, event.fromStatus, event.toStatus]),
      ).toEqual([
        ['created', creator.id, null, 'draft'],
        ['submitted', creator.id, 'draft', 'review'],
        ['approved', third.id, 'review', 'scheduled'],
        ['opened', third.id, 'scheduled', 'open'],
      ]);
      // ADR-0093 decision 2 #172 item 6 '승인하는 즉시 연다': at the decision instant, by its admin.
      const opened = events.at(-1)!;
      expect(opened.payload).toEqual({
        openAt: decidedAt.toISOString(),
        closeAt: iso(close),
        source: 'approval',
      });
      expect(opened.createdAt).toEqual(decidedAt);
      expect(events.at(-2)!.createdAt).toEqual(decidedAt);
      expect(shown).toMatchObject({
        status: 'open',
        openAt: decidedAt.toISOString(),
        scheduledOpenAt: passed,
        updatedAt: decidedAt.toISOString(),
        statusEventId: String(opened.id),
        leadCloseGapMinutes: 30,
        missingOpenItems: [],
        review: { pending: null },
      });
      expect(shown.events[0]).toMatchObject({
        type: 'opened',
        actorId: third.id,
        fromStatus: 'scheduled',
        toStatus: 'open',
      });
      expect(await marketRow(review.id)).toMatchObject({
        status: 'open',
        openAt: decidedAt,
        updatedAt: decidedAt,
        statusEventId: opened.id,
        leadCloseGapMinutes: 30,
      });
      // The approval's record and the event say who opened it: no record of its own.
      expect(
        (await reviewActionsFor(review.id)).map((action) => [action.type, action.adminId]),
      ).toEqual([
        ['market_submit', creator.id],
        ['market_approve', third.id],
      ]);
      expect(shown.review.log.map((entry) => entry.type)).toEqual(['approved', 'submitted']);
      // One `market:status`: the OPEN status with the `opened` event's key, never SCHEDULED first.
      await waitForMessages(received, 1, 'market:status of the approval that opened');
      await sleep(100);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        marketId: review.id,
        status: 'open',
        statusEventId: String(opened.id),
        ts: decidedAt.toISOString(),
      });
      // The close job at the close, delayed from the decision; no open job — it opened.
      const closeJob = await jobQueue.getJob(marketCloseJobId(review.id, new Date(close)));
      expect(closeJob).toMatchObject({
        name: JOB_NAMES.marketClose,
        data: { marketId: review.id },
        delay: close - decidedAt.getTime(),
      });
      expect(await jobIds()).toEqual([marketCloseJobId(review.id, new Date(close))]);
    });
    // Public now, still without a price or a chart point: an open is not a price (N02 §5).
    const pub = await publicDetail(review.id);
    expect(pub.statusCode).toBe(200);
    expect(data<Market>(pub)).toMatchObject({ status: 'open', lastPrice: null, tradeCount: 0 });
    const chart = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${review.id}/ticks` });
    expect(data<PriceSeries>(chart).points).toEqual([]);
    expect(
      await t.db.select().from(schema.priceTicks).where(eq(schema.priceTicks.marketId, review.id)),
    ).toEqual([]);
    // Open: nothing approves, reschedules or sends it back any more.
    expectWrongStatus(await approve(review.id, second), 'open');
    expectWrongStatus(
      await reschedule(review.id, second, { scheduledOpenAt: iso(close - DAY_MS) }),
      'open',
    );
    expectWrongStatus(await revert(review.id, second), 'open');
  });

  it('approves a market whose scheduled open is ahead as SCHEDULED with its open and close jobs; a 되돌리기 cancels both', async () => {
    const review = await submitted();
    const res = await approve(review.id, third);
    expect(res.statusCode).toBe(200);
    const shown = detail(res);
    expect(shown).toMatchObject({ status: 'scheduled', openAt: null });
    expect((await eventsFor(review.id)).map((event) => event.type)).toEqual([
      'created',
      'submitted',
      'approved',
    ]);
    const [request] = await requestsFor(review.id);
    const decidedAt = request!.decidedAt!.getTime();
    const scheduledOpenAt = new Date(shown.scheduledOpenAt!);
    const closeAt = new Date(shown.closeAt);
    const openId = marketOpenJobId(review.id, scheduledOpenAt);
    const closeId = marketCloseJobId(review.id, closeAt);
    // Each delayed from the decision instant on the database clock, as the worker re-checks it.
    const openJob = await jobQueue.getJob(openId);
    expect(openJob).toMatchObject({
      name: JOB_NAMES.marketOpen,
      data: { marketId: review.id },
      delay: scheduledOpenAt.getTime() - decidedAt,
    });
    expect(openJob!.opts).toMatchObject({
      jobId: openId,
      attempts: 3,
      removeOnComplete: true,
    });
    const closeJob = await jobQueue.getJob(closeId);
    expect(closeJob).toMatchObject({
      name: JOB_NAMES.marketClose,
      data: { marketId: review.id },
      delay: closeAt.getTime() - decidedAt,
    });
    expect(await jobIds()).toEqual([closeId, openId].sort());

    // Sent back to a draft: neither job is left behind.
    expect((await revert(review.id, creator)).statusCode).toBe(200);
    expect(await jobIds()).toEqual([]);
    // Submitted and approved again at the same instants: the same jobs again.
    expect((await submit(review.id)).statusCode).toBe(200);
    expect(await jobIds()).toEqual([]);
    expect((await approve(review.id, third)).statusCode).toBe(200);
    expect(await jobIds()).toEqual([closeId, openId].sort());
  });

  it('opens a scheduled market at once when its open moves to an instant already passed: its mover opens it, the old open job is cancelled', async () => {
    const market = await scheduled();
    const before = market.scheduledOpenAt!;
    const closeId = marketCloseJobId(market.id, new Date(market.closeAt));
    expect(await jobIds()).toEqual([closeId, marketOpenJobId(market.id, new Date(before))].sort());
    // No early-open action (decision 3 '#21 앞당긴 개장'): the scheduled open moves earlier instead.
    const past = iso(floorToMinute(Date.now()) - HOUR_MS);
    await listening(market.id, async (received) => {
      const res = await reschedule(market.id, second, { scheduledOpenAt: past });
      expect(res.statusCode).toBe(200);
      const shown = detail(res);
      const [rescheduled, opened] = (await eventsFor(market.id)).slice(-2);
      expect(rescheduled).toMatchObject({
        type: 'open_rescheduled',
        actorId: second.id,
        fromStatus: null,
        toStatus: null,
        payload: { before, after: past, reason: '발표 일정이 당겨졌다' },
      });
      const at = rescheduled!.createdAt;
      expect(opened).toMatchObject({
        type: 'opened',
        actorId: second.id,
        fromStatus: 'scheduled',
        toStatus: 'open',
        payload: { openAt: at.toISOString(), closeAt: market.closeAt, source: 'reschedule' },
      });
      expect(opened!.createdAt).toEqual(at);
      expect(shown).toMatchObject({
        status: 'open',
        scheduledOpenAt: past,
        openAt: at.toISOString(),
        updatedAt: at.toISOString(),
        statusEventId: String(opened!.id),
      });
      expect((await reviewActionsFor(market.id)).map((action) => action.type)).toEqual([
        'market_submit',
        'market_approve',
        'market_reschedule',
      ]);
      // One `market:status`, the OPEN status with its new key.
      await waitForMessages(received, 1, 'market:status of the reschedule that opened');
      await sleep(100);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        status: 'open',
        statusEventId: String(opened!.id),
      });
    });
    // The open job of the old instant is gone and none was added; the approval's close job stays.
    expect(await jobIds()).toEqual([closeId]);
    expect(data<Market>(await publicDetail(market.id)).status).toBe('open');
  });

  it('serves no route that opens a market: the interim open is gone (#21)', async () => {
    expect(discoverRoutes().map((route) => route.key)).not.toContain(
      'POST /admin/markets/:id/open',
    );
    // A draft, and a SCHEDULED market whose scheduled open has come (the factory's, a minute ago):
    // neither is opened by an admin — the worker's job opens the second.
    const draft = await createDraft();
    const { market: due } = await createScheduledMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      approvedBy: third.id,
    });
    for (const id of [draft.id, due.id]) {
      const res = await post(`${marketUrl(id)}/open`, second);
      expect({ status: res.statusCode, code: errorOf(res).code }).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    expect((await marketRow(draft.id)).status).toBe('draft');
    expect((await marketRow(due.id)).status).toBe('scheduled');
    expect((await eventsFor(due.id)).map((event) => event.type)).toEqual(['submitted', 'approved']);
  });

  // --- the lock -------------------------------------------------------------------------------
  it('keeps a market in review or scheduled locked: no edit', async () => {
    const { market: review } = await createMarketInReview(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
    });
    const { market: approved } = await createScheduledMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      approvedBy: third.id,
    });
    for (const [market, status] of [
      [review, 'review'],
      [approved, 'scheduled'],
    ] as const) {
      expectWrongStatus(await patch(marketUrl(market.id), second, { title: '바꾼 질문' }), status);
      expectWrongStatus(
        await patch(marketUrl(market.id), second, { scheduledOpenAt: iso(week() - DAY_MS) }),
        status,
      );
      expect((await marketRow(market.id)).title).toBe(market.title);
      expect(await reviewActionsFor(market.id)).toEqual([]);
    }
    // Neither edit was made, so neither admin became an editor.
    expect(detail(await get(marketUrl(review.id))).review.editors).toEqual([]);
  });

  // --- the queue ------------------------------------------------------------------------------
  it('lists the pending reviews, the oldest submission first, with a cursor', async () => {
    const base = Date.now() - HOUR_MS;
    const made: string[] = [];
    // Submitted out of creation order, by different admins.
    for (const [offset, submitter] of [
      [2_000, third],
      [0, creator],
      [1_000, second],
    ] as const) {
      const { market } = await createMarketInReview(t.db, {
        createdBy: creator.id,
        categoryId: category.id,
        submittedBy: submitter.id,
        submittedAt: new Date(base + offset),
      });
      made.push(market.id);
    }
    // Not waiting: approved, rejected through the routes, and a draft.
    await createScheduledMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      approvedBy: third.id,
    });
    const rejected = await submitted();
    expect((await reject(rejected.id, third)).statusCode).toBe(200);
    await createDraft();

    const first = await queue('?limit=2');
    expect(first.statusCode).toBe(200);
    const page = first.json<QueuePage>();
    expect(page.data.map((item) => item.marketId)).toEqual([made[1], made[2]]);
    const [oldest] = page.data;
    const row = await marketRow(made[1]!);
    expect(oldest).toEqual({
      marketId: row.id,
      slug: row.slug,
      title: row.title,
      categoryName: '경제',
      scheduledOpenAt: row.scheduledOpenAt!.toISOString(),
      closeAt: row.closeAt.toISOString(),
      requestedBy: await actorOf(creator),
      requestedAt: new Date(base).toISOString(),
      createdBy: await actorOf(creator),
    });
    expect(page.meta.nextCursor).not.toBeNull();
    const next = (await queue(`?limit=2&cursor=${page.meta.nextCursor!}`)).json<QueuePage>();
    expect(next.data.map((item) => [item.marketId, item.requestedBy.id])).toEqual([
      [made[0], third.id],
    ]);
    expect(next.meta.nextCursor).toBeNull();
    // Any admin reads it; a member and nobody do not.
    expect((await queue('', second)).statusCode).toBe(200);
    const member = await signUpTestUser(t);
    expect((await queue('', member)).statusCode).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/admin/market-reviews' })).statusCode,
    ).toBe(401);
    expectRefused(await queue('?limit=0'), 400, 'VALIDATION_ERROR', ['limit']);
  });

  // --- the review in the detail ---------------------------------------------------------------
  it('shows the editors first edit first, the unfinished markets with the same conditions and nothing for a blank one', async () => {
    const deadline = new Date(week() + DAY_MS);
    const yesCondition = '사건 기한까지 기준금리가 3% 이하가 되면 YES.';
    const draft = await createDraft({ yesCondition, eventDeadline: deadline.toISOString() });
    for (const [who, title] of [
      [second, '하나'],
      [creator, '둘'],
      [second, '셋'],
    ] as const) {
      expect((await patch(marketUrl(draft.id), who, { title })).statusCode).toBe(200);
    }
    const same = (status: MarketStatus, extra: Parameters<typeof createMarket>[1] = {}) =>
      createMarket(t.db, {
        createdBy: second.id,
        categoryId: category.id,
        yesCondition,
        eventDeadline: deadline,
        status,
        ...extra,
      });
    const made: Awaited<ReturnType<typeof same>>[] = [];
    const listed: { id: string; slug: string; title: string; status: MarketStatus }[] = [];
    for (const status of [
      'review',
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
    ] as const) {
      made.push(await same(status, status === 'provisional' ? { resolvedResult: 'YES' } : {}));
    }
    // The oldest first: by creation instant, then by id — two inserts may share a millisecond.
    made.sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const row of made) {
      listed.push({ id: row.id, slug: row.slug, title: row.title, status: row.status });
    }
    // Finished, not yet in review, or with another condition or deadline: not listed.
    await same('draft');
    await same('resolved', { resolvedResult: 'NO', resolvedAt: new Date() });
    await same('settled', { resolvedResult: 'YES', resolvedAt: new Date(), settledAt: new Date() });
    await same('cancelled');
    await same('open', { eventDeadline: new Date(deadline.getTime() + MINUTE_MS) });
    await same('open', { yesCondition: `${yesCondition} 다른 조건` });

    const shown = detail(await get(marketUrl(draft.id)));
    expect(shown.review).toEqual({
      pending: null,
      createdBy: await actorOf(creator),
      editors: [await actorOf(second), await actorOf(creator)],
      sameCondition: listed,
      log: [],
    });
    // From the open one: the other unfinished ones, never the draft (not yet in review).
    const openOne = listed.find((row) => row.status === 'open')!;
    const other = detail(await get(marketUrl(openOne.id)));
    expect(other.review.sameCondition.map((row) => row.id)).toEqual(
      listed.filter((row) => row.status !== 'open').map((row) => row.id),
    );

    // A blank YES condition is nobody's 중복, however many share it.
    const blank = await createMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      yesCondition: '',
      eventDeadline: deadline,
    });
    await createMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      yesCondition: '',
      eventDeadline: deadline,
    });
    expect(detail(await get(marketUrl(blank.id))).review.sameCondition).toEqual([]);
  });

  // --- the admin on screen (ADR-0092) ---------------------------------------------------------
  it('refuses every review write that names another admin than the cookie’s, before anything is written', async () => {
    const draft = await createDraft();
    const { market: review } = await createMarketInReview(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
    });
    const { market: approved } = await createScheduledMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      approvedBy: second.id,
    });
    // The screen still shows `creator` while the tab's cookie is `third`'s.
    const asShown = { expectedAccountId: creator.id };
    for (const [what, res] of [
      ['submit', await post(`${marketUrl(draft.id)}/submit`, third, asShown)],
      ['approve', await approve(review.id, third, asShown)],
      ['reject', await reject(review.id, third, asShown)],
      ['revert', await revert(approved.id, third, asShown)],
      [
        'reschedule',
        await reschedule(approved.id, third, {
          scheduledOpenAt: iso(approved.closeAt.getTime() - DAY_MS),
          ...asShown,
        }),
      ],
    ] as const) {
      expect({ what, status: res.statusCode }).toEqual({ what, status: 403 });
      expect(errorOf(res).code).toBe('FORBIDDEN');
      expect(errorOf(res).details?.[0]?.path).toEqual(['expectedAccountId']);
    }
    expect((await marketRow(draft.id)).status).toBe('draft');
    expect((await marketRow(review.id)).status).toBe('review');
    expect((await marketRow(approved.id)).status).toBe('scheduled');
    for (const id of [draft.id, review.id, approved.id]) {
      expect(await reviewActionsFor(id)).toEqual([]);
    }
    expect((await requestsFor(review.id)).map((row) => row.status)).toEqual(['pending']);
    expect(await requestsFor(draft.id)).toEqual([]);
  });

  it('is closed to members and anonymous callers', async () => {
    const member = await signUpTestUser(t);
    const { market } = await createMarketInReview(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
    });
    for (const action of ['submit', 'approve', 'reject', 'revert', 'reschedule'] as const) {
      const url = `${marketUrl(market.id)}/${action}`;
      const asMember = await post(url, member);
      expect({ action, status: asMember.statusCode }).toEqual({ action, status: 403 });
      const anonymous = await t.app.inject({
        method: 'POST',
        url,
        headers: jsonHeaders,
        payload: {},
      });
      expect({ action, status: anonymous.statusCode }).toEqual({ action, status: 401 });
    }
    expect((await marketRow(market.id)).status).toBe('review');
  });

  // --- at once --------------------------------------------------------------------------------
  /**
   * `first` and then `second` dispatched while a test connection holds the market's lock, each
   * seen waiting on it before the next goes, then the lock released: they run in that order.
   */
  async function inTurn(
    marketId: string,
    first: () => Promise<Res>,
    then: () => Promise<Res>,
  ): Promise<[Res, Res]> {
    const holder = await t.db.$client.connect();
    let pending: [Promise<Res>, Promise<Res>] | undefined;
    let released = false;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [marketId]);
      const a = first();
      await waitForLockWaiter(holder, 'the first write on the market lock');
      const b = then();
      await waitForLockWaiter(holder, 'the second write on the market lock', 2);
      pending = [a, b];
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [marketId]);
      released = true;
      return [await a, await b];
    } finally {
      if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
      await Promise.allSettled(pending ?? []);
    }
  }

  it('serialises an approval and a 되돌리기 of one market: the second finds the status the first left', async () => {
    // The submitter sends it back while another admin approves: the approval finds a draft.
    const one = await submitted();
    const [reverted, refused] = await inTurn(
      one.id,
      () => revert(one.id, creator),
      () => approve(one.id, third),
    );
    expect(reverted.statusCode).toBe(200);
    expectWrongStatus(refused, 'draft');
    expect((await requestsFor(one.id)).map((row) => row.status)).toEqual(['retracted']);
    expect((await eventsFor(one.id)).map((event) => event.type)).toEqual([
      'created',
      'submitted',
      'reverted',
    ]);

    // The other way round: approved first, the 되돌리기 takes it back from SCHEDULED.
    const two = await submitted();
    const [approvedRes, revertedRes] = await inTurn(
      two.id,
      () => approve(two.id, third),
      () => revert(two.id, second),
    );
    expect(approvedRes.statusCode).toBe(200);
    expect(revertedRes.statusCode).toBe(200);
    expect((await requestsFor(two.id)).map((row) => row.status)).toEqual(['approved']);
    expect(
      (await eventsFor(two.id)).map((event) => [event.type, event.fromStatus, event.toStatus]),
    ).toEqual([
      ['created', null, 'draft'],
      ['submitted', 'draft', 'review'],
      ['approved', 'review', 'scheduled'],
      ['reverted', 'scheduled', 'draft'],
    ]);
    expect((await reviewActionsFor(two.id)).at(-1)!.payload).toMatchObject({ from: 'scheduled' });
  });
});
