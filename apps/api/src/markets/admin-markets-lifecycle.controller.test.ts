/**
 * The M5 jobs and the market keys through the admin routes (PLAN 5.5, 7.3; ADR-0046; m5 design
 * 3.3–3.5) against the docker `test` profile: the close job the API registers in the `markets`
 * queue (inspected with a BullMQ Queue on the test Redis, as the worker sees them) moved by a
 * supplement and dropped by an early close, `statusEventId` — the transition's `market_events.id`
 * — on every market DTO and every `market:status` published, a judgement's approval (#152)
 * included, and `settlementSteps` on the admin detail from the result's confirmation on. The
 * judgement itself — registered, approved, rejected, retracted, its job — is
 * admin-market-judgements.controller.test's; the interim one-admin judgement these tests shared a
 * file with is gone (#152, ADR-0103). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createFill,
  createMarket,
  createOpenedMarket,
  createProvisionalMarket,
  createSettlementStep,
  resolveMarketNow,
} from '@buddha/db/test';
import {
  DEFAULT_JUDGEMENT_TIME_ZONE,
  ceilToMinute,
  floorToMinute,
  marketChannel,
  marketCloseJobId,
  JOB_NAMES,
  SETTLEMENT_STEPS,
  type AdminMarket,
  type Market,
  type MarketResult,
  type MarketSummary,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MARKETS_QUEUE, MarketJobs } from '../jobs/market-jobs.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

type StatusEvent = {
  type: string;
  status: string;
  resolvedResult: MarketResult | null;
  statusEventId: string | null;
  ts: string;
};

describe.skipIf(!hasTestInfra)('admin markets lifecycle (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let category: { id: number; slug: string };
  let inspector: Redis;
  let queue: Queue;

  beforeAll(async () => {
    t = await createTestApp();
    inspector = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(MARKETS_QUEUE, { connection: inspector });
  });
  afterAll(async () => {
    await queue?.close();
    await inspector?.quit();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    // Jobs are keyed by market id and instant, so nothing of an earlier test can collide; the
    // queue is still emptied so a count means what this test registered.
    await queue.obliterate({ force: true });
    admin = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // An admin finishes the onboarding like any account before /admin answers it (ADR-0072).
    await completeOnboarding(t.db, { userId: admin.id });
    await t.app.get(AdminGuard).invalidate(admin.id);
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  // Every write names the admin on screen (ADR-0092): `who`'s own account unless the payload
  // names another.
  const post = (url: string, payload: Record<string, unknown> = {}, who: TestUser = admin) =>
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
  const patch = (url: string, payload: Record<string, unknown>, who: TestUser = admin) =>
    t.app.inject({
      method: 'PATCH',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const get = (url: string, cookie = admin.cookie) =>
    t.app.inject({ method: 'GET', url, headers: { cookie } });

  const create = (overrides: Record<string, unknown> = {}) => {
    const closeAt = Date.now() + 7 * DAY_MS;
    const eventDeadline = Date.now() + 8 * DAY_MS;
    return post('/api/v1/admin/markets', {
      title: '기준금리 3% 이하로 인하?',
      // Every rule item (#23), every time (#22) and a tag, so the draft passes the open-items
      // check (#17): the scheduled open passed, the judgement a day after the deadline, raised to
      // the minute, and no announcement time.
      description: '한국은행 금융통화위원회가 기준금리를 정한다.',
      yesCondition: '사건 기한까지 기준금리를 3% 이하로 내리면 YES.',
      noCondition: '사건 기한까지 3% 이하로 내리지 않으면 NO.',
      eventDeadline: new Date(eventDeadline).toISOString(),
      primarySource: { name: '한국은행 보도자료', url: 'https://www.bok.or.kr' },
      longDelayDays: 14,
      delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정한다.',
      categoryId: category.id,
      scheduledOpenAt: new Date(floorToMinute(Date.now()) - MINUTE_MS).toISOString(),
      closeAt: new Date(closeAt).toISOString(),
      scheduledJudgementAt: new Date(ceilToMinute(eventDeadline) + DAY_MS).toISOString(),
      judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
      tags: ['금리'],
      ...overrides,
    });
  };
  /** Another onboarded admin, past the guard's role cache. */
  async function anotherAdmin(): Promise<TestUser> {
    const other = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, other.id));
    await completeOnboarding(t.db, { userId: other.id });
    await t.app.get(AdminGuard).invalidate(other.id);
    return other;
  }
  /**
   * A rule supplement of an open market (#80): `changes` requested by another admin against the
   * current version and approved by the test admin. Answers the approval.
   */
  async function supplement(marketId: string, changes: Record<string, unknown>) {
    const requester = await anotherAdmin();
    const url = `/api/v1/admin/markets/${marketId}/supplements`;
    const requested = await post(
      url,
      {
        baseVersion: (await marketRow(marketId)).ruleVersion,
        changes,
        reason: '오탈자 수정',
        settlementImpact: '판정 기준이 바뀌지 않는다',
      },
      requester,
    );
    expect(requested.statusCode).toBe(200);
    const requestId = detail(requested).supplement.pending!.requestId;
    const approved = await post(`${url}/${requestId}/approve`, { reason: '뜻이 그대로다' });
    expect(approved.statusCode).toBe(200);
    return approved;
  }
  /**
   * 조기 마감 through the routes (#114, ADR-0102), the way a market reaches CLOSED before its close
   * now that the one-admin close is gone: the test admin pauses it (실질 기준 변경) and asks for the
   * early close (reviewed 판정 가능, Q2), and another admin approves it. Answers the approval. One
   * fill between two members is recorded first (`createFill`: rows only), as a trade before the
   * pause: without it the early close cancels the market (#20, ADR-0117).
   */
  async function closeEarly(marketId: string) {
    await createFill(t.db, { marketId, amountCoin: 50n, qty: 1 });
    const approver = await anotherAdmin();
    const url = `/api/v1/admin/markets/${marketId}`;
    const paused = await post(`${url}/pause`, {
      reason: 'basis_change',
      note: '사건 일정이 앞당겨졌다.',
    });
    expect(paused.statusCode).toBe(200);
    const requested = await post(`${url}/pause-decisions`, {
      pauseId: detail(paused).pause.history[0]!.id,
      path: 'early_close',
      reviewResult: 'judgeable',
      reason: '앞당겨진 일정에 맞춰 마감한다.',
    });
    expect(requested.statusCode).toBe(200);
    const requestId = detail(requested).pause.pending!.requestId;
    const approved = await post(
      `${url}/pause-decisions/${requestId}/approve`,
      { reason: '조기 마감이 맞다.' },
      approver,
    );
    expect(approved.statusCode).toBe(200);
    return approved;
  }
  /**
   * 판정 through the routes (#152, ADR-0103): the release setting `market.dispute_window` entered
   * (a day, a test value), the test admin registers YES on the primary source and another admin
   * approves it — confirming the event deadline, as an approval before the scheduled judgement
   * must. Answers the approval: the market PROVISIONAL.
   */
  async function judge(marketId: string) {
    const window = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/release-settings/market.dispute_window',
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: {
        status: 'test',
        value: 1_440,
        reason: '이의 기간 시험값',
        expectedAccountId: admin.id,
      },
    });
    expect(window.statusCode).toBe(200);
    const url = `/api/v1/admin/markets/${marketId}/judgements`;
    const registered = await post(url, {
      result: 'YES',
      source: { priority: 0 },
      evidence: {
        links: ['https://www.bok.or.kr/press'],
        collectedAt: new Date(Date.now() - MINUTE_MS).toISOString(),
      },
      description: '한국은행 보도자료에서 3.00%를 확인했다.',
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const requestId = detail(registered).judgement.pending!.requestId;
    const approved = await post(
      `${url}/${requestId}/approve`,
      { reason: '증거와 출처가 규칙에 맞다.', eventDeadlineConfirmed: true },
      await anotherAdmin(),
    );
    expect(approved.statusCode, approved.body).toBe(200);
    return approved;
  }

  /** A market row written by the factory (no events, so `statusEventId` null). */
  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: admin.id, categoryId: category.id, ...input });

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const detail = (res: { json: <U>() => U }) => data<AdminMarket>(res);

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
  async function stepRows(marketId: string) {
    return t.db
      .select()
      .from(schema.marketSettlementSteps)
      .where(eq(schema.marketSettlementSteps.marketId, marketId))
      .orderBy(asc(schema.marketSettlementSteps.step));
  }
  async function jobIds() {
    const jobs = await queue.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed']);
    return jobs.map((job) => job.id).sort();
  }

  /** A raw subscriber on the market's channel, collecting parsed `market:status` events. */
  async function subscribeStatus(marketId: string) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: StatusEvent[] = [];
    subscriber.on('message', (_channel: string, message: string) => {
      received.push(JSON.parse(message) as StatusEvent);
    });
    await subscriber.subscribe(marketChannel(marketId));
    return { received, quit: () => subscriber.quit() };
  }

  // --- close job --------------------------------------------------------------------------
  it('moves the close job with closeAt, and drops it on an early close', async () => {
    // PLAN 5.5: delayed `market.close` for `close_at`, registered at the approval (#21, ADR-0100:
    // admin-markets-review.controller.test.ts); registered here as the approval left it.
    const { market: row } = await createOpenedMarket(t.db, {
      createdBy: admin.id,
      categoryId: category.id,
      closeAt: new Date(Date.now() + 7 * DAY_MS),
    });
    await t.app.get(MarketJobs).scheduleClose(row.id, row.closeAt, new Date());
    const firstId = marketCloseJobId(row.id, row.closeAt);
    expect(await jobIds()).toEqual([firstId]);

    // An edit or a supplement that keeps the close time leaves the registration alone.
    const tagged = await patch(`/api/v1/admin/markets/${row.id}`, { tags: ['태그만 수정'] });
    expect(tagged.statusCode).toBe(200);
    await supplement(row.id, { title: '제목만 보충' });
    expect(await jobIds()).toEqual([firstId]);

    // A moved close time is a new job (the instant is part of the id) and the old one is gone. On
    // an open market it moves by a supplement alone, later only, up to the scheduled judgement
    // (#80; #22, owner answer 2026-10-31 A2): a day later stays before it.
    const laterCloseAt = new Date(row.closeAt.getTime() + DAY_MS).toISOString();
    const moved = detail(await supplement(row.id, { closeAt: laterCloseAt }));
    expect(moved.closeAt).toBe(laterCloseAt);
    const secondId = marketCloseJobId(row.id, new Date(laterCloseAt));
    expect(await queue.getJob(firstId)).toBeUndefined();
    const second = await queue.getJob(secondId);
    expect(second).toBeDefined();
    expect(second!.name).toBe(JOB_NAMES.marketClose);
    expect(second!.data).toEqual({ marketId: row.id });
    expect(second!.delay).toBe(Date.parse(laterCloseAt) - Date.parse(moved.updatedAt));
    expect(await jobIds()).toEqual([secondId]);

    // A draft's close time can move too, but a draft has no job to move.
    const other = detail(await create());
    const otherCloseAt = new Date(Date.now() + 3 * DAY_MS).toISOString();
    expect(
      (await patch(`/api/v1/admin/markets/${other.id}`, { closeAt: otherCloseAt })).statusCode,
    ).toBe(200);
    expect(await jobIds()).toEqual([secondId]);

    // A pause leaves it (the close still comes on schedule, #173 item 3); an approved early close
    // is the job's job done before its time (#114): the registration is dropped.
    const paused = await post(`/api/v1/admin/markets/${row.id}/pause`, {
      reason: 'ledger_failure',
      note: '원장 장애로 멈춘다.',
    });
    expect(paused.statusCode).toBe(200);
    expect(await jobIds()).toEqual([secondId]);
    const approver = await anotherAdmin();
    const requested = await post(`/api/v1/admin/markets/${row.id}/pause-decisions`, {
      pauseId: detail(paused).pause.history[0]!.id,
      path: 'early_close',
      reason: '복구가 마감까지 끝나지 않는다.',
    });
    const requestId = detail(requested).pause.pending!.requestId;
    expect(
      (
        await post(
          `/api/v1/admin/markets/${row.id}/pause-decisions/${requestId}/approve`,
          { reason: '조기 마감이 맞다.' },
          approver,
        )
      ).statusCode,
    ).toBe(200);
    expect(await queue.getJob(secondId)).toBeUndefined();
    expect(await jobIds()).toEqual([]);
  });

  // --- statusEventId ----------------------------------------------------------------------
  it('keys every DTO and every published status by the transition event id (A-M3-19)', async () => {
    const created = detail(await create());
    const [createdEvent] = await eventsFor(created.id);
    expect(created.statusEventId).toBe(String(createdEvent!.id));
    expect((await marketRow(created.id)).statusEventId).toBe(createdEvent!.id);

    // Opened at its scheduled open as the worker's job leaves it (#21): submitted, approved and
    // opened, each a transition event. The approval's own open is admin-markets-review's.
    const { market: opened } = await createOpenedMarket(t.db, {
      createdBy: admin.id,
      categoryId: category.id,
    });
    const { received, quit } = await subscribeStatus(opened.id);
    let edited!: AdminMarket;
    let closed!: AdminMarket;
    let judged!: AdminMarket;
    try {
      // A rule supplement is not a transition (#80): its approval republishes the UNCHANGED key
      // (A-M4-36), which is what lets a client drop the repeat and still refetch the row. The
      // early close (#114) is two transitions, the pause and the approved close, each its key;
      // the judgement's approval one more, PROVISIONAL with its result (#152) — the registration
      // before it is none and publishes nothing.
      edited = detail(await supplement(opened.id, { yesCondition: '고친 YES 조건' }));
      closed = detail(await closeEarly(opened.id));
      judged = detail(await judge(opened.id));
      await waitForMessages(received, 4, 'market:status of supplement, pause, close and judgement');
      await sleep(100);
      expect(received).toHaveLength(4);
    } finally {
      await quit();
    }

    const events = await eventsFor(opened.id);
    expect(events.map((event) => event.type)).toEqual([
      'submitted',
      'approved',
      'opened',
      'rules_supplemented',
      'paused',
      'closed',
      'provisional',
    ]);
    const [, , openedEvent, rulesEvent, pausedEvent, closedEvent, provisionalEvent] = events;
    expect(opened.statusEventId).toBe(openedEvent!.id);
    expect(edited.statusEventId).toBe(String(openedEvent!.id));
    expect(edited.statusEventId).not.toBe(String(rulesEvent!.id));
    expect(closed.statusEventId).toBe(String(closedEvent!.id));
    expect(BigInt(closed.statusEventId!)).toBeGreaterThan(BigInt(edited.statusEventId!));
    expect(judged.statusEventId).toBe(String(provisionalEvent!.id));
    expect(BigInt(judged.statusEventId!)).toBeGreaterThan(BigInt(closed.statusEventId!));
    expect(received.map((event) => [event.status, event.statusEventId])).toEqual([
      ['open', String(openedEvent!.id)],
      ['paused', String(pausedEvent!.id)],
      ['closed', String(closedEvent!.id)],
      ['provisional', String(provisionalEvent!.id)],
    ]);
    expect(received.at(-1)!.resolvedResult).toBe('YES');

    // The same key on every read, public and admin, list and detail.
    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${opened.id}` });
    expect(data<Market>(pub).statusEventId).toBe(String(provisionalEvent!.id));
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/markets?status=provisional' });
    expect(data<MarketSummary[]>(list).map((item) => [item.id, item.statusEventId])).toEqual([
      [opened.id, String(provisionalEvent!.id)],
    ]);
    expect(detail(await get(`/api/v1/admin/markets/${opened.id}`)).statusEventId).toBe(
      String(provisionalEvent!.id),
    );
    const adminList = await get('/api/v1/admin/markets?status=provisional');
    expect(data<MarketSummary[]>(adminList)[0]!.statusEventId).toBe(String(provisionalEvent!.id));

    // A row written outside the transition paths carries no key (the rank is its fallback).
    const factory = await market({ status: 'open' });
    const bare = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${factory.id}` });
    expect(data<Market>(bare).statusEventId).toBeNull();
  });

  // --- settlement steps on the admin detail --------------------------------------------
  it('shows the settlement steps on the admin detail in SETTLEMENT_STEPS order, never in public', async () => {
    const stepsOf = async (id: string) =>
      detail(await get(`/api/v1/admin/markets/${id}`)).settlementSteps;

    // Before the result's confirmation there is nothing to settle, nor on a cancelled market.
    for (const status of [
      'draft',
      'review',
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
      'cancelled',
    ] as const) {
      const before = await market({ status });
      expect({ status, steps: await stepsOf(before.id) }).toEqual({ status, steps: [] });
    }

    // Confirmed by the worker at its dispute deadline (#152): one pending row per step, written in
    // the confirmation's transaction at its instant (`resolveProvisionalMarket`, the factories'
    // `resolveMarketNow`) — none while the result was only provisional.
    const { market: provisional } = await createProvisionalMarket(t.db, {
      market: { createdBy: admin.id, categoryId: category.id },
    });
    expect(await stepsOf(provisional.id)).toEqual([]);
    const { market: confirmed } = await resolveMarketNow(t.db, provisional.id);
    expect(await stepsOf(provisional.id)).toEqual([
      {
        step: 'coin',
        status: 'pending',
        attempts: 0,
        completedAt: null,
        lastError: null,
        updatedAt: confirmed.resolvedAt!.toISOString(),
      },
    ]);

    // Confirmed and waiting for the worker's payout: one pending row (the factory writes what the
    // confirmation does).
    const pending = await market({ status: 'resolved', resolvedResult: 'YES' });
    const [pendingRow] = await stepRows(pending.id);
    expect(await stepsOf(pending.id)).toEqual([
      {
        step: 'coin',
        status: 'pending',
        attempts: 0,
        completedAt: null,
        lastError: null,
        updatedAt: pendingRow!.updatedAt.toISOString(),
      },
    ]);

    // A step whose attempts rolled back: still `settling` (ADR-0093 decision 1 item 14), and the
    // reason is on the detail — what the admin's '정산 대기' badge points at.
    const failing = await market({
      status: 'settling',
      resolvedResult: 'NO',
      settlementSteps: false,
    });
    const failedRow = await createSettlementStep(t.db, {
      marketId: failing.id,
      status: 'failed',
      attempts: 3,
      lastError: 'deadlock detected',
    });
    expect(await stepsOf(failing.id)).toEqual([
      {
        step: 'coin',
        status: 'failed',
        attempts: 3,
        completedAt: null,
        lastError: 'deadlock detected',
        updatedAt: failedRow.updatedAt.toISOString(),
      },
    ]);

    // Settled after a retry: done with its completion instant, the last error kept.
    const settledAt = new Date(Date.now() - 60_000);
    const settled = await market({
      status: 'settled',
      resolvedResult: 'YES',
      settledAt,
      settlementSteps: false,
    });
    await createSettlementStep(t.db, {
      marketId: settled.id,
      status: 'done',
      attempts: 2,
      completedAt: settledAt,
      lastError: 'deadlock detected',
    });
    expect(await stepsOf(settled.id)).toEqual([
      expect.objectContaining({
        step: 'coin',
        status: 'done',
        attempts: 2,
        completedAt: settledAt.toISOString(),
        lastError: 'deadlock detected',
      }),
    ]);

    // A row for a step this build does not know (a later release's, after a rollback) is left
    // out rather than breaking the detail; the known steps keep SETTLEMENT_STEPS order.
    await t.db
      .insert(schema.marketSettlementSteps)
      .values({ marketId: pending.id, step: 'unknown', status: 'pending' });
    expect((await stepsOf(pending.id)).map((step) => step.step)).toEqual([...SETTLEMENT_STEPS]);

    // The public shape never carries them (D7).
    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${failing.id}` });
    expect(pub.statusCode).toBe(200);
    expect(data<Market>(pub)).not.toHaveProperty('settlementSteps');
  });
});
