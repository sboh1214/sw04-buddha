/**
 * 판정 등록과 별도 검토자 승인 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·4·5·9·13, decision
 * 3 the #152 rows '역할'·'판정 출처'·'증거'·'등록 시점') through the admin routes against the docker
 * `test` profile: a registration by one admin — the request with its frozen payload (the source's
 * name and address copied from the rules, the rule version), the record, nothing else: no event,
 * nothing published, nothing public — refused for its body (the result, the source and the
 * reasons together, the links, the description) and, in order, for the status, one waiting, no
 * decider, the undecided dispute window, an unknown source, a YES or NO on a market closed early
 * as 판정 불가 and evidence collected after now; a VOID with no source and its reason; an approval
 * by another admin — PROVISIONAL with the result, the version and the dispute deadline fixed from
 * the window read then, the append-only judgement, the record, the status published, the resolve
 * job at the deadline, nothing settled and nothing of it public — the event deadline confirmed
 * before the scheduled judgement, and refused for an unknown request, one no longer waiting, its
 * registrant, a market no longer CLOSED and the undecided window; a 반려 and a 철회 writing the
 * record alone, the market registered again by any admin; 판정 정정 (#176, ADR-0105; #173 items
 * 2·5·7·8, decision 3 '#176 정정 대기', owner answer 2026-11-02) by the same routes — a
 * registration against the current version listing its accepted disputes, the mirror set and the
 * status republished, refused for its body and, in order, off PROVISIONAL, against another
 * version, while one waits, with no decider, changing nothing, an unknown source, after 판정 불가
 * and evidence after now, reading no setting; its approval — the next version with a deadline of
 * v1's length from it (the window undecided too), v1's pending disputes 정정으로 종결 and its
 * accepted one answered, the record, the status under the new key, a new resolve job beside v1's,
 * a second correction's history — and its refusals; its 반려 and 철회 sending the accepted
 * disputes it answered back to pending, retractable and decided again; the member disputing v2,
 * decided by any admin but v2's registrant; the hold and '판정 지연' past the deadline, and the
 * resolve job registered at once once nothing holds; two writes at once; the 판정 승인 대기 queue;
 * the admin on screen; and the interim one-admin `POST …/resolve`, gone. The worker's
 * confirmation at the deadline is apps/worker's (market-resolve.test.ts). Skips when TEST_* are
 * unset.
 */
