/**
 * 거래 일시 중단·재개·조기 마감 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4, decision 3 '#114
 * 조기 결과의 공개 시각', the owner's answers Q1·Q2 of 2026-11-02) through the admin routes against
 * the docker `test` profile: a pause by one admin — the `paused` event, the pause row, the record,
 * the published status, the close job kept, nothing public of it — and refused for the body, the
 * status, the close by the clock and a publication instant after it; a next path asked for —
 * changing nothing — and refused for the status, the close, a pause ended since (the one its
 * author saw is named), one waiting, no decider and what the pause's reason allows (판정 불가: the
 * early close alone); approved by another admin — 재개 back to
 * OPEN, 조기 마감 to CLOSED with the scheduled close kept and its job cancelled, each reason and
 * review (Q1, Q2) — and refused for a request no longer waiting, its requester, a market closed at
 * its close by the worker, its close come and a pause since ended; rejected and retracted in any
 * status; two pauses in a row; two writes at once; the 일시 중단 결정 대기 queue; the admin on
 * screen; and the PATCH of a paused market (category and tags, never a version item). The removed
 * one-admin close is admin-markets.controller.test's. Skips when TEST_* are unset.
 */
import { clockTimestamp, endPauseAtClose, lockMarket, schema, transitionMarket } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createMarketPause,
  createOpenedMarket,
  createPauseDecision,
  createPausedMarket,
  createSupplementRequest,
  resumeMarket,
} from '@buddha/db/test';
import {
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  floorToMinute,
  marketChannel,
  marketCloseJobId,
  type AdminMarket,
  type AdminMarketPauseDecisionItem,
  type Market,
  type MarketPauseReason,
  type MarketPauseReviewResult,
  type MarketPausePath,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MARKETS_QUEUE, MarketJobs } from '../jobs/market-jobs.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A well-formed request id that names no request. */
const NO_REQUEST = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
/** A well-formed pause id that names no pause. */
const NO_PAUSE = '5c2e8b1d-7a3f-4e6b-8d0c-2f1a3b4c5d6e';

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: (string | number)[]; message: string }[];
  };
};
type QueuePage = { data: AdminMarketPauseDecisionItem[]; meta: { nextCursor: string | null } };
type Res = { statusCode: number; json: <U>() => U; body: string };

/** An ISO instant, `ms` from the epoch. */
const iso = (ms: number) => new Date(ms).toISOString();
/** A whole minute a week ahead: the close the tests' markets start from. */
const week = () => floorToMinute(Date.now()) + 7 * DAY_MS;

const NOTE = '사건 일정이 바뀌어 판정 기준을 검토한다.';
const REASON = '검토를 마쳤다.';
const APPROVAL = '요청한 경로가 맞다.';

