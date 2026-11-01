/**
 * Admin judgement and the M5 jobs (PLAN 5.5, 7.3; ADR-0046; m5 design 3.3–3.5) against the
 * docker `test` profile: the judgement (closed → resolved, final at once — the interim edge until
 * #152) with its event, its `market_settlement_steps` rows and its audit row in one transaction,
 * the finalize and close jobs the API registers in the `markets` queue (inspected with a BullMQ
 * Queue on the test Redis, as the worker sees them), `settlementSteps` on the admin detail, and
 * `statusEventId` — the transition's `market_events.id` — on every market DTO and every
 * `market:status` published. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createOpenedMarket,
  createSettlementStep,
} from '@buddha/db/test';
import {
  DEFAULT_JUDGEMENT_TIME_ZONE,
  ceilToMinute,
  floorToMinute,
  marketChannel,
  marketCloseJobId,
  marketFinalizeJobId,
  JOB_NAMES,
  SETTLEMENT_STEPS,
  type AdminMarket,
  type Market,
  type MarketResult,
  type MarketSummary,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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

type ErrorBody = {
  error: { code: string; message: string; details?: { path: (string | number)[] }[] };
};
type StatusEvent = {
  type: string;
  status: string;
  resolvedResult: MarketResult | null;
  statusEventId: string | null;
  ts: string;
};

describe.skipIf(!hasTestInfra)('admin markets M5 (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;
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
    member = await signUpTestUser(t);
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
      payload: { expectedAccountId: who.id, ...payload },
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
  const close = (id: string) => post(`/api/v1/admin/markets/${id}/close`);
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
  const resolve = (id: string, body: Record<string, unknown>, who?: TestUser) =>
    post(`/api/v1/admin/markets/${id}/resolve`, body, who);

  /** A market row written by the factory (no events, so `statusEventId` null). */
  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: admin.id, categoryId: category.id, ...input });

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const detail = (res: { json: <U>() => U }) => data<AdminMarket>(res);
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;
  const detailPath = (res: { json: <U>() => U }) => errorOf(res).details?.[0]?.path;

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
  // By created_at, never by id: admin_actions.id is a random uuid, so ordering on it made two
  // actions on one market come back in either order and this suite flaked on the second row.
  // Each action's created_at is its transaction's post-lock clock read, and the requests are
  // sequential, so the instants are distinct and in call order.
  async function actionsFor(targetId: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, targetId))
      .orderBy(asc(schema.adminActions.createdAt));
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

  // --- resolve ----------------------------------------------------------------------------
  it('judges a closed market: resolved at once, event, steps, audit, publish and the finalize job', async () => {
    const row = await market({ status: 'closed' });
    const { received, quit } = await subscribeStatus(row.id);
    let resolved!: AdminMarket;
    try {
      const res = await resolve(row.id, {
        result: 'YES',
        note: '한국은행 9월 발표 기준 3.00%.',
        evidenceUrl: 'https://example.com/bok/2026-09',
      });
      expect(res.statusCode).toBe(200);
      resolved = detail(res);
      await waitForMessages(received, 1, 'market:status of the judgement');
      await sleep(100);
      expect(received).toHaveLength(1);
    } finally {
      await quit();
    }

    // ADR-0046: final at once — `resolved`, the result and the judgement's own post-lock
    // instant, and nothing of the retired dispute window anywhere on the DTO.
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolvedResult: 'YES',
      settledAt: null,
    });
    // VOID is a result now, not a status with its own instant (#174).
    expect(resolved).not.toHaveProperty('voidedAt');
    expect(resolved.resolvedAt).toBe(resolved.updatedAt);
    expect(resolved).not.toHaveProperty('disputeUntil');
    expect(resolved).not.toHaveProperty('disputeCounts');

    const events = await eventsFor(row.id);
    expect(events.map((event) => event.type)).toEqual(['resolved']);
    const event = events[0]!;
    // Who, when, from and to (#174): the row the transition table let through.
    expect(event).toMatchObject({ actorId: admin.id, fromStatus: 'closed', toStatus: 'resolved' });
    expect(event.payload).toEqual({
      result: 'YES',
      note: '한국은행 9월 발표 기준 3.00%.',
      evidenceUrl: 'https://example.com/bok/2026-09',
    });
    expect(event.createdAt.toISOString()).toBe(resolved.resolvedAt);
    // The event row's id is the market's ordering key, on the row and on every DTO.
    expect((await marketRow(row.id)).statusEventId).toBe(event.id);
    expect(resolved.statusEventId).toBe(String(event.id));
    expect(resolved.events[0]).toMatchObject({
      id: String(event.id),
      type: 'resolved',
      actorId: admin.id,
      fromStatus: 'closed',
      toStatus: 'resolved',
      createdAt: resolved.resolvedAt,
    });

    // D5: exactly one `pending` row per SETTLEMENT_STEPS step, stamped with the judgement's
    // instant — written by the same transaction (the same clock read) — and on the answer.
    const steps = await stepRows(row.id);
    expect(steps).toHaveLength(SETTLEMENT_STEPS.length);
    expect(steps).toEqual([
      expect.objectContaining({
        marketId: row.id,
        step: 'coin',
        status: 'pending',
        attempts: 0,
        completedAt: null,
        lastError: null,
      }),
    ]);
    expect(steps[0]!.createdAt.toISOString()).toBe(resolved.resolvedAt);
    expect(steps[0]!.updatedAt.toISOString()).toBe(resolved.resolvedAt);
    expect(resolved.settlementSteps).toEqual([
      {
        step: 'coin',
        status: 'pending',
        attempts: 0,
        completedAt: null,
        lastError: null,
        updatedAt: resolved.resolvedAt,
      },
    ]);

    const actions = await actionsFor(row.id);
    expect(actions.map((action) => action.type)).toEqual(['market_resolve']);
    const payload = actions[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      result: 'YES',
      note: '한국은행 9월 발표 기준 3.00%.',
      evidenceUrl: 'https://example.com/bok/2026-09',
      before: { status: 'closed' },
      after: { status: 'resolved' },
    });
    // The fields of a proposal that could be changed are gone with the change itself.
    expect(Object.keys(payload).sort()).toEqual([
      'after',
      'before',
      'evidenceUrl',
      'note',
      'result',
    ]);
    expect(actions[0]!.createdAt.toISOString()).toBe(resolved.resolvedAt);

    // PLAN 8: `market:status` after COMMIT, carrying the result and the key — nothing else.
    expect(received[0]).toEqual({
      type: 'market:status',
      marketId: row.id,
      status: 'resolved',
      resolvedResult: 'YES',
      statusEventId: String(event.id),
      ts: resolved.updatedAt,
    });

    // ADR-0046: the finalize job is due at once, under the id that carries the judgement
    // instant, so the worker settles the market without waiting for its per-minute scan.
    const jobId = marketFinalizeJobId(row.id, new Date(resolved.resolvedAt!));
    expect(jobId).toBe(`market.finalize.${row.id}.${String(Date.parse(resolved.resolvedAt!))}`);
    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(JOB_NAMES.marketFinalize);
    expect(job!.data).toEqual({ marketId: row.id });
    expect(job!.delay).toBe(0);
    expect(await jobIds()).toEqual([jobId]);

    // A settlement is not a price: no tick is written (Q-M5).
    expect(await t.db.select().from(schema.priceTicks)).toHaveLength(0);

    // What the public sees: the judgement, without the admin-only step rows.
    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${row.id}` });
    const publicMarket = data<Market>(pub);
    expect(publicMarket).toMatchObject({
      status: 'resolved',
      resolvedResult: 'YES',
      resolvedAt: resolved.resolvedAt,
      statusEventId: String(event.id),
    });
    expect(publicMarket).not.toHaveProperty('disputeUntil');
    expect(publicMarket).not.toHaveProperty('settlementSteps');
  });

  it('writes the judgement and its step rows in one transaction: a failed step insert leaves nothing', async () => {
    // A step row a closed market cannot have (only a judgement writes one): the judgement's
    // insert collides on the primary key (market_id, step) and the whole transaction must
    // roll back with it — no `resolved` status, no event, no audit row, no job, no publish.
    const row = await market({ status: 'closed' });
    await createSettlementStep(t.db, { marketId: row.id, status: 'failed', lastError: 'stale' });
    const { received, quit } = await subscribeStatus(row.id);
    try {
      const res = await resolve(row.id, { result: 'YES' });
      expect(res.statusCode).toBe(500);
      expect(errorOf(res).code).toBe('INTERNAL');
      await sleep(100);
      expect(received).toHaveLength(0);
    } finally {
      await quit();
    }
    expect(await marketRow(row.id)).toMatchObject({
      status: 'closed',
      resolvedResult: null,
      resolvedAt: null,
      statusEventId: null,
    });
    expect(await eventsFor(row.id)).toHaveLength(0);
    expect(await actionsFor(row.id)).toHaveLength(0);
    expect(await stepRows(row.id)).toEqual([
      expect.objectContaining({ step: 'coin', status: 'failed', lastError: 'stale' }),
    ]);
    expect(await jobIds()).toEqual([]);
  });

  it('refuses every status but closed naming status: a judgement is final, whatever the result', async () => {
    const row = await market({ status: 'closed' });
    const resolved = detail(await resolve(row.id, { result: 'YES' }));
    const jobId = marketFinalizeJobId(row.id, new Date(resolved.resolvedAt!));

    // No result change (ADR-0046, #26): the same result and the other one are both refused,
    // naming `status` — the market is no longer closed.
    for (const result of ['YES', 'NO'] as const) {
      const again = await resolve(row.id, { result, note: '다시' });
      expect({ result, code: again.statusCode }).toEqual({ result, code: 400 });
      expect(errorOf(again)).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Market is resolved',
      });
      expect(detailPath(again)).toEqual(['status']);
    }
    // Refused before anything is written: one event, one action, one step row, the one job.
    expect((await eventsFor(row.id)).map((event) => event.type)).toEqual(['resolved']);
    expect(await actionsFor(row.id)).toHaveLength(1);
    expect(await stepRows(row.id)).toHaveLength(1);
    expect(await marketRow(row.id)).toMatchObject({
      status: 'resolved',
      resolvedResult: 'YES',
      statusEventId: Number(resolved.statusEventId),
    });
    expect(await jobIds()).toEqual([jobId]);

    // A market already judged (or settled) by the factory, and the statuses before closed and
    // after it — a PROVISIONAL one included: CLOSED → RESOLVED is the interim edge, and
    // PROVISIONAL → RESOLVED is the dispute window's end (#175), never this action. None of them
    // gains an event, an audit row or a step row.
    const judged = new Set<string>(['provisional', 'resolved', 'settling', 'settled']);
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
      const other = await market({
        status,
        ...(judged.has(status) ? { resolvedResult: 'NO' } : {}),
      });
      const stepsBefore = (await stepRows(other.id)).length;
      const res = await resolve(other.id, { result: 'YES' });
      expect({ status, code: res.statusCode }).toEqual({ status, code: 400 });
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: `Market is ${status}`,
      });
      expect(detailPath(res)).toEqual(['status']);
      const after = await marketRow(other.id);
      expect(after.status).toBe(status);
      expect(after.resolvedResult).toBe(other.resolvedResult);
      expect(await eventsFor(other.id)).toHaveLength(0);
      expect(await actionsFor(other.id)).toHaveLength(0);
      expect(await stepRows(other.id)).toHaveLength(stepsBefore);
    }

    expect((await resolve(randomUUID(), { result: 'YES' })).statusCode).toBe(404);
    expect((await resolve('not-a-uuid', { result: 'YES' })).statusCode).toBe(400);
    const fresh = await market({ status: 'closed' });
    for (const bad of [
      {},
      { result: 'MAYBE' },
      // VOID is a result, but chosen in #152's judgement and paid by #126: not this action's.
      { result: 'VOID' },
      { result: 'YES', evidenceUrl: 'javascript:alert(1)' },
      { result: 'YES', note: 'x'.repeat(1_001) },
    ]) {
      const res = await resolve(fresh.id, bad);
      expect({ bad, status: res.statusCode }).toEqual({ bad, status: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    expect((await marketRow(fresh.id)).status).toBe('closed');
    expect(await stepRows(fresh.id)).toHaveLength(0);
    // Nothing of the refusals reached the queue.
    expect(await jobIds()).toEqual([jobId]);
  });

  // --- close job --------------------------------------------------------------------------
  it('moves the close job with closeAt, and drops it on close', async () => {
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

    // The manual close is the job's job done by hand: the registration is dropped.
    expect((await close(row.id)).statusCode).toBe(200);
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
    try {
      // A rule supplement is not a transition (#80): its approval republishes the UNCHANGED key
      // (A-M4-36), which is what lets a client drop the repeat and still refetch the row.
      edited = detail(await supplement(opened.id, { yesCondition: '고친 YES 조건' }));
      closed = detail(await close(opened.id));
      await waitForMessages(received, 2, 'market:status of supplement and close');
      await sleep(100);
      expect(received).toHaveLength(2);
    } finally {
      await quit();
    }

    const events = await eventsFor(opened.id);
    expect(events.map((event) => event.type)).toEqual([
      'submitted',
      'approved',
      'opened',
      'rules_supplemented',
      'closed',
    ]);
    const [, , openedEvent, rulesEvent, closedEvent] = events;
    expect(opened.statusEventId).toBe(openedEvent!.id);
    expect(edited.statusEventId).toBe(String(openedEvent!.id));
    expect(edited.statusEventId).not.toBe(String(rulesEvent!.id));
    expect(closed.statusEventId).toBe(String(closedEvent!.id));
    expect(BigInt(closed.statusEventId!)).toBeGreaterThan(BigInt(edited.statusEventId!));
    expect(received.map((event) => [event.status, event.statusEventId])).toEqual([
      ['open', String(openedEvent!.id)],
      ['closed', String(closedEvent!.id)],
    ]);

    // The same key on every read, public and admin, list and detail.
    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${opened.id}` });
    expect(data<Market>(pub).statusEventId).toBe(String(closedEvent!.id));
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/markets?status=closed' });
    expect(data<MarketSummary[]>(list).map((item) => [item.id, item.statusEventId])).toEqual([
      [opened.id, String(closedEvent!.id)],
    ]);
    expect(detail(await get(`/api/v1/admin/markets/${opened.id}`)).statusEventId).toBe(
      String(closedEvent!.id),
    );
    const adminList = await get('/api/v1/admin/markets?status=closed');
    expect(data<MarketSummary[]>(adminList)[0]!.statusEventId).toBe(String(closedEvent!.id));

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

    // Judged and waiting for the worker: one pending row (the factory writes what resolve does).
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

  // --- guards -----------------------------------------------------------------------------
  it('is closed to members and anonymous callers', async () => {
    const row = await market({ status: 'closed' });
    const asMember = await resolve(row.id, { result: 'YES' }, member);
    expect(asMember.statusCode).toBe(403);
    expect(errorOf(asMember).code).toBe('FORBIDDEN');
    const anonymous = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${row.id}/resolve`,
      headers: jsonHeaders,
      payload: { result: 'YES' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
    expect((await marketRow(row.id)).status).toBe('closed');
    expect(await eventsFor(row.id)).toHaveLength(0);
    expect(await jobIds()).toEqual([]);
  });

  it('refuses a 판정 that names another admin than the cookie’s before anything is read (ADR-0092)', async () => {
    const other = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, other.id));
    await completeOnboarding(t.db, { userId: other.id });
    await t.app.get(AdminGuard).invalidate(other.id);
    const row = await market({ status: 'closed' });
    // The screen still shows `admin` while the tab's cookie is `other`'s.
    const refused = await resolve(row.id, { result: 'YES', expectedAccountId: admin.id }, other);
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused).code).toBe('FORBIDDEN');
    expect(errorOf(refused).details?.[0]?.path).toEqual(['expectedAccountId']);
    // No account named at all: a validation error naming the field.
    const unnamed = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${row.id}/resolve`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { result: 'YES' },
    });
    expect(unnamed.statusCode).toBe(400);
    expect(errorOf(unnamed).details?.map((detail) => detail.path)).toEqual([['expectedAccountId']]);
    // Nothing judged, recorded, settled or scheduled.
    expect(await marketRow(row.id)).toMatchObject({ status: 'closed', resolvedResult: null });
    expect(await eventsFor(row.id)).toHaveLength(0);
    expect(await t.db.select().from(schema.adminActions)).toEqual([]);
    expect(await jobIds()).toEqual([]);
    // The cookie's own account is taken, and the account is never kept with the judgement.
    const judged = await resolve(row.id, { result: 'NO' }, other);
    expect(judged.statusCode, judged.body).toBe(200);
    const [event] = await eventsFor(row.id);
    expect(event!.payload).not.toHaveProperty('expectedAccountId');
    expect((await t.db.select().from(schema.adminActions)).map((action) => action.adminId)).toEqual(
      [other.id],
    );
  });
});
