/**
 * 시장 취소 of a SCHEDULED market (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로', '#20
 * CANCELLED 시장의 결과 유형', '#20 CANCELLED의 라벨·공개·필터') through the admin routes against the
 * docker `test` profile: a request by one admin — changing nothing, publishing nothing — and
 * refused for the body, the status (SCHEDULED only), one waiting and no decider; approved by
 * another admin — the `cancelled` event with the request's reason, the market CANCELLED with its
 * result type empty, the record, `market:status` after COMMIT, the delayed open and close jobs
 * removed — and refused for a request no longer waiting, its requester, a market opened or sent
 * back since and one approved again since (stale); rejected and retracted in any status; the 시장
 * 취소 대기 queue; the admin on screen. Then the cancelled market as the public and the other
 * routes see it: its public detail, the home list without it, the search by its label's status,
 * the related lists without it, a watch accepted, the book empty with its reason and a quote
 * rejected, and every dispute, judgement, delay, pause and supplement route refusing it. Skips when
 * TEST_* are unset.
 */
import {
  clockTimestamp,
  lockMarket,
  openScheduledMarket,
  schema,
  transitionMarket,
} from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createMarketLink,
  createOpenedMarket,
  createPauseDecision,
  createPausedMarket,
  createScheduledMarket,
  prepareMarketMakerOpening,
} from '@buddha/db/test';
import {
  MARKET_CANCEL_APPROVAL_KIND,
  MARKET_STATUSES,
  floorToMinute,
  marketChannel,
  marketCloseJobId,
  marketOpenJobId,
  type AdminMarket,
  type AdminMarketCancelItem,
  type Market,
  type MarketStatus,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { and, asc, eq, ne } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MARKETS_QUEUE, MarketJobs } from '../jobs/market-jobs.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A well-formed request id that names no request. */
const NO_REQUEST = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: (string | number)[]; message: string }[];
  };
};
type QueuePage = { data: AdminMarketCancelItem[]; meta: { nextCursor: string | null } };
type ListPage = { data: { id: string }[] };
type Res = { statusCode: number; json: <U>() => U; body: string };

/** A whole minute a week ahead: the close the tests' markets start from. */
const week = () => floorToMinute(Date.now()) + 7 * DAY_MS;

const REASON = '사건이 개장 전에 취소되어 거래할 대상이 없다.';
const APPROVAL = '요청한 취소가 맞다.';

