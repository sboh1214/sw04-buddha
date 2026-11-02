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
 * record alone, the market registered again by any admin; two writes at once; the 판정 승인 대기
 * queue; the admin on screen; and the interim one-admin `POST …/resolve`, gone. The worker's
 * confirmation at the deadline is apps/worker's (market-resolve.test.ts). Skips when TEST_* are
 * unset.
 */
import { schema } from '@buddha/db';
import {
  closeMarketEarly,
  completeOnboarding,
  createCategory,
  createJudgementRequest,
  createMarket,
  createOpenedMarket,
} from '@buddha/db/test';
import {
  JOB_NAMES,
  MARKET_JUDGEMENT_APPROVAL_KIND,
  marketChannel,
  marketResolveJobId,
  type AdminMarket,
  type AdminMarketJudgementQueueItem,
  type Market,
  type MarketPauseReviewResult,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { and, asc, eq, ne } from 'drizzle-orm';
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
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: 90,
        publishedAt: at.toISOString(),
        disputeDeadline: deadline.toISOString(),
        approvalId: requestId,
        registeredBy: await actorOf(registrant),
        approvedBy: await actorOf(reviewer),
      });
      expect(answer.judgement.pending).toBeNull();
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
