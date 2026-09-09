/**
 * M5 admin transitions (PLAN 5.5, 7.3, M5 AC 2 and 6; m5 design 3.3–3.5) against the docker
 * `test` profile: propose / change a result with its dispute window, the finalize and close
 * jobs the API registers in the `markets` queue (inspected with a BullMQ Queue on the test
 * Redis, as the worker sees them), the void of a proposal, and `statusEventId` — the
 * transition's `market_events.id` — on every market DTO and every `market:status` published.
 * Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { createCategory, createDispute, createMarket, createUser } from '@buddha/db/test';
import {
  marketChannel,
  marketCloseJobId,
  marketFinalizeJobId,
  JOB_NAMES,
  type AdminMarket,
  type Market,
  type MarketListItem,
  type MarketSummary,
  type Outcome,
} from '@buddha/shared';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { type Env } from '../config/env.js';
import { MARKETS_QUEUE } from '../jobs/market-jobs.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const DAY_MS = 24 * 60 * 60 * 1000;

type ErrorBody = {
  error: { code: string; message: string; details?: { path: (string | number)[] }[] };
};
type StatusEvent = {
  type: string;
  status: string;
  resolvedResult: Outcome | null;
  disputeUntil: string | null;
  statusEventId: string | null;
  ts: string;
};

describe.skipIf(!hasTestInfra)('admin markets M5 (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;
  let category: { id: number; slug: string };
  /** Seconds, as the app read it: the one figure every window assertion is derived from. */
  let windowMs: number;
  let inspector: Redis;
  let queue: Queue;

  beforeAll(async () => {
    t = await createTestApp();
    windowMs =
      t.app
        .get<ConfigService<Env, true>>(ConfigService)
        .get('TEST_DISPUTE_WINDOW_SECONDS', { infer: true }) * 1_000;
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
    await t.app.get(AdminGuard).invalidate(admin.id);
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  const post = (url: string, payload?: Record<string, unknown>, cookie = admin.cookie) =>
    t.app.inject({ method: 'POST', url, headers: { ...jsonHeaders, cookie }, payload });
  const patch = (url: string, payload: Record<string, unknown>, cookie = admin.cookie) =>
    t.app.inject({ method: 'PATCH', url, headers: { ...jsonHeaders, cookie }, payload });
  const get = (url: string, cookie = admin.cookie) =>
    t.app.inject({ method: 'GET', url, headers: { cookie } });

  const create = (overrides: Record<string, unknown> = {}) =>
    post('/api/v1/admin/markets', {
      title: '기준금리 3% 이하로 인하?',
      rules: '한국은행 발표 기준. 발표가 없으면 아니오.',
      categoryId: category.id,
      closeAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      initialProbBp: 5_000,
      liquidityB: 1_000,
      ...overrides,
    });
  const open = (id: string) => post(`/api/v1/admin/markets/${id}/open`);
  const close = (id: string) => post(`/api/v1/admin/markets/${id}/close`);
  const resolve = (id: string, body: Record<string, unknown>, cookie?: string) =>
    post(`/api/v1/admin/markets/${id}/resolve`, body, cookie);
  const voidMarket = (id: string, reason = '데이터 소스 폐쇄') =>
    post(`/api/v1/admin/markets/${id}/void`, { reason });

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
  // By created_at, never by id: admin_actions.id is a random uuid, so ordering on it made the
  // propose/change pair come back in either order and this suite flaked on the second row.
  // Each action's created_at is its transaction's post-lock clock read, and the two requests
  // are sequential, so the instants are distinct and in call order.
  async function actionsFor(targetId: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, targetId))
      .orderBy(asc(schema.adminActions.createdAt));
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
  it('proposes a result on a closed market: window, event, audit, publish and the finalize job', async () => {
    const row = await market({ status: 'closed' });
    const { received, quit } = await subscribeStatus(row.id);
    let proposed!: AdminMarket;
    try {
      const res = await resolve(row.id, {
        result: 'YES',
        note: '한국은행 9월 발표 기준 3.00%.',
        evidenceUrl: 'https://example.com/bok/2026-09',
      });
      expect(res.statusCode).toBe(200);
      proposed = detail(res);
      await waitForMessages(received, 1, 'market:status of the proposal');
      await sleep(100);
      expect(received).toHaveLength(1);
    } finally {
      await quit();
    }

    // PLAN M5 AC 2: resolving, and the window is exactly what the app was configured with,
    // measured from the proposal's own post-lock instant.
    expect(proposed).toMatchObject({
      status: 'resolving',
      resolvedResult: 'YES',
      settledAt: null,
      voidedAt: null,
    });
    expect(proposed.resolvedAt).toBe(proposed.updatedAt);
    expect(Date.parse(proposed.disputeUntil!) - Date.parse(proposed.resolvedAt!)).toBe(windowMs);

    const events = await eventsFor(row.id);
    expect(events.map((event) => event.type)).toEqual(['resolve_proposed']);
    const event = events[0]!;
    expect(event).toMatchObject({
      actorId: admin.id,
      payload: {
        result: 'YES',
        note: '한국은행 9월 발표 기준 3.00%.',
        evidenceUrl: 'https://example.com/bok/2026-09',
        disputeUntil: proposed.disputeUntil,
      },
    });
    expect(event.createdAt.toISOString()).toBe(proposed.resolvedAt);
    // The event row's id is the market's ordering key, on the row and on every DTO.
    expect((await marketRow(row.id)).statusEventId).toBe(event.id);
    expect(proposed.statusEventId).toBe(String(event.id));
    expect(proposed.events[0]).toMatchObject({ id: String(event.id), type: 'resolve_proposed' });

    const actions = await actionsFor(row.id);
    expect(actions.map((action) => action.type)).toEqual(['market_resolve']);
    expect(actions[0]!.payload).toMatchObject({
      changed: false,
      result: 'YES',
      previousResult: null,
      note: '한국은행 9월 발표 기준 3.00%.',
      evidenceUrl: 'https://example.com/bok/2026-09',
      disputeUntil: proposed.disputeUntil,
      before: { status: 'closed' },
      after: { status: 'resolving' },
    });

    // PLAN 8: `market:status` after COMMIT, carrying the result, the deadline and the key.
    expect(received[0]).toEqual({
      type: 'market:status',
      marketId: row.id,
      status: 'resolving',
      resolvedResult: 'YES',
      disputeUntil: proposed.disputeUntil,
      statusEventId: String(event.id),
      ts: proposed.updatedAt,
    });

    // PLAN 5.5: the delayed finalize job for `dispute_until`, delayed by the window measured
    // on the database clock the transaction read (so exactly the window, not "about").
    const job = await queue.getJob(marketFinalizeJobId(row.id, new Date(proposed.disputeUntil!)));
    expect(job).toBeDefined();
    expect(job!.name).toBe(JOB_NAMES.marketFinalize);
    expect(job!.data).toEqual({ marketId: row.id });
    expect(job!.delay).toBe(windowMs);
    expect(await jobIds()).toEqual([marketFinalizeJobId(row.id, new Date(proposed.disputeUntil!))]);

    // A settlement is not a price: no tick is written (Q-M5).
    expect(await t.db.select().from(schema.priceTicks)).toHaveLength(0);

    // What the public sees.
    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${row.id}` });
    expect(data<Market>(pub)).toMatchObject({
      status: 'resolving',
      resolvedResult: 'YES',
      resolvedAt: proposed.resolvedAt,
      disputeUntil: proposed.disputeUntil,
      statusEventId: String(event.id),
    });
  });

  it('changes the result while the window is open: the window restarts and the job is replaced', async () => {
    const row = await market({ status: 'closed' });
    const { received, quit } = await subscribeStatus(row.id);
    let proposed!: AdminMarket;
    let changed!: AdminMarket;
    try {
      proposed = detail(await resolve(row.id, { result: 'YES', evidenceUrl: null }));
      // Strictly later on the millisecond clock the deadline is stamped with.
      await sleep(5);
      const res = await resolve(row.id, { result: 'NO', note: '이의 수용: 발표 정정.' });
      expect(res.statusCode).toBe(200);
      changed = detail(res);
      await waitForMessages(received, 2, 'market:status of both proposals');
      await sleep(100);
      expect(received).toHaveLength(2);
    } finally {
      await quit();
    }

    // PLAN M5 AC 6: a fresh window from the change's own instant, strictly after the first.
    expect(changed).toMatchObject({ status: 'resolving', resolvedResult: 'NO' });
    expect(changed.resolvedAt).toBe(changed.updatedAt);
    expect(Date.parse(changed.resolvedAt!)).toBeGreaterThan(Date.parse(proposed.resolvedAt!));
    expect(Date.parse(changed.disputeUntil!)).toBeGreaterThan(Date.parse(proposed.disputeUntil!));
    expect(Date.parse(changed.disputeUntil!) - Date.parse(changed.resolvedAt!)).toBe(windowMs);

    const events = await eventsFor(row.id);
    expect(events.map((event) => event.type)).toEqual(['resolve_proposed', 'result_changed']);
    const change = events[1]!;
    expect(change.payload).toEqual({
      before: 'YES',
      after: 'NO',
      note: '이의 수용: 발표 정정.',
      evidenceUrl: null,
      disputeUntil: changed.disputeUntil,
    });
    // The same status twice, told apart by the key — the reason the rank order was retired.
    expect(BigInt(changed.statusEventId!)).toBeGreaterThan(BigInt(proposed.statusEventId!));
    expect(changed.statusEventId).toBe(String(change.id));
    expect((await marketRow(row.id)).statusEventId).toBe(change.id);
    expect(
      received.map((event) => [event.status, event.resolvedResult, event.statusEventId]),
    ).toEqual([
      ['resolving', 'YES', proposed.statusEventId],
      ['resolving', 'NO', changed.statusEventId],
    ]);
    expect(received[1]!.disputeUntil).toBe(changed.disputeUntil);

    const actions = await actionsFor(row.id);
    expect(actions.map((action) => action.type)).toEqual(['market_resolve', 'market_resolve']);
    expect(actions[1]!.payload).toMatchObject({
      changed: true,
      result: 'NO',
      previousResult: 'YES',
      disputeUntil: changed.disputeUntil,
      before: { status: 'resolving' },
      after: { status: 'resolving' },
    });

    // PLAN M5 AC 6: the finalize job of the first deadline is gone, the new one is registered.
    const oldId = marketFinalizeJobId(row.id, new Date(proposed.disputeUntil!));
    const newId = marketFinalizeJobId(row.id, new Date(changed.disputeUntil!));
    expect(oldId).not.toBe(newId);
    expect(await queue.getJob(oldId)).toBeUndefined();
    const job = await queue.getJob(newId);
    expect(job).toBeDefined();
    expect(job!.delay).toBe(windowMs);
    expect(await jobIds()).toEqual([newId]);
  });

  it('refuses the same result naming result, a passed window naming status, and other statuses', async () => {
    const row = await market({ status: 'closed' });
    const proposed = detail(await resolve(row.id, { result: 'YES' }));

    const same = await resolve(row.id, { result: 'YES', note: '다시' });
    expect(same.statusCode).toBe(400);
    expect(errorOf(same)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Result is unchanged',
    });
    expect(detailPath(same)).toEqual(['result']);
    // Refused before anything is written: one event, one action, the one job, same key.
    expect((await eventsFor(row.id)).map((event) => event.type)).toEqual(['resolve_proposed']);
    expect(await actionsFor(row.id)).toHaveLength(1);
    expect((await marketRow(row.id)).disputeUntil?.toISOString()).toBe(proposed.disputeUntil);
    expect(await jobIds()).toEqual([marketFinalizeJobId(row.id, new Date(proposed.disputeUntil!))]);

    // The window has closed: the worker's finalize is due, and PLAN 5.5 lets it proceed —
    // a change now would race the payout, so it is refused; the way out is a void.
    const due = await market({
      status: 'resolving',
      resolvedResult: 'YES',
      resolvedAt: new Date(Date.now() - 2 * DAY_MS),
      disputeUntil: new Date(Date.now() - 1_000),
    });
    const late = await resolve(due.id, { result: 'NO' });
    expect(late.statusCode).toBe(400);
    expect(errorOf(late)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Dispute window has closed; finalize is pending',
    });
    expect(detailPath(late)).toEqual(['status']);
    expect(await marketRow(due.id)).toMatchObject({
      status: 'resolving',
      resolvedResult: 'YES',
      disputeUntil: due.disputeUntil,
    });
    expect(await eventsFor(due.id)).toHaveLength(0);

    for (const status of ['draft', 'open', 'settled', 'voided'] as const) {
      const other = await market({ status });
      const res = await resolve(other.id, { result: 'YES' });
      expect({ status, code: res.statusCode }).toEqual({ status, code: 400 });
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: `Market is ${status}`,
      });
      expect(detailPath(res)).toEqual(['status']);
      expect((await marketRow(other.id)).status).toBe(status);
      expect((await marketRow(other.id)).resolvedResult).toBeNull();
      expect(await actionsFor(other.id)).toHaveLength(0);
    }

    expect((await resolve(randomUUID(), { result: 'YES' })).statusCode).toBe(404);
    expect((await resolve('not-a-uuid', { result: 'YES' })).statusCode).toBe(400);
    for (const bad of [
      {},
      { result: 'MAYBE' },
      { result: 'YES', evidenceUrl: 'javascript:alert(1)' },
      { result: 'YES', note: 'x'.repeat(1_001) },
    ]) {
      const res = await resolve(row.id, bad);
      expect({ bad, status: res.statusCode }).toEqual({ bad, status: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    // Nothing of the refusals reached the queue.
    expect(await jobIds()).toEqual([marketFinalizeJobId(row.id, new Date(proposed.disputeUntil!))]);
  });

  // --- void of a proposal -----------------------------------------------------------------
  it('voids a resolving market: the proposal is discarded and recorded, the finalize job removed', async () => {
    const row = await market({ status: 'closed', title: '무효될 정산' });
    const proposed = detail(await resolve(row.id, { result: 'YES' }));
    const finalizeId = marketFinalizeJobId(row.id, new Date(proposed.disputeUntil!));
    expect(await queue.getJob(finalizeId)).toBeDefined();
    // An objection already filed stays as it is: the admin may still review it.
    await createDispute(t.db, {
      marketId: row.id,
      userId: member.id,
      reason: '출처가 다릅니다.',
    });

    const { received, quit } = await subscribeStatus(row.id);
    let voided!: AdminMarket;
    try {
      const res = await voidMarket(row.id, '결과 확인 불가');
      expect(res.statusCode).toBe(200);
      voided = detail(res);
      await waitForMessages(received, 1, 'market:status of the void');
    } finally {
      await quit();
    }

    // A voided market has no result (A-M3-23): the columns are cleared on the row and the DTO.
    expect(voided).toMatchObject({
      status: 'voided',
      resolvedResult: null,
      resolvedAt: null,
      disputeUntil: null,
    });
    expect(voided.voidedAt).not.toBeNull();
    expect(await marketRow(row.id)).toMatchObject({
      status: 'voided',
      resolvedResult: null,
      resolvedAt: null,
      disputeUntil: null,
    });
    // ...and the audit trail still says what was discarded.
    const events = await eventsFor(row.id);
    expect(events.map((event) => event.type)).toEqual(['resolve_proposed', 'voided']);
    expect(events[1]!.payload).toEqual({
      reason: '결과 확인 불가',
      refundedAccounts: 0,
      refundedP: '0',
      discardedResult: 'YES',
      discardedDisputeUntil: proposed.disputeUntil,
    });
    expect(voided.statusEventId).toBe(String(events[1]!.id));
    expect(received[0]).toMatchObject({
      status: 'voided',
      resolvedResult: null,
      disputeUntil: null,
      statusEventId: String(events[1]!.id),
    });

    // PLAN 5.5: the pending finalize is cancelled; nothing else was registered.
    expect(await queue.getJob(finalizeId)).toBeUndefined();
    expect(await jobIds()).toEqual([]);

    const [dispute] = await t.db.select().from(schema.disputes);
    expect(dispute).toMatchObject({ marketId: row.id, userId: member.id, status: 'open' });
    expect(voided.disputeCounts).toEqual({ open: 1, accepted: 0, rejected: 0 });

    // A void from closed, with nothing proposed, records nothing discarded.
    const plain = await market({ status: 'closed' });
    const plainVoid = detail(await voidMarket(plain.id));
    expect(plainVoid.events[0]!.payload).toEqual({
      reason: '데이터 소스 폐쇄',
      refundedAccounts: 0,
      refundedP: '0',
    });
  });

  // --- close job --------------------------------------------------------------------------
  it('registers the close job on open, moves it with closeAt, and drops it on close or void', async () => {
    const draft = detail(await create());
    expect(await jobIds()).toEqual([]);

    // PLAN 5.5: delayed `market.close` for `close_at`, delayed from the open's own instant.
    const opened = detail(await open(draft.id));
    const firstId = marketCloseJobId(draft.id, new Date(opened.closeAt));
    const first = await queue.getJob(firstId);
    expect(first).toBeDefined();
    expect(first!.name).toBe(JOB_NAMES.marketClose);
    expect(first!.data).toEqual({ marketId: draft.id });
    expect(first!.delay).toBe(Date.parse(opened.closeAt) - Date.parse(opened.openAt!));
    expect(await jobIds()).toEqual([firstId]);

    // An edit that keeps the close time leaves the registration alone.
    const retitled = await patch(`/api/v1/admin/markets/${draft.id}`, { title: '제목만 수정' });
    expect(retitled.statusCode).toBe(200);
    expect(await jobIds()).toEqual([firstId]);

    // A moved close time is a new job (the instant is part of the id) and the old one is gone.
    const laterCloseAt = new Date(Date.now() + 30 * DAY_MS).toISOString();
    const moved = detail(
      await patch(`/api/v1/admin/markets/${draft.id}`, { closeAt: laterCloseAt }),
    );
    expect(moved.closeAt).toBe(laterCloseAt);
    const secondId = marketCloseJobId(draft.id, new Date(laterCloseAt));
    expect(await queue.getJob(firstId)).toBeUndefined();
    const second = await queue.getJob(secondId);
    expect(second).toBeDefined();
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
    expect((await close(draft.id)).statusCode).toBe(200);
    expect(await queue.getJob(secondId)).toBeUndefined();
    expect(await jobIds()).toEqual([]);

    // A void from open drops the close job likewise.
    const opened2 = detail(await open(other.id));
    const thirdId = marketCloseJobId(other.id, new Date(opened2.closeAt));
    expect(await jobIds()).toEqual([thirdId]);
    expect((await voidMarket(other.id)).statusCode).toBe(200);
    expect(await jobIds()).toEqual([]);
  });

  // --- statusEventId ----------------------------------------------------------------------
  it('keys every DTO and every published status by the transition event id (A-M3-19)', async () => {
    const created = detail(await create());
    const [createdEvent] = await eventsFor(created.id);
    expect(created.statusEventId).toBe(String(createdEvent!.id));
    expect((await marketRow(created.id)).statusEventId).toBe(createdEvent!.id);

    const { received, quit } = await subscribeStatus(created.id);
    let opened!: AdminMarket;
    let edited!: AdminMarket;
    let closed!: AdminMarket;
    try {
      opened = detail(await open(created.id));
      // A rules edit is not a transition: it republishes the UNCHANGED key (A-M4-36), which
      // is what lets a client drop the repeat and still refetch the row.
      edited = detail(await patch(`/api/v1/admin/markets/${created.id}`, { rules: '고친 규칙' }));
      closed = detail(await close(created.id));
      await waitForMessages(received, 3, 'market:status of open, edit and close');
      await sleep(100);
      expect(received).toHaveLength(3);
    } finally {
      await quit();
    }

    const events = await eventsFor(created.id);
    expect(events.map((event) => event.type)).toEqual([
      'created',
      'opened',
      'rules_edited',
      'closed',
    ]);
    const [, openedEvent, rulesEvent, closedEvent] = events;
    expect(opened.statusEventId).toBe(String(openedEvent!.id));
    expect(edited.statusEventId).toBe(String(openedEvent!.id));
    expect(edited.statusEventId).not.toBe(String(rulesEvent!.id));
    expect(closed.statusEventId).toBe(String(closedEvent!.id));
    expect(BigInt(closed.statusEventId!)).toBeGreaterThan(BigInt(opened.statusEventId!));
    expect(received.map((event) => [event.status, event.statusEventId])).toEqual([
      ['open', String(openedEvent!.id)],
      ['open', String(openedEvent!.id)],
      ['closed', String(closedEvent!.id)],
    ]);

    // The same key on every read, public and admin, list and detail.
    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${created.id}` });
    expect(data<Market>(pub).statusEventId).toBe(String(closedEvent!.id));
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/markets?status=closed' });
    expect(data<MarketListItem[]>(list).map((item) => [item.id, item.statusEventId])).toEqual([
      [created.id, String(closedEvent!.id)],
    ]);
    expect(detail(await get(`/api/v1/admin/markets/${created.id}`)).statusEventId).toBe(
      String(closedEvent!.id),
    );
    const adminList = await get('/api/v1/admin/markets?status=closed');
    expect(data<MarketSummary[]>(adminList)[0]!.statusEventId).toBe(String(closedEvent!.id));

    // A row written outside the transition paths carries no key (the rank is its fallback).
    const factory = await market({ status: 'open' });
    const bare = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${factory.id}` });
    expect(data<Market>(bare).statusEventId).toBeNull();
  });

  // --- dispute counts ---------------------------------------------------------------------
  it('counts the disputes of a market per status on the admin detail', async () => {
    const row = await market({
      status: 'resolving',
      resolvedResult: 'YES',
      resolvedAt: new Date(),
      disputeUntil: new Date(Date.now() + DAY_MS),
    });
    const other = await market({ status: 'resolving', resolvedResult: 'NO' });
    const filers = [];
    for (let i = 0; i < 4; i += 1) filers.push(await createUser(t.db));
    await createDispute(t.db, { marketId: row.id, userId: filers[0]!.user.id });
    await createDispute(t.db, { marketId: row.id, userId: filers[1]!.user.id, status: 'open' });
    await createDispute(t.db, {
      marketId: row.id,
      userId: filers[2]!.user.id,
      status: 'rejected',
      adminNote: '근거 부족',
    });
    await createDispute(t.db, {
      marketId: other.id,
      userId: filers[3]!.user.id,
      status: 'accepted',
    });

    expect(detail(await get(`/api/v1/admin/markets/${row.id}`)).disputeCounts).toEqual({
      open: 2,
      accepted: 0,
      rejected: 1,
    });
    expect(detail(await get(`/api/v1/admin/markets/${other.id}`)).disputeCounts).toEqual({
      open: 0,
      accepted: 1,
      rejected: 0,
    });
    const untouched = await market({ status: 'open' });
    expect(detail(await get(`/api/v1/admin/markets/${untouched.id}`)).disputeCounts).toEqual({
      open: 0,
      accepted: 0,
      rejected: 0,
    });
    // The public shape never carries them (PLAN 7.1).
    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${row.id}` });
    expect(data<Market>(pub)).not.toHaveProperty('disputeCounts');
  });

  // --- guards -----------------------------------------------------------------------------
  it('is closed to members and anonymous callers', async () => {
    const row = await market({ status: 'closed' });
    const asMember = await resolve(row.id, { result: 'YES' }, member.cookie);
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
});