describe.skipIf(!hasTestInfra)('admin market cancels (integration)', () => {
  let t: TestApp;
  /** The worker's view of the `markets` queue: a plain Queue on its own client. */
  let inspector: Redis;
  let jobQueue: Queue;
  /** Asks for the cancels unless a test says otherwise. */
  let asker: TestUser;
  /** Decides them. */
  let approver: TestUser;
  let third: TestUser;
  let category: { id: number; slug: string };

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
    await jobQueue.obliterate({ force: true });
    asker = await makeAdmin();
    approver = await makeAdmin();
    third = await makeAdmin();
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  // Every write names the admin on screen (ADR-0092): `who`'s own account unless the payload
  // names another.
  const post = (url: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: {
        expectedAccountId: who.id,
        ...(/\/judgements(?:$|\/[^/]+\/approve$)|\/disputes\/[^/]+\/(?:accept|dismiss)$/.test(url)
          ? { noConflictConfirmed: true }
          : {}),
        ...payload,
      },
    });
  const get = (url: string, who: TestUser | null = asker) =>
    t.app.inject({ method: 'GET', url, headers: who ? { cookie: who.cookie } : {} });

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;
  const cancelsUrl = (id: string) => `${marketUrl(id)}/cancel-requests`;
  /** 시장 취소 요청: REASON unless the payload says otherwise. */
  const requestCancel = (
    id: string,
    who: TestUser = asker,
    payload: Record<string, unknown> = {},
  ) => post(cancelsUrl(id), who, { reason: REASON, ...payload });
  const approve = (
    id: string,
    requestId: string,
    who: TestUser = approver,
    payload: Record<string, unknown> = {},
  ) => post(`${cancelsUrl(id)}/${requestId}/approve`, who, { reason: APPROVAL, ...payload });
  const reject = (
    id: string,
    requestId: string,
    who: TestUser = approver,
    payload: Record<string, unknown> = {},
  ) => post(`${cancelsUrl(id)}/${requestId}/reject`, who, { reason: '아직 이르다.', ...payload });
  const retract = (id: string, requestId: string, who: TestUser = asker) =>
    post(`${cancelsUrl(id)}/${requestId}/retract`, who);
  const queue = (query = '', who: TestUser = asker) =>
    get(`/api/v1/admin/market-cancel-requests${query}`, who);

  /**
   * A market approved for opening (`createScheduledMarket`), created by `asker`, its scheduled
   * open a day ahead and its close a week ahead unless `input` says otherwise.
   */
  async function scheduled(input: Parameters<typeof createScheduledMarket>[1] = {}) {
    const { market } = await createScheduledMarket(t.db, {
      createdBy: asker.id,
      categoryId: category.id,
      tags: ['취소'],
      scheduledOpenAt: new Date(floorToMinute(Date.now()) + DAY_MS),
      closeAt: new Date(week()),
      ...input,
    });
    return market;
  }

  const data = <T>(res: Res) => res.json<{ data: T }>().data;
  const detail = (res: Res) => data<AdminMarket>(res);
  const errorOf = (res: Res) => res.json<ErrorBody>().error;

  /** An account as the admin screens name it: its id and its nickname. */
  const actorOf = async (user: TestUser) => {
    const [profile] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    return { id: user.id, nickname: profile!.nickname };
  };

  /** A refusal VALIDATION_ERROR naming `path` with `message`. */
  function expectRefused(res: Res, path: string, message: string) {
    expect({ status: res.statusCode, details: errorOf(res).details }).toEqual({
      status: 400,
      details: [{ path: [path], message }],
    });
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  }
  /** APPROVAL_NOT_ALLOWED with `reason`. */
  function expectNotAllowed(res: Res, reason: string) {
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('APPROVAL_NOT_ALLOWED');
    expect(errorOf(res).details).toEqual([{ path: ['request'], message: reason }]);
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
  /** The market's cancel requests, oldest first. */
  async function requestsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_CANCEL_APPROVAL_KIND),
          eq(schema.approvalRequests.targetId, marketId),
        ),
      )
      .orderBy(asc(schema.approvalRequests.requestedAt));
  }
  /** The market's waiting cancel request's id. */
  async function pendingId(marketId: string) {
    const pending = (await requestsFor(marketId)).filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(1);
    return pending[0]!.id;
  }
  /** The market's cancel records, oldest first. */
  async function cancelActionsFor(marketId: string) {
    const rows = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, marketId))
      .orderBy(asc(schema.adminActions.createdAt));
    return rows.filter((row) => row.type.startsWith('market_cancel'));
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

  /** A raw status change as a route or the worker writes it, under the market lock. */
  async function moveStatus(
    marketId: string,
    from: MarketStatus,
    to: MarketStatus,
    type: 'submitted' | 'approved',
  ) {
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      await transitionMarket(tx, {
        marketId,
        from,
        to,
        type,
        actorId: third.id,
        at: await clockTimestamp(tx),
      });
    });
  }

  // --- the request ------------------------------------------------------------------------------
  it('asks to cancel a scheduled market: the request, the record, nothing changed or published', async () => {
    const market = await scheduled();
    await listening(market.id, async (received) => {
      const res = await requestCancel(market.id);
      expect(res.statusCode, res.body).toBe(200);
      const [request] = await requestsFor(market.id);
      expect(request).toMatchObject({
        kind: 'market_cancel',
        targetType: 'market',
        targetId: market.id,
        payload: { statusEventId: Number(market.statusEventId) },
        requestedBy: asker.id,
        requestReason: REASON,
        status: 'pending',
      });
      const pending = {
        requestId: request!.id,
        reason: REASON,
        requestedBy: await actorOf(asker),
        requestedAt: request!.requestedAt.toISOString(),
      };
      expect(detail(res)).toMatchObject({ status: 'scheduled' });
      expect(detail(res).cancel).toEqual({
        pending,
        log: [
          {
            ...pending,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
            decisionReason: null,
            retractedAt: null,
          },
        ],
      });
      expect(await cancelActionsFor(market.id)).toMatchObject([
        {
          adminId: asker.id,
          type: 'market_cancel_request',
          targetType: 'market',
          createdAt: request!.requestedAt,
          payload: {
            approvalId: request!.id,
            statusEventId: Number(market.statusEventId),
            reason: REASON,
          },
        },
      ]);
      // Nothing changed: no event, the row as it was, nothing published.
      expect(await marketRow(market.id)).toEqual(market);
      expect((await eventsFor(market.id)).at(-1)!.type).toBe('approved');
      await sleep(100);
      expect(received).toEqual([]);
    });
    // The admin detail read on its own says the same.
    expect(detail(await get(marketUrl(market.id))).cancel.pending).toMatchObject({
      reason: REASON,
    });
  });

  it.each(MARKET_STATUSES.filter((status) => status !== 'scheduled'))(
    'refuses a request on a %s market: an operator cancels a SCHEDULED market alone',
    async (status) => {
      const market = await createMarket(t.db, {
        createdBy: asker.id,
        categoryId: category.id,
        status,
      });
      expectRefused(await requestCancel(market.id), 'status', 'not scheduled');
      expect(await requestsFor(market.id)).toEqual([]);
      expect(await cancelActionsFor(market.id)).toEqual([]);
    },
  );

  it('refuses a request for its body, an unknown market, one waiting and no decider, in that order', async () => {
    const market = await scheduled();
    const blank = await requestCancel(market.id, asker, { reason: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(errorOf(blank).details?.map((issue) => issue.path)).toEqual([['reason']]);
    const unknown = await requestCancel(NO_REQUEST);
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe('NOT_FOUND');

    expect((await requestCancel(market.id)).statusCode).toBe(200);
    // One waits per market at a time, whoever asks.
    expectRefused(await requestCancel(market.id, third), 'cancel', 'pending');
    expect(await requestsFor(market.id)).toHaveLength(1);

    // No admin but the requester to decide it: not taken at all — but a request already
    // waiting answers first ('pending' before `no_decider`).
    const lone = await scheduled();
    const waiting = await scheduled();
    expect((await requestCancel(waiting.id)).statusCode).toBe(200);
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(ne(schema.profiles.userId, asker.id));
    expectRefused(await requestCancel(waiting.id), 'cancel', 'pending');
    expect(await requestsFor(waiting.id)).toHaveLength(1);
    expectNotAllowed(await requestCancel(lone.id), 'no_decider');
    expect(await requestsFor(lone.id)).toEqual([]);
  });

  // --- the approval -----------------------------------------------------------------------------
  it('cancels a scheduled market by another admin’s approval: CANCELLED, the result empty, the record, the status published, the jobs removed', async () => {
    const market = await scheduled();
    const jobs = t.app.get(MarketJobs);
    await jobs.scheduleOpen(market.id, market.scheduledOpenAt!, new Date());
    await jobs.scheduleClose(market.id, market.closeAt, new Date());
    expect(
      await jobQueue.getJob(marketOpenJobId(market.id, market.scheduledOpenAt!)),
    ).toBeDefined();
    expect((await requestCancel(market.id)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    await listening(market.id, async (received) => {
      const res = await approve(market.id, requestId);
      expect(res.statusCode, res.body).toBe(200);
      const at = (await requestsFor(market.id))[0]!.decidedAt!;
      const event = (await eventsFor(market.id)).at(-1)!;
      expect(event).toMatchObject({
        type: 'cancelled',
        actorId: approver.id,
        fromStatus: 'scheduled',
        toStatus: 'cancelled',
        createdAt: at,
        // The request's reason — the public one — not the approver's (ADR-0107 결정 4 '#24
        // 싣지 않는 기록').
        payload: {
          cancelledAt: at.toISOString(),
          source: 'operator',
          reason: REASON,
          approvalId: requestId,
          requestedBy: asker.id,
        },
      });
      const answer = detail(res);
      expect(answer).toMatchObject({
        status: 'cancelled',
        resolvedResult: null,
        statusEventId: String(event.id),
        closeAt: market.closeAt.toISOString(),
      });
      expect(answer.cancel).toMatchObject({
        pending: null,
        log: [
          {
            requestId,
            status: 'approved',
            decidedBy: await actorOf(approver),
            decidedAt: at.toISOString(),
            decisionReason: APPROVAL,
          },
        ],
      });
      expect(await marketRow(market.id)).toMatchObject({
        status: 'cancelled',
        statusEventId: event.id,
        resolvedResult: null,
        resolvedAt: null,
        updatedAt: at,
      });
      expect((await cancelActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: approver.id,
        type: 'market_cancel_approve',
        createdAt: at,
        payload: {
          approvalId: requestId,
          reason: APPROVAL,
          before: { status: 'scheduled' },
          after: { status: 'cancelled' },
        },
      });
      await waitForMessages(received, 1, 'market:status of the cancel');
      await sleep(100);
      // No order expired (a SCHEDULED market takes none): the status alone.
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'cancelled',
          resolvedResult: null,
          statusEventId: String(event.id),
          ts: at.toISOString(),
        },
      ]);
    });
    // The approval's jobs are removed (hygiene: both skip a cancelled market anyway).
    expect(
      await jobQueue.getJob(marketOpenJobId(market.id, market.scheduledOpenAt!)),
    ).toBeUndefined();
    expect(await jobQueue.getJob(marketCloseJobId(market.id, market.closeAt))).toBeUndefined();
    // Terminal: nothing more to ask, decide or open.
    expectRefused(await requestCancel(market.id, third), 'status', 'not scheduled');
    expectNotAllowed(await approve(market.id, requestId, third), 'decided');
  });

  it('keeps a cancelled market public with its status, out of the home list and the related lists, found by its label, watchable, its book empty, and refused by every judgement route', async () => {
    const market = await scheduled();
    const hub = await createOpenedMarket(t.db, {
      createdBy: asker.id,
      categoryId: category.id,
      closeAt: new Date(week()),
    });
    await createMarketLink(t.db, { marketId: hub.market.id, relatedMarketId: market.id });
    expect((await requestCancel(market.id)).statusCode).toBe(200);
    expect((await approve(market.id, await pendingId(market.id))).statusCode).toBe(200);

    // The public detail (ADR-0107 결정 5: a SCHEDULED-cancelled market keeps one), the result
    // type empty; #24 shows the reason.
    const publicDetail = await get(`/api/v1/markets/${market.id}`, null);
    expect(publicDetail.statusCode).toBe(200);
    expect(data<Market>(publicDetail)).toMatchObject({
      id: market.id,
      status: 'cancelled',
      resolvedResult: null,
      judgingRecord: {
        cancellation: {
          reason: REASON,
          cancelledAt: (await eventsFor(market.id)).at(-1)!.createdAt.toISOString(),
        },
      },
    });
    for (const hidden of [APPROVAL, asker.id, approver.id]) {
      expect(publicDetail.body).not.toContain(hidden);
    }
    // Home lists OPEN alone; the search finds it by its label's status, and in `all`.
    const ids = async (query: string) =>
      (await get(`/api/v1/markets${query}`, null)).json<ListPage>().data.map((row) => row.id);
    expect(await ids('')).toEqual([hub.market.id]);
    expect(await ids('?status=cancelled')).toEqual([market.id]);
    expect(await ids('?status=all')).toContain(market.id);
    // Related lists leave a cancelled market out, on either side.
    expect(await ids(`/${hub.market.id}/related`)).toEqual([]);
    // A watch is accepted (watch and discussion stay open on a cancelled market).
    const member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
    const watch = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/me/watchlist/${market.id}`,
      headers: { ...jsonHeaders, cookie: member.cookie },
      payload: { watched: true, expectedAccountId: member.id },
    });
    expect(watch.statusCode, watch.body).toBe(200);
    // No order: the book is empty with its reason, a quote rejected as 마감 (#177 8항).
    const book = await get(`/api/v1/markets/${market.id}/book`, null);
    expect(data<{ marketRejectReason: string | null }>(book).marketRejectReason).toBe('closed');
    const quote = await t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${market.id}/quote`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 1 }),
    });
    expect(data<{ status: string; rejectReason: string | null }>(quote)).toMatchObject({
      status: 'rejected',
      rejectReason: 'closed',
    });

    // No 판정 이의 (nothing provisional to dispute) …
    const dispute = await post(`/api/v1/markets/${market.id}/disputes`, member, {
      judgementVersion: 1,
      links: ['https://example.com/notice'],
      reason: '결과가 틀렸다.',
    });
    expect({ status: dispute.statusCode, error: errorOf(dispute) }).toMatchObject({
      status: 409,
      error: { code: 'DISPUTE_NOT_ALLOWED', details: { reason: 'not_provisional' } },
    });
    // … and no judgement, delay, pause or supplement: the result type stays empty (never VOID).
    expectRefused(
      await post(`${marketUrl(market.id)}/judgements`, approver, {
        result: 'VOID',
        source: null,
        voidReason: '개장 전에 사건이 취소되었다.',
        evidence: {
          links: ['https://example.com/notice'],
          collectedAt: new Date(Date.now() - MINUTE_MS).toISOString(),
        },
        description: '사건이 열리지 않았다.',
      }),
      'status',
      'not closed',
    );
    expectRefused(
      await post(`${marketUrl(market.id)}/judgement-delays`, approver, {
        reason: '출처가 발표를 미뤘다.',
        nextReviewAt: new Date(Date.now() + DAY_MS).toISOString(),
      }),
      'status',
      'not awaiting a judgement',
    );
    expectRefused(
      await post(`${marketUrl(market.id)}/pause`, approver, {
        publicNoteConfirmed: true,
        reason: 'basis_change',
        note: '기준이 바뀌었다.',
      }),
      'status',
      'not open',
    );
    expectRefused(
      await post(`${marketUrl(market.id)}/supplements`, approver, {
        baseVersion: 1,
        changes: { description: '고친 배경' },
        reason: '보충한다.',
        settlementImpact: '정산에 영향이 없다.',
      }),
      'status',
      'not open or paused',
    );
    expect(await marketRow(market.id)).toMatchObject({ status: 'cancelled', resolvedResult: null });
  });

  it('refuses an approval of a request that is no longer waiting, by its requester, or of an unknown one', async () => {
    const market = await scheduled();
    const other = await scheduled();
    expect((await requestCancel(other.id)).statusCode).toBe(200);
    const otherRequest = await pendingId(other.id);
    expectRefused(await approve(market.id, NO_REQUEST), 'requestId', 'unknown');
    // Another market's request, or another kind's of this market, is no cancel request of it.
    expectRefused(await approve(market.id, otherRequest), 'requestId', 'unknown');
    expectRefused(await reject(market.id, otherRequest), 'requestId', 'unknown');
    expectRefused(await retract(market.id, otherRequest), 'requestId', 'unknown');
    const { market: paused } = await createPausedMarket(t.db, { categoryId: category.id });
    const decision = await createPauseDecision(t.db, { marketId: paused.id, path: 'resume' });
    expectRefused(await approve(paused.id, decision.id), 'requestId', 'unknown');

    expect((await requestCancel(market.id)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    expectNotAllowed(await approve(market.id, requestId, asker), 'requester');
    expectNotAllowed(await reject(market.id, requestId, asker), 'requester');
    expectNotAllowed(await retract(market.id, requestId, approver), 'not_requester');
    expect((await marketRow(market.id)).status).toBe('scheduled');
    expect((await retract(market.id, requestId)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, requestId), 'retracted');
    expectNotAllowed(await reject(market.id, requestId), 'retracted');
    expectNotAllowed(await retract(market.id, requestId), 'retracted');

    // A new request after the 철회; its approval decides it once.
    expect((await requestCancel(market.id, third)).statusCode).toBe(200);
    const again = await pendingId(market.id);
    expect((await approve(market.id, again)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, again, asker), 'decided');
    expectNotAllowed(await reject(market.id, again, asker), 'decided');
    expectNotAllowed(await retract(market.id, again, third), 'decided');
    expect((await eventsFor(market.id)).filter((event) => event.type === 'cancelled')).toHaveLength(
      1,
    );
  });

  it('refuses an approval once the worker opened the market, without holding the open; the request ends by a 반려 alone', async () => {
    // A waiting request does not hold the automatic open (구현의 선택 P1): once OPEN, the market
    // ends by its close or a pause's early close, never by an operator's cancel.
    const market = await scheduled({ scheduledOpenAt: new Date(Date.now() - MINUTE_MS) });
    // This tests a cancel request across an actual open, with #129's normal opening funds/settings.
    await prepareMarketMakerOpening(t.db, market.id);
    expect((await requestCancel(market.id)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      const opened = await openScheduledMarket(tx, {
        market: await marketRow(market.id),
        now: await clockTimestamp(tx),
        actorId: null,
        source: 'job',
      });
      expect(opened).toMatchObject({ opened: true });
    });
    expectRefused(await approve(market.id, requestId), 'status', 'not scheduled');
    expect((await marketRow(market.id)).status).toBe('open');
    // The refusals' order with the request still waiting: a new request answers the status
    // before the waiting one ('not scheduled', not 'pending'), and the requester's approval
    // answers the requester before the status.
    expectRefused(await requestCancel(market.id, third), 'status', 'not scheduled');
    expectNotAllowed(await approve(market.id, requestId, asker), 'requester');
    expect(await requestsFor(market.id)).toHaveLength(1);
    // Still listed, open, for its 반려 or 철회.
    expect((await queue()).json<QueuePage>().data).toMatchObject([
      { requestId, marketId: market.id, status: 'open' },
    ]);
    const rejected = await reject(market.id, requestId);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(detail(rejected)).toMatchObject({
      status: 'open',
      cancel: { pending: null, log: [expect.objectContaining({ requestId, status: 'rejected' })] },
    });
    expect((await cancelActionsFor(market.id)).at(-1)).toMatchObject({
      adminId: approver.id,
      type: 'market_cancel_reject',
      payload: { approvalId: requestId, reason: '아직 이르다.' },
    });
    expect((await queue()).json<QueuePage>().data).toEqual([]);
  });

  it('refuses a request asked before a 되돌리기 and a new approval: not scheduled, then stale', async () => {
    const market = await scheduled();
    expect((await requestCancel(market.id)).statusCode).toBe(200);
    const old = await pendingId(market.id);
    // 되돌리기 (#78) leaves the request waiting: refused by the status while a draft…
    const reverted = await post(`${marketUrl(market.id)}/revert`, third, {
      reason: '시각을 고친다.',
    });
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(detail(reverted).cancel.pending).toMatchObject({ requestId: old });
    expectRefused(await approve(market.id, old), 'status', 'not scheduled');
    // …and, approved again, by the SCHEDULED state it was asked in.
    await moveStatus(market.id, 'draft', 'review', 'submitted');
    await moveStatus(market.id, 'review', 'scheduled', 'approved');
    expectRefused(await approve(market.id, old), 'cancel', 'stale');
    expect((await marketRow(market.id)).status).toBe('scheduled');
    // It blocks a new request until a 반려 or a 철회 ends it.
    expectRefused(await requestCancel(market.id, third), 'cancel', 'pending');
    expect((await retract(market.id, old)).statusCode).toBe(200);
    expect((await cancelActionsFor(market.id)).at(-1)).toMatchObject({
      adminId: asker.id,
      type: 'market_cancel_retract',
      payload: { approvalId: old },
    });
    expect((await requestCancel(market.id, third)).statusCode).toBe(200);
    const fresh = await requestsFor(market.id);
    expect(fresh.at(-1)!.payload).toEqual({
      statusEventId: Number((await marketRow(market.id)).statusEventId),
    });
    expect((await approve(market.id, await pendingId(market.id))).statusCode).toBe(200);
    expect((await marketRow(market.id)).status).toBe('cancelled');
  });

  // --- the queue, the admin on screen ------------------------------------------------------------
  it('lists the waiting cancel requests across markets, the oldest first, with a keyset cursor', async () => {
    const first = await scheduled();
    const second = await scheduled();
    const last = await scheduled();
    expect((await requestCancel(first.id)).statusCode).toBe(200);
    expect((await requestCancel(second.id, third)).statusCode).toBe(200);
    expect((await requestCancel(last.id)).statusCode).toBe(200);
    // Decided and retracted ones leave the queue.
    expect((await retract(last.id, await pendingId(last.id))).statusCode).toBe(200);
    const page = (await queue()).json<QueuePage>();
    expect(page.data).toEqual([
      {
        requestId: await pendingId(first.id),
        marketId: first.id,
        slug: first.slug,
        title: first.title,
        status: 'scheduled',
        scheduledOpenAt: first.scheduledOpenAt!.toISOString(),
        closeAt: first.closeAt.toISOString(),
        reason: REASON,
        requestedBy: await actorOf(asker),
        requestedAt: (await requestsFor(first.id))[0]!.requestedAt.toISOString(),
      },
      expect.objectContaining({ marketId: second.id, requestedBy: await actorOf(third) }),
    ]);
    const one = (await queue('?limit=1')).json<QueuePage>();
    expect(one.data.map((item) => item.marketId)).toEqual([first.id]);
    const next = (
      await queue(`?limit=1&cursor=${encodeURIComponent(one.meta.nextCursor!)}`)
    ).json<QueuePage>();
    expect(next.data.map((item) => item.marketId)).toEqual([second.id]);
    expect(next.meta.nextCursor).toBeNull();
    expect((await approve(second.id, await pendingId(second.id))).statusCode).toBe(200);
    expect((await queue()).json<QueuePage>().data.map((item) => item.marketId)).toEqual([first.id]);
    // Admins only.
    const member = await signUpTestUser(t);
    expect((await queue('', member)).statusCode).toBe(403);
  });

  it('asks every cancel write for the admin on screen, before anything is read or written', async () => {
    const market = await scheduled();
    expect((await requestCancel(market.id)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    const fresh = await scheduled();
    for (const res of [
      await requestCancel(fresh.id, third, { expectedAccountId: approver.id }),
      await approve(market.id, requestId, approver, { expectedAccountId: third.id }),
      await reject(market.id, requestId, approver, { expectedAccountId: third.id }),
      await post(`${cancelsUrl(market.id)}/${requestId}/retract`, asker, {
        expectedAccountId: third.id,
      }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    }
    // And a write that names none is the pipe's 400 on the field.
    const unnamed = (url: string, payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'POST',
        url,
        headers: { ...jsonHeaders, cookie: asker.cookie },
        payload,
      });
    for (const res of [
      await unnamed(cancelsUrl(fresh.id), { reason: REASON }),
      await unnamed(`${cancelsUrl(market.id)}/${requestId}/approve`, { reason: APPROVAL }),
      await unnamed(`${cancelsUrl(market.id)}/${requestId}/reject`, { reason: '반려' }),
      await unnamed(`${cancelsUrl(market.id)}/${requestId}/retract`, {}),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    }
    expect((await marketRow(market.id)).status).toBe('scheduled');
    expect(await requestsFor(fresh.id)).toEqual([]);
    expect((await requestsFor(market.id)).map((row) => row.status)).toEqual(['pending']);
    expect((await cancelActionsFor(market.id)).map((action) => action.type)).toEqual([
      'market_cancel_request',
    ]);
  });
});