describe.skipIf(!hasTestInfra)('admin market pauses (integration)', () => {
  let t: TestApp;
  /** The worker's view of the `markets` queue: a plain Queue on its own client. */
  let inspector: Redis;
  let jobQueue: Queue;
  /** Pauses the markets and asks for their next paths unless a test says otherwise. */
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
      payload: { expectedAccountId: who.id, ...payload },
    });
  const patch = (url: string, who: TestUser, payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'PATCH',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const get = (url: string, who: TestUser = asker) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;
  const decisionsUrl = (id: string) => `${marketUrl(id)}/pause-decisions`;
  /** 거래 일시 중단: a basis change and the note unless the payload says otherwise. */
  const pause = (id: string, who: TestUser = asker, payload: Record<string, unknown> = {}) =>
    post(`${marketUrl(id)}/pause`, who, { reason: 'basis_change', note: NOTE, ...payload });
  /**
   * 다음 경로 요청: `decision` holds the path and, for a basis change, the review result. It names
   * the pause the admin detail shows its author (`shownPause`) unless the payload names another.
   */
  const requestDecision = async (
    id: string,
    decision: Record<string, unknown>,
    who: TestUser = asker,
    payload: Record<string, unknown> = {},
  ) =>
    post(decisionsUrl(id), who, {
      pauseId: await shownPause(id),
      reason: REASON,
      ...decision,
      ...payload,
    });
  const approve = (
    id: string,
    requestId: string,
    who: TestUser = approver,
    payload: Record<string, unknown> = {},
  ) => post(`${decisionsUrl(id)}/${requestId}/approve`, who, { reason: APPROVAL, ...payload });
  const reject = (
    id: string,
    requestId: string,
    who: TestUser = approver,
    payload: Record<string, unknown> = {},
  ) => post(`${decisionsUrl(id)}/${requestId}/reject`, who, { reason: '아직 이르다.', ...payload });
  const retract = (id: string, requestId: string, who: TestUser = asker) =>
    post(`${decisionsUrl(id)}/${requestId}/retract`, who);
  const queue = (query = '', who: TestUser = asker) =>
    get(`/api/v1/admin/market-pause-decisions${query}`, who);
  const publicDetail = (id: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1/markets/${id}` });

  /**
   * A market opened at its scheduled open as the worker leaves it (`createOpenedMarket`: rule v1
   * recorded), created by `asker`, closing a week ahead unless `input` says otherwise.
   */
  async function opened(input: Parameters<typeof createOpenedMarket>[1] = {}) {
    const { market } = await createOpenedMarket(t.db, {
      createdBy: asker.id,
      categoryId: category.id,
      tags: ['중단'],
      closeAt: new Date(week()),
      ...input,
    });
    return market;
  }
  /** `opened`'s market paused by `asker` for a basis change unless `input` says otherwise. */
  async function paused(input: Parameters<typeof createPausedMarket>[1] = {}) {
    return createPausedMarket(t.db, {
      createdBy: asker.id,
      categoryId: category.id,
      tags: ['중단'],
      closeAt: new Date(week()),
      by: asker.id,
      ...input,
    });
  }

  /**
   * The worker's close at `close_at` (apps/worker market-close.ts), as one transaction under the
   * market lock: OPEN or PAUSED → CLOSED with `{closedAt, source: 'job'}` and no actor, ending a
   * paused market's pause (`endPauseAtClose`).
   */
  async function workerClose(marketId: string) {
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [current] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId))
        .for('update');
      const now = await clockTimestamp(tx);
      expect(current!.closeAt.getTime()).toBeLessThanOrEqual(now.getTime());
      const eventId = await transitionMarket(tx, {
        marketId,
        from: current!.status,
        to: 'closed',
        type: 'closed',
        actorId: null,
        payload: { closedAt: now.toISOString(), source: 'job' },
        at: now,
      });
      if (current!.status === 'paused') await endPauseAtClose(tx, { marketId, now, eventId });
    });
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
  /** The market's pauses, the newest first. */
  async function pausesOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketPauses)
      .where(eq(schema.marketPauses.marketId, marketId))
      .orderBy(desc(schema.marketPauses.pausedAt));
  }
  /**
   * The pause a request's author saw, as the admin detail shows it (`pause.history[0]`): the
   * market's newest pause — the lasting one while it is PAUSED — or, for a market never paused, a
   * well-formed id naming none.
   */
  async function shownPause(marketId: string) {
    const [newest] = await pausesOf(marketId);
    return newest?.id ?? NO_PAUSE;
  }
  /** The market's next-path requests, oldest first. */
  async function requestsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_PAUSE_DECISION_APPROVAL_KIND),
          eq(schema.approvalRequests.targetId, marketId),
        ),
      )
      .orderBy(asc(schema.approvalRequests.requestedAt));
  }
  /** The market's waiting next-path request's id. */
  async function pendingId(marketId: string) {
    const pending = (await requestsFor(marketId)).filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(1);
    return pending[0]!.id;
  }
  /** The market's pause records, oldest first. */
  async function pauseActionsFor(marketId: string) {
    const rows = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, marketId))
      .orderBy(asc(schema.adminActions.createdAt));
    return rows.filter((row) => row.type.startsWith('market_pause'));
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

  // --- the pause --------------------------------------------------------------------------------
  it('pauses an open market at once: the event, the pause, the record, the status published, the close job kept, nothing public', async () => {
    const market = await opened();
    // The approval (#78) registered the close job at the close; the pause leaves it (#173 item 3).
    await t.app.get(MarketJobs).scheduleClose(market.id, market.closeAt, new Date());
    await listening(market.id, async (received) => {
      const res = await pause(market.id, asker, { note: `  ${NOTE}  ` });
      expect(res.statusCode).toBe(200);
      const answer = detail(res);
      const [row] = await pausesOf(market.id);
      const events = await eventsFor(market.id);
      expect(events.map((event) => event.type)).toEqual([
        'submitted',
        'approved',
        'opened',
        'paused',
      ]);
      const event = events.at(-1)!;
      expect(event).toMatchObject({
        actorId: asker.id,
        fromStatus: 'open',
        toStatus: 'paused',
        payload: { pauseId: row!.id, reason: 'basis_change', resultPublishedAt: null },
      });
      expect(row).toMatchObject({
        marketId: market.id,
        reason: 'basis_change',
        note: NOTE,
        resultPublishedAt: null,
        pausedAt: event.createdAt,
        pausedBy: asker.id,
        pauseEventId: event.id,
        reviewResult: null,
        endKind: null,
        endedAt: null,
        endedBy: null,
        endEventId: null,
        endApprovalId: null,
      });
      const at = event.createdAt.toISOString();
      expect(answer).toMatchObject({
        status: 'paused',
        statusEventId: String(event.id),
        updatedAt: at,
        closeAt: market.closeAt.toISOString(),
        ruleVersion: 1,
      });
      expect(answer.events[0]).toMatchObject({ type: 'paused', actorId: asker.id });
      expect(answer.pause).toEqual({
        history: [
          {
            id: row!.id,
            reason: 'basis_change',
            note: NOTE,
            resultPublishedAt: null,
            pausedAt: at,
            pausedBy: await actorOf(asker),
            reviewResult: null,
            endKind: null,
            endedAt: null,
            endedBy: null,
          },
        ],
        pending: null,
        log: [],
      });
      // The market's times stay: the close still comes at `close_at` (#173 item 3), and `open_at`
      // is the open's.
      expect(await marketRow(market.id)).toMatchObject({
        status: 'paused',
        closeAt: market.closeAt,
        openAt: market.openAt,
        statusEventId: event.id,
      });
      const actions = await pauseActionsFor(market.id);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        adminId: asker.id,
        type: 'market_pause',
        targetType: 'market',
        createdAt: event.createdAt,
        payload: {
          pauseId: row!.id,
          reason: 'basis_change',
          note: NOTE,
          resultPublishedAt: null,
          before: { status: 'open', closeAt: market.closeAt.toISOString() },
          after: { status: 'paused', closeAt: market.closeAt.toISOString() },
        },
      });
      // Published once after COMMIT: the PAUSED status and the event's key.
      await waitForMessages(received, 1, 'market:status of the pause');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'paused',
          resolvedResult: null,
          statusEventId: String(event.id),
          ts: at,
        },
      ]);
    });
    expect(await jobQueue.getJob(marketCloseJobId(market.id, market.closeAt))).toBeDefined();

    // The public detail says PAUSED (its label and notice are the web's, #174) and nothing of the
    // pause: the reason and the times are #24's, the note and the admin nobody's (#173 item 13).
    const pub = await publicDetail(market.slug);
    expect(pub.statusCode).toBe(200);
    expect(data<Market>(pub).status).toBe('paused');
    expect(data<Market>(pub)).not.toHaveProperty('pause');
    for (const hidden of [NOTE, asker.id]) expect(pub.body).not.toContain(hidden);
  });

  it('records an early result’s publication instant, in UTC, on the pause and its event', async () => {
    const market = await opened();
    // Ninety minutes before the pause, as the admin entered it in KST (the screen's).
    const publishedAt = new Date(Date.now() - 90 * MINUTE_MS + 123);
    const res = await pause(market.id, third, {
      reason: 'early_result',
      note: '결과가 마감 전에 발표되었다.',
      resultPublishedAt: publishedAt.toISOString(),
    });
    expect(res.statusCode).toBe(200);
    const [row] = await pausesOf(market.id);
    expect(row).toMatchObject({ reason: 'early_result', resultPublishedAt: publishedAt });
    expect(detail(res).pause.history[0]).toMatchObject({
      reason: 'early_result',
      resultPublishedAt: publishedAt.toISOString(),
      pausedBy: await actorOf(third),
    });
    expect((await eventsFor(market.id)).at(-1)!.payload).toEqual({
      pauseId: row!.id,
      reason: 'early_result',
      resultPublishedAt: publishedAt.toISOString(),
    });
    expect((await pauseActionsFor(market.id))[0]!.payload).toMatchObject({
      reason: 'early_result',
      resultPublishedAt: publishedAt.toISOString(),
    });
    // Any other reason records none.
    const other = await opened();
    const now = await pause(other.id, asker, { reason: 'ledger_failure' });
    expect(now.statusCode).toBe(200);
    expect(detail(now).pause.history[0]).toMatchObject({
      reason: 'ledger_failure',
      resultPublishedAt: null,
    });
  });

  it('refuses a pause for its body, then in order: status, the close by the clock, a publication after the pause', async () => {
    const market = await opened();
    // The body's own: the reason (these three only), the note, the publication instant's rule.
    const cases: [Record<string, unknown>, string, string | null][] = [
      [{ reason: 'bot_stop' }, 'reason', null],
      [{ note: '   ' }, 'note', null],
      [{ note: 'x'.repeat(501) }, 'note', null],
      [{ reason: 'early_result' }, 'resultPublishedAt', 'required'],
      [{ reason: 'early_result', resultPublishedAt: null }, 'resultPublishedAt', 'required'],
      [
        { reason: 'ledger_failure', resultPublishedAt: iso(Date.now() - MINUTE_MS) },
        'resultPublishedAt',
        'only for early_result',
      ],
      [{ reason: 'early_result', resultPublishedAt: '어제 저녁' }, 'resultPublishedAt', null],
    ];
    for (const [payload, path, message] of cases) {
      const res = await pause(market.id, asker, payload);
      expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
      const details = errorOf(res).details ?? [];
      expect(details.map((issue) => issue.path)).toEqual([[path]]);
      if (message !== null) expect(details[0]!.message).toBe(message);
    }
    // Not OPEN: every other status, a PAUSED market included — even past its close.
    for (const status of [
      'draft',
      'review',
      'scheduled',
      'paused',
      'closed',
      'provisional',
      'resolved',
      'cancelled',
    ] as const) {
      const other = await createMarket(t.db, {
        createdBy: asker.id,
        categoryId: category.id,
        status,
        closeAt: new Date(Date.now() - MINUTE_MS),
      });
      expectRefused(await pause(other.id), 'status', 'not open');
      expect(await pausesOf(other.id)).toEqual([]);
    }
    // Its close has come, by the clock, while the worker has not closed it (A-M3-31): before the
    // publication instant.
    const late = await createMarket(t.db, {
      createdBy: asker.id,
      categoryId: category.id,
      status: 'open',
      closeAt: new Date(Date.now() - MINUTE_MS),
    });
    expectRefused(
      await pause(late.id, asker, {
        reason: 'early_result',
        resultPublishedAt: iso(Date.now() + HOUR_MS),
      }),
      'closeAt',
      'closed',
    );
    // Published after the pause (the database clock's instant).
    expectRefused(
      await pause(market.id, asker, {
        reason: 'early_result',
        resultPublishedAt: iso(Date.now() + HOUR_MS),
      }),
      'resultPublishedAt',
      'after the pause',
    );
    // Nothing was written by any refusal.
    for (const id of [market.id, late.id]) {
      expect((await marketRow(id)).status).toBe('open');
      expect(await pausesOf(id)).toEqual([]);
      expect(await pauseActionsFor(id)).toEqual([]);
    }
    expect((await eventsFor(market.id)).map((event) => event.type)).toEqual([
      'submitted',
      'approved',
      'opened',
    ]);
    // A paused market is paused again by nobody: its next path is the way on.
    expect((await pause(market.id)).statusCode).toBe(200);
    expectRefused(await pause(market.id, third), 'status', 'not open');
    expect(await pausesOf(market.id)).toHaveLength(1);
    // Unknown market.
    expect((await pause(NO_REQUEST)).statusCode).toBe(404);
  });

  // --- the next-path request --------------------------------------------------------------------
  it('asks for a next path of the current pause, changing nothing yet', async () => {
    const { market, pause: current } = await paused();
    await listening(market.id, async (received) => {
      // The admin who paused may ask.
      const res = await requestDecision(market.id, {
        path: 'early_close',
        reviewResult: 'judgeable',
        reason: '  사건 일정이 앞당겨졌다  ',
      });
      expect(res.statusCode).toBe(200);
      const [request] = await requestsFor(market.id);
      const pending = {
        requestId: request!.id,
        pauseId: current.id,
        path: 'early_close',
        reviewResult: 'judgeable',
        reason: '사건 일정이 앞당겨졌다',
        requestedBy: await actorOf(asker),
        requestedAt: request!.requestedAt.toISOString(),
      };
      expect(detail(res).pause).toEqual({
        history: [expect.objectContaining({ id: current.id, endKind: null })],
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
      expect(request).toMatchObject({
        kind: MARKET_PAUSE_DECISION_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        requestedBy: asker.id,
        requestReason: '사건 일정이 앞당겨졌다',
        status: 'pending',
        payload: { pauseId: current.id, path: 'early_close', reviewResult: 'judgeable' },
      });
      expect(await pauseActionsFor(market.id)).toEqual([
        expect.objectContaining({
          adminId: asker.id,
          type: 'market_pause_decision_request',
          targetType: 'market',
          createdAt: request!.requestedAt,
          payload: {
            approvalId: request!.id,
            pauseId: current.id,
            path: 'early_close',
            reviewResult: 'judgeable',
            reason: '사건 일정이 앞당겨졌다',
          },
        }),
      ]);
      // Nothing changed: the market, the pause, the events; nothing published.
      expect(await marketRow(market.id)).toEqual(market);
      expect((await pausesOf(market.id))[0]).toEqual(current);
      expect((await eventsFor(market.id)).at(-1)!.type).toBe('paused');
      await sleep(100);
      expect(received).toEqual([]);
    });
  });

  it('refuses a request in order: status, close, a stale pause, one waiting, no decider, then what the pause’s reason allows', async () => {
    // Not PAUSED — before the pause the request names (these were never paused: it names none).
    // The close by the clock comes next (the close test: before a stale pause and one waiting).
    for (const status of ['draft', 'scheduled', 'open', 'closed'] as const) {
      const other = await createMarket(t.db, {
        createdBy: asker.id,
        categoryId: category.id,
        status,
      });
      expectRefused(
        await requestDecision(other.id, { path: 'resume', reviewResult: 'judgeable' }),
        'status',
        'not paused',
      );
    }
    // The reason's rules (owner answer Q1; #173 item 4): a basis change asks with its review
    // result, and 판정 불가 closes early alone; the other reasons carry none.
    const { market: basis } = await paused();
    expectRefused(await requestDecision(basis.id, { path: 'resume' }), 'reviewResult', 'required');
    expectRefused(
      await requestDecision(basis.id, { path: 'early_close', reviewResult: null }),
      'reviewResult',
      'required',
    );
    expectRefused(
      await requestDecision(basis.id, { path: 'resume', reviewResult: 'not_judgeable' }),
      'path',
      'early close only',
    );
    for (const reason of ['early_result', 'ledger_failure'] as const) {
      const { market: other } = await paused({ reason });
      expectRefused(
        await requestDecision(other.id, { path: 'resume', reviewResult: 'judgeable' }),
        'reviewResult',
        'only for basis_change',
      );
    }
    // The body's own shapes.
    for (const [payload, path] of [
      [{ path: 'reopen' }, 'path'],
      [{ path: 'resume', reviewResult: 'maybe' }, 'reviewResult'],
      [{ path: 'resume', reviewResult: 'judgeable', reason: ' ' }, 'reason'],
    ] as const) {
      const res = await requestDecision(basis.id, payload);
      expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
      expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([[path]]);
    }
    // A pause that is not the market's lasting one — before the reason's rules (an earlier pause
    // of the market: 'refuses a request naming a pause that has ended since').
    expectRefused(
      await requestDecision(basis.id, { path: 'resume' }, asker, { pauseId: NO_PAUSE }),
      'pause',
      'stale',
    );
    expect(await requestsFor(basis.id)).toEqual([]);
    // One waits at a time, whoever asks — after a stale pause, before the reason's rules.
    expect(
      (await requestDecision(basis.id, { path: 'resume', reviewResult: 'judgeable' })).statusCode,
    ).toBe(200);
    expectRefused(
      await requestDecision(basis.id, { path: 'early_close' }, third, { pauseId: NO_PAUSE }),
      'pause',
      'stale',
    );
    expectRefused(
      await requestDecision(basis.id, { path: 'early_close' }, third),
      'pause',
      'pending',
    );
    // No admin but the requester to decide it: not taken at all — after a stale pause, before the
    // reason's rules.
    const { market: lone } = await paused();
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(ne(schema.profiles.userId, asker.id));
    expectRefused(
      await requestDecision(lone.id, { path: 'resume' }, asker, { pauseId: NO_PAUSE }),
      'pause',
      'stale',
    );
    expectNotAllowed(await requestDecision(lone.id, { path: 'resume' }), 'no_decider');
    expect(await requestsFor(lone.id)).toEqual([]);
    expect(await pauseActionsFor(lone.id)).toEqual([]);
    // Unknown market.
    expect((await requestDecision(NO_REQUEST, { path: 'resume' })).statusCode).toBe(404);
  });

  it('refuses a request naming a pause that has ended since: stale, writing nothing', async () => {
    // The request names the pause its author saw, as #80's supplements their base version: one
    // asked on a pause since resumed, the market paused again, decides nothing of the new pause —
    // even when the new pause's reason would take the same path.
    const market = await opened();
    expect((await pause(market.id, asker, { reason: 'ledger_failure' })).statusCode).toBe(200);
    const [first] = await pausesOf(market.id);
    expect((await requestDecision(market.id, { path: 'resume' })).statusCode).toBe(200);
    expect((await approve(market.id, await pendingId(market.id))).statusCode).toBe(200);
    expect((await pause(market.id, third, { reason: 'ledger_failure' })).statusCode).toBe(200);
    const [second] = await pausesOf(market.id);
    const before = {
      market: await marketRow(market.id),
      pauses: await pausesOf(market.id),
      requests: await requestsFor(market.id),
      actions: await pauseActionsFor(market.id),
      events: await eventsFor(market.id),
    };
    expect(before.requests.map((row) => row.status)).toEqual(['approved']);
    await listening(market.id, async (received) => {
      const stale = await requestDecision(market.id, { path: 'early_close' }, approver, {
        pauseId: first!.id,
      });
      expectRefused(stale, 'pause', 'stale');
      // Nothing written: no request, no record, the market and its pauses as they were.
      expect({
        market: await marketRow(market.id),
        pauses: await pausesOf(market.id),
        requests: await requestsFor(market.id),
        actions: await pauseActionsFor(market.id),
        events: await eventsFor(market.id),
      }).toEqual(before);
      await sleep(100);
      expect(received).toEqual([]);
    });
    // The pause the market shows now is the one to ask about.
    const asked = await requestDecision(market.id, { path: 'early_close' }, approver, {
      pauseId: second!.id,
    });
    expect(asked.statusCode).toBe(200);
    expect(detail(asked).pause.pending).toMatchObject({
      pauseId: second!.id,
      path: 'early_close',
      requestedBy: await actorOf(approver),
    });
  });

  // --- the approval -----------------------------------------------------------------------------
  it('resumes a paused market by another admin’s approval: OPEN again, the event, the pause ended, the record, the status published, the close job kept', async () => {
    const { market, pause: current } = await paused({ reason: 'early_result' });
    await t.app.get(MarketJobs).scheduleClose(market.id, market.closeAt, new Date());
    expect((await requestDecision(market.id, { path: 'resume' })).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    await listening(market.id, async (received) => {
      const res = await approve(market.id, requestId, approver, { reason: ' 재개가 맞다 ' });
      expect(res.statusCode).toBe(200);
      const answer = detail(res);
      const [request] = await requestsFor(market.id);
      const at = request!.decidedAt!;
      expect(request).toMatchObject({
        status: 'approved',
        decidedBy: approver.id,
        decisionReason: '재개가 맞다',
      });
      const event = (await eventsFor(market.id)).at(-1)!;
      expect(event).toMatchObject({
        type: 'resumed',
        actorId: approver.id,
        fromStatus: 'paused',
        toStatus: 'open',
        createdAt: at,
        payload: {
          pauseId: current.id,
          approvalId: requestId,
          requestedBy: asker.id,
          reviewResult: null,
        },
      });
      expect((await pausesOf(market.id))[0]).toMatchObject({
        id: current.id,
        endKind: 'resumed',
        endedAt: at,
        endedBy: approver.id,
        endEventId: event.id,
        endApprovalId: requestId,
        reviewResult: null,
      });
      expect(answer).toMatchObject({
        status: 'open',
        statusEventId: String(event.id),
        updatedAt: at.toISOString(),
      });
      expect(answer.pause.pending).toBeNull();
      expect(answer.pause.history[0]).toMatchObject({
        id: current.id,
        endKind: 'resumed',
        endedAt: at.toISOString(),
        endedBy: await actorOf(approver),
      });
      expect(answer.pause.log[0]).toMatchObject({
        requestId,
        status: 'approved',
        decidedBy: await actorOf(approver),
        decidedAt: at.toISOString(),
        decisionReason: '재개가 맞다',
      });
      // The first open's `open_at` and the scheduled close stay (the 신규 order reads the first).
      expect(await marketRow(market.id)).toMatchObject({
        status: 'open',
        openAt: market.openAt,
        closeAt: market.closeAt,
      });
      expect((await pauseActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: approver.id,
        type: 'market_pause_decision_approve',
        createdAt: at,
        payload: {
          approvalId: requestId,
          pauseId: current.id,
          path: 'resume',
          reviewResult: null,
          reason: '재개가 맞다',
          before: { status: 'paused' },
          after: { status: 'open' },
        },
      });
      // OPEN again goes back in rank: the key orders it (A-M3-19).
      await waitForMessages(received, 1, 'market:status of the resume');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'open',
          resolvedResult: null,
          statusEventId: String(event.id),
          ts: at.toISOString(),
        },
      ]);
      expect(BigInt(answer.statusEventId!)).toBeGreaterThan(BigInt(market.statusEventId!));
    });
    expect(await jobQueue.getJob(marketCloseJobId(market.id, market.closeAt))).toBeDefined();
    expect(data<Market>(await publicDetail(market.id)).status).toBe('open');
  });

  it('closes a paused market early by another admin’s approval: CLOSED, the scheduled close kept, the close job cancelled, judged as any closed market', async () => {
    // The admin who paused may approve another's request (only the requester decides nothing).
    const { market, pause: current } = await paused();
    await t.app.get(MarketJobs).scheduleClose(market.id, market.closeAt, new Date());
    expect(
      (
        await requestDecision(
          market.id,
          { path: 'early_close', reviewResult: 'not_judgeable' },
          third,
        )
      ).statusCode,
    ).toBe(200);
    const requestId = await pendingId(market.id);
    await listening(market.id, async (received) => {
      const res = await approve(market.id, requestId, asker);
      expect(res.statusCode).toBe(200);
      const answer = detail(res);
      const at = (await requestsFor(market.id))[0]!.decidedAt!;
      const event = (await eventsFor(market.id)).at(-1)!;
      expect(event).toMatchObject({
        type: 'closed',
        actorId: asker.id,
        fromStatus: 'paused',
        toStatus: 'closed',
        createdAt: at,
        payload: {
          closedAt: at.toISOString(),
          source: 'early_close',
          pauseId: current.id,
          approvalId: requestId,
          requestedBy: third.id,
          reviewResult: 'not_judgeable',
        },
      });
      expect((await pausesOf(market.id))[0]).toMatchObject({
        endKind: 'early_closed',
        endedAt: at,
        endedBy: asker.id,
        endEventId: event.id,
        endApprovalId: requestId,
        reviewResult: 'not_judgeable',
      });
      // The scheduled close is a rule-version item (#80): it stays; `closedAt` is the actual one.
      expect(answer).toMatchObject({
        status: 'closed',
        closeAt: market.closeAt.toISOString(),
        statusEventId: String(event.id),
      });
      expect(answer.pause.history[0]).toMatchObject({
        endKind: 'early_closed',
        reviewResult: 'not_judgeable',
        endedBy: await actorOf(asker),
      });
      expect((await pauseActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: asker.id,
        type: 'market_pause_decision_approve',
        payload: {
          path: 'early_close',
          reviewResult: 'not_judgeable',
          before: { status: 'paused' },
          after: { status: 'closed', closeAt: market.closeAt.toISOString() },
        },
      });
      await waitForMessages(received, 1, 'market:status of the early close');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as { status: string })).toEqual([
        expect.objectContaining({ status: 'closed', statusEventId: String(event.id) }),
      ]);
    });
    // The close job under the scheduled close is cancelled (hygiene).
    expect(await jobQueue.getJob(marketCloseJobId(market.id, market.closeAt))).toBeUndefined();
    // Never reopened (#173 item 4): nothing pauses or asks again, and the judgement takes it as
    // any closed market — VOID alone, reviewed 판정 불가 ("판정이 VOID 규칙을 따른다", #152,
    // ADR-0103; admin-market-judgements.controller.test has the rest).
    expectRefused(await pause(market.id), 'status', 'not open');
    expectRefused(
      await requestDecision(market.id, { path: 'resume', reviewResult: 'judgeable' }),
      'status',
      'not paused',
    );
    const pub = data<Market>(await publicDetail(market.id));
    expect(pub).toMatchObject({ status: 'closed', closeAt: market.closeAt.toISOString() });
    const window = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/release-settings/market.dispute_window',
      headers: { ...jsonHeaders, cookie: asker.cookie },
      payload: {
        status: 'test',
        value: 1_440,
        reason: '이의 기간 시험값',
        expectedAccountId: asker.id,
      },
    });
    expect(window.statusCode).toBe(200);
    const judgements = `${marketUrl(market.id)}/judgements`;
    const evidence = {
      links: ['https://example.com/schedule'],
      collectedAt: new Date(Date.now() - MINUTE_MS).toISOString(),
    };
    expectRefused(
      await post(judgements, approver, {
        result: 'NO',
        source: { priority: 0 },
        evidence,
        description: '사건 일정이 바뀌었다.',
      }),
      'result',
      'void only',
    );
    const registered = await post(judgements, approver, {
      result: 'VOID',
      source: null,
      voidReason: '조기 마감 검토에서 판정 불가로 보았다.',
      evidence,
      description: '사건 일정이 바뀌어 규칙으로 판정할 수 없다.',
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const judged = await post(
      `${judgements}/${detail(registered).judgement.pending!.requestId}/approve`,
      asker,
      { reason: '판정 불가가 맞다.', eventDeadlineConfirmed: true },
    );
    expect(judged.statusCode, judged.body).toBe(200);
    expect(detail(judged)).toMatchObject({ status: 'provisional', resolvedResult: 'VOID' });
  });

  it.each([
    // Q1: a basis change reviewed 판정 가능 leaves the operator the path.
    ['basis_change', 'resume', 'judgeable', 'open'],
    // Q2: an event's schedule moved earlier — a basis change reviewed 판정 가능, closed early.
    ['basis_change', 'early_close', 'judgeable', 'closed'],
    ['basis_change', 'early_close', 'not_judgeable', 'closed'],
    // The other reasons carry no review, and either path is the operator's.
    ['early_result', 'resume', null, 'open'],
    ['early_result', 'early_close', null, 'closed'],
    ['ledger_failure', 'resume', null, 'open'],
    ['ledger_failure', 'early_close', null, 'closed'],
  ] as const)(
    'takes a %s pause’s %s reviewed %s to %s',
    async (
      reason: MarketPauseReason,
      path: MarketPausePath,
      reviewResult: MarketPauseReviewResult | null,
      status: string,
    ) => {
      const { market } = await paused({ reason });
      const requested = await requestDecision(market.id, {
        path,
        ...(reviewResult === null ? {} : { reviewResult }),
      });
      expect(requested.statusCode).toBe(200);
      const res = await approve(market.id, await pendingId(market.id));
      expect(res.statusCode).toBe(200);
      expect(detail(res).status).toBe(status);
      expect(detail(res).pause.history[0]).toMatchObject({
        reason,
        reviewResult,
        endKind: path === 'resume' ? 'resumed' : 'early_closed',
      });
      expect((await eventsFor(market.id)).at(-1)!.type).toBe(
        path === 'resume' ? 'resumed' : 'closed',
      );
    },
  );

  it('refuses an approval of a request that is no longer waiting, by its requester, or of an unknown one', async () => {
    const { market } = await paused();
    const { market: other } = await paused();
    expect(
      (await requestDecision(other.id, { path: 'resume', reviewResult: 'judgeable' })).statusCode,
    ).toBe(200);
    const otherRequest = await pendingId(other.id);
    expectRefused(await approve(market.id, NO_REQUEST), 'requestId', 'unknown');
    // Another market's request, or another kind's of this market, is no request of its pause.
    expectRefused(await approve(market.id, otherRequest), 'requestId', 'unknown');
    expectRefused(await reject(market.id, otherRequest), 'requestId', 'unknown');
    expectRefused(await retract(market.id, otherRequest), 'requestId', 'unknown');
    const supplement = await createSupplementRequest(t.db, {
      marketId: market.id,
      requestedBy: asker.id,
      changes: { title: '고친 제목' },
    });
    expectRefused(await approve(market.id, supplement.id), 'requestId', 'unknown');

    expect(
      (await requestDecision(market.id, { path: 'resume', reviewResult: 'judgeable' })).statusCode,
    ).toBe(200);
    const requestId = await pendingId(market.id);
    expectNotAllowed(await approve(market.id, requestId, asker), 'requester');
    expectNotAllowed(await reject(market.id, requestId, asker), 'requester');
    expectNotAllowed(await retract(market.id, requestId, approver), 'not_requester');
    expect((await approve(market.id, requestId)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, requestId, third), 'decided');
    expectNotAllowed(await reject(market.id, requestId, third), 'decided');
    // No longer waiting comes before the requester.
    expectNotAllowed(await approve(market.id, requestId, asker), 'decided');
    expectNotAllowed(await retract(market.id, requestId), 'decided');

    // Paused again; a request retracted is decided by nobody.
    expect((await pause(market.id, third)).statusCode).toBe(200);
    expect(
      (await requestDecision(market.id, { path: 'early_close', reviewResult: 'judgeable' }))
        .statusCode,
    ).toBe(200);
    const retracted = await pendingId(market.id);
    expect((await retract(market.id, retracted)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, retracted), 'retracted');
    expectNotAllowed(await reject(market.id, retracted), 'retracted');
    expectNotAllowed(await retract(market.id, retracted), 'retracted');
    expect((await marketRow(market.id)).status).toBe('paused');
  });

  it('refuses an approval once the close has come by the clock, and after the worker closed the market at its close; the request ends by a 반려 or a 철회 alone', async () => {
    // #173 items 1·3: the close comes on schedule while PAUSED. Until the worker runs the market
    // is PAUSED past its close; a request waiting then is moot.
    const closeAt = new Date(Date.now() + 4_000);
    const { market, pause: current } = await paused({ closeAt });
    const { market: other } = await paused({ reason: 'ledger_failure', closeAt });
    expect(
      (await requestDecision(market.id, { path: 'early_close', reviewResult: 'judgeable' }))
        .statusCode,
    ).toBe(200);
    expect((await requestDecision(other.id, { path: 'resume' })).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    await sleep(Math.max(0, closeAt.getTime() - Date.now()) + 50);
    expect((await marketRow(market.id)).status).toBe('paused');
    // The close by the clock: before a stale pause and the waiting request; the approval too.
    expectRefused(
      await requestDecision(market.id, { path: 'resume', reviewResult: 'judgeable' }, third),
      'closeAt',
      'closed',
    );
    expectRefused(
      await requestDecision(market.id, { path: 'resume', reviewResult: 'judgeable' }, third, {
        pauseId: NO_PAUSE,
      }),
      'closeAt',
      'closed',
    );
    expectRefused(await approve(market.id, requestId), 'closeAt', 'closed');
    // The worker closes both at their close (`source: 'job'`) and ends the pauses.
    await workerClose(market.id);
    await workerClose(other.id);
    expect((await pausesOf(market.id))[0]).toMatchObject({
      id: current.id,
      endKind: 'closed_at_close',
      endedBy: null,
      endApprovalId: null,
      reviewResult: null,
    });
    expectRefused(await approve(market.id, requestId), 'status', 'not paused');
    // Still listed in the queue, closed, for its 반려 or 철회.
    const page = (await queue()).json<QueuePage>();
    expect(page.data.map((item) => [item.marketId, item.status])).toEqual([
      [market.id, 'closed'],
      [other.id, 'closed'],
    ]);
    const rejected = await reject(market.id, requestId);
    expect(rejected.statusCode).toBe(200);
    expect(detail(rejected).pause).toMatchObject({
      history: [expect.objectContaining({ endKind: 'closed_at_close', endedBy: null })],
      pending: null,
      log: [expect.objectContaining({ requestId, status: 'rejected' })],
    });
    const retracted = await retract(other.id, await pendingId(other.id));
    expect(retracted.statusCode).toBe(200);
    expect(detail(retracted)).toMatchObject({ status: 'closed', pause: { pending: null } });
    expect((await queue()).json<QueuePage>().data).toEqual([]);
    // The worker's close is the only `closed` event, and no early close was recorded.
    const closes = (await eventsFor(market.id)).filter((event) => event.type === 'closed');
    expect(closes.map((event) => [event.actorId, event.payload?.source])).toEqual([[null, 'job']]);
  });

  it('refuses an approval of a request whose pause has ended since: stale', async () => {
    // A request names its pause; one left from an earlier pause decides nothing of a later one.
    // The routes cannot leave one (a pause ends by its own request's approval or at the close),
    // so the factories write it.
    const market = await opened();
    const first = await createMarketPause(t.db, {
      marketId: market.id,
      reason: 'ledger_failure',
      by: asker.id,
    });
    await resumeMarket(t.db, market.id, { requestedBy: third.id, approvedBy: approver.id });
    const second = await createMarketPause(t.db, { marketId: market.id, by: asker.id });
    const old = await createPauseDecision(t.db, {
      marketId: market.id,
      path: 'resume',
      pauseId: first.pause.id,
      by: third.id,
    });
    expectRefused(await approve(market.id, old.id), 'pause', 'stale');
    expect((await marketRow(market.id)).status).toBe('paused');
    expect((await pausesOf(market.id))[0]).toMatchObject({ id: second.pause.id, endKind: null });
    expect((await reject(market.id, old.id)).statusCode).toBe(200);
  });

  // --- 반려 and 철회 -----------------------------------------------------------------------------
  it('rejects by another admin and retracts by the requester, writing nothing but the record', async () => {
    const { market, pause: current } = await paused();
    expect(
      (await requestDecision(market.id, { path: 'resume', reviewResult: 'judgeable' })).statusCode,
    ).toBe(200);
    const requestId = await pendingId(market.id);
    await listening(market.id, async (received) => {
      expect((await reject(market.id, requestId, approver, { reason: '' })).statusCode).toBe(400);
      const res = await reject(market.id, requestId, approver, {
        reason: ' 아직 기준을 다 보지 못했다 ',
      });
      expect(res.statusCode).toBe(200);
      const [request] = await requestsFor(market.id);
      expect(detail(res).pause).toMatchObject({
        history: [expect.objectContaining({ id: current.id, endKind: null })],
        pending: null,
        log: [
          expect.objectContaining({
            requestId,
            status: 'rejected',
            decidedBy: await actorOf(approver),
            decidedAt: request!.decidedAt!.toISOString(),
            decisionReason: '아직 기준을 다 보지 못했다',
            retractedAt: null,
          }),
        ],
      });
      expect(detail(res).status).toBe('paused');
      expect((await pauseActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: approver.id,
        type: 'market_pause_decision_reject',
        createdAt: request!.decidedAt,
        payload: {
          approvalId: requestId,
          pauseId: current.id,
          path: 'resume',
          reason: '아직 기준을 다 보지 못했다',
        },
      });

      // Asked again, and retracted by its requester.
      expect(
        (
          await requestDecision(market.id, { path: 'early_close' }, third, {
            reviewResult: 'judgeable',
          })
        ).statusCode,
      ).toBe(200);
      const again = await pendingId(market.id);
      expectNotAllowed(await retract(market.id, again, asker), 'not_requester');
      const retracted = await retract(market.id, again, third);
      expect(retracted.statusCode).toBe(200);
      const [, second] = await requestsFor(market.id);
      expect(detail(retracted).pause.log[0]).toMatchObject({
        requestId: again,
        status: 'retracted',
        decidedBy: null,
        retractedAt: second!.retractedAt!.toISOString(),
      });
      expect((await pauseActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: third.id,
        type: 'market_pause_decision_retract',
        createdAt: second!.retractedAt,
        payload: { approvalId: again, pauseId: current.id, path: 'early_close' },
      });
      await sleep(100);
      expect(received).toEqual([]);
    });
    expect((await eventsFor(market.id)).at(-1)!.type).toBe('paused');
    expect(await marketRow(market.id)).toEqual(market);
  });

  // --- two pauses, at once, the queue ------------------------------------------------------------
  it('pauses a market again after a resume, keeping every pause and request, the newest first', async () => {
    const market = await opened();
    expect((await pause(market.id, asker, { reason: 'ledger_failure' })).statusCode).toBe(200);
    expect((await requestDecision(market.id, { path: 'resume' })).statusCode).toBe(200);
    expect((await approve(market.id, await pendingId(market.id))).statusCode).toBe(200);
    expect((await pause(market.id, third)).statusCode).toBe(200);
    expect(
      (await requestDecision(market.id, { path: 'early_close', reviewResult: 'judgeable' }, third))
        .statusCode,
    ).toBe(200);
    const closed = await approve(market.id, await pendingId(market.id), asker);
    expect(closed.statusCode).toBe(200);
    const [second, first] = await pausesOf(market.id);
    expect(detail(closed).pause.history).toEqual([
      expect.objectContaining({
        id: second!.id,
        reason: 'basis_change',
        pausedBy: await actorOf(third),
        reviewResult: 'judgeable',
        endKind: 'early_closed',
        endedBy: await actorOf(asker),
      }),
      expect.objectContaining({
        id: first!.id,
        reason: 'ledger_failure',
        pausedBy: await actorOf(asker),
        reviewResult: null,
        endKind: 'resumed',
        endedBy: await actorOf(approver),
      }),
    ]);
    expect(
      detail(closed).pause.log.map((entry) => [entry.pauseId, entry.path, entry.status]),
    ).toEqual([
      [second!.id, 'early_close', 'approved'],
      [first!.id, 'resume', 'approved'],
    ]);
    expect((await eventsFor(market.id)).map((event) => event.type)).toEqual([
      'submitted',
      'approved',
      'opened',
      'paused',
      'resumed',
      'paused',
      'closed',
    ]);
    // The admin detail read on its own says the same.
    expect(detail(await get(marketUrl(market.id))).pause).toEqual(detail(closed).pause);
  });

  it('serialises two writes of one market’s pause: one request waits, and one approval takes the path', async () => {
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

    const market = await opened();
    // Two pauses at once: the second finds the market PAUSED.
    const [pausedFirst, pausedAgain] = await inTurn(
      market.id,
      () => pause(market.id),
      () => pause(market.id, third, { reason: 'ledger_failure' }),
    );
    expect(pausedFirst.statusCode).toBe(200);
    expectRefused(pausedAgain, 'status', 'not open');
    const [taken, waiting] = await inTurn(
      market.id,
      () => requestDecision(market.id, { path: 'resume', reviewResult: 'judgeable' }),
      () => requestDecision(market.id, { path: 'early_close', reviewResult: 'judgeable' }, third),
    );
    expect(taken.statusCode).toBe(200);
    expectRefused(waiting, 'pause', 'pending');
    const requestId = await pendingId(market.id);
    const [approved, again] = await inTurn(
      market.id,
      () => approve(market.id, requestId),
      () => approve(market.id, requestId, third),
    );
    expect(approved.statusCode).toBe(200);
    expectNotAllowed(again, 'decided');
    expect((await eventsFor(market.id)).filter((event) => event.type === 'resumed')).toHaveLength(
      1,
    );
    expect(await pausesOf(market.id)).toHaveLength(1);
    expect((await marketRow(market.id)).status).toBe('open');
  });

  it('lists the waiting next paths across markets, the oldest first, with the pause’s reason and a keyset cursor', async () => {
    const { market: first, pause: firstPause } = await paused({ reason: 'ledger_failure' });
    const { market: second } = await paused();
    const { market: last } = await paused();
    expect((await requestDecision(first.id, { path: 'early_close' })).statusCode).toBe(200);
    expect(
      (await requestDecision(second.id, { path: 'resume', reviewResult: 'judgeable' }, third))
        .statusCode,
    ).toBe(200);
    expect(
      (await requestDecision(last.id, { path: 'early_close', reviewResult: 'not_judgeable' }))
        .statusCode,
    ).toBe(200);
    // Decided and retracted ones leave the queue.
    expect((await retract(last.id, await pendingId(last.id))).statusCode).toBe(200);
    const page = (await queue()).json<QueuePage>();
    expect(page.data).toEqual([
      {
        requestId: await pendingId(first.id),
        marketId: first.id,
        slug: first.slug,
        title: first.title,
        status: 'paused',
        closeAt: first.closeAt.toISOString(),
        pauseId: firstPause.id,
        reason: 'ledger_failure',
        path: 'early_close',
        reviewResult: null,
        requestedBy: await actorOf(asker),
        requestedAt: (await requestsFor(first.id))[0]!.requestedAt.toISOString(),
      },
      expect.objectContaining({
        marketId: second.id,
        reason: 'basis_change',
        path: 'resume',
        reviewResult: 'judgeable',
        requestedBy: await actorOf(third),
      }),
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

  // --- the admin on screen, and the PATCH -------------------------------------------------------
  it('asks every pause write for the admin on screen, before anything is read or written', async () => {
    const market = await opened();
    const { market: held } = await paused();
    expect(
      (await requestDecision(held.id, { path: 'resume', reviewResult: 'judgeable' })).statusCode,
    ).toBe(200);
    const requestId = await pendingId(held.id);
    for (const res of [
      await pause(market.id, third, { expectedAccountId: approver.id }),
      await requestDecision(held.id, { path: 'early_close' }, third, {
        expectedAccountId: approver.id,
      }),
      await approve(held.id, requestId, approver, { expectedAccountId: third.id }),
      await reject(held.id, requestId, approver, { expectedAccountId: third.id }),
      await post(`${decisionsUrl(held.id)}/${requestId}/retract`, asker, {
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
      await unnamed(`${marketUrl(market.id)}/pause`, { reason: 'basis_change', note: NOTE }),
      await unnamed(decisionsUrl(held.id), {
        pauseId: await shownPause(held.id),
        path: 'resume',
        reason: REASON,
      }),
      await unnamed(`${decisionsUrl(held.id)}/${requestId}/approve`, { reason: APPROVAL }),
      await unnamed(`${decisionsUrl(held.id)}/${requestId}/reject`, { reason: '반려' }),
      await unnamed(`${decisionsUrl(held.id)}/${requestId}/retract`, {}),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    }
    expect((await marketRow(market.id)).status).toBe('open');
    expect((await requestsFor(held.id)).map((row) => row.status)).toEqual(['pending']);
    expect((await pauseActionsFor(held.id)).map((action) => action.type)).toEqual([
      'market_pause_decision_request',
    ]);
    expect(await pauseActionsFor(market.id)).toEqual([]);
  });

  it('edits a paused market’s category and tags with the record, and refuses its version items, slug and last tag as an open market’s', async () => {
    // #172 item 14: '개장 뒤' includes the pause — category and tags change directly with the
    // person, the time and both values; the rule version's items by a supplement alone.
    const { market } = await paused();
    const politics = await createCategory(t.db, { slug: 'politics', nameKo: '정치' });
    await listening(market.id, async (received) => {
      const res = await patch(marketUrl(market.id), asker, {
        categoryId: politics.id,
        tags: ['중단 중 태그', '정치'],
      });
      expect(res.statusCode).toBe(200);
      expect(detail(res)).toMatchObject({
        status: 'paused',
        category: { slug: 'politics' },
        tags: ['중단 중 태그', '정치'],
        statusEventId: String(market.statusEventId),
      });
      const [action] = (
        await t.db
          .select()
          .from(schema.adminActions)
          .where(eq(schema.adminActions.targetId, market.id))
          .orderBy(desc(schema.adminActions.createdAt))
      ).filter((row) => row.type === 'market_update');
      expect(action).toMatchObject({
        adminId: asker.id,
        payload: {
          before: { categoryId: category.id, tags: ['중단'], status: 'paused' },
          after: { categoryId: politics.id, tags: ['중단 중 태그', '정치'], status: 'paused' },
        },
      });
      // PAUSED is public: viewers are told to refetch, the status and key unchanged.
      await waitForMessages(received, 1, 'market:status of the paused market’s edit');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        expect.objectContaining({
          status: 'paused',
          statusEventId: String(market.statusEventId),
        }),
      ]);
    });
    // The version items, as an open market's (#80).
    const items = await patch(marketUrl(market.id), asker, {
      title: '새 제목',
      closeAt: iso(week() + DAY_MS),
    });
    expect(errorOf(items)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'title, closeAt change by a supplement alone while the market is paused',
      details: [
        { path: ['title'], message: 'supplement only while open' },
        { path: ['closeAt'], message: 'supplement only while open' },
      ],
    });
    const slug = await patch(marketUrl(market.id), asker, { slug: 'paused-slug' });
    expect(errorOf(slug)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'slug cannot change while the market is paused',
      details: [{ path: ['slug'], message: 'immutable while open' }],
    });
    const untagged = await patch(marketUrl(market.id), asker, { tags: [] });
    expect(errorOf(untagged)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Tags cannot be removed while the market is paused',
      details: [{ path: ['tags'], message: 'required while open' }],
    });
    expect(await marketRow(market.id)).toMatchObject({
      title: market.title,
      slug: market.slug,
      closeAt: market.closeAt,
      status: 'paused',
    });
  });
});
