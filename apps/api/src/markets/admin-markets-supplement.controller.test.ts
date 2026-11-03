/**
 * 규칙 버전과 보충 (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7·14·15, decision 3 '#80 보충의
 * 형태', ADR-0098 A2) through the admin routes against the docker `test` profile: a supplement
 * requested against the current rule version, changing nothing and refused for the market's state
 * (status, no version, its close come, a stale version, one waiting already, no decider) and for
 * its text (unchanged, the item rules the open market's PATCH held until #80); approved by another
 * admin with everything checked again — the new text, the next version read back, one
 * `rules_supplemented` event, the record, the republished status and the moved close job — and
 * refused for a request no longer waiting, the requester, a market paused, closed or moved since;
 * rejected and retracted in any status; the 규칙 보충 대기 queue; the database guard never hit by a
 * route; two writes at once; and the public history, the current version first, naming nobody.
 * The PATCH's refusal of an open market's version items is admin-markets.controller.test's. Skips
 * when TEST_* are unset.
 */
import { readRuleContent, schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createOpenedMarket,
  createRuleSupplement,
  createSupplementRequest,
} from '@buddha/db/test';
import {
  MARKET_SUPPLEMENT_APPROVAL_KIND,
  floorToMinute,
  marketChannel,
  marketCloseJobId,
  type AdminMarket,
  type AdminMarketSupplementItem,
  type Market,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { and, asc, eq, ne } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { findPgError } from '../common/errors/pg-error.js';
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

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: (string | number)[]; message: string }[];
  };
};
type QueuePage = { data: AdminMarketSupplementItem[]; meta: { nextCursor: string | null } };
type Res = { statusCode: number; json: <U>() => U; body: string };

/** An ISO instant, `ms` from the epoch. */
const iso = (ms: number) => new Date(ms).toISOString();
/** A whole minute a week ahead: the close the tests' markets start from. */
const week = () => floorToMinute(Date.now()) + 7 * DAY_MS;

const REASON = '배경의 오탈자를 고친다';
const IMPACT = '판정 기준과 결과의 뜻이 바뀌지 않아 정산에 영향이 없다';