import { clockTimestamp, schema } from '@buddha/db';
import {
  closeMarketEarly,
  completeOnboarding,
  createCategory,
  createDispute,
  createFill,
  createJudgementRequest,
  createMarket,
  createOpenedMarket,
  createProvisionalMarket,
  resolveMarketNow,
} from '@buddha/db/test';
import {
  JOB_NAMES,
  MARKET_JUDGEMENT_APPROVAL_KIND,
  marketChannel,
  marketResolveJobId,
  type AdminDisputeQueueItem,
  type AdminMarket,
  type AdminMarketJudgementQueueItem,
  type Market,
  type MarketPauseReviewResult,
  type MyDispute,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
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
type QueuePage = { data: AdminMarketJudgementQueueItem[]; meta: { nextCursor: string | null } };
type Res = { statusCode: number; json: <U>() => U; body: string };

/** An ISO instant, `ms` from the epoch. */
const iso = (ms: number) => new Date(ms).toISOString();

const LINK = 'https://www.bok.or.kr/press/2026-10';
const DESCRIPTION = '한국은행 보도자료에서 기준금리 3.00%를 확인했다.';
const APPROVAL = '증거와 출처가 규칙에 맞다.';
const FALLBACK = { name: '통계청 보도자료', url: 'https://kostat.go.kr/press' };
const CORRECTION = '1차 출처가 발표를 정정해 기준금리는 3.25%다.';
const DISPUTE_REASON = '발표 원문은 3.25%인데 판정은 3.00%로 보았다.';
const ACCEPTANCE = '발표 원문을 다시 확인했고 판정과 다르다.';

describe.skipIf(!hasTestInfra)('admin market judgements (integration)', () => {
  let t: TestApp;
  /** The worker's view of the `markets` queue: a plain Queue on its own client. */
  let inspector: Redis;
  let jobQueue: Queue;
  /** Registers the judgements unless a test says otherwise. */
  let registrant: TestUser;
  /** Decides them. */
  let reviewer: TestUser;
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
    registrant = await makeAdmin();
    reviewer = await makeAdmin();
    third = await makeAdmin();
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    // Every environment starts undecided (ADR-0055); a day, as the design proposal, unless a test
    // enters another.
    await setWindow(1_440);
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
  const get = (url: string, who: TestUser = registrant) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });

  /**
   * The release setting `market.dispute_window` as an admin enters it — a test value in minutes —
   * or back to undecided (`null`).
   */
  async function setWindow(value: number | null) {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/release-settings/market.dispute_window',
      headers: { ...jsonHeaders, cookie: registrant.cookie },
      payload: {
        ...(value === null ? { status: 'undecided' } : { status: 'test', value }),
        reason: '이의 기간 시험값',
        expectedAccountId: registrant.id,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;
  const judgementsUrl = (id: string) => `${marketUrl(id)}/judgements`;
  /** 판정 등록: YES on the primary source, one link collected a minute ago, unless told. */
  const register = (
    id: string,
    who: TestUser = registrant,
    payload: Record<string, unknown> = {},
  ) =>
    post(judgementsUrl(id), who, {
      result: 'YES',
      source: { priority: 0 },
      evidence: { links: [LINK], collectedAt: iso(Date.now() - MINUTE_MS) },
      description: DESCRIPTION,
      ...payload,
    });
  /** 승인 without the event-deadline confirmation unless told. */
  const approve = (
    id: string,
    requestId: string,
    who: TestUser = reviewer,
    payload: Record<string, unknown> = {},
  ) =>
    post(`${judgementsUrl(id)}/${requestId}/approve`, who, {
      reason: APPROVAL,
      eventDeadlineConfirmed: false,
      ...payload,
    });
  const reject = (
    id: string,
    requestId: string,
    who: TestUser = reviewer,
    payload: Record<string, unknown> = {},
  ) =>
    post(`${judgementsUrl(id)}/${requestId}/reject`, who, {
      reason: '증거가 결과를 보이지 않는다.',
      ...payload,
    });
  const retract = (id: string, requestId: string, who: TestUser = registrant) =>
    post(`${judgementsUrl(id)}/${requestId}/retract`, who);
  const queue = (query = '', who: TestUser = registrant) =>
    get(`/api/v1/admin/market-judgements${query}`, who);
  const publicDetail = (id: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1/markets/${id}` });

  /**
   * A market the worker closed at its close three days ago, with a fallback source (priority 1):
   * its scheduled judgement has passed (the factory's, a day after the event deadline a day after
   * the close), so an approval needs no confirmation. Opened before #80: no rule version.
   */
  function closed(input: Parameters<typeof createMarket>[1] = {}) {
    return createMarket(t.db, {
      createdBy: registrant.id,
      categoryId: category.id,
      status: 'closed',
      openAt: new Date(Date.now() - 10 * DAY_MS),
      closeAt: new Date(Date.now() - 3 * DAY_MS),
      fallbackSources: [FALLBACK],
      ...input,
    });
  }
  /**
   * A market opened with rule v1 and closed early by another admin's approval (#114), its review
   * `judgeable` unless told: its close and scheduled judgement still ahead, so an approval before
   * then confirms the event deadline.
   */
  async function closedEarly(reviewResult: MarketPauseReviewResult = 'judgeable') {
    const { market } = await createOpenedMarket(t.db, {
      createdBy: registrant.id,
      categoryId: category.id,
      tags: ['판정'],
      closeAt: new Date(Date.now() + 7 * DAY_MS),
      fallbackSources: [FALLBACK],
    });
    return (await closeMarketEarly(t.db, market.id, { reviewResult })).market;
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

  /** A refusal VALIDATION_ERROR naming `path` (a field, or a field inside one) with `message`. */
  function expectRefused(res: Res, path: string | (string | number)[], message: string) {
    expect({ status: res.statusCode, details: errorOf(res).details }).toEqual({
      status: 400,
      details: [{ path: typeof path === 'string' ? [path] : path, message }],
    });
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  }
  /** APPROVAL_NOT_ALLOWED with `reason`. */
  function expectNotAllowed(res: Res, reason: string) {
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('APPROVAL_NOT_ALLOWED');
    expect(errorOf(res).details).toEqual([{ path: ['request'], message: reason }]);
  }
  /** A 판정 이의 route's DISPUTE_NOT_ALLOWED with `reason` (#175). */
  function expectDisputeNotAllowed(res: Res, reason: string) {
    expect({ status: res.statusCode, error: errorOf(res) }).toMatchObject({
      status: 409,
      error: { code: 'DISPUTE_NOT_ALLOWED', details: { reason } },
    });
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
  /** The market's registrations, oldest first. */
  async function requestsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_JUDGEMENT_APPROVAL_KIND),
          eq(schema.approvalRequests.targetId, marketId),
        ),
      )
      .orderBy(asc(schema.approvalRequests.requestedAt));
  }
  /** The market's waiting registration's id. */
  async function pendingId(marketId: string) {
    const pending = (await requestsFor(marketId)).filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(1);
    return pending[0]!.id;
  }
  /** The market's 1차 출처 as the registration copies it (`market_sources` priority 0). */
  async function primaryOf(marketId: string) {
    const [row] = await t.db
      .select({ name: schema.marketSources.name, url: schema.marketSources.url })
      .from(schema.marketSources)
      .where(
        and(eq(schema.marketSources.marketId, marketId), eq(schema.marketSources.priority, 0)),
      );
    return { priority: 0, name: row!.name, url: row!.url };
  }
  /** The market's judgements, oldest first. */
  async function judgementsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.marketJudgements)
      .where(eq(schema.marketJudgements.marketId, marketId))
      .orderBy(asc(schema.marketJudgements.version));
  }
  /** The market's judgement records, oldest first. */
  async function judgementActionsFor(marketId: string) {
    const rows = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, marketId))
      .orderBy(asc(schema.adminActions.createdAt));
    return rows.filter((row) => row.type.startsWith('market_judgement'));
  }
  async function stepRows(marketId: string) {
    return t.db
      .select()
      .from(schema.marketSettlementSteps)
      .where(eq(schema.marketSettlementSteps.marketId, marketId));
  }
  async function jobIds() {
    const jobs = await jobQueue.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed']);
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

  // --- 판정 등록 ----------------------------------------------------------------------------------
  it('registers a closed market’s judgement for another admin’s approval, changing nothing yet', async () => {
    const market = await closedEarly();
    const before = await marketRow(market.id);
    const eventsBefore = await eventsFor(market.id);
    // An hour before the registration, at an odd millisecond; the links trimmed.
    const collectedAt = new Date(Date.now() - HOUR_MS + 123);
    await listening(market.id, async (received) => {
      const res = await register(market.id, registrant, {
        source: { priority: 1 },
        fallbackReason: ' 1차 출처가 아직 발표하지 않았다 ',
        evidence: {
          links: [`  ${LINK}  `, 'https://kostat.go.kr/a'],
          collectedAt: iso(+collectedAt),
        },
        description: `  ${DESCRIPTION}  `,
      });
      expect(res.statusCode, res.body).toBe(200);
      const answer = detail(res);
      const [request] = await requestsFor(market.id);
      const payload = {
        result: 'YES',
        // Copied from the rules' row at that priority: the body names the priority alone.
        source: { priority: 1, ...FALLBACK },
        fallbackReason: '1차 출처가 아직 발표하지 않았다',
        voidReason: null,
        evidence: {
          links: [LINK, 'https://kostat.go.kr/a'],
          collectedAt: collectedAt.toISOString(),
        },
        // The rule version the market had (ADR-0101 결과 5): the judgement follows it.
        ruleVersion: 1,
        // A first judgement (#176: a correction names its base version).
        correction: null,
      };
      expect(request).toMatchObject({
        kind: MARKET_JUDGEMENT_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        payload,
        requestedBy: registrant.id,
        requestReason: DESCRIPTION,
        status: 'pending',
        decidedBy: null,
      });
      const at = request!.requestedAt.toISOString();
      const actions = await judgementActionsFor(market.id);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        adminId: registrant.id,
        type: 'market_judgement_request',
        targetType: 'market',
        createdAt: request!.requestedAt,
        payload: { approvalId: request!.id, ...payload, description: DESCRIPTION },
      });
      // The admin detail: the registration waits, nothing published yet.
      const entry = {
        requestId: request!.id,
        ...payload,
        description: DESCRIPTION,
        requestedBy: await actorOf(registrant),
        requestedAt: at,
      };
      expect(answer).toMatchObject({
        status: 'closed',
        resolvedResult: null,
        judgementVersion: null,
        disputeDeadline: null,
      });
      expect(answer.judgement).toEqual({
        current: null,
        history: [],
        pending: entry,
        log: [
          {
            ...entry,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
            decisionReason: null,
            retractedAt: null,
            version: null,
          },
        ],
        disputeWindowUndecided: false,
      });
      // Nothing of the market moved (#173 item 1: the approval publishes, not the registration).
      expect(await marketRow(market.id)).toEqual(before);
      expect(await eventsFor(market.id)).toEqual(eventsBefore);
      await sleep(100);
      expect(received).toEqual([]);
    });
    expect(await jobIds()).toEqual([]);
    expect(await judgementsFor(market.id)).toEqual([]);
    // The admin detail reads the same; the public one nothing of it (#24, #173 item 13).
    expect(detail(await get(marketUrl(market.id))).judgement.pending?.requestId).toBe(
      await pendingId(market.id),
    );
    const pub = await publicDetail(market.id);
    expect(data<Market>(pub)).toMatchObject({ status: 'closed', resolvedResult: null });
    for (const hidden of [DESCRIPTION, LINK, '1차 출처가 아직', registrant.id]) {
      expect(pub.body).not.toContain(hidden);
    }
  });

  it('refuses a registration for its body: the result, the source and the reasons together, the links and the description', async () => {
    const market = await closed();
    const at = iso(Date.now() - MINUTE_MS);
    const cases: [Record<string, unknown>, (string | number)[], string | null][] = [
      [{ result: 'MAYBE' }, ['result'], null],
      [{ result: undefined }, ['result'], null],
      // The key is required: null names none, a VOID's alone.
      [{ source: undefined }, ['source'], null],
      [{ source: null }, ['source'], 'required'],
      [{ result: 'NO', source: null }, ['source'], 'required'],
      [{ source: { priority: 4 } }, ['source', 'priority'], null],
      [{ source: { priority: 0.5 } }, ['source', 'priority'], null],
      // A fallback with the reason the primary could not be used, and nothing else with one.
      [{ source: { priority: 1 } }, ['fallbackReason'], 'required'],
      [{ source: { priority: 2 }, fallbackReason: null }, ['fallbackReason'], 'required'],
      [{ fallbackReason: '1차 출처를 썼다' }, ['fallbackReason'], 'only for a fallback source'],
      [{ source: { priority: 1 }, fallbackReason: '   ' }, ['fallbackReason'], null],
      // A VOID with its reason, and nothing else with one.
      [{ result: 'VOID', source: null }, ['voidReason'], 'required'],
      [{ result: 'VOID' }, ['voidReason'], 'required'],
      [{ voidReason: '판정 불가' }, ['voidReason'], 'only for VOID'],
      [{ result: 'VOID', source: null, voidReason: 'x'.repeat(501) }, ['voidReason'], null],
      // 1..5 distinct http(s) links of at most 500 characters, and an instant.
      [{ evidence: { links: [], collectedAt: at } }, ['evidence', 'links'], null],
      [
        {
          evidence: { links: Array.from({ length: 6 }, (_, i) => `${LINK}/${i}`), collectedAt: at },
        },
        ['evidence', 'links'],
        null,
      ],
      [
        { evidence: { links: ['ftp://example.com/a'], collectedAt: at } },
        ['evidence', 'links', 0],
        null,
      ],
      [
        { evidence: { links: [`https://example.com/${'a'.repeat(490)}`], collectedAt: at } },
        ['evidence', 'links', 0],
        null,
      ],
      [
        { evidence: { links: [LINK, `  ${LINK} `], collectedAt: at } },
        ['evidence', 'links', 1],
        'duplicate',
      ],
      [
        { evidence: { links: [LINK], collectedAt: '어제 저녁' } },
        ['evidence', 'collectedAt'],
        null,
      ],
      [{ evidence: { links: [LINK] } }, ['evidence', 'collectedAt'], null],
      [{ description: '   ' }, ['description'], null],
      [{ description: 'x'.repeat(501) }, ['description'], null],
    ];
    for (const [payload, path, message] of cases) {
      const res = await register(market.id, registrant, payload);
      expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
      const details = errorOf(res).details ?? [];
      expect({ payload, paths: details.map((issue) => issue.path) }).toEqual({
        payload,
        paths: [path],
      });
      if (message !== null) expect(details[0]!.message).toBe(message);
    }
    expect(await requestsFor(market.id)).toEqual([]);
    expect(await judgementActionsFor(market.id)).toEqual([]);
  });

  it('refuses a registration in order: status, one waiting, no decider, the undecided window, an unknown source, YES or NO after 판정 불가, evidence after now', async () => {
    // Not CLOSED, every other status — before anything else, the undecided window included.
    await setWindow(null);
    for (const status of [
      'draft',
      'review',
      'scheduled',
      'open',
      'paused',
      'provisional',
      'resolved',
      'settling',
      'settled',
      'cancelled',
    ] as const) {
      const other = await createMarket(t.db, {
        createdBy: registrant.id,
        categoryId: category.id,
        status,
        ...(['resolved', 'settling', 'settled'].includes(status) ? { resolvedResult: 'NO' } : {}),
      });
      expectRefused(await register(other.id), 'status', 'not closed');
      expect(await requestsFor(other.id)).toEqual([]);
    }
    // The admin detail says the window is undecided, so the screen turns the form off.
    const market = await closed();
    expect(detail(await get(marketUrl(market.id))).judgement.disputeWindowUndecided).toBe(true);
    expectRefused(await register(market.id), 'disputeWindow', 'undecided');
    await setWindow(1_440);
    expect(detail(await get(marketUrl(market.id))).judgement.disputeWindowUndecided).toBe(false);

    // One waits at a time, whoever registers — before the window and anything after it.
    expect((await register(market.id)).statusCode).toBe(200);
    await setWindow(null);
    expectRefused(
      await register(market.id, third, {
        source: { priority: 3 },
        fallbackReason: '1차 출처가 없다',
      }),
      'judgement',
      'pending',
    );
    await setWindow(1_440);

    // No admin but the registrant to approve it: not taken at all — before the window.
    const lone = await closed();
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(ne(schema.profiles.userId, registrant.id));
    await setWindow(null);
    expectNotAllowed(await register(lone.id), 'no_decider');
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, reviewer.id));
    expectRefused(await register(lone.id), 'disputeWindow', 'undecided');
    expect(await requestsFor(lone.id)).toEqual([]);
    await setWindow(1_440);

    // A priority the rules have no source of: the market has a fallback at 1 alone, and one
    // opened before #23 none at all — before the 판정 불가 rule.
    const voidOnly = await closedEarly('not_judgeable');
    expectRefused(
      await register(voidOnly.id, registrant, {
        source: { priority: 3 },
        fallbackReason: '1차 출처가 없다',
      }),
      'source',
      'unknown',
    );
    const bare = await closed({ blankRuleItems: true, fallbackSources: [] });
    expectRefused(await register(bare.id), 'source', 'unknown');
    // A market closed early as 판정 불가 (ADR-0102: "판정이 VOID 규칙을 따른다") takes a VOID alone —
    // before the evidence's instant.
    for (const result of ['YES', 'NO'] as const) {
      expectRefused(
        await register(voidOnly.id, registrant, {
          result,
          evidence: { links: [LINK], collectedAt: iso(Date.now() + HOUR_MS) },
        }),
        'result',
        'void only',
      );
    }
    // Evidence collected after the registration, by the database clock: no evidence yet.
    const fresh = await closed();
    expectRefused(
      await register(fresh.id, registrant, {
        evidence: { links: [LINK], collectedAt: iso(Date.now() + 10 * MINUTE_MS) },
      }),
      ['evidence', 'collectedAt'],
      'after now',
    );
    expect(await requestsFor(fresh.id)).toEqual([]);
    expect(await requestsFor(voidOnly.id)).toEqual([]);
    expect(await judgementActionsFor(voidOnly.id)).toEqual([]);
    // VOID is registered there, with no source or with the rules' — and an early result's
    // evidence may predate the close (no lower bound).
    expect(
      (
        await register(voidOnly.id, registrant, {
          result: 'VOID',
          source: null,
          voidReason: '조기 마감 검토에서 판정 불가로 보았다.',
          evidence: { links: [LINK], collectedAt: iso(Date.now() - 30 * DAY_MS) },
        })
      ).statusCode,
    ).toBe(200);
    // Unknown market.
    expect((await register(NO_REQUEST)).statusCode).toBe(404);
  });

  // --- 승인 ------------------------------------------------------------------------------------
  it('approves by another admin: PROVISIONAL with the result, the version, the deadline fixed, the judgement, the record, the status published, the resolve job; nothing settled, nothing of it public', async () => {
    const market = await closedEarly();
    const primary = await primaryOf(market.id);
    await setWindow(90);
    const collectedAt = new Date(Date.now() - 2 * HOUR_MS + 777);
    expect(
      (
        await register(market.id, registrant, {
          evidence: { links: [LINK], collectedAt: iso(+collectedAt) },
        })
      ).statusCode,
    ).toBe(200);
    const requestId = await pendingId(market.id);
    let answer!: AdminMarket;
    await listening(market.id, async (received) => {
      const res = await approve(market.id, requestId, reviewer, {
        reason: ` ${APPROVAL} `,
        eventDeadlineConfirmed: true,
      });
      expect(res.statusCode, res.body).toBe(200);
      answer = detail(res);
      await waitForMessages(received, 1, 'market:status of the approval');
      await sleep(100);
      const [request] = await requestsFor(market.id);
      const at = request!.decidedAt!;
      const deadline = new Date(at.getTime() + 90 * MINUTE_MS);
      const event = (await eventsFor(market.id)).at(-1)!;
      // The approver's `provisional` event, at the decision's instant (#173 item 1).
      expect(event).toMatchObject({
        type: 'provisional',
        actorId: reviewer.id,
        fromStatus: 'closed',
        toStatus: 'provisional',
        createdAt: at,
        payload: {
          version: 1,
          result: 'YES',
          approvalId: requestId,
          requestedBy: registrant.id,
          disputeDeadline: deadline.toISOString(),
        },
      });
      // The deadline: the publication plus the window read then, exactly (#173 item 5); the
      // result is the judged one (ADR-0095 8-2); `resolved_at` is the confirmation's, to come.
      expect(await marketRow(market.id)).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        resolvedAt: null,
        judgementVersion: 1,
        disputeDeadline: deadline,
        statusEventId: event.id,
        closeAt: market.closeAt,
        ruleVersion: 1,
      });
      const [judgement] = await judgementsFor(market.id);
      expect(judgement).toEqual({
        marketId: market.id,
        version: 1,
        result: 'YES',
        sourcePriority: 0,
        sourceName: primary.name,
        sourceUrl: primary.url,
        fallbackReason: null,
        voidReason: null,
        evidenceLinks: [LINK],
        evidenceDescription: DESCRIPTION,
        collectedAt,
        ruleVersion: 1,
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: 90,
        publishedAt: at,
        disputeDeadline: deadline,
        correctionReason: null,
        approvalId: requestId,
        registeredBy: registrant.id,
        approvedBy: reviewer.id,
        provisionalEventId: event.id,
        createdAt: at,
      });
      expect(request).toMatchObject({
        status: 'approved',
        decidedBy: reviewer.id,
        decisionReason: APPROVAL,
      });
      expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: reviewer.id,
        type: 'market_judgement_approve',
        targetType: 'market',
        createdAt: at,
        payload: {
          approvalId: requestId,
          version: 1,
          result: 'YES',
          reason: APPROVAL,
          eventDeadlineConfirmed: true,
          disputeWindowMinutes: 90,
          disputeDeadline: deadline.toISOString(),
          previous: null,
          correction: null,
          closedDisputeIds: [],
          before: { status: 'closed' },
          after: { status: 'provisional' },
        },
      });
      // The answer: the provisional result, the version, the deadline and the judgement with who
      // registered and approved it — no settlement before the confirmation.
      expect(answer).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        resolvedAt: null,
        settledAt: null,
        statusEventId: String(event.id),
        updatedAt: at.toISOString(),
        judgementVersion: 1,
        disputeDeadline: deadline.toISOString(),
        settlementSteps: [],
      });
      expect(answer.events[0]).toMatchObject({ type: 'provisional', actorId: reviewer.id });
      expect(answer.judgement.current).toEqual({
        version: 1,
        result: 'YES',
        source: primary,
        fallbackReason: null,
        voidReason: null,
        evidence: { links: [LINK], collectedAt: collectedAt.toISOString() },
        description: DESCRIPTION,
        ruleVersion: 1,
        correctionReason: null,
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: 90,
        publishedAt: at.toISOString(),
        disputeDeadline: deadline.toISOString(),
        approvalId: requestId,
        registeredBy: await actorOf(registrant),
        approvedBy: await actorOf(reviewer),
      });
      expect(answer.judgement.pending).toBeNull();
      expect(answer.judgement.history).toEqual([]);
      expect(answer.judgement.log).toEqual([
        expect.objectContaining({
          requestId,
          status: 'approved',
          decidedBy: await actorOf(reviewer),
          decidedAt: at.toISOString(),
          decisionReason: APPROVAL,
          version: 1,
        }),
      ]);
      // Published once after COMMIT: PROVISIONAL with its result and the event's key.
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'provisional',
          resolvedResult: 'YES',
          statusEventId: String(event.id),
          ts: at.toISOString(),
        },
      ]);
      // The worker confirms it at the deadline: `market.resolve`, delayed from the approval's
      // instant to it. Nothing settles yet — the worker registers the finalize after confirming.
      const jobId = marketResolveJobId(market.id, deadline);
      expect(jobId).toBe(`market.resolve.${market.id}.${String(deadline.getTime())}`);
      const job = await jobQueue.getJob(jobId);
      expect(job).toMatchObject({
        name: JOB_NAMES.marketResolve,
        data: { marketId: market.id },
        delay: 90 * MINUTE_MS,
      });
      expect(await jobIds()).toEqual([jobId]);
      expect(await stepRows(market.id)).toEqual([]);
    });

    // The public detail: the status and the provisional result (labels and notice are the web's),
    // the version and its dispute deadline, which anonymous visitors see with the submission link
    // (#175, #173 item 6) — and nothing else of the judgement: the record is #24's, the accounts
    // nobody's (#173 item 13).
    const pub = await publicDetail(market.slug);
    expect(pub.statusCode).toBe(200);
    expect(data<Market>(pub)).toMatchObject({
      status: 'provisional',
      resolvedResult: 'YES',
      resolvedAt: null,
      statusEventId: answer.statusEventId,
      judgementVersion: 1,
      disputeDeadline: answer.disputeDeadline,
      disputeOpen: true,
      disputeUnderReview: false,
      judgementDelayed: false,
    });
    expect(data<Market>(pub)).not.toHaveProperty('judgement');
    expect(data<Market>(pub)).not.toHaveProperty('disputes');
    for (const hidden of [
      DESCRIPTION,
      LINK,
      APPROVAL,
      registrant.id,
      reviewer.id,
      collectedAt.toISOString(),
    ]) {
      expect(pub.body).not.toContain(hidden);
    }

    // The deadline is fixed: a later change of the window leaves it (#173 item 5).
    await setWindow(30);
    expect((await marketRow(market.id)).disputeDeadline!.toISOString()).toBe(
      answer.disputeDeadline,
    );
    // Published once: no second approval, and no registration on a PROVISIONAL market.
    expectNotAllowed(await approve(market.id, requestId, third), 'decided');
    expectRefused(await register(market.id, third), 'status', 'not closed');
    expect((await queue()).json<QueuePage>().data).toEqual([]);
  });

  it('publishes a VOID with no source and its reason the same way (#173 item 9)', async () => {
    const market = await closed();
    const voidReason = '사건이 규칙의 출처 밖에서만 확인된다.';
    const res = await register(market.id, registrant, {
      result: 'VOID',
      source: null,
      voidReason,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(detail(res).judgement.pending).toMatchObject({
      result: 'VOID',
      source: null,
      voidReason,
      fallbackReason: null,
    });
    const approved = await approve(market.id, await pendingId(market.id));
    expect(approved.statusCode, approved.body).toBe(200);
    expect(detail(approved)).toMatchObject({ status: 'provisional', resolvedResult: 'VOID' });
    expect(detail(approved).judgement.current).toMatchObject({
      result: 'VOID',
      source: null,
      voidReason,
      eventDeadlineConfirmed: false,
    });
    expect((await judgementsFor(market.id))[0]).toMatchObject({
      sourcePriority: null,
      sourceName: null,
      sourceUrl: null,
      voidReason,
    });
    expect(data<Market>(await publicDetail(market.id))).toMatchObject({
      status: 'provisional',
      resolvedResult: 'VOID',
    });
  });

  it('asks the approver to confirm the event deadline before the scheduled judgement, and nobody after it or on a market with none', async () => {
    // Before the scheduled judgement (decision 3 '등록 시점'): the reviewer confirms the NO
    // condition's event deadline, or the approval is refused — nothing decided.
    const early = await closedEarly();
    expect((await register(early.id, registrant, { result: 'NO' })).statusCode).toBe(200);
    const requestId = await pendingId(early.id);
    expectRefused(
      await approve(early.id, requestId, reviewer, { eventDeadlineConfirmed: false }),
      'eventDeadlineConfirmed',
      'required',
    );
    const [request] = await requestsFor(early.id);
    expect(request).toMatchObject({ status: 'pending', decidedBy: null });
    expect((await marketRow(early.id)).status).toBe('closed');
    expect(await judgementActionsFor(early.id)).toHaveLength(1);
    // The body's own: a boolean, always sent.
    for (const eventDeadlineConfirmed of [undefined, 'yes']) {
      const res = await approve(early.id, requestId, reviewer, { eventDeadlineConfirmed });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([
        ['eventDeadlineConfirmed'],
      ]);
    }
    const confirmed = await approve(early.id, requestId, reviewer, {
      eventDeadlineConfirmed: true,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(detail(confirmed).judgement.current).toMatchObject({
      result: 'NO',
      eventDeadlineConfirmed: true,
    });
    // After it, nothing is asked, and a confirmation sent anyway is not recorded as one.
    const late = await closed();
    expect((await register(late.id)).statusCode).toBe(200);
    const lateJudged = await approve(late.id, await pendingId(late.id), reviewer, {
      eventDeadlineConfirmed: true,
    });
    expect(lateJudged.statusCode, lateJudged.body).toBe(200);
    expect(detail(lateJudged).judgement.current!.eventDeadlineConfirmed).toBe(false);
    expect((await judgementActionsFor(late.id)).at(-1)?.payload).toMatchObject({
      eventDeadlineConfirmed: false,
    });
    // A market opened before #22 has no scheduled judgement: never before it.
    const old = await closed({ blankTimes: true });
    expect((await register(old.id)).statusCode).toBe(200);
    expect((await approve(old.id, await pendingId(old.id))).statusCode).toBe(200);
  });

  it('refuses an approval of an unknown registration, one no longer waiting, by its registrant; then on a market no longer closed and while the window is undecided', async () => {
    const market = await closed();
    expect((await register(market.id)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    // No registration of this market by that id: none, or another market's.
    const other = await closed();
    expect((await register(other.id, third)).statusCode).toBe(200);
    for (const id of [NO_REQUEST, await pendingId(other.id)]) {
      expectRefused(await approve(market.id, id), 'requestId', 'unknown');
      expectRefused(await reject(market.id, id), 'requestId', 'unknown');
      expectRefused(await retract(market.id, id), 'requestId', 'unknown');
    }
    // The registrant decides nothing of that judgement (decision 3 '역할').
    expectNotAllowed(await approve(market.id, requestId, registrant), 'requester');
    expectNotAllowed(await reject(market.id, requestId, registrant), 'requester');
    // The window undecided since the registration: no deadline can be fixed.
    await setWindow(null);
    expectRefused(await approve(market.id, requestId), 'disputeWindow', 'undecided');
    expect((await requestsFor(market.id))[0]!.status).toBe('pending');
    expect((await marketRow(market.id)).status).toBe('closed');
    await setWindow(1_440);
    // Retracted, it decides nothing.
    expect((await retract(market.id, requestId)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, requestId), 'retracted');
    expectNotAllowed(await reject(market.id, requestId), 'retracted');

    // A registration left waiting on a market no longer CLOSED — the routes leave none (one waits
    // at a time, and only its approval moves CLOSED), so the factory writes it: the approval is
    // refused, and a 반려 ends it in any status.
    const moved = await createMarket(t.db, {
      createdBy: registrant.id,
      categoryId: category.id,
      status: 'provisional',
    });
    const stale = await createJudgementRequest(t.db, { marketId: moved.id, by: third.id });
    expectRefused(await approve(moved.id, stale.id), 'status', 'not closed');
    const rejected = await reject(moved.id, stale.id);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(detail(rejected)).toMatchObject({ status: 'provisional', judgement: { pending: null } });

    // A rule version moved since the registration is a broken invariant (nothing moves it after
    // the close): INTERNAL, nothing written.
    const drifted = await closed();
    const broken = await createJudgementRequest(t.db, {
      marketId: drifted.id,
      by: third.id,
      ruleVersion: 7,
    });
    const res = await approve(drifted.id, broken.id);
    expect({ status: res.statusCode, code: errorOf(res).code }).toEqual({
      status: 500,
      code: 'INTERNAL',
    });
    expect((await requestsFor(drifted.id))[0]!.status).toBe('pending');
    expect(await marketRow(drifted.id)).toMatchObject({ status: 'closed', resolvedResult: null });
    expect(await eventsFor(drifted.id)).toEqual([]);
    expect(await jobIds()).toEqual([]);
  });

  // --- 반려 and 철회 -----------------------------------------------------------------------------
  it('rejects by another admin and retracts by the registrant, writing the record alone; the market stays CLOSED and is registered again by any admin', async () => {
    const market = await closed();
    expect((await register(market.id)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    const before = await marketRow(market.id);
    await listening(market.id, async (received) => {
      expect((await reject(market.id, requestId, reviewer, { reason: ' ' })).statusCode).toBe(400);
      const res = await reject(market.id, requestId, reviewer, {
        reason: ' 증거 링크가 결과를 보이지 않는다 ',
      });
      expect(res.statusCode, res.body).toBe(200);
      const [request] = await requestsFor(market.id);
      expect(request).toMatchObject({ status: 'rejected', decidedBy: reviewer.id });
      expect(detail(res)).toMatchObject({ status: 'closed', resolvedResult: null });
      expect(detail(res).judgement).toMatchObject({
        current: null,
        pending: null,
        log: [
          expect.objectContaining({
            requestId,
            status: 'rejected',
            decidedBy: await actorOf(reviewer),
            decidedAt: request!.decidedAt!.toISOString(),
            decisionReason: '증거 링크가 결과를 보이지 않는다',
            retractedAt: null,
            version: null,
          }),
        ],
      });
      expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: reviewer.id,
        type: 'market_judgement_reject',
        createdAt: request!.decidedAt,
        payload: {
          approvalId: requestId,
          result: 'YES',
          reason: '증거 링크가 결과를 보이지 않는다',
        },
      });
      // A first judgement's ends nothing else: no dispute to reopen (decision 10-23).
      expect((await judgementActionsFor(market.id)).at(-1)!.payload).not.toHaveProperty(
        'reopenedDisputeIds',
      );
      expect(await marketRow(market.id)).toEqual(before);
      await sleep(100);
      expect(received).toEqual([]);
    });
    expectNotAllowed(await approve(market.id, requestId, third), 'decided');

    // Registered again (#173 item 1) — by the admin who rejected it (Q11: only a judgement's
    // registrant is barred, from that judgement) — and retracted by them before anyone decides.
    expect((await register(market.id, reviewer, { result: 'NO' })).statusCode).toBe(200);
    const second = await pendingId(market.id);
    expectNotAllowed(await retract(market.id, second, registrant), 'not_requester');
    const retracted = await retract(market.id, second, reviewer);
    expect(retracted.statusCode, retracted.body).toBe(200);
    const [, secondRow] = await requestsFor(market.id);
    expect(secondRow).toMatchObject({ status: 'retracted', decidedBy: null });
    expect(detail(retracted).judgement).toMatchObject({
      pending: null,
      log: [
        expect.objectContaining({
          requestId: second,
          result: 'NO',
          status: 'retracted',
          retractedAt: secondRow!.retractedAt!.toISOString(),
        }),
        expect.objectContaining({ requestId, status: 'rejected' }),
      ],
    });
    expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
      adminId: reviewer.id,
      type: 'market_judgement_retract',
      createdAt: secondRow!.retractedAt,
      payload: { approvalId: second, result: 'NO' },
    });
    expect((await judgementActionsFor(market.id)).at(-1)!.payload).not.toHaveProperty(
      'reopenedDisputeIds',
    );
    expectNotAllowed(await retract(market.id, second, reviewer), 'retracted');

    // A third registration, by the reviewer again: the first one's registrant may approve it.
    expect((await register(market.id, reviewer)).statusCode).toBe(200);
    const approved = await approve(market.id, await pendingId(market.id), registrant);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(detail(approved).judgement.current).toMatchObject({
      version: 1,
      registeredBy: await actorOf(reviewer),
      approvedBy: await actorOf(registrant),
    });
    expect((await judgementActionsFor(market.id)).map((action) => action.type)).toEqual([
      'market_judgement_request',
      'market_judgement_reject',
      'market_judgement_request',
      'market_judgement_retract',
      'market_judgement_request',
      'market_judgement_approve',
    ]);
    expect((await eventsFor(market.id)).map((event) => event.type)).toEqual(['provisional']);
  });

  // --- 판정 정정 (#176) ---------------------------------------------------------------------------
  /**
   * A PROVISIONAL market as the routes leave it (#176's corrections): `closed()`'s market — its
   * scheduled judgement passed, so no approval asks for a confirmation — judged v1, a YES on the
   * primary source registered by `registrant` and approved by `reviewer` at `publishedAt` (default
   * now) with a 90-minute window, unless told.
   */
  async function provisional(input: Parameters<typeof createProvisionalMarket>[1] = {}) {
    const market = await closed();
    return createProvisionalMarket(t.db, {
      marketId: market.id,
      registeredBy: registrant.id,
      approvedBy: reviewer.id,
      disputeWindowMinutes: 90,
      ...input,
    });
  }
  /** 판정 정정 of version 1 by `third` unless told: NO on the primary source, with its reason. */
  const correct = (id: string, who: TestUser = third, payload: Record<string, unknown> = {}) =>
    register(id, who, {
      result: 'NO',
      correction: { baseVersion: 1, reason: CORRECTION },
      ...payload,
    });
  /** A member who finished the onboarding, with a fill on `marketId` (none by #119's path). */
  async function memberWithFill(marketId: string): Promise<TestUser> {
    const member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
    await createFill(t.db, { marketId, userId: member.id, amountCoin: 50n });
    return member;
  }
  /** The member's 판정 이의 of version 1 unless told (#175's route). */
  const dispute = (marketId: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    post(`/api/v1/markets/${marketId}/disputes`, who, {
      judgementVersion: 1,
      links: [LINK],
      reason: DISPUTE_REASON,
      ...payload,
    });
  /** 수용 of a dispute by `who` (#175's route). */
  const accept = (marketId: string, disputeId: string, who: TestUser = third) =>
    post(`${marketUrl(marketId)}/disputes/${disputeId}/accept`, who, { reason: ACCEPTANCE });
  /** The market's disputes, the oldest submission first. */
  async function disputesFor(marketId: string) {
    return t.db
      .select()
      .from(schema.marketDisputes)
      .where(eq(schema.marketDisputes.marketId, marketId))
      .orderBy(asc(schema.marketDisputes.submittedAt), asc(schema.marketDisputes.id));
  }
  /** The three display flags of a public read. */
  const flagsOf = (market: Market) => ({
    disputeOpen: market.disputeOpen,
    disputeUnderReview: market.disputeUnderReview,
    judgementDelayed: market.judgementDelayed,
  });

  it('registers a provisional market’s correction against its current version: the accepted disputes it answers listed by the server, the mirror set, the status republished unchanged — nothing else moves', async () => {
    const { market } = await provisional();
    const primary = await primaryOf(market.id);
    // v1's disputes: two accepted by an admin who did not register v1, one pending, one dismissed.
    const { dispute: older } = await createDispute(t.db, {
      marketId: market.id,
      status: 'accepted',
      decidedBy: third.id,
    });
    const { dispute: newer } = await createDispute(t.db, {
      marketId: market.id,
      status: 'accepted',
      decidedBy: third.id,
    });
    const { dispute: waiting } = await createDispute(t.db, { marketId: market.id });
    await createDispute(t.db, { marketId: market.id, status: 'dismissed', decidedBy: third.id });
    const before = await marketRow(market.id);
    const eventsBefore = await eventsFor(market.id);
    await listening(market.id, async (received) => {
      // The reason trimmed; a client's `disputeIds` are none of its business (stripped).
      const res = await correct(market.id, third, {
        correction: { baseVersion: 1, reason: ` ${CORRECTION} `, disputeIds: [waiting.id] },
      });
      expect(res.statusCode, res.body).toBe(200);
      const answer = detail(res);
      const [, request] = await requestsFor(market.id);
      const correction = { baseVersion: 1, reason: CORRECTION, disputeIds: [older.id, newer.id] };
      const payload = {
        result: 'NO',
        source: primary,
        fallbackReason: null,
        voidReason: null,
        evidence: { links: [LINK], collectedAt: expect.any(String) as unknown },
        ruleVersion: before.ruleVersion,
        correction,
      };
      expect(request).toMatchObject({
        kind: MARKET_JUDGEMENT_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        payload,
        requestedBy: third.id,
        requestReason: DESCRIPTION,
        status: 'pending',
      });
      expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: third.id,
        type: 'market_judgement_request',
        createdAt: request!.requestedAt,
        payload: { approvalId: request!.id, ...payload, description: DESCRIPTION },
      });
      // The mirror the labels read, at the registration's instant; nothing else of the market.
      expect(await marketRow(market.id)).toEqual({
        ...before,
        correctionPending: true,
        updatedAt: request!.requestedAt,
      });
      expect(await eventsFor(market.id)).toEqual(eventsBefore);
      expect(await judgementsFor(market.id)).toHaveLength(1);
      expect(answer).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        judgementVersion: 1,
        updatedAt: request!.requestedAt.toISOString(),
      });
      expect(answer.judgement.pending).toEqual({
        requestId: request!.id,
        ...payload,
        evidence: (request!.payload as { evidence: unknown }).evidence,
        description: DESCRIPTION,
        requestedBy: await actorOf(third),
        requestedAt: request!.requestedAt.toISOString(),
      });
      expect(answer.judgement.log.map((entry) => [entry.status, entry.correction])).toEqual([
        ['pending', correction],
        ['approved', null],
      ]);
      expect(answer.judgement.current).toMatchObject({ version: 1, correctionReason: null });
      expect(answer.judgement.history).toEqual([]);
      // Republished once, the status and its key unchanged: an open detail refetches its labels.
      await waitForMessages(received, 1, 'market:status of the registration');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'provisional',
          resolvedResult: 'YES',
          statusEventId: String(before.statusEventId),
          ts: request!.requestedAt.toISOString(),
        },
      ]);
    });
    expect(await jobIds()).toEqual([]);
    // The 판정 승인 대기 queue marks it a correction.
    expect((await queue()).json<QueuePage>().data).toEqual([
      expect.objectContaining({
        marketId: market.id,
        status: 'provisional',
        result: 'NO',
        correction: { baseVersion: 1, reason: CORRECTION, disputeIds: [older.id, newer.id] },
        requestedBy: await actorOf(third),
      }),
    ]);
    // Nothing of it is public (#24, #173 item 13): its deadline ahead, the market reads as before.
    const pub = await publicDetail(market.id);
    expect(data<Market>(pub)).toMatchObject({
      resolvedResult: 'YES',
      judgementVersion: 1,
      disputeOpen: true,
      judgementDelayed: false,
    });
    for (const hidden of [CORRECTION, DESCRIPTION, LINK, third.id]) {
      expect(pub.body).not.toContain(hidden);
    }
  });

  it('refuses a correction for its body and, in order, off PROVISIONAL, against another version, while one waits, with no decider, changing nothing, an unknown source, YES or NO after 판정 불가 and evidence after now — reading no setting', async () => {
    const { market, judgement: v1 } = await provisional();
    // The body's own: a version and a reason of 1..500 characters.
    for (const [correction, path] of [
      [{ baseVersion: 0, reason: CORRECTION }, ['correction', 'baseVersion']],
      [{ reason: CORRECTION }, ['correction', 'baseVersion']],
      [{ baseVersion: 1 }, ['correction', 'reason']],
      [{ baseVersion: 1, reason: '   ' }, ['correction', 'reason']],
      [{ baseVersion: 1, reason: 'x'.repeat(501) }, ['correction', 'reason']],
    ] as const) {
      const res = await correct(market.id, third, { correction });
      expect({ correction, status: res.statusCode }).toEqual({ correction, status: 400 });
      expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([path]);
    }
    // Not PROVISIONAL — CLOSED, or confirmed (#173 item 8: #144's) — before the version; and a
    // first judgement of a PROVISIONAL market is still refused as not closed.
    const unjudged = await closed();
    expectRefused(
      await correct(unjudged.id, third, { correction: { baseVersion: 3, reason: CORRECTION } }),
      'status',
      'not provisional',
    );
    const { market: confirmed } = await provisional({
      publishedAt: new Date(Date.now() - 2 * HOUR_MS),
    });
    await resolveMarketNow(t.db, confirmed.id);
    expectRefused(await correct(confirmed.id), 'status', 'not provisional');
    expectRefused(await register(market.id, third), 'status', 'not closed');
    // Against a version the market is not at, before one waiting; then one waits at a time.
    expect((await correct(market.id, reviewer)).statusCode).toBe(200);
    expectRefused(
      await correct(market.id, third, { correction: { baseVersion: 2, reason: CORRECTION } }),
      ['correction', 'baseVersion'],
      'stale',
    );
    expectRefused(await correct(market.id, third), 'judgement', 'pending');
    expect((await retract(market.id, await pendingId(market.id), reviewer)).statusCode).toBe(200);

    // v1's result and grounds exactly, as the body would send them again.
    const unchanged = {
      result: v1.result,
      source: { priority: v1.sourcePriority },
      evidence: { links: v1.evidenceLinks, collectedAt: v1.collectedAt.toISOString() },
      description: v1.evidenceDescription,
    };
    // No admin but the registrant to approve it — before anything about the correction itself.
    const demoted = await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(and(ne(schema.profiles.userId, third.id), eq(schema.profiles.role, 'admin')))
      .returning({ userId: schema.profiles.userId });
    expectNotAllowed(await correct(market.id, third, unchanged), 'no_decider');
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(
        inArray(
          schema.profiles.userId,
          demoted.map((row) => row.userId),
        ),
      );
    // No setting is read: a correction's deadline takes v1's length (#173 item 5).
    await setWindow(null);
    // Nothing to change — a dismissal's, not a correction's (#173 item 7): the texts compared
    // trimmed, the instant by its moment.
    expectRefused(await correct(market.id, third, unchanged), 'correction', 'unchanged');
    expectRefused(
      await correct(market.id, third, {
        ...unchanged,
        evidence: { links: [` ${v1.evidenceLinks[0]!} `], collectedAt: iso(+v1.collectedAt) },
        description: ` ${v1.evidenceDescription} `,
      }),
      'correction',
      'unchanged',
    );
    // The result kept with new grounds is a correction (#173 item 7 '결과나 근거').
    const regrounded = await correct(market.id, third, {
      ...unchanged,
      description: '1차 출처의 정정 공지를 다시 확인했다.',
    });
    expect(regrounded.statusCode, regrounded.body).toBe(200);
    expect(detail(regrounded).judgement.disputeWindowUndecided).toBe(true);
    expect((await retract(market.id, await pendingId(market.id), third)).statusCode).toBe(200);
    await setWindow(1_440);
    // A source the rules do not have; evidence collected after now.
    expectRefused(
      await correct(market.id, third, {
        source: { priority: 3 },
        fallbackReason: '1차 출처가 없다',
      }),
      'source',
      'unknown',
    );
    expectRefused(
      await correct(market.id, third, {
        evidence: { links: [LINK], collectedAt: iso(Date.now() + 10 * MINUTE_MS) },
      }),
      ['evidence', 'collectedAt'],
      'after now',
    );
    // A market closed early as 판정 불가 is corrected to VOID alone, as its first judgement was
    // (ADR-0102 binds the market, not the version) — before the evidence's instant.
    const voidOnly = await closedEarly('not_judgeable');
    await createProvisionalMarket(t.db, {
      marketId: voidOnly.id,
      result: 'VOID',
      registeredBy: registrant.id,
      approvedBy: reviewer.id,
    });
    expectRefused(
      await correct(voidOnly.id, third, {
        result: 'YES',
        evidence: { links: [LINK], collectedAt: iso(Date.now() + HOUR_MS) },
      }),
      'result',
      'void only',
    );
    const voided = await correct(voidOnly.id, third, {
      result: 'VOID',
      source: null,
      voidReason: '정정 검토에서도 판정 불가로 보았다.',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    // A refusal writes nothing: the two retracted above and the waiting VOID alone.
    expect((await requestsFor(market.id)).map((row) => row.status)).toEqual([
      'approved',
      'retracted',
      'retracted',
    ]);
    expect((await marketRow(market.id)).correctionPending).toBe(false);
    expect(await requestsFor(unjudged.id)).toEqual([]);
    expect(await requestsFor(confirmed.id)).toHaveLength(1);
  });

  it('approves a correction by another admin: the next version with the new result and a deadline of v1’s length from the approval, v1’s pending disputes closed and its accepted one answered, the record, the status under the new key, a new resolve job beside v1’s; a second correction’s v3 with the history the newest first', async () => {
    // v1 through the routes, so its resolve job waits for its deadline.
    const market = await closed();
    await setWindow(90);
    expect((await register(market.id)).statusCode).toBe(200);
    expect((await approve(market.id, await pendingId(market.id))).statusCode).toBe(200);
    const [v1] = await judgementsFor(market.id);
    const v1Job = marketResolveJobId(market.id, v1!.disputeDeadline);
    // v1's disputes: one accepted through the route (a correction follows, #173 item 7), one
    // pending, one retracted.
    const { dispute: accepted } = await createDispute(t.db, { marketId: market.id });
    expect((await accept(market.id, accepted.id, reviewer)).statusCode).toBe(200);
    const { dispute: waiting } = await createDispute(t.db, { marketId: market.id });
    const { dispute: gone } = await createDispute(t.db, {
      marketId: market.id,
      status: 'retracted',
    });
    expect((await marketRow(market.id)).disputeHoldCount).toBe(2);
    // The window changed since: a correction reads none of it (#173 item 5 '첫 기한과 같은 길이').
    await setWindow(30);
    const grounds = '정정된 발표 원문을 확인했다.';
    expect((await correct(market.id, third, { description: grounds })).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    // Its registrant decides nothing of it; v1's registrant may (#173 item 2).
    expectNotAllowed(await approve(market.id, requestId, third), 'requester');
    const eventsBefore = await eventsFor(market.id);
    let answer!: AdminMarket;
    await listening(market.id, async (received) => {
      const res = await approve(market.id, requestId, registrant);
      expect(res.statusCode, res.body).toBe(200);
      answer = detail(res);
      await waitForMessages(received, 1, 'market:status of the correction');
      await sleep(100);
      const request = (await requestsFor(market.id)).find((row) => row.id === requestId)!;
      expect(request).toMatchObject({ status: 'approved', decidedBy: registrant.id });
      const at = request.decidedAt!;
      const deadline = new Date(at.getTime() + 90 * MINUTE_MS);
      // The approver's `judgement_corrected` event: no status on either side (ADR-0095 결정 4).
      const events = await eventsFor(market.id);
      expect(events).toHaveLength(eventsBefore.length + 1);
      const event = events.at(-1)!;
      expect(event).toMatchObject({
        type: 'judgement_corrected',
        actorId: registrant.id,
        fromStatus: null,
        toStatus: null,
        createdAt: at,
        payload: {
          version: 2,
          previousVersion: 1,
          result: 'NO',
          previousResult: 'YES',
          approvalId: requestId,
          requestedBy: third.id,
          disputeDeadline: deadline.toISOString(),
          closedDisputes: 1,
        },
      });
      // Still PROVISIONAL, the new result, version and deadline, the mirrors reset, its key the
      // correction's event.
      expect(await marketRow(market.id)).toMatchObject({
        status: 'provisional',
        resolvedResult: 'NO',
        resolvedAt: null,
        judgementVersion: 2,
        disputeDeadline: deadline,
        disputeHoldCount: 0,
        correctionPending: false,
        statusEventId: event.id,
        updatedAt: at,
      });
      // v1 kept as it was published (#173 item 13); v2 with v1's window from the approval.
      const [kept, v2] = await judgementsFor(market.id);
      expect(kept).toEqual(v1);
      expect(v2).toMatchObject({
        version: 2,
        result: 'NO',
        sourcePriority: 0,
        evidenceLinks: [LINK],
        evidenceDescription: grounds,
        correctionReason: CORRECTION,
        eventDeadlineConfirmed: false,
        disputeWindowMinutes: 90,
        publishedAt: at,
        disputeDeadline: deadline,
        approvalId: requestId,
        registeredBy: third.id,
        approvedBy: registrant.id,
        provisionalEventId: event.id,
      });
      // v1's pending dispute 정정으로 종결 at the approval (#173 item 8); the accepted one stays
      // accepted — answered — and the retracted one as it was.
      expect(
        (await disputesFor(market.id)).map(({ id, status, closedAt, decidedBy }) => ({
          id,
          status,
          closedAt,
          decidedBy,
        })),
      ).toEqual([
        { id: accepted.id, status: 'accepted', closedAt: null, decidedBy: reviewer.id },
        { id: waiting.id, status: 'closed_by_correction', closedAt: at, decidedBy: null },
        { id: gone.id, status: 'retracted', closedAt: null, decidedBy: null },
      ]);
      expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: registrant.id,
        type: 'market_judgement_approve',
        createdAt: at,
        payload: {
          approvalId: requestId,
          version: 2,
          result: 'NO',
          reason: APPROVAL,
          eventDeadlineConfirmed: false,
          disputeWindowMinutes: 90,
          disputeDeadline: deadline.toISOString(),
          previous: {
            version: 1,
            result: 'YES',
            disputeDeadline: v1!.disputeDeadline.toISOString(),
          },
          correction: { baseVersion: 1, reason: CORRECTION, disputeIds: [accepted.id] },
          closedDisputeIds: [waiting.id],
          before: { status: 'provisional' },
          after: { status: 'provisional' },
        },
      });
      // The answer: v2 current, v1 in the history, v2's disputes (none yet).
      expect(answer).toMatchObject({
        status: 'provisional',
        resolvedResult: 'NO',
        judgementVersion: 2,
        disputeDeadline: deadline.toISOString(),
        statusEventId: String(event.id),
        updatedAt: at.toISOString(),
        disputes: { holding: 0, items: [] },
      });
      expect(answer.events[0]).toMatchObject({ type: 'judgement_corrected' });
      expect(answer.judgement.current).toMatchObject({
        version: 2,
        result: 'NO',
        correctionReason: CORRECTION,
        disputeWindowMinutes: 90,
        publishedAt: at.toISOString(),
        disputeDeadline: deadline.toISOString(),
        registeredBy: await actorOf(third),
        approvedBy: await actorOf(registrant),
      });
      expect(answer.judgement.history).toEqual([
        expect.objectContaining({
          version: 1,
          result: 'YES',
          correctionReason: null,
          disputeWindowMinutes: 90,
          disputeDeadline: v1!.disputeDeadline.toISOString(),
          registeredBy: await actorOf(registrant),
          approvedBy: await actorOf(reviewer),
        }),
      ]);
      expect(answer.judgement.pending).toBeNull();
      expect(answer.judgement.log[0]).toMatchObject({
        requestId,
        status: 'approved',
        version: 2,
        correction: { baseVersion: 1, reason: CORRECTION, disputeIds: [accepted.id] },
      });
      // Published once after COMMIT: the new result under the newer key, so a late snapshot of
      // v1 cannot roll it back.
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'provisional',
          resolvedResult: 'NO',
          statusEventId: String(event.id),
          ts: at.toISOString(),
        },
      ]);
      // The worker confirms v2 at its deadline; v1's job stays — it finds the later deadline and
      // skips (`not_due`): nothing is cancelled.
      const v2Job = marketResolveJobId(market.id, deadline);
      expect(await jobIds()).toEqual([v1Job, v2Job].sort());
      expect(await jobQueue.getJob(v2Job)).toMatchObject({
        name: JOB_NAMES.marketResolve,
        data: { marketId: market.id },
        delay: 90 * MINUTE_MS,
      });
    });
    // The public detail: the new result, version and deadline, disputes taken again — nothing of
    // the correction itself (#24, #173 item 13).
    const pub = await publicDetail(market.slug);
    expect(data<Market>(pub)).toMatchObject({
      status: 'provisional',
      resolvedResult: 'NO',
      statusEventId: answer.statusEventId,
      judgementVersion: 2,
      disputeDeadline: answer.disputeDeadline,
      disputeOpen: true,
      disputeUnderReview: false,
      judgementDelayed: false,
    });
    for (const hidden of [CORRECTION, grounds, third.id, registrant.id]) {
      expect(pub.body).not.toContain(hidden);
    }
    // Decided once; v1 is no longer the one to correct, v2 is.
    expectNotAllowed(await approve(market.id, requestId, reviewer), 'decided');
    expectRefused(await correct(market.id, reviewer), ['correction', 'baseVersion'], 'stale');
    const next = await correct(market.id, reviewer, {
      result: 'YES',
      correction: { baseVersion: 2, reason: CORRECTION },
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(detail(next).judgement.pending?.correction).toEqual({
      baseVersion: 2,
      reason: CORRECTION,
      disputeIds: [],
    });
    // Approved: v3 current, still at v1's length, and the history the newest first.
    const v3 = await approve(market.id, await pendingId(market.id), third);
    expect(v3.statusCode, v3.body).toBe(200);
    expect(detail(v3).judgement.current).toMatchObject({
      version: 3,
      result: 'YES',
      disputeWindowMinutes: 90,
    });
    expect(detail(v3).judgement.history.map((entry) => entry.version)).toEqual([2, 1]);
  });

  it('refuses a correction’s approval by its registrant, off PROVISIONAL, against another version (before the confirmation is asked) and before the scheduled judgement without the confirmation; approves one confirmed with the window undecided, at the base version’s length', async () => {
    const { market } = await provisional();
    expect((await correct(market.id)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, await pendingId(market.id), third), 'requester');
    // Requests the routes leave none of, so the factory writes them: one waiting on a CLOSED
    // market, and one against a version the market is not at — each refused, and a 반려 ends it.
    const unjudged = await closed();
    const off = await createJudgementRequest(t.db, {
      marketId: unjudged.id,
      by: third.id,
      correction: { baseVersion: 1 },
    });
    expectRefused(await approve(unjudged.id, off.id), 'status', 'not provisional');
    const ended = await reject(unjudged.id, off.id);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(detail(ended)).toMatchObject({ status: 'closed', judgement: { pending: null } });
    const { market: other } = await provisional();
    const ahead = await createJudgementRequest(t.db, {
      marketId: other.id,
      by: third.id,
      result: 'NO',
      correction: { baseVersion: 2 },
    });
    expectRefused(await approve(other.id, ahead.id), ['correction', 'baseVersion'], 'stale');
    expect((await requestsFor(other.id)).at(-1)!.status).toBe('pending');
    expect(await judgementsFor(other.id)).toHaveLength(1);
    expect((await eventsFor(other.id)).map((event) => event.type)).toEqual(['provisional']);
    // Before the scheduled judgement the approver confirms the NO condition's event deadline, a
    // correction's approval too (decision 3 '등록 시점') — asked after the base version: a stale
    // one unconfirmed is 'stale'.
    const { market: early } = await createProvisionalMarket(t.db, {
      registeredBy: registrant.id,
      approvedBy: reviewer.id,
      disputeWindowMinutes: 45,
      market: { createdBy: registrant.id, categoryId: category.id },
    });
    const staleEarly = await createJudgementRequest(t.db, {
      marketId: early.id,
      by: third.id,
      result: 'NO',
      correction: { baseVersion: 2 },
    });
    expectRefused(await approve(early.id, staleEarly.id), ['correction', 'baseVersion'], 'stale');
    expect((await reject(early.id, staleEarly.id)).statusCode).toBe(200);
    expect((await correct(early.id)).statusCode).toBe(200);
    const earlyId = await pendingId(early.id);
    expectRefused(await approve(early.id, earlyId), 'eventDeadlineConfirmed', 'required');
    expect(await marketRow(early.id)).toMatchObject({
      judgementVersion: 1,
      correctionPending: true,
    });
    // Confirmed while the window is undecided: a correction reads no setting, its deadline of
    // the base version's length from the approval (decision 10-5).
    await setWindow(null);
    const confirmed = await approve(early.id, earlyId, reviewer, { eventDeadlineConfirmed: true });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const decidedAt = (await requestsFor(early.id)).find((row) => row.id === earlyId)!.decidedAt!;
    expect(detail(confirmed).judgement.current).toMatchObject({
      version: 2,
      eventDeadlineConfirmed: true,
      disputeWindowMinutes: 45,
      disputeDeadline: iso(decidedAt.getTime() + 45 * MINUTE_MS),
    });
    await setWindow(1_440);
  });

  it('rejects a correction: the version, its deadline and its disputes’ results carry on, the accepted dispute it answered back to pending — one accepted since stays — the mirror cleared, the status republished; the reopened one is decided again', async () => {
    const { market } = await provisional();
    const v1Deadline = market.disputeDeadline!;
    const { dispute: answered } = await createDispute(t.db, { marketId: market.id });
    expect((await accept(market.id, answered.id)).statusCode).toBe(200);
    expect((await correct(market.id, reviewer)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    // A dispute accepted after the registration: not one this correction answers.
    const { dispute: later } = await createDispute(t.db, { marketId: market.id });
    expect((await accept(market.id, later.id)).statusCode).toBe(200);
    const before = await marketRow(market.id);
    expect(before).toMatchObject({ disputeHoldCount: 2, correctionPending: true });
    const eventsBefore = await eventsFor(market.id);
    await listening(market.id, async (received) => {
      const res = await reject(market.id, requestId, third, { reason: ' 정정할 근거가 부족하다 ' });
      expect(res.statusCode, res.body).toBe(200);
      const request = (await requestsFor(market.id)).find((row) => row.id === requestId)!;
      expect(request).toMatchObject({ status: 'rejected', decidedBy: third.id });
      const at = request.decidedAt!;
      // Back to pending, the decision cleared and the submission kept (owner answer 2026-11-02).
      const rows = await disputesFor(market.id);
      expect(
        rows.map(({ id, status, decidedBy, decisionReason }) => [
          id,
          status,
          decidedBy,
          decisionReason,
        ]),
      ).toEqual([
        [answered.id, 'pending', null, null],
        [later.id, 'accepted', third.id, ACCEPTANCE],
      ]);
      expect(rows[0]).toMatchObject({ submittedAt: answered.submittedAt, decidedAt: null });
      // Both statuses hold: the mirror kept; the correction's cleared at the decision's instant.
      expect(await marketRow(market.id)).toEqual({
        ...before,
        correctionPending: false,
        updatedAt: at,
      });
      expect(await eventsFor(market.id)).toEqual(eventsBefore);
      expect(await judgementsFor(market.id)).toHaveLength(1);
      expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: third.id,
        type: 'market_judgement_reject',
        createdAt: at,
        payload: {
          approvalId: requestId,
          result: 'NO',
          reason: '정정할 근거가 부족하다',
          reopenedDisputeIds: [answered.id],
        },
      });
      const answer = detail(res);
      expect(answer).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        judgementVersion: 1,
        disputeDeadline: v1Deadline.toISOString(),
        judgement: { pending: null, current: { version: 1 }, history: [] },
      });
      expect(answer.disputes).toMatchObject({
        holding: 2,
        items: [
          { id: answered.id, status: 'pending', decidedBy: null },
          { id: later.id, status: 'accepted' },
        ],
      });
      // Republished once, unchanged: an open detail refetches its labels and disputes.
      await waitForMessages(received, 1, 'market:status of the rejection');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'provisional',
          resolvedResult: 'YES',
          statusEventId: String(before.statusEventId),
          ts: at.toISOString(),
        },
      ]);
    });
    // The deadline ahead: nothing registered (v1's own job confirms it then).
    expect(await jobIds()).toEqual([]);
    // Pending again, it is decided again by an admin who did not register v1 — dismissed here.
    const dismissed = await post(`${marketUrl(market.id)}/disputes/${answered.id}/dismiss`, third, {
      reason: '정정 반려 뒤 다시 보니 판정과 같다.',
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(detail(dismissed).disputes.holding).toBe(1);
    expect((await marketRow(market.id)).disputeHoldCount).toBe(1);
  });

  it('retracts a correction as a rejection ends one: its accepted dispute back to pending and retractable again by its submitter before the deadline', async () => {
    const { market } = await provisional();
    const member = await memberWithFill(market.id);
    const submitted = await dispute(market.id, member);
    expect(submitted.statusCode, submitted.body).toBe(201);
    const disputeId = data<MyDispute>(submitted).id;
    expect((await accept(market.id, disputeId)).statusCode).toBe(200);
    expect((await correct(market.id, reviewer)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    // Accepted, the member cannot take it back.
    expect((await post(`/api/v1/me/disputes/${disputeId}/retract`, member)).statusCode).toBe(409);
    await listening(market.id, async (received) => {
      expectNotAllowed(await retract(market.id, requestId, third), 'not_requester');
      const res = await retract(market.id, requestId, reviewer);
      expect(res.statusCode, res.body).toBe(200);
      const request = (await requestsFor(market.id)).find((row) => row.id === requestId)!;
      expect(request).toMatchObject({ status: 'retracted', decidedBy: null });
      expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: reviewer.id,
        type: 'market_judgement_retract',
        createdAt: request.retractedAt,
        payload: { approvalId: requestId, result: 'NO', reopenedDisputeIds: [disputeId] },
      });
      expect(detail(res).disputes.items).toMatchObject([{ id: disputeId, status: 'pending' }]);
      expect(await marketRow(market.id)).toMatchObject({
        disputeHoldCount: 1,
        correctionPending: false,
        updatedAt: request.retractedAt,
      });
      await waitForMessages(received, 1, 'market:status of the retraction');
      expect(JSON.parse(received[0]!)).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        ts: request.retractedAt!.toISOString(),
      });
    });
    // Pending again before the deadline: its submitter may take it back (#173 item 6).
    const mine = await get('/api/v1/me/disputes', member);
    expect(mine.json<{ data: MyDispute[] }>().data[0]).toMatchObject({
      id: disputeId,
      status: 'pending',
      decidedAt: null,
      decisionReason: null,
      retractable: true,
    });
    const taken = await post(`/api/v1/me/disputes/${disputeId}/retract`, member);
    expect(taken.statusCode, taken.body).toBe(200);
    expect(data<MyDispute>(taken).status).toBe('retracted');
    expect((await marketRow(market.id)).disputeHoldCount).toBe(0);
  });

  it('closes the replaced version’s pending disputes as 정정으로 종결, no longer retractable: their submitters dispute the new version under its new deadline, decided by an admin who did not register it, and MY and 이의 접수 read the closure', async () => {
    const { market } = await provisional();
    const member = await memberWithFill(market.id);
    const first = data<MyDispute>(await dispute(market.id, member));
    expect((await correct(market.id)).statusCode).toBe(200);
    const corrected = await approve(market.id, await pendingId(market.id));
    expect(corrected.statusCode, corrected.body).toBe(200);
    const at = (await requestsFor(market.id)).at(-1)!.decidedAt!;
    // The screen that showed v1 is stale; v2 takes the member's dispute again (#173 item 8).
    expectDisputeNotAllowed(await dispute(market.id, member), 'stale_version');
    const again = await dispute(market.id, member, { judgementVersion: 2 });
    expect(again.statusCode, again.body).toBe(201);
    expect(data<MyDispute>(again)).toMatchObject({
      judgementVersion: 2,
      status: 'pending',
      market: { judgementVersion: 2 },
      retractable: true,
    });
    expect((await marketRow(market.id)).disputeHoldCount).toBe(1);
    // MY: both, the newest first — v1's closed at the approval, its market now at v2.
    const mine = (await get('/api/v1/me/disputes', member)).json<{ data: MyDispute[] }>().data;
    expect(mine.map((row) => row.id)).toEqual([data<MyDispute>(again).id, first.id]);
    expect(mine[1]).toEqual({
      ...first,
      status: 'closed_by_correction',
      closedAt: at.toISOString(),
      market: { ...first.market, judgementVersion: 2 },
      retractable: false,
    });
    // The dispute screen reads the current version alone.
    const standing = await get(`/api/v1/me/disputes/markets/${market.id}`, member);
    expect(data<{ eligibility: string; judgementVersion: number }>(standing)).toMatchObject({
      eligibility: 'duplicate',
      judgementVersion: 2,
    });
    // 이의 접수 처리됨: the closure, by its instant.
    const decided = (await get('/api/v1/admin/market-disputes?status=decided', third)).json<{
      data: AdminDisputeQueueItem[];
    }>().data;
    expect(decided).toEqual([
      expect.objectContaining({
        id: first.id,
        status: 'closed_by_correction',
        closedAt: at.toISOString(),
        decidedBy: null,
        market: expect.objectContaining({ id: market.id, judgementVersion: 2 }) as unknown,
      }),
    ]);
    // Closed, v1's dispute is no longer its submitter's to take back (decision 2 '이의 상태').
    expectDisputeNotAllowed(
      await post(`/api/v1/me/disputes/${first.id}/retract`, member),
      'decided',
    );
    // v2's dispute is decided by an admin who did not register v2 (#175): not the correction's
    // registrant, and v1's may (decision 10-4).
    const dismissV2 = (who: TestUser) =>
      post(`${marketUrl(market.id)}/disputes/${data<MyDispute>(again).id}/dismiss`, who, {
        reason: '정정한 판정의 근거와 같다.',
      });
    expectDisputeNotAllowed(await dismissV2(third), 'registrant');
    const dismissed = await dismissV2(registrant);
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect((await marketRow(market.id)).disputeHoldCount).toBe(0);
  });

  it('holds a market past its deadline while a correction waits — 판정 지연 — and once it is rejected or retracted with nothing else holding, registers the worker’s confirmation at once; not while a dispute still holds it', async () => {
    const publishedAt = new Date((await clockTimestamp(t.db)).getTime() - 2 * HOUR_MS);
    const { market } = await provisional({ publishedAt });
    const deadline = market.disputeDeadline!;
    expect(deadline.getTime()).toBeLessThan(Date.now());
    // Past its deadline with nothing holding: the plain provisional result.
    const quiet = { disputeOpen: false, disputeUnderReview: false, judgementDelayed: false };
    expect(flagsOf(data<Market>(await publicDetail(market.id)))).toEqual(quiet);
    // A correction registered past the deadline (still PROVISIONAL, the worker not there yet)
    // holds it: '판정 지연', with no dispute under review.
    expect((await correct(market.id)).statusCode).toBe(200);
    const delayed = { disputeOpen: false, disputeUnderReview: false, judgementDelayed: true };
    expect(flagsOf(data<Market>(await publicDetail(market.id)))).toEqual(delayed);
    expect(flagsOf(detail(await get(marketUrl(market.id))))).toEqual(delayed);
    // Rejected: nothing holds it now — `market.resolve` under v1's deadline's id, due at once.
    expect((await reject(market.id, await pendingId(market.id))).statusCode).toBe(200);
    const jobId = marketResolveJobId(market.id, deadline);
    expect(await jobIds()).toEqual([jobId]);
    expect(await jobQueue.getJob(jobId)).toMatchObject({
      name: JOB_NAMES.marketResolve,
      data: { marketId: market.id },
      delay: 0,
    });
    expect(flagsOf(data<Market>(await publicDetail(market.id)))).toEqual(quiet);
    // A correction's record names the disputes it reopened, none here (decision 10-23).
    expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
      type: 'market_judgement_reject',
      payload: { reopenedDisputeIds: [] },
    });
    // Retracted the same way.
    await jobQueue.obliterate({ force: true });
    expect((await correct(market.id)).statusCode).toBe(200);
    expect((await retract(market.id, await pendingId(market.id), third)).statusCode).toBe(200);
    expect(await jobIds()).toEqual([jobId]);
    expect((await judgementActionsFor(market.id)).at(-1)).toMatchObject({
      type: 'market_judgement_retract',
      payload: { reopenedDisputeIds: [] },
    });

    // An accepted dispute the correction answered goes back to pending and still holds: nothing
    // registered, the market under review and late.
    await jobQueue.obliterate({ force: true });
    const { market: held } = await provisional({ publishedAt });
    const { dispute: answered } = await createDispute(t.db, {
      marketId: held.id,
      status: 'accepted',
      decidedBy: third.id,
      submittedAt: new Date(held.disputeDeadline!.getTime() - HOUR_MS),
    });
    expect((await correct(held.id, reviewer)).statusCode).toBe(200);
    expect((await reject(held.id, await pendingId(held.id), third)).statusCode).toBe(200);
    expect((await disputesFor(held.id)).map((row) => [row.id, row.status])).toEqual([
      [answered.id, 'pending'],
    ]);
    expect(await jobIds()).toEqual([]);
    expect(flagsOf(data<Market>(await publicDetail(held.id)))).toEqual({
      disputeOpen: false,
      disputeUnderReview: true,
      judgementDelayed: true,
    });
  });

  // --- at once ---------------------------------------------------------------------------------
  it('serialises two writes of one market’s judgement: one registration waits, and one approval publishes', async () => {
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

    const market = await closed();
    const [taken, waiting] = await inTurn(
      market.id,
      () => register(market.id),
      () => register(market.id, third, { result: 'NO' }),
    );
    expect(taken.statusCode, taken.body).toBe(200);
    expectRefused(waiting, 'judgement', 'pending');
    const requestId = await pendingId(market.id);
    const [approved, again] = await inTurn(
      market.id,
      () => approve(market.id, requestId),
      () => approve(market.id, requestId, third),
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expectNotAllowed(again, 'decided');
    expect((await eventsFor(market.id)).map((event) => event.type)).toEqual(['provisional']);
    expect(await judgementsFor(market.id)).toHaveLength(1);
    expect(await marketRow(market.id)).toMatchObject({
      status: 'provisional',
      resolvedResult: 'YES',
      judgementVersion: 1,
    });
  });

  // --- 판정 승인 대기 ------------------------------------------------------------------------------
  it('lists the waiting registrations across markets, the oldest first, with a keyset cursor', async () => {
    const first = await closed();
    const second = await closedEarly();
    const last = await closed();
    expect((await register(first.id, registrant, { result: 'NO' })).statusCode).toBe(200);
    expect((await register(second.id, third)).statusCode).toBe(200);
    expect((await register(last.id)).statusCode).toBe(200);
    // Retracted ones leave the queue; one on a market no longer CLOSED stays until its 반려.
    expect((await retract(last.id, await pendingId(last.id))).statusCode).toBe(200);
    const moved = await createMarket(t.db, {
      createdBy: registrant.id,
      categoryId: category.id,
      status: 'provisional',
    });
    const stale = await createJudgementRequest(t.db, { marketId: moved.id, by: third.id });
    const page = (await queue()).json<QueuePage>();
    expect(page.data).toEqual([
      {
        requestId: await pendingId(first.id),
        marketId: first.id,
        slug: first.slug,
        title: first.title,
        status: 'closed',
        closeAt: first.closeAt.toISOString(),
        scheduledJudgementAt: first.scheduledJudgementAt!.toISOString(),
        result: 'NO',
        correction: null,
        requestedBy: await actorOf(registrant),
        requestedAt: (await requestsFor(first.id))[0]!.requestedAt.toISOString(),
      },
      expect.objectContaining({
        marketId: second.id,
        status: 'closed',
        result: 'YES',
        requestedBy: await actorOf(third),
      }),
      expect.objectContaining({ requestId: stale.id, marketId: moved.id, status: 'provisional' }),
    ]);
    const one = (await queue('?limit=1')).json<QueuePage>();
    expect(one.data.map((item) => item.marketId)).toEqual([first.id]);
    const next = (
      await queue(`?limit=1&cursor=${encodeURIComponent(one.meta.nextCursor!)}`)
    ).json<QueuePage>();
    expect(next.data.map((item) => item.marketId)).toEqual([second.id]);
    expect(next.meta.nextCursor).not.toBeNull();
    expect(
      (
        await approve(second.id, await pendingId(second.id), reviewer, {
          eventDeadlineConfirmed: true,
        })
      ).statusCode,
    ).toBe(200);
    expect((await reject(moved.id, stale.id)).statusCode).toBe(200);
    expect((await queue()).json<QueuePage>().data.map((item) => item.marketId)).toEqual([first.id]);
    // Admins only.
    const member = await signUpTestUser(t);
    expect((await queue('', member)).statusCode).toBe(403);
  });

  // --- the admin on screen, the guards and the interim route ---------------------------------
  it('asks every judgement write for the admin on screen, before anything is read or written', async () => {
    const market = await closed();
    const held = await closed();
    expect((await register(held.id)).statusCode).toBe(200);
    const requestId = await pendingId(held.id);
    for (const res of [
      await register(market.id, third, { expectedAccountId: reviewer.id }),
      await approve(held.id, requestId, reviewer, { expectedAccountId: third.id }),
      await reject(held.id, requestId, reviewer, { expectedAccountId: third.id }),
      await post(`${judgementsUrl(held.id)}/${requestId}/retract`, registrant, {
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
        headers: { ...jsonHeaders, cookie: registrant.cookie },
        payload,
      });
    for (const res of [
      await unnamed(judgementsUrl(market.id), {
        result: 'YES',
        source: { priority: 0 },
        evidence: { links: [LINK], collectedAt: iso(Date.now() - MINUTE_MS) },
        description: DESCRIPTION,
      }),
      await unnamed(`${judgementsUrl(held.id)}/${requestId}/approve`, {
        reason: APPROVAL,
        eventDeadlineConfirmed: false,
      }),
      await unnamed(`${judgementsUrl(held.id)}/${requestId}/reject`, { reason: '반려' }),
      await unnamed(`${judgementsUrl(held.id)}/${requestId}/retract`, {}),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    }
    expect(await requestsFor(market.id)).toEqual([]);
    expect((await requestsFor(held.id)).map((row) => row.status)).toEqual(['pending']);
    expect((await judgementActionsFor(held.id)).map((action) => action.type)).toEqual([
      'market_judgement_request',
    ]);
  });

  it('is closed to members and anonymous callers', async () => {
    const market = await closed();
    const member = await signUpTestUser(t);
    const asMember = await register(market.id, member);
    expect({ status: asMember.statusCode, code: errorOf(asMember).code }).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
    const anonymous = await t.app.inject({
      method: 'POST',
      url: judgementsUrl(market.id),
      headers: jsonHeaders,
      payload: { result: 'YES' },
    });
    expect({ status: anonymous.statusCode, code: errorOf(anonymous).code }).toEqual({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    expect(await requestsFor(market.id)).toEqual([]);
  });

  it('serves no route that judges a market at once: the one-admin resolve is gone (#152)', async () => {
    // ADR-0093 decision 1 #173 items 1·9 (ADR-0103): a CLOSED market's judgement is registered
    // and approved by another admin (PROVISIONAL), and the worker confirms it at its deadline —
    // never one admin's closed → resolved.
    expect(discoverRoutes().map((route) => route.key)).not.toContain(
      'POST /admin/markets/:id/resolve',
    );
    const market = await closed();
    const res = await post(`${marketUrl(market.id)}/resolve`, registrant, { result: 'YES' });
    expect({ status: res.statusCode, code: errorOf(res).code }).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(await marketRow(market.id)).toMatchObject({ status: 'closed', resolvedResult: null });
    expect(await eventsFor(market.id)).toEqual([]);
    expect(await jobIds()).toEqual([]);
  });
});