describe.skipIf(!hasTestInfra)('admin market supplements (integration)', () => {
  let t: TestApp;
  /** The worker's view of the `markets` queue: a plain Queue on its own client. */
  let inspector: Redis;
  let jobQueue: Queue;
  /** Requests the supplements unless a test says otherwise. */
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
  const get = (url: string, who: TestUser = asker) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;
  const supplementsUrl = (id: string) => `${marketUrl(id)}/supplements`;
  const requestSupplement = (
    id: string,
    changes: Record<string, unknown>,
    who: TestUser = asker,
    payload: Record<string, unknown> = {},
  ) =>
    post(supplementsUrl(id), who, {
      baseVersion: 1,
      changes,
      reason: REASON,
      settlementImpact: IMPACT,
      ...payload,
    });
  const approve = (
    id: string,
    requestId: string,
    who: TestUser = approver,
    payload: Record<string, unknown> = {},
  ) =>
    post(`${supplementsUrl(id)}/${requestId}/approve`, who, {
      reason: '뜻이 그대로다',
      ...payload,
    });
  const reject = (
    id: string,
    requestId: string,
    who: TestUser = approver,
    payload: Record<string, unknown> = {},
  ) =>
    post(`${supplementsUrl(id)}/${requestId}/reject`, who, {
      rejectReason: 'meaning_change',
      reason: 'YES 조건의 뜻이 바뀐다',
      ...payload,
    });
  const retract = (id: string, requestId: string, who: TestUser = asker) =>
    post(`${supplementsUrl(id)}/${requestId}/retract`, who);
  const queue = (query = '', who: TestUser = asker) =>
    get(`/api/v1/admin/market-supplements${query}`, who);
  const publicDetail = (id: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1/markets/${id}` });

  /**
   * A market opened at its scheduled open as the worker leaves it (`createOpenedMarket`: rule v1
   * recorded), created by `asker`, closing at `closeMs` (a whole minute a week ahead by default),
   * 사건 기한 a day later and the judgement a day after that.
   */
  async function opened(input: Parameters<typeof createOpenedMarket>[1] = {}) {
    const { market } = await createOpenedMarket(t.db, {
      createdBy: asker.id,
      categoryId: category.id,
      tags: ['보충'],
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
  async function versionsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketRuleVersions)
      .where(eq(schema.marketRuleVersions.marketId, marketId))
      .orderBy(asc(schema.marketRuleVersions.version));
  }
  async function requestsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_SUPPLEMENT_APPROVAL_KIND),
          eq(schema.approvalRequests.targetId, marketId),
        ),
      )
      .orderBy(asc(schema.approvalRequests.requestedAt));
  }
  /** The market's waiting supplement request's id. */
  async function pendingId(marketId: string) {
    const pending = (await requestsFor(marketId)).filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(1);
    return pending[0]!.id;
  }
  /** The market's supplement records, oldest first. */
  async function supplementActionsFor(marketId: string) {
    const rows = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, marketId))
      .orderBy(asc(schema.adminActions.createdAt));
    return rows.filter((row) => row.type.startsWith('market_supplement_'));
  }
  /** The market's `market_sources` rows in priority order (#23). */
  async function sourcesOf(marketId: string) {
    return t.db
      .select({
        priority: schema.marketSources.priority,
        name: schema.marketSources.name,
        url: schema.marketSources.url,
      })
      .from(schema.marketSources)
      .where(eq(schema.marketSources.marketId, marketId))
      .orderBy(asc(schema.marketSources.priority));
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

  /** The release setting `market.lead_close_gap` as an admin enters it (a test value). */
  async function setGap(value: number) {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/release-settings/market.lead_close_gap',
      headers: { ...jsonHeaders, cookie: asker.cookie },
      payload: { status: 'test', value, reason: '선행 마감 시험값', expectedAccountId: asker.id },
    });
    expect(res.statusCode).toBe(200);
  }

  // --- the request ----------------------------------------------------------------------------
  it('requests a supplement against the current version, keeping only what changes and changing nothing yet', async () => {
    const market = await opened();
    const c = market.closeAt.getTime();
    await listening(market.id, async (received) => {
      const res = await requestSupplement(market.id, {
        // The current title again is no change; a later close and a new 배경 are.
        title: ` ${market.title} `,
        description: '  고친 배경  ',
        closeAt: iso(c + HOUR_MS).replace('.000Z', 'Z'),
      });
      expect(res.statusCode).toBe(200);
      const answer = detail(res);
      const request = (await requestsFor(market.id))[0]!;
      expect(answer.supplement).toEqual({
        pending: {
          requestId: request.id,
          requestedBy: await actorOf(asker),
          requestedAt: request.requestedAt.toISOString(),
          baseVersion: 1,
          items: ['description', 'closeAt'],
          changes: { description: '고친 배경', closeAt: iso(c + HOUR_MS) },
          reason: REASON,
          settlementImpact: IMPACT,
        },
        log: [
          expect.objectContaining({
            requestId: request.id,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
            decisionReason: null,
            rejectReason: null,
            retractedAt: null,
            version: null,
          }),
        ],
      });
      // Nothing changed yet: the text, the version, the events, the jobs; nothing published.
      expect(answer).toMatchObject({
        description: market.description,
        closeAt: iso(c),
        ruleVersion: 1,
      });
      expect(answer.ruleVersions.map((version) => version.version)).toEqual([1]);
      expect(request).toMatchObject({
        kind: MARKET_SUPPLEMENT_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        requestedBy: asker.id,
        requestReason: REASON,
        status: 'pending',
        payload: {
          baseVersion: 1,
          changes: { description: '고친 배경', closeAt: iso(c + HOUR_MS) },
          settlementImpact: IMPACT,
        },
      });
      const [action] = await supplementActionsFor(market.id);
      expect(action).toMatchObject({
        adminId: asker.id,
        type: 'market_supplement_request',
        targetType: 'market',
        createdAt: request.requestedAt,
        payload: {
          approvalId: request.id,
          baseVersion: 1,
          items: ['description', 'closeAt'],
          changes: { description: '고친 배경', closeAt: iso(c + HOUR_MS) },
          reason: REASON,
          settlementImpact: IMPACT,
        },
      });
      expect((await eventsFor(market.id)).map((event) => event.type)).toEqual([
        'submitted',
        'approved',
        'opened',
      ]);
      expect(await marketRow(market.id)).toEqual(market);
      await sleep(100);
      expect(received).toEqual([]);
    });
  });

  it('refuses a request for the market’s state, in order: status, rule version, close, base version, waiting request, decider', async () => {
    // Not open or paused: a draft, a market in review, a closed one.
    for (const status of ['draft', 'review', 'scheduled', 'closed'] as const) {
      const other = await createMarket(t.db, {
        createdBy: asker.id,
        categoryId: category.id,
        status,
      });
      expectRefused(
        await requestSupplement(other.id, { description: '고친 배경' }),
        'status',
        'not open or paused',
      );
    }
    // Opened before #80 (D4): no version, so no supplement — before anything about the version.
    const legacy = await createMarket(t.db, { createdBy: asker.id, categoryId: category.id });
    expectRefused(
      await requestSupplement(legacy.id, { description: '고친 배경' }, asker, { baseVersion: 7 }),
      'ruleVersion',
      'none',
    );
    const market = await opened();
    // A version the market is not at.
    expectRefused(
      await requestSupplement(market.id, { description: '고친 배경' }, asker, { baseVersion: 2 }),
      'baseVersion',
      'stale',
    );
    // One waits at a time, whoever asks.
    expect((await requestSupplement(market.id, { description: '고친 배경' })).statusCode).toBe(200);
    expectRefused(
      await requestSupplement(market.id, { title: '고친 제목' }, third),
      'supplement',
      'pending',
    );
    // No admin but the requester to decide it: not taken at all.
    const lone = await opened();
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(ne(schema.profiles.userId, asker.id));
    expectNotAllowed(await requestSupplement(lone.id, { description: '고친 배경' }), 'no_decider');
    expect(await requestsFor(lone.id)).toEqual([]);
    expect(await supplementActionsFor(lone.id)).toEqual([]);
    // Unknown market.
    const missing = await requestSupplement(NO_REQUEST, { description: '고친 배경' });
    expect(missing.statusCode).toBe(404);
  });

  it('refuses a request once the close has come, by the clock, while the market is still open', async () => {
    // The worker closes it at its close; until then it is OPEN, and a close extended now would
    // bring it back to life (#172 item 15: no supplement after the close).
    const market = await opened({ closeAt: new Date(Date.now() + 2_500) });
    const requested = await requestSupplement(market.id, { description: '고친 배경' });
    expect(requested.statusCode).toBe(200);
    await sleep(Math.max(0, market.closeAt.getTime() - Date.now()) + 50);
    expect((await marketRow(market.id)).status).toBe('open');
    // Before the waiting request, and before the stale version.
    expectRefused(
      await requestSupplement(market.id, { closeAt: iso(week()) }, third, { baseVersion: 3 }),
      'closeAt',
      'closed',
    );
    // Its approval is refused too; only a 반려 or a 철회 ends it.
    const requestId = await pendingId(market.id);
    expectRefused(await approve(market.id, requestId), 'closeAt', 'closed');
    expect((await reject(market.id, requestId)).statusCode).toBe(200);
    expect(await versionsOf(market.id)).toHaveLength(1);
  });

  it('refuses a body that names no item, another item or a bad value, before anything is read', async () => {
    const market = await opened();
    // Each refused with one issue; `null` for a message is the field schema's own.
    const cases: [Record<string, unknown>, string[], string | null][] = [
      [{}, ['changes'], 'at least one item is required'],
      [{ description: undefined }, ['changes'], 'at least one item is required'],
      [
        { scheduledJudgementAt: iso(week() + 3 * DAY_MS) },
        ['changes'],
        'not a supplement item: scheduledJudgementAt',
      ],
      [
        { scheduledOpenAt: null, categoryId: category.id, tags: ['x'] },
        ['changes'],
        'not a supplement item: scheduledOpenAt, categoryId, tags',
      ],
      [{ title: '  ' }, ['changes', 'title'], null],
      [{ closeAt: null }, ['changes', 'closeAt'], null],
      [
        { primarySource: { name: '출처', url: 'ftp://example.com' } },
        ['changes', 'primarySource', 'url'],
        null,
      ],
    ];
    for (const [changes, path, message] of cases) {
      const res = await requestSupplement(market.id, changes);
      expect({ changes, status: res.statusCode }).toEqual({ changes, status: 400 });
      const details = errorOf(res).details ?? [];
      expect(details.map((issue) => issue.path)).toEqual([path]);
      if (message !== null) expect(details[0]!.message).toBe(message);
    }
    for (const payload of [
      { reason: ' ' },
      { settlementImpact: '' },
      { settlementImpact: 'x'.repeat(501) },
      { baseVersion: 0 },
    ]) {
      const res = await requestSupplement(market.id, { description: '고친 배경' }, asker, payload);
      expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
      expect(errorOf(res).details?.[0]?.path).toEqual([Object.keys(payload)[0]]);
    }
    expect(await requestsFor(market.id)).toEqual([]);
  });

  it('holds the changes to the open market’s rules, as the PATCH did until #80: unchanged, the close, the order, RULES_REQUIRED, the switch condition', async () => {
    const c = week();
    const market = await opened({ closeAt: new Date(c + 30_000) });
    const judgement = market.scheduledJudgementAt!.getTime();
    // Nothing differs from the current version: every item sent as it stands.
    expectRefused(
      await requestSupplement(market.id, {
        title: market.title,
        description: `${market.description!}  `,
        closeAt: iso(c + 30_000).replace('.000Z', 'Z'),
        judgementTimeZone: market.judgementTimeZone,
      }),
      'changes',
      'unchanged',
    );
    // A millisecond earlier is an early close (#173 item 4), never a supplement.
    const earlier = await requestSupplement(market.id, { closeAt: iso(c + 29_999) });
    expect(errorOf(earlier)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'The close time cannot move earlier while the market is open: close it instead',
      details: [{ path: ['closeAt'], message: 'cannot move earlier while open' }],
    });
    expectRefused(
      await requestSupplement(market.id, { closeAt: iso(Date.now() - 1_000) }),
      'closeAt',
      'must be in the future',
    );
    // Up to the scheduled judgement by the minute (A2): its minute is fine, the next is not.
    const past = await requestSupplement(market.id, { closeAt: iso(judgement + MINUTE_MS) });
    expect(errorOf(past)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'The market times are out of order: closeByJudgement',
      details: [
        { path: ['closeAt'], message: 'must be at or before scheduledJudgementAt' },
        { path: ['scheduledJudgementAt'], message: 'must be at or after closeAt' },
      ],
    });
    // 사건 기한 too (A1).
    expect(
      errorOf(await requestSupplement(market.id, { eventDeadline: iso(judgement + MINUTE_MS) }))
        .details?.[0],
    ).toEqual({ path: ['eventDeadline'], message: 'must be at or before scheduledJudgementAt' });
    // RULES_REQUIRED: what it had filled stays filled, the zone included, in RULE_ITEMS order.
    for (const [changes, items] of [
      [{ yesCondition: '' }, ['yesCondition']],
      [{ judgementTimeZone: null }, ['judgementTimeZone']],
      [
        { judgementTimeZone: null, primarySource: null, description: '고친 배경' },
        ['primarySource', 'judgementTimeZone'],
      ],
    ] as const) {
      const res = await requestSupplement(market.id, changes);
      expect({ changes, status: res.statusCode }).toEqual({ changes, status: 422 });
      expect(errorOf(res)).toEqual({
        code: 'RULES_REQUIRED',
        message: `Rule items cannot be left missing while the market is open: ${items.join(', ')}`,
        details: items.map((item) => ({ path: [item], message: 'required while open' })),
      });
    }
    // A switch condition with no fallback to switch to, before RULES_REQUIRED.
    expectRefused(
      await requestSupplement(market.id, {
        fallbackCondition: '대체 출처로 넘어간다',
        yesCondition: '',
      }),
      'fallbackCondition',
      'no fallback source',
    );
    expect(await requestsFor(market.id)).toEqual([]);
    // Within the judgement's minute it is taken.
    const extended = await requestSupplement(market.id, { closeAt: iso(judgement + 59_999) });
    expect(extended.statusCode).toBe(200);
    expect(detail(extended).supplement.pending?.items).toEqual(['closeAt']);
    // Approved, the close moves and the scheduled judgement stays as it is (#22 AC 2).
    expect((await approve(market.id, await pendingId(market.id))).statusCode).toBe(200);
    const row = await marketRow(market.id);
    expect(row.closeAt.toISOString()).toBe(iso(judgement + 59_999));
    expect(row.scheduledJudgementAt).toEqual(market.scheduledJudgementAt);
    expect(row.status).toBe('open');

    // A market opened with an item blank (the open checks nothing again, #21) keeps it blank, and
    // the blank sent for it again is no change: the 배경 alone is the supplement.
    const blank = await opened({ fallbackCondition: '', delayHandling: '' });
    const blanked = await requestSupplement(blank.id, {
      delayHandling: '',
      description: '고친 배경',
    });
    expect(blanked.statusCode).toBe(200);
    expect(detail(blanked).supplement.pending?.items).toEqual(['description']);
  });

  it('keeps every rule item filled that the market had filled (RULES_REQUIRED), and lets one it lacked be filled', async () => {
    // #23: what the review required holds for as long as the market trades — one detail per item
    // the supplement would newly leave missing, in RULE_ITEMS order, as the open-items check
    // counts one (the PATCH's rule until #80).
    const fallback = { name: '대체 출처', url: 'https://example.com/fallback' };
    const market = await opened({ fallbackSources: [fallback] });
    for (const [changes, items] of [
      [{ yesCondition: '' }, ['yesCondition']],
      [{ yesCondition: '   ' }, ['yesCondition']],
      [{ description: null }, ['description']],
      [{ description: ' ' }, ['description']],
      [{ eventDeadline: null }, ['eventDeadline']],
      [{ primarySource: null }, ['primarySource']],
      [{ primarySource: { name: '이름만', url: '' } }, ['primarySource']],
      [
        { fallbackSources: [fallback, { name: '', url: 'https://example.com/x' }] },
        ['fallbackSources'],
      ],
      [{ fallbackCondition: '' }, ['fallbackCondition']],
      [{ longDelayDays: null }, ['longDelayDays']],
      [{ delayHandling: '', noCondition: '', title: '새 제목' }, ['noCondition', 'delayHandling']],
    ] as const) {
      const res = await requestSupplement(market.id, changes);
      expect({ changes, status: res.statusCode }).toEqual({ changes, status: 422 });
      expect(errorOf(res)).toEqual({
        code: 'RULES_REQUIRED',
        message: `Rule items cannot be left missing while the market is open: ${items.join(', ')}`,
        details: items.map((item) => ({ path: [item], message: 'required while open' })),
      });
    }
    expect(await requestsFor(market.id)).toEqual([]);

    // Every fallback removed with its switch condition leaves nothing missing ('없음' is no gap);
    // a fallback added without one leaves the condition missing, which it was not.
    expect(
      (await requestSupplement(market.id, { fallbackSources: [], fallbackCondition: '' }))
        .statusCode,
    ).toBe(200);
    const removed = await approve(market.id, await pendingId(market.id));
    expect(detail(removed)).toMatchObject({
      fallbackSources: [],
      fallbackCondition: '',
      missingOpenItems: [],
      ruleVersion: 2,
    });
    const added = await requestSupplement(market.id, { fallbackSources: [fallback] }, asker, {
      baseVersion: 2,
    });
    expect(added.statusCode).toBe(422);
    expect(errorOf(added).details).toEqual([
      { path: ['fallbackCondition'], message: 'required while open' },
    ]);
    const switched = await requestSupplement(
      market.id,
      {
        fallbackSources: [fallback],
        fallbackCondition: '1차 출처에 발표가 없으면 대체 출처를 본다.',
      },
      asker,
      { baseVersion: 2 },
    );
    expect(switched.statusCode).toBe(200);

    // A market that opened with every rule item blank (the open checks nothing again, #21; v1
    // keeps the blanks): those block no other supplement, one may be filled in, and once filled
    // it may not be blanked again.
    const blank = await opened({ blankRuleItems: true });
    const blankItems = [
      'description',
      'yesCondition',
      'noCondition',
      'eventDeadline',
      'primarySource',
      'longDelayDays',
      'delayHandling',
    ];
    expect((await versionsOf(blank.id))[0]!.content).toMatchObject({
      description: null,
      yesCondition: '',
      primarySource: null,
    });
    expect(
      (await requestSupplement(blank.id, { title: '빈 시장의 새 제목', delayHandling: '' }))
        .statusCode,
    ).toBe(200);
    const retitled = await approve(blank.id, await pendingId(blank.id));
    expect(detail(retitled).missingOpenItems).toEqual(blankItems);
    expect(
      (
        await requestSupplement(blank.id, { yesCondition: '이제 채운 YES 조건' }, asker, {
          baseVersion: 2,
        })
      ).statusCode,
    ).toBe(200);
    const filled = await approve(blank.id, await pendingId(blank.id));
    expect(detail(filled).missingOpenItems).toEqual(
      blankItems.filter((item) => item !== 'yesCondition'),
    );
    const reblanked = await requestSupplement(blank.id, { yesCondition: '' }, asker, {
      baseVersion: 3,
    });
    expect(reblanked.statusCode).toBe(422);
    expect(errorOf(reblanked).details).toEqual([
      { path: ['yesCondition'], message: 'required while open' },
    ]);
  });

  it('checks the lead close again when the close or the announcement changes, at the market’s gap or else the setting’s, which the approval stores', async () => {
    const c = week();
    // Its own gap holds whatever the setting says, undecided included (docs/SETTINGS.md).
    const own = await opened({
      closeAt: new Date(c),
      scheduledAnnouncementAt: new Date(c + 3 * HOUR_MS),
      leadCloseGapMinutes: 60,
    });
    const short = await requestSupplement(own.id, {
      closeAt: iso(c + 2 * HOUR_MS + 30 * MINUTE_MS),
    });
    expect(errorOf(short)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'The close must be at least 60 minutes before the announcement time',
      details: [
        {
          path: ['closeAt'],
          message: 'must be at least the lead-close gap before scheduledAnnouncementAt',
        },
        {
          path: ['scheduledAnnouncementAt'],
          message: 'must be at least the lead-close gap after closeAt',
        },
      ],
    });
    // An announcement moved earlier is checked and named first; a change of neither is not.
    expect(
      errorOf(await requestSupplement(own.id, { scheduledAnnouncementAt: iso(c + 30 * MINUTE_MS) }))
        .details?.[0]?.path,
    ).toEqual(['scheduledAnnouncementAt']);
    expect((await requestSupplement(own.id, { closeAt: iso(c + 2 * HOUR_MS) })).statusCode).toBe(
      200,
    );
    expect((await approve(own.id, await pendingId(own.id))).statusCode).toBe(200);
    expect((await marketRow(own.id)).leadCloseGapMinutes).toBe(60);

    // No gap of its own and the setting undecided: an announcement cannot be checked.
    const bare = await opened({ closeAt: new Date(c) });
    const undecided = await requestSupplement(bare.id, {
      scheduledAnnouncementAt: iso(c + 3 * HOUR_MS),
    });
    expect(errorOf(undecided)).toEqual({
      code: 'VALIDATION_ERROR',
      message:
        'The lead-close gap is undecided: the release setting market.lead_close_gap has no value',
      details: [{ path: ['scheduledAnnouncementAt'], message: 'lead-close gap undecided' }],
    });
    // Once decided, the request is checked at the setting's reading; the approval checks again at
    // the reading then and keeps it on the market.
    await setGap(60);
    expect(
      (await requestSupplement(bare.id, { scheduledAnnouncementAt: iso(c + 30 * MINUTE_MS) }))
        .statusCode,
    ).toBe(400);
    const announced = await requestSupplement(bare.id, {
      scheduledAnnouncementAt: iso(c + 90 * MINUTE_MS),
    });
    expect(announced.statusCode).toBe(200);
    const requestId = await pendingId(bare.id);
    await setGap(120);
    const moved = await approve(bare.id, requestId);
    expect(errorOf(moved).message).toBe(
      'The close must be at least 120 minutes before the announcement time',
    );
    expect((await marketRow(bare.id)).leadCloseGapMinutes).toBeNull();
    await setGap(90);
    const approved = await approve(bare.id, requestId);
    expect(approved.statusCode).toBe(200);
    expect(detail(approved)).toMatchObject({
      leadCloseGapMinutes: 90,
      scheduledAnnouncementAt: iso(c + 90 * MINUTE_MS),
      ruleVersion: 2,
    });
    expect((await marketRow(bare.id)).leadCloseGapMinutes).toBe(90);
  });

  // --- the approval ---------------------------------------------------------------------------
  it('approves a supplement: the new text, the next version read back, one event, the record, the republished status and the moved close job', async () => {
    const c = week();
    const market = await opened({
      closeAt: new Date(c),
      fallbackSources: [{ name: '통계청', url: 'https://kostat.go.kr' }],
    });
    const v1 = (await versionsOf(market.id))[0]!;
    // The approval (#78) registered the close job at the close; the supplement moves it.
    await t.app.get(MarketJobs).scheduleClose(market.id, market.closeAt, new Date());
    const changes = {
      title: '고친 제목',
      description: '고친 배경',
      primarySource: { name: '한국은행 보도자료', url: 'https://www.bok.or.kr' },
      fallbackSources: [],
      fallbackCondition: '',
      closeAt: iso(c + DAY_MS),
    };
    expect((await requestSupplement(market.id, changes)).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    const before = await marketRow(market.id);
    const items = [
      'title',
      'description',
      'primarySource',
      'fallbackSources',
      'fallbackCondition',
      'closeAt',
    ];

    await listening(market.id, async (received) => {
      const res = await approve(market.id, requestId, approver, { reason: ' 뜻이 그대로다 ' });
      expect(res.statusCode).toBe(200);
      const answer = detail(res);
      const [request] = await requestsFor(market.id);
      const at = request!.decidedAt!.toISOString();
      expect(request).toMatchObject({
        status: 'approved',
        decidedBy: approver.id,
        decisionReason: '뜻이 그대로다',
      });
      expect(answer).toMatchObject({
        title: '고친 제목',
        description: '고친 배경',
        primarySource: changes.primarySource,
        fallbackSources: [],
        fallbackCondition: '',
        closeAt: iso(c + DAY_MS),
        scheduledJudgementAt: market.scheduledJudgementAt!.toISOString(),
        status: 'open',
        statusEventId: String(market.statusEventId),
        updatedAt: at,
        ruleVersion: 2,
      });
      // The version is the market as written, read back — the full text, the changed items.
      const versions = await versionsOf(market.id);
      expect(versions).toHaveLength(2);
      const v2 = versions[1]!;
      expect(v2).toMatchObject({
        version: 2,
        changedItems: items,
        reason: REASON,
        settlementImpact: IMPACT,
        approvalId: requestId,
        requestedBy: asker.id,
        createdBy: approver.id,
        createdAt: request!.decidedAt,
      });
      expect(v2.content).toEqual(await readRuleContent(t.db, market.id));
      expect(answer.ruleVersions).toEqual([
        {
          version: 2,
          createdAt: at,
          changedItems: items,
          reason: REASON,
          content: { ...v1.content, ...changes, closeAt: iso(c + DAY_MS) },
          approvalId: requestId,
          requestedBy: await actorOf(asker),
          createdBy: await actorOf(approver),
          settlementImpact: IMPACT,
        },
        {
          version: 1,
          createdAt: v1.createdAt.toISOString(),
          changedItems: [],
          reason: null,
          content: v1.content,
          approvalId: null,
          requestedBy: null,
          createdBy: null,
          settlementImpact: null,
        },
      ]);
      expect(answer.supplement.pending).toBeNull();
      expect(answer.supplement.log).toEqual([
        expect.objectContaining({
          requestId,
          status: 'approved',
          decidedBy: await actorOf(approver),
          decidedAt: at,
          decisionReason: '뜻이 그대로다',
          version: 2,
        }),
      ]);
      expect(await sourcesOf(market.id)).toEqual([
        { priority: 0, name: '한국은행 보도자료', url: 'https://www.bok.or.kr' },
      ]);
      // One market event, no status change, the approver its actor.
      const events = await eventsFor(market.id);
      expect(events.map((event) => event.type)).toEqual([
        'submitted',
        'approved',
        'opened',
        'rules_supplemented',
      ]);
      expect(events.at(-1)).toMatchObject({
        actorId: approver.id,
        fromStatus: null,
        toStatus: null,
        createdAt: request!.decidedAt,
        payload: {
          version: 2,
          approvalId: requestId,
          items,
          reason: REASON,
          requestedBy: asker.id,
        },
      });
      const actions = await supplementActionsFor(market.id);
      expect(actions.map((action) => action.type)).toEqual([
        'market_supplement_request',
        'market_supplement_approve',
      ]);
      expect(actions[1]).toMatchObject({
        adminId: approver.id,
        createdAt: request!.decidedAt,
        payload: {
          approvalId: requestId,
          version: 2,
          items,
          reason: '뜻이 그대로다',
          before: { title: before.title, closeAt: iso(c) },
          after: { title: '고친 제목', closeAt: iso(c + DAY_MS) },
        },
      });
      // Published once after COMMIT, the status and key unchanged, so viewers refetch.
      await waitForMessages(received, 1, 'market:status of the supplement');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'open',
          resolvedResult: null,
          statusEventId: String(market.statusEventId),
          ts: at,
        },
      ]);
    });
    // The close job moved with the close.
    expect(await jobQueue.getJob(marketCloseJobId(market.id, market.closeAt))).toBeUndefined();
    expect(await jobQueue.getJob(marketCloseJobId(market.id, new Date(c + DAY_MS)))).toBeDefined();

    // A later one builds on v2, and moves no close job.
    expect(
      (
        await requestSupplement(market.id, { noCondition: '고친 NO 조건' }, third, {
          baseVersion: 2,
        })
      ).statusCode,
    ).toBe(200);
    const v3 = await approve(market.id, await pendingId(market.id), asker);
    expect(
      detail(v3).ruleVersions.map((version) => [version.version, version.changedItems]),
    ).toEqual([
      [3, ['noCondition']],
      [2, items],
      [1, []],
    ]);
    expect(await jobQueue.getJob(marketCloseJobId(market.id, new Date(c + DAY_MS)))).toBeDefined();
  });

  it('approves 사건 기한, the delay items, the zone and an announcement cleared', async () => {
    const c = week();
    // 사건 기한, 장기 지연 기한, 지연 처리 and the zone, which no approval above changes, and the
    // announcement cleared. With an announcement, no gap of its own and the setting decided, a lead
    // close checked would store the setting's gap on the market (ADR-0098 7-6); an announcement
    // cleared leaves none to check, so none is checked and the gap stays as it was.
    const market = await opened({
      closeAt: new Date(c),
      scheduledAnnouncementAt: new Date(c + 3 * HOUR_MS),
    });
    expect(market.leadCloseGapMinutes).toBeNull();
    await setGap(60);
    const judgement = market.scheduledJudgementAt!.getTime();
    const v1 = (await versionsOf(market.id))[0]!;
    const changes = {
      // Later, up to the scheduled judgement itself (A1).
      eventDeadline: iso(judgement),
      longDelayDays: 30,
      delayHandling: '장기 지연 기한까지 발표가 없으면 취소로 처리한다.',
      judgementTimeZone: 'America/New_York',
      scheduledAnnouncementAt: null,
    };
    expect((await requestSupplement(market.id, changes)).statusCode).toBe(200);
    expect((await approve(market.id, await pendingId(market.id))).statusCode).toBe(200);

    expect(await marketRow(market.id)).toMatchObject({
      eventDeadline: new Date(judgement),
      longDelayDays: 30,
      delayHandling: changes.delayHandling,
      judgementTimeZone: 'America/New_York',
      scheduledAnnouncementAt: null,
      closeAt: market.closeAt,
      scheduledJudgementAt: market.scheduledJudgementAt,
      leadCloseGapMinutes: null,
      ruleVersion: 2,
    });
    const v2 = (await versionsOf(market.id))[1]!;
    // RULE_VERSION_ITEMS order: the rule items, then the times.
    expect(v2.changedItems).toEqual([
      'eventDeadline',
      'longDelayDays',
      'delayHandling',
      'scheduledAnnouncementAt',
      'judgementTimeZone',
    ]);
    expect(v2.content).toEqual({ ...v1.content, ...changes });
    expect(v2.content).toEqual(await readRuleContent(t.db, market.id));
  });

  it('refuses an approval of a request that is no longer waiting, by its requester, or of an unknown one', async () => {
    const market = await opened();
    const other = await opened();
    expect((await requestSupplement(other.id, { description: '다른 시장' })).statusCode).toBe(200);
    expectRefused(await approve(market.id, NO_REQUEST), 'requestId', 'unknown');
    // Another market's request is no request of this one.
    expectRefused(await approve(market.id, await pendingId(other.id)), 'requestId', 'unknown');
    expectRefused(await reject(market.id, await pendingId(other.id)), 'requestId', 'unknown');
    expectRefused(await retract(market.id, await pendingId(other.id)), 'requestId', 'unknown');

    expect((await requestSupplement(market.id, { description: '고친 배경' })).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    expectNotAllowed(await approve(market.id, requestId, asker), 'requester');
    expectNotAllowed(await reject(market.id, requestId, asker), 'requester');
    expect((await approve(market.id, requestId)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, requestId, third), 'decided');
    expectNotAllowed(await reject(market.id, requestId, third), 'decided');
    // No longer waiting comes before the requester.
    expectNotAllowed(await approve(market.id, requestId, asker), 'decided');
    expectNotAllowed(await retract(market.id, requestId), 'decided');

    expect(
      (await requestSupplement(market.id, { title: '고친 제목' }, asker, { baseVersion: 2 }))
        .statusCode,
    ).toBe(200);
    const retracted = await pendingId(market.id);
    expect((await retract(market.id, retracted)).statusCode).toBe(200);
    expectNotAllowed(await approve(market.id, retracted), 'retracted');
    expectNotAllowed(await reject(market.id, retracted), 'retracted');
    expectNotAllowed(await retract(market.id, retracted), 'retracted');
    expect((await versionsOf(market.id)).map((version) => version.version)).toEqual([1, 2]);
  });

  it('checks the request again at the approval: a market paused, closed or moved past its version since', async () => {
    const c = week();
    // Paused since: its title still changes, its close no longer (#172 item 14).
    const paused = await opened({ closeAt: new Date(c) });
    expect(
      (await requestSupplement(paused.id, { title: '고친 제목', closeAt: iso(c + HOUR_MS) }))
        .statusCode,
    ).toBe(200);
    const pausedRequest = await pendingId(paused.id);
    await t.db
      .update(schema.markets)
      .set({ status: 'paused' })
      .where(eq(schema.markets.id, paused.id));
    expectRefused(await approve(paused.id, pausedRequest), 'closeAt', 'fixed while paused');
    expect((await reject(paused.id, pausedRequest)).statusCode).toBe(200);
    expectRefused(
      await requestSupplement(paused.id, { closeAt: iso(c + HOUR_MS) }),
      'closeAt',
      'fixed while paused',
    );
    expect((await requestSupplement(paused.id, { title: '고친 제목' })).statusCode).toBe(200);
    const title = await approve(paused.id, await pendingId(paused.id));
    expect(detail(title)).toMatchObject({ status: 'paused', title: '고친 제목', ruleVersion: 2 });

    // Closed since (the interim close): no supplement after the close.
    const closed = await opened();
    expect((await requestSupplement(closed.id, { description: '고친 배경' })).statusCode).toBe(200);
    const closedRequest = await pendingId(closed.id);
    expect((await post(`${marketUrl(closed.id)}/close`, third)).statusCode).toBe(200);
    expectRefused(await approve(closed.id, closedRequest), 'status', 'not open or paused');

    // Moved past its version since (a factory's supplement, which asks for no waiting request).
    const moved = await opened();
    const waiting = await createSupplementRequest(t.db, {
      marketId: moved.id,
      requestedBy: asker.id,
      changes: { description: '먼저 쓴 배경' },
    });
    await createRuleSupplement(t.db, { marketId: moved.id, changes: { title: '먼저 고친 제목' } });
    expectRefused(await approve(moved.id, waiting.id), 'baseVersion', 'stale');
    // Nothing was written by any refusal.
    expect((await requestsFor(moved.id)).find((row) => row.id === waiting.id)?.status).toBe(
      'pending',
    );
    expect(await versionsOf(closed.id)).toHaveLength(1);
    expect((await marketRow(closed.id)).description).toBe(closed.description);
  });

  // --- 반려 and 철회 -----------------------------------------------------------------------------
  it('rejects with a reason from the list and retracts by the requester, in any status, writing nothing but the record', async () => {
    const market = await opened();
    expect((await requestSupplement(market.id, { yesCondition: '고친 YES 조건' })).statusCode).toBe(
      200,
    );
    const requestId = await pendingId(market.id);
    await listening(market.id, async (received) => {
      for (const payload of [{ rejectReason: 'other_reason' }, { reason: '' }]) {
        const res = await reject(market.id, requestId, approver, payload);
        expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
      }
      const res = await reject(market.id, requestId);
      expect(res.statusCode).toBe(200);
      const answer = detail(res);
      const [request] = await requestsFor(market.id);
      expect(answer.supplement).toEqual({
        pending: null,
        log: [
          expect.objectContaining({
            requestId,
            status: 'rejected',
            decidedBy: await actorOf(approver),
            decidedAt: request!.decidedAt!.toISOString(),
            decisionReason: 'YES 조건의 뜻이 바뀐다',
            rejectReason: 'meaning_change',
            retractedAt: null,
            version: null,
          }),
        ],
      });
      expect(answer).toMatchObject({ yesCondition: market.yesCondition, ruleVersion: 1 });
      expect((await supplementActionsFor(market.id)).at(-1)).toMatchObject({
        adminId: approver.id,
        type: 'market_supplement_reject',
        createdAt: request!.decidedAt,
        payload: {
          approvalId: requestId,
          rejectReason: 'meaning_change',
          reason: 'YES 조건의 뜻이 바뀐다',
        },
      });
      await sleep(100);
      expect(received).toEqual([]);
    });
    expect((await eventsFor(market.id)).map((event) => event.type)).toEqual([
      'submitted',
      'approved',
      'opened',
    ]);

    // A request waiting at the close ends by a 반려 or a 철회 alone, after the close too.
    expect((await requestSupplement(market.id, { title: '고친 제목' })).statusCode).toBe(200);
    const late = await pendingId(market.id);
    expect((await post(`${marketUrl(market.id)}/close`, third)).statusCode).toBe(200);
    expectNotAllowed(await retract(market.id, late, third), 'not_requester');
    const retracted = await retract(market.id, late);
    expect(retracted.statusCode).toBe(200);
    const [, request] = await requestsFor(market.id);
    expect(detail(retracted).supplement.log[0]).toMatchObject({
      requestId: late,
      status: 'retracted',
      decidedBy: null,
      retractedAt: request!.retractedAt!.toISOString(),
    });
    expect((await supplementActionsFor(market.id)).at(-1)).toMatchObject({
      adminId: asker.id,
      type: 'market_supplement_retract',
      createdAt: request!.retractedAt,
      payload: { approvalId: late },
    });
    expect(detail(retracted)).toMatchObject({ status: 'closed', ruleVersion: 1 });
  });

  // --- the queue ------------------------------------------------------------------------------
  it('lists the waiting supplements across markets, the oldest first, in any status, with a keyset cursor', async () => {
    const first = await opened();
    const second = await opened();
    const last = await opened();
    expect((await requestSupplement(first.id, { description: '첫째' })).statusCode).toBe(200);
    expect(
      (await requestSupplement(second.id, { title: '둘째', closeAt: iso(week() + HOUR_MS) }))
        .statusCode,
    ).toBe(200);
    expect((await requestSupplement(last.id, { description: '셋째' })).statusCode).toBe(200);
    // Decided and retracted ones leave the queue; one on a closed market stays.
    expect((await retract(last.id, await pendingId(last.id))).statusCode).toBe(200);
    expect((await post(`${marketUrl(second.id)}/close`, third)).statusCode).toBe(200);
    const page = (await queue()).json<QueuePage>();
    expect(page.data).toEqual([
      {
        requestId: await pendingId(first.id),
        marketId: first.id,
        slug: first.slug,
        title: first.title,
        status: 'open',
        closeAt: first.closeAt.toISOString(),
        requestedBy: await actorOf(asker),
        requestedAt: (await requestsFor(first.id))[0]!.requestedAt.toISOString(),
        baseVersion: 1,
        items: ['description'],
      },
      expect.objectContaining({
        marketId: second.id,
        status: 'closed',
        items: ['title', 'closeAt'],
      }),
    ]);
    const one = (await queue('?limit=1')).json<QueuePage>();
    expect(one.data.map((item) => item.marketId)).toEqual([first.id]);
    const next = (
      await queue(`?limit=1&cursor=${encodeURIComponent(one.meta.nextCursor!)}`)
    ).json<QueuePage>();
    expect(next.data.map((item) => item.marketId)).toEqual([second.id]);
    expect(next.meta.nextCursor).toBeNull();
    // Admins only.
    const member = await signUpTestUser(t);
    expect((await queue('', member)).statusCode).toBe(403);
  });

  // --- the guard and at once -------------------------------------------------------------------
  it('is the one writer of a versioned market’s rules: the database guard refuses any other, and the approval never trips it', async () => {
    /** The SQLSTATE a statement fails with, or null when it succeeds. */
    const sqlState = async (statement: Promise<unknown>) => {
      try {
        await statement;
        return null;
      } catch (error) {
        return findPgError(error)?.code ?? null;
      }
    };
    const market = await opened();
    // A write of a version item or a source without the supplement's setting: migration 0053.
    expect(
      await sqlState(
        t.db
          .update(schema.markets)
          .set({ description: '몰래 고친 배경' })
          .where(eq(schema.markets.id, market.id)),
      ),
    ).toBe('23000');
    expect(
      await sqlState(
        t.db.delete(schema.marketSources).where(eq(schema.marketSources.marketId, market.id)),
      ),
    ).toBe('23000');
    // The route's write passes it, with the sources and the close.
    expect(
      (
        await requestSupplement(market.id, {
          primarySource: { name: '새 출처', url: 'https://example.org' },
          closeAt: iso(week() + HOUR_MS),
        })
      ).statusCode,
    ).toBe(200);
    expect((await approve(market.id, await pendingId(market.id))).statusCode).toBe(200);
    expect(await sourcesOf(market.id)).toEqual([
      { priority: 0, name: '새 출처', url: 'https://example.org' },
    ]);
    // The setting was the approval's transaction's alone.
    expect(
      await sqlState(
        t.db
          .update(schema.markets)
          .set({ title: '몰래 고친 제목' })
          .where(eq(schema.markets.id, market.id)),
      ),
    ).toBe('23000');
    expect((await marketRow(market.id)).ruleVersion).toBe(2);
  });

  it('serialises two writes of one market’s supplements: one request waits, and one approval makes the version', async () => {
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
    const [taken, waiting] = await inTurn(
      market.id,
      () => requestSupplement(market.id, { description: '먼저 쓴 배경' }),
      () => requestSupplement(market.id, { title: '나중에 쓴 제목' }, third),
    );
    expect(taken.statusCode).toBe(200);
    expectRefused(waiting, 'supplement', 'pending');

    const requestId = await pendingId(market.id);
    const [approved, again] = await inTurn(
      market.id,
      () => approve(market.id, requestId),
      () => approve(market.id, requestId, third),
    );
    expect(approved.statusCode).toBe(200);
    expectNotAllowed(again, 'decided');
    expect((await versionsOf(market.id)).map((version) => version.version)).toEqual([1, 2]);
    expect(
      (await eventsFor(market.id)).filter((event) => event.type === 'rules_supplemented'),
    ).toHaveLength(1);
  });

  // --- what the public reads ------------------------------------------------------------------
  it('shows the public every version, the current first, with its text, items, reason and time, and nobody', async () => {
    const market = await opened();
    expect(
      (await requestSupplement(market.id, { description: '공개되는 새 배경' })).statusCode,
    ).toBe(200);
    // A waiting request is not public.
    const waiting = data<Market>(await publicDetail(market.id));
    expect(waiting.ruleVersion).toBe(1);
    expect(waiting.ruleVersions.map((version) => version.version)).toEqual([1]);
    const approved = detail(await approve(market.id, await pendingId(market.id)));

    const res = await publicDetail(market.slug);
    expect(res.statusCode).toBe(200);
    const pub = data<Market>(res);
    expect(pub).toMatchObject({ description: '공개되는 새 배경', ruleVersion: 2 });
    expect(pub.ruleVersions).toEqual(
      approved.ruleVersions.map(({ version, createdAt, changedItems, reason, content }) => ({
        version,
        createdAt,
        changedItems,
        reason,
        content,
      })),
    );
    for (const version of pub.ruleVersions) {
      expect(Object.keys(version).sort()).toEqual(
        ['changedItems', 'content', 'createdAt', 'reason', 'version'].sort(),
      );
    }
    // Neither who asked nor who approved, nor the 정산 영향 검토, anywhere in the answer.
    for (const hidden of [asker.id, approver.id, IMPACT]) {
      expect(res.body).not.toContain(hidden);
    }
    // After the close it stays.
    expect((await post(`${marketUrl(market.id)}/close`, third)).statusCode).toBe(200);
    expect(data<Market>(await publicDetail(market.id)).ruleVersions).toEqual(pub.ruleVersions);
  });

  it('asks every supplement write for the admin on screen, before anything is read or written', async () => {
    const market = await opened();
    expect((await requestSupplement(market.id, { description: '고친 배경' })).statusCode).toBe(200);
    const requestId = await pendingId(market.id);
    for (const res of [
      await requestSupplement(market.id, { title: '다른 제목' }, third, {
        expectedAccountId: approver.id,
      }),
      await approve(market.id, requestId, approver, { expectedAccountId: third.id }),
      await reject(market.id, requestId, approver, { expectedAccountId: third.id }),
      await post(`${supplementsUrl(market.id)}/${requestId}/retract`, asker, {
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
      await unnamed(supplementsUrl(market.id), {
        baseVersion: 1,
        changes: { title: '다른 제목' },
        reason: REASON,
        settlementImpact: IMPACT,
      }),
      await unnamed(`${supplementsUrl(market.id)}/${requestId}/approve`, { reason: '승인' }),
      await unnamed(`${supplementsUrl(market.id)}/${requestId}/reject`, {
        rejectReason: 'other',
        reason: '반려',
      }),
      await unnamed(`${supplementsUrl(market.id)}/${requestId}/retract`, {}),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    }
    expect((await requestsFor(market.id)).map((row) => row.status)).toEqual(['pending']);
    expect((await supplementActionsFor(market.id)).map((action) => action.type)).toEqual([
      'market_supplement_request',
    ]);
  });
});
