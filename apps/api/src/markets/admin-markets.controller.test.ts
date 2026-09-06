/**
 * Admin market CRUD and transitions (PLAN 5.2, 5.5, 12; M3 design 3.4) against the docker
 * `test` profile: create/update per status, open/close/void with their audit rows, the void
 * refund, list/detail, and the guard surface (401/403/CSRF). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { createCategory, createMarket, createPosition, createUser } from '@buddha/db/test';
import {
  SIGNUP_BONUS_P,
  initState,
  marketChannel,
  maxLossP,
  priceOf,
  probabilityBp,
  serializeQuantity,
  userChannel,
  type AdminMarket,
  type Market,
  type MarketSummary,
  type Outcome,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { expectLedgerChain } from '../test/ledger.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const DAY_MS = 24 * 60 * 60 * 1000;
/** U+0000: Postgres refuses it in text and jsonb, so the pipe must refuse it first. */
const NUL = String.fromCharCode(0);

type ListPage = { data: MarketSummary[]; meta: { nextCursor: string | null } };
type ErrorBody = { error: { code: string; details?: { path: (string | number)[] }[] } };

describe.skipIf(!hasTestInfra)('admin markets (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;
  let category: { id: number; slug: string };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    member = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  const future = () => new Date(Date.now() + 7 * DAY_MS).toISOString();

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    title: '기준금리 3% 이하로 인하?',
    rules: '한국은행 발표 기준. 발표가 없으면 아니오.',
    categoryId: category.id,
    closeAt: future(),
    initialProbBp: 5_000,
    liquidityB: 1_000,
    ...overrides,
  });

  const post = (url: string, payload?: Record<string, unknown>, cookie = admin.cookie) =>
    t.app.inject({ method: 'POST', url, headers: { ...jsonHeaders, cookie }, payload });
  const patch = (url: string, payload: Record<string, unknown>, cookie = admin.cookie) =>
    t.app.inject({ method: 'PATCH', url, headers: { ...jsonHeaders, cookie }, payload });
  const get = (url: string, cookie = admin.cookie) =>
    t.app.inject({ method: 'GET', url, headers: { cookie } });

  const create = (overrides: Record<string, unknown> = {}) =>
    post('/api/v1/admin/markets', createBody(overrides));
  const open = (id: string) => post(`/api/v1/admin/markets/${id}/open`);
  const close = (id: string) => post(`/api/v1/admin/markets/${id}/close`);
  const voidMarket = (id: string, reason = '데이터 소스 폐쇄') =>
    post(`/api/v1/admin/markets/${id}/void`, { reason });

  /** A market row written by the factory (no events, no tick) owned by the test admin. */
  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: admin.id, categoryId: category.id, ...input });

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const detail = (res: { json: <U>() => U }) => data<AdminMarket>(res);
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;
  const detailPath = (res: { json: <U>() => U }) => errorOf(res).details?.[0]?.path;

  async function actionsFor(targetId: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, targetId))
      .orderBy(asc(schema.adminActions.createdAt));
  }
  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }
  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row!;
  }
  async function ledgerOf(userId: string) {
    return t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));
  }

  /**
   * A holder the ledger can explain: the position row, the balance debited by its cost and a
   * TRADE_BUY entry — what `POST /trades` writes, minus the market statistics (the trades
   * suite owns that route; this one must not depend on it).
   */
  async function hold(input: {
    userId: string;
    marketId: string;
    outcome: Outcome;
    qty: number;
    costBasisP: bigint;
    realizedPnlP?: bigint;
  }) {
    await createPosition(t.db, input);
    if (input.costBasisP === 0n) return;
    const [balance] = await t.db
      .update(schema.balances)
      .set({ availableP: sql`${schema.balances.availableP} - ${input.costBasisP}` })
      .where(eq(schema.balances.userId, input.userId))
      .returning();
    await t.db.insert(schema.ledgerEntries).values({
      userId: input.userId,
      type: 'TRADE_BUY',
      amountP: -input.costBasisP,
      balanceAfterP: balance!.availableP,
      refType: 'fill',
      refId: '0',
    });
  }

  // --- create ---------------------------------------------------------------------------
  it('creates a draft with LMSR state from (p0, b), reserve = maxLossP and an audit trail', async () => {
    const res = await create({ initialProbBp: 3_000, liquidityB: 1_500.5, slug: 'rate-cut-2026' });
    expect(res.statusCode).toBe(201);
    const created = detail(res);
    const state = initState(0.3, 1_500.5);
    expect(created).toMatchObject({
      slug: 'rate-cut-2026',
      title: '기준금리 3% 이하로 인하?',
      status: 'draft',
      category: { slug: 'economy', nameKo: '경제' },
      liquidityB: '1500.500000',
      qYes: serializeQuantity(state.qYes),
      qNo: serializeQuantity(state.qNo),
      initialProbBp: 3_000,
      reserveP: maxLossP(0.3, 1_500.5).toString(),
      lastPrice: priceOf(state),
      pYesBp: probabilityBp(state),
      volumeP: '0',
      tradeCount: 0,
      openAt: null,
      createdBy: admin.id,
      netCollectedP: '0',
      openInterest: { yes: 0, no: 0 },
      description: null,
      imageUrl: null,
    });
    // Not the PLAN 5.3 guide value 100·b·ln2: p0 ≠ 0.5 (ADR-0027).
    expect(BigInt(created.reserveP)).toBeGreaterThan(BigInt(Math.ceil(100 * 1_500.5 * Math.LN2)));
    expect(created.events.map((event) => event.type)).toEqual(['created']);
    expect(created.events[0]).toMatchObject({
      actorId: admin.id,
      payload: { slug: 'rate-cut-2026' },
    });

    const [action] = await actionsFor(created.id);
    expect(action).toMatchObject({
      adminId: admin.id,
      type: 'market_create',
      targetType: 'market',
    });
    // jsonb payloads are JSON-safe: P amounts crossed as strings, never bigint.
    const after = (action!.payload as { after: Record<string, unknown> }).after;
    expect(after).toMatchObject({
      slug: 'rate-cut-2026',
      status: 'draft',
      reserveP: created.reserveP,
    });
    expect(typeof after.volumeP).toBe('string');

    // Drafts are the admin's alone.
    expect((await get(`/api/v1/admin/markets/${created.id}`)).statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/v1/markets/${created.id}` })).statusCode,
    ).toBe(404);
  });

  it('derives a slug from the title when none is given, or from a tag alone', async () => {
    const fromTitle = detail(await create({ title: '비트코인 10만 달러 돌파?' }));
    expect(fromTitle.slug).toMatch(/^비트코인-10만-달러-돌파-[a-z0-9]{4}$/);
    const fromTag = detail(await create({ title: '🚀🚀🚀' }));
    expect(fromTag.slug).toMatch(/^market-[a-z0-9]{4}$/);
    // Two markets with one title get two slugs.
    const twin = detail(await create({ title: '비트코인 10만 달러 돌파?' }));
    expect(twin.slug).not.toBe(fromTitle.slug);
  });

  it('refuses a taken, uuid-shaped or malformed slug naming the field; stores NFC', async () => {
    await market({ slug: 'taken-slug' });
    const taken = await create({ slug: 'taken-slug' });
    expect(taken.statusCode).toBe(400);
    expect(errorOf(taken).code).toBe('VALIDATION_ERROR');
    expect(detailPath(taken)).toEqual(['slug']);
    // Nothing of the refused create is left behind.
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);

    for (const slug of [randomUUID(), 'ab', 'Upper-Case', 'has space', 'a'.repeat(81)]) {
      const res = await create({ slug });
      expect({ slug, status: res.statusCode }).toEqual({ slug, status: 400 });
      expect(detailPath(res)).toEqual(['slug']);
    }

    const nfd = '한글-슬러그'.normalize('NFD');
    const created = detail(await create({ slug: nfd }));
    expect(created.slug).toBe('한글-슬러그');
    expect((await marketRow(created.id)).slug).toBe('한글-슬러그');
  });

  it('validates the category, the close time and the body; a draft may have blank rules', async () => {
    const unknown = await create({ categoryId: 999_999 });
    expect(unknown.statusCode).toBe(404);
    expect(detailPath(unknown)).toEqual(['categoryId']);

    const retired = await createCategory(t.db, { isActive: false });
    const inactive = await create({ categoryId: retired.id });
    expect(inactive.statusCode).toBe(400);
    expect(detailPath(inactive)).toEqual(['categoryId']);

    const past = await create({ closeAt: new Date(Date.now() - 1_000).toISOString() });
    expect(past.statusCode).toBe(400);
    expect(detailPath(past)).toEqual(['closeAt']);

    for (const bad of [
      { title: '' },
      { initialProbBp: 0 },
      { initialProbBp: 10_000 },
      { liquidityB: 0.5 },
      { liquidityB: 1.1234567 },
      { imageUrl: 'javascript:alert(1)' },
      { closeAt: 'tomorrow' },
    ]) {
      const res = await create(bad);
      expect({ bad, status: res.statusCode }).toEqual({ bad, status: 400 });
    }
    // A NUL inside otherwise valid text is bad input naming the field, not a driver 500.
    const nul = await create({ title: `기준금리${NUL} 인하?` });
    expect(nul.statusCode).toBe(400);
    expect(errorOf(nul)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: ['title'], message: 'must not contain NUL' }],
    });
    expect(await t.db.select().from(schema.markets)).toHaveLength(0);

    const blank = detail(await create({ rules: '   ' }));
    expect(blank).toMatchObject({ status: 'draft', rules: '   ' });
  });

  // --- update ---------------------------------------------------------------------------
  it('re-initialises a draft on a new initialProbBp, and logs a rules edit', async () => {
    const draft = detail(await create({ initialProbBp: 5_000, liquidityB: 1_000 }));
    const res = await patch(`/api/v1/admin/markets/${draft.id}`, {
      initialProbBp: 7_000,
      rules: '새 규칙: 한국은행 홈페이지 공지 기준.',
      description: '설명 추가',
    });
    expect(res.statusCode).toBe(200);
    const updated = detail(res);
    const state = initState(0.7, 1_000);
    expect(updated).toMatchObject({
      initialProbBp: 7_000,
      qYes: serializeQuantity(state.qYes),
      qNo: '0.0000000000',
      lastPrice: 70,
      pYesBp: 7_000,
      reserveP: maxLossP(0.7, 1_000).toString(),
      rules: '새 규칙: 한국은행 홈페이지 공지 기준.',
      description: '설명 추가',
    });
    expect(updated.events.map((event) => event.type)).toEqual(['rules_edited', 'created']);
    expect(updated.events[0]!.payload).toEqual({
      before: draft.rules,
      after: '새 규칙: 한국은행 홈페이지 공지 기준.',
    });

    const actions = await actionsFor(draft.id);
    expect(actions.map((action) => action.type)).toEqual(['market_create', 'market_update']);
    expect(actions[1]!.payload).toMatchObject({
      before: { initialProbBp: 5_000, lastPrice: 50 },
      after: { initialProbBp: 7_000, lastPrice: 70 },
    });

    // A liquidity change alone re-runs the same init; the same rules are no rules edit.
    const again = detail(
      await patch(`/api/v1/admin/markets/${draft.id}`, {
        liquidityB: 2_000,
        rules: '새 규칙: 한국은행 홈페이지 공지 기준. ',
      }),
    );
    expect(again).toMatchObject({
      liquidityB: '2000.000000',
      qYes: serializeQuantity(initState(0.7, 2_000).qYes),
      reserveP: maxLossP(0.7, 2_000).toString(),
    });
    expect(again.events.filter((event) => event.type === 'rules_edited')).toHaveLength(1);

    // Slug and category can change while draft; a taken slug is refused naming it.
    await market({ slug: 'other-slug' });
    const collision = await patch(`/api/v1/admin/markets/${draft.id}`, { slug: 'other-slug' });
    expect(collision.statusCode).toBe(400);
    expect(detailPath(collision)).toEqual(['slug']);
    const empty = await patch(`/api/v1/admin/markets/${draft.id}`, {});
    expect(empty.statusCode).toBe(400);
    const missing = await patch(`/api/v1/admin/markets/${randomUUID()}`, { title: 'x' });
    expect(missing.statusCode).toBe(404);
  });

  it('lets an open market change its text, close time and category, but not its curve', async () => {
    const row = await market({ status: 'open' });
    const ok = await patch(`/api/v1/admin/markets/${row.id}`, {
      title: '제목 수정',
      closeAt: future(),
      resolutionSource: null,
      imageUrl: 'https://example.com/cover.png',
    });
    expect(ok.statusCode).toBe(200);
    expect(detail(ok)).toMatchObject({
      title: '제목 수정',
      resolutionSource: null,
      imageUrl: 'https://example.com/cover.png',
      status: 'open',
    });

    for (const [field, value] of [
      ['liquidityB', 2_000],
      ['initialProbBp', 6_000],
      ['slug', 'new-slug'],
    ] as const) {
      const res = await patch(`/api/v1/admin/markets/${row.id}`, { [field]: value });
      expect({ field, status: res.statusCode }).toEqual({ field, status: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(detailPath(res)).toEqual([field]);
    }
    // Refused before anything is written: one audit row, the successful edit's.
    expect((await actionsFor(row.id)).map((action) => action.type)).toEqual(['market_update']);
    expect((await marketRow(row.id)).liquidityB).toBe(row.liquidityB);

    const closed = await market({ status: 'closed' });
    const refused = await patch(`/api/v1/admin/markets/${closed.id}`, { title: '늦은 수정' });
    expect(refused.statusCode).toBe(400);
    expect(detailPath(refused)).toEqual(['status']);
    expect(errorOf(refused)).toMatchObject({ message: 'Market is closed' });
  });

  // --- open / close ---------------------------------------------------------------------
  it('opens a draft: open_at, the "open" tick, the "opened" event, an audit row and a publish', async () => {
    const draft = detail(await create({ initialProbBp: 4_000 }));
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel, message) => received.push(message));
    await subscriber.subscribe(marketChannel(draft.id));
    try {
      const res = await open(draft.id);
      expect(res.statusCode).toBe(200);
      const opened = detail(res);
      expect(opened.status).toBe('open');
      expect(opened.openAt).not.toBeNull();
      expect(opened.events.map((event) => event.type)).toEqual(['opened', 'created']);

      const ticks = await t.db
        .select()
        .from(schema.priceTicks)
        .where(eq(schema.priceTicks.marketId, draft.id));
      expect(ticks).toHaveLength(1);
      expect(ticks[0]).toMatchObject({ trigger: 'open', pYesBp: 4_000 });
      expect(ticks[0]!.ts.toISOString()).toBe(opened.openAt);

      const actions = await actionsFor(draft.id);
      expect(actions.map((action) => action.type)).toEqual(['market_create', 'market_open']);
      expect(actions[1]!.payload).toMatchObject({
        before: { status: 'draft', openAt: null },
        after: { status: 'open', openAt: opened.openAt },
      });

      // Visible to the public now, with the same tick on the chart.
      const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${draft.id}` });
      expect(pub.statusCode).toBe(200);
      expect(data<Market>(pub)).toMatchObject({ status: 'open', pYesBp: 4_000 });
      const chart = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${draft.id}/ticks` });
      expect(data<unknown[]>(chart)).toEqual([
        { ts: opened.openAt, pYesBp: 4_000, trigger: 'open' },
      ]);

      // PLAN 8: `market:status` published after commit on the market's channel.
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (received.length >= 1) return resolve();
          if (Date.now() - started > 5_000) return reject(new Error('market:status not received'));
          setTimeout(poll, 20);
        };
        poll();
      });
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        marketId: draft.id,
        status: 'open',
      });

      // Twice: the second open finds an open market, which is a status error, not a no-op.
      const twice = await open(draft.id);
      expect(twice.statusCode).toBe(400);
      expect(errorOf(twice).code).toBe('VALIDATION_ERROR');
      expect(detailPath(twice)).toEqual(['status']);
      expect(await actionsFor(draft.id)).toHaveLength(2);
    } finally {
      await subscriber.quit();
    }
  });

  it('refuses to open without rules (RULES_REQUIRED) or past the close time; 404 unknown', async () => {
    const blank = detail(await create({ rules: '  \n ' }));
    const res = await open(blank.id);
    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toMatchObject({ code: 'RULES_REQUIRED', details: [{ path: ['rules'] }] });
    expect((await marketRow(blank.id)).status).toBe('draft');
    expect(await t.db.select().from(schema.priceTicks)).toHaveLength(0);

    // Rules added later make it openable.
    await patch(`/api/v1/admin/markets/${blank.id}`, { rules: '규칙 추가' });
    expect((await open(blank.id)).statusCode).toBe(200);

    const stale = await market({ status: 'draft', closeAt: new Date(Date.now() - 1_000) });
    const past = await open(stale.id);
    expect(past.statusCode).toBe(400);
    expect(detailPath(past)).toEqual(['closeAt']);
    expect((await marketRow(stale.id)).status).toBe('draft');

    expect((await open(randomUUID())).statusCode).toBe(404);
    expect((await open('not-a-uuid')).statusCode).toBe(400);
  });

  it('closes an open market and answers MARKET_NOT_OPEN for anything else', async () => {
    const row = await market({ status: 'open' });
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel, message) => received.push(message));
    await subscriber.subscribe(marketChannel(row.id));
    let closed!: AdminMarket;
    try {
      const res = await close(row.id);
      expect(res.statusCode).toBe(200);
      closed = detail(res);
      // PLAN 8: exactly one `market:status` on the market's channel, after commit.
      await waitForMessages(received, 1, 'market:status of the close');
      await sleep(100);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        marketId: row.id,
        status: 'closed',
      });
    } finally {
      await subscriber.quit();
    }
    expect(closed.status).toBe('closed');
    expect(closed.events.map((event) => event.type)).toEqual(['closed']);
    const actions = await actionsFor(row.id);
    expect(actions.map((action) => action.type)).toEqual(['market_close']);
    expect(actions[0]).toMatchObject({ adminId: admin.id, targetType: 'market' });
    expect(actions[0]!.payload).toMatchObject({
      before: { status: 'open' },
      after: { status: 'closed' },
    });

    const again = await close(row.id);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('MARKET_NOT_OPEN');

    const draft = await market({ status: 'draft' });
    const onDraft = await close(draft.id);
    expect(onDraft.statusCode).toBe(409);
    expect(errorOf(onDraft).code).toBe('MARKET_NOT_OPEN');
    expect((await marketRow(draft.id)).status).toBe('draft');
    expect(await actionsFor(draft.id)).toHaveLength(0);
  });

  it.each([
    ['open', 'draft', open],
    ['close', 'open', close],
    ['void', 'open', (id: string) => voidMarket(id)],
  ] as const)(
    '%s waits for the market advisory lock before touching the row (PLAN 0.2)',
    async (_name, status, transition) => {
      // A session-level lock on the same key from another connection stands in for a trade
      // (or another transition) holding the transaction-level one. The row `FOR UPDATE`
      // alone would not show this: the fixture row is unlocked, so a transition that skipped
      // `lockMarket` would go straight through.
      const row = await market({ status });
      const holder = await t.db.$client.connect();
      let released = false;
      try {
        await holder.query('SELECT pg_advisory_lock(hashtext($1))', [row.id]);
        // light-my-request dispatches lazily: `.then` is what sends the request.
        const pending = transition(row.id).then((res) => res);
        await sleep(300);
        expect((await marketRow(row.id)).status).toBe(status);
        expect(await actionsFor(row.id)).toHaveLength(0);

        await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [row.id]);
        released = true;
        const res = await pending;
        expect(res.statusCode).toBe(200);
        expect((await marketRow(row.id)).status).not.toBe(status);
        expect(await actionsFor(row.id)).toHaveLength(1);
      } finally {
        if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
        holder.release();
      }
    },
  );

  // --- void -----------------------------------------------------------------------------
  it('voids a market: every unsettled holder gets its cost basis back, ledger-explained', async () => {
    const row = await market({ status: 'closed', title: '무효될 시장' });
    const alice = (await createUser(t.db)).user.id;
    const bob = (await createUser(t.db)).user.id;
    const carol = (await createUser(t.db)).user.id;
    // alice holds both outcomes; bob sold out (qty 0) but keeps realised PnL and no cost;
    // carol's position is already settled and must be left alone.
    await hold({ userId: alice, marketId: row.id, outcome: 'YES', qty: 10, costBasisP: 520n });
    await hold({ userId: alice, marketId: row.id, outcome: 'NO', qty: 4, costBasisP: 190n });
    await hold({
      userId: bob,
      marketId: row.id,
      outcome: 'YES',
      qty: 0,
      costBasisP: 0n,
      realizedPnlP: 35n,
    });
    await createPosition(t.db, {
      userId: carol,
      marketId: row.id,
      outcome: 'NO',
      qty: 3,
      costBasisP: 150n,
      settled: true,
    });
    // A holder in another market is untouched.
    const other = await market({ status: 'open' });
    await hold({ userId: bob, marketId: other.id, outcome: 'NO', qty: 2, costBasisP: 90n });

    // PLAN 8: the market's channel hears the status change, and alice's own channel her
    // refunded balance and both closed-out rows.
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    const statuses: string[] = [];
    subscriber.on('message', (channel: string, message: string) => {
      (channel === marketChannel(row.id) ? statuses : received).push(message);
    });
    await subscriber.subscribe(marketChannel(row.id), userChannel(alice));
    let voided!: AdminMarket;
    try {
      const res = await voidMarket(row.id, '데이터 소스 폐쇄');
      expect(res.statusCode).toBe(200);
      voided = detail(res);

      await waitForMessages(statuses, 1, 'market:status of the void');
      await waitForMessages(received, 3, 'user events of the void');
      await sleep(100);
      expect(statuses).toHaveLength(1);
      expect(JSON.parse(statuses[0]!)).toMatchObject({
        type: 'market:status',
        marketId: row.id,
        status: 'voided',
        ts: voided.voidedAt,
      });
      const events = received.map((message) => JSON.parse(message) as Record<string, unknown>);
      // The balance event carries alice's last refund instant (stamped after her balance
      // lock), the position events the void's own; see the ordering test below.
      const lastRefund = (await ledgerOf(alice))
        .filter((entry) => entry.type === 'MARKET_VOID_REFUND')
        .at(-1)!;
      expect(events).toEqual([
        {
          type: 'user:balance',
          availableP: SIGNUP_BONUS_P.toString(),
          lockedP: '0',
          ts: lastRefund.createdAt.toISOString(),
        },
        {
          type: 'user:position',
          marketId: row.id,
          outcome: 'YES',
          qty: 0,
          costBasisP: '0',
          realizedPnlP: '0',
          ts: voided.voidedAt,
        },
        {
          type: 'user:position',
          marketId: row.id,
          outcome: 'NO',
          qty: 0,
          costBasisP: '0',
          realizedPnlP: '0',
          ts: voided.voidedAt,
        },
      ]);
    } finally {
      await subscriber.quit();
    }
    expect(voided.status).toBe('voided');
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.openInterest).toEqual({ yes: 0, no: 0 });
    expect(voided.events.map((event) => event.type)).toEqual(['voided']);
    expect(voided.events[0]!.payload).toEqual({
      reason: '데이터 소스 폐쇄',
      refundedAccounts: 1,
      refundedP: '710',
    });

    // alice: bonus − 520 − 190 + 520 + 190 = bonus, and the ledger says so entry by entry.
    expect((await balanceOf(alice)).availableP).toBe(SIGNUP_BONUS_P);
    const aliceLedger = await ledgerOf(alice);
    expect(aliceLedger.map((entry) => entry.type)).toEqual([
      'BONUS',
      'TRADE_BUY',
      'TRADE_BUY',
      'MARKET_VOID_REFUND',
      'MARKET_VOID_REFUND',
    ]);
    const refunds = aliceLedger.filter((entry) => entry.type === 'MARKET_VOID_REFUND');
    // Deterministic (user_id, outcome) order; `outcome` is a Postgres enum, so YES (declared
    // first) sorts before NO.
    expect(refunds.map((entry) => entry.amountP)).toEqual([520n, 190n]);
    for (const entry of refunds) {
      expect(entry).toMatchObject({
        refType: 'market',
        refId: row.id,
        memo: '무효 환불: 무효될 시장',
      });
    }
    expect(aliceLedger.reduce((sum, entry) => sum + entry.amountP, 0n)).toBe(
      (await balanceOf(alice)).availableP,
    );
    expect(refunds.at(-1)!.balanceAfterP).toBe(SIGNUP_BONUS_P);
    // Each refund is stamped after its balance lock: no earlier than the void itself, in
    // refund order, and the balance row carries the last one.
    expect(refunds[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(Date.parse(voided.voidedAt!));
    expect(refunds[1]!.createdAt.getTime()).toBeGreaterThanOrEqual(refunds[0]!.createdAt.getTime());
    expect((await balanceOf(alice)).updatedAt.getTime()).toBe(refunds[1]!.createdAt.getTime());
    expectLedgerChain(aliceLedger, (await balanceOf(alice)).availableP);

    // bob: nothing to refund, no ledger row, but the row is closed out; his other market stands.
    expect((await balanceOf(bob)).availableP).toBe(SIGNUP_BONUS_P - 90n);
    expect((await ledgerOf(bob)).map((entry) => entry.type)).toEqual(['BONUS', 'TRADE_BUY']);

    const positions = await t.db
      .select()
      .from(schema.positions)
      .where(eq(schema.positions.marketId, row.id))
      .orderBy(asc(schema.positions.userId), asc(schema.positions.outcome));
    expect(positions).toHaveLength(4);
    for (const position of positions.filter((p) => p.userId !== carol)) {
      expect(position).toMatchObject({ qty: 0, costBasisP: 0n, settled: true });
    }
    // Already settled before the void: not refunded, not rewritten.
    expect(positions.find((p) => p.userId === carol)).toMatchObject({
      qty: 3,
      costBasisP: 150n,
      settled: true,
    });
    expect((await ledgerOf(carol)).map((entry) => entry.type)).toEqual(['BONUS']);
    expect(positions.find((p) => p.userId === bob)!.realizedPnlP).toBe(35n);
    expect(positions.find((p) => p.userId === alice && p.outcome === 'YES')!.realizedPnlP).toBe(0n);
    const [untouched] = await t.db
      .select()
      .from(schema.positions)
      .where(and(eq(schema.positions.marketId, other.id), eq(schema.positions.userId, bob)));
    expect(untouched).toMatchObject({ qty: 2, costBasisP: 90n, settled: false });

    const [action] = await actionsFor(row.id);
    expect(action).toMatchObject({ type: 'market_void', adminId: admin.id });
    expect(action!.payload).toMatchObject({
      reason: '데이터 소스 폐쇄',
      refundedAccounts: 1,
      refundedP: '710',
      before: { status: 'closed' },
      after: { status: 'voided', voidedAt: voided.voidedAt },
    });

    // Once voided, a second void (or a close) is a status error.
    const again = await voidMarket(row.id);
    expect(again.statusCode).toBe(400);
    expect(detailPath(again)).toEqual(['status']);
    expect((await ledgerOf(alice)).filter((e) => e.type === 'MARKET_VOID_REFUND')).toHaveLength(2);
  });

  it('stamps each refund after its balance lock, so the ledger keeps commit order', async () => {
    // The void's transaction begins (its `now()` is fixed) and waits on the market lock;
    // while it waits alice buys elsewhere and that TRADE_BUY commits. Her refund runs after
    // it and includes it in balance_after_p, so it must sort after it in `/me/ledger` too —
    // the column default (transaction start) would put it before.
    const row = await market({ status: 'closed' });
    const elsewhere = await market({ status: 'open' });
    const alice = (await createUser(t.db)).user.id;
    await hold({ userId: alice, marketId: row.id, outcome: 'YES', qty: 10, costBasisP: 520n });

    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(userChannel(alice));
    const holder = await t.db.$client.connect();
    let pending: ReturnType<typeof voidMarket> | undefined;
    let released = false;
    let voided!: AdminMarket;
    let releasedMs!: number;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [row.id]);
      pending = voidMarket(row.id).then((res) => res);
      await waitForLockWaiter(holder, 'the void on the market lock');
      expect((await marketRow(row.id)).status).toBe('closed');
      await hold({ userId: alice, marketId: elsewhere.id, outcome: 'NO', qty: 2, costBasisP: 90n });
      // The database clock just before the release, in the expression the services use.
      const { rows } = await holder.query<{ ms: string }>(
        'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms',
      );
      releasedMs = Number(rows[0]!.ms);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [row.id]);
      released = true;
      const res = await pending;
      expect(res.statusCode).toBe(200);
      voided = detail(res);
      await waitForMessages(received, 2, 'user events of the void');
    } finally {
      if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
      await pending?.catch(() => undefined);
      await subscriber.quit();
    }

    const ledger = await ledgerOf(alice);
    expect(ledger.map((entry) => entry.type)).toEqual([
      'BONUS',
      'TRADE_BUY',
      'TRADE_BUY',
      'MARKET_VOID_REFUND',
    ]);
    const trade = ledger[2]!;
    const refund = ledger[3]!;
    expect(refund.balanceAfterP).toBe(SIGNUP_BONUS_P - 90n);
    expect(refund.createdAt.getTime()).toBeGreaterThanOrEqual(trade.createdAt.getTime());
    expectLedgerChain(ledger, (await balanceOf(alice)).availableP);
    // The void itself is stamped after the market lock, the refund after the balance lock.
    expect(Date.parse(voided.voidedAt!)).toBeGreaterThanOrEqual(releasedMs);
    expect(refund.createdAt.getTime()).toBeGreaterThanOrEqual(Date.parse(voided.voidedAt!));
    expect((await balanceOf(alice)).updatedAt.getTime()).toBe(refund.createdAt.getTime());
    expect(received.map((message) => JSON.parse(message) as Record<string, unknown>)).toEqual([
      {
        type: 'user:balance',
        availableP: (SIGNUP_BONUS_P - 90n).toString(),
        lockedP: '0',
        ts: refund.createdAt.toISOString(),
      },
      {
        type: 'user:position',
        marketId: row.id,
        outcome: 'YES',
        qty: 0,
        costBasisP: '0',
        realizedPnlP: '0',
        ts: voided.voidedAt,
      },
    ]);
  });

  it('takes an upper-case path id and records the canonical one in the audit and ledger rows', async () => {
    // The path parameter is lower-cased at the boundary (api/uuid.ts) and the rows that keep
    // an id as text — admin_actions.target_id, the refund's ledger ref_id — are written from
    // the locked row, so neither can hold a spelling that no lookup would match.
    const row = await market({ status: 'closed' });
    const alice = (await createUser(t.db)).user.id;
    await hold({ userId: alice, marketId: row.id, outcome: 'YES', qty: 10, costBasisP: 520n });

    const res = await voidMarket(row.id.toUpperCase());
    expect(res.statusCode).toBe(200);
    expect(detail(res).id).toBe(row.id);
    const refund = (await ledgerOf(alice)).find((entry) => entry.type === 'MARKET_VOID_REFUND');
    expect(refund).toMatchObject({ refId: row.id });
    const [action] = await actionsFor(row.id);
    expect(action).toMatchObject({ type: 'market_void', targetId: row.id });
    expect((await get(`/api/v1/admin/markets/${row.id.toUpperCase()}`)).statusCode).toBe(200);
  });

  it('voids open and resolving markets without positions, and refuses draft/settled/voided', async () => {
    for (const status of ['open', 'resolving'] as const) {
      const row = await market({ status });
      const res = await voidMarket(row.id);
      expect({ status, code: res.statusCode }).toEqual({ status, code: 200 });
      expect(detail(res)).toMatchObject({ status: 'voided' });
      expect(detail(res).events[0]!.payload).toMatchObject({ refundedAccounts: 0, refundedP: '0' });
    }
    for (const status of ['draft', 'settled', 'voided'] as const) {
      const row = await market({ status });
      const res = await voidMarket(row.id);
      expect({ status, code: res.statusCode }).toEqual({ status, code: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(detailPath(res)).toEqual(['status']);
      expect((await marketRow(row.id)).status).toBe(status);
      expect(await actionsFor(row.id)).toHaveLength(0);
    }
    const noReason = await post(`/api/v1/admin/markets/${(await market()).id}/void`, {
      reason: ' ',
    });
    expect(noReason.statusCode).toBe(400);
    expect((await voidMarket(randomUUID())).statusCode).toBe(404);
  });

  // --- list / detail --------------------------------------------------------------------
  it('lists every status including drafts, newest first, with a keyset cursor', async () => {
    const ids: string[] = [];
    const base = Date.now() - 60 * 60 * 1000;
    const rows: { id: string; createdAt: Date }[] = [];
    for (const [i, status] of (['draft', 'open', 'closed', 'draft', 'voided'] as const).entries()) {
      const row = await market({ status });
      ids.push(row.id);
      // Pairs share a created_at, so the id half of the keyset is what orders them.
      const createdAt = new Date(base + Math.floor(i / 2) * 1_000);
      await t.db.update(schema.markets).set({ createdAt }).where(eq(schema.markets.id, row.id));
      rows.push({ id: row.id, createdAt });
    }
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const expected = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byId(b, a))
      .map((row) => row.id);

    const all = await get('/api/v1/admin/markets?limit=3');
    expect(all.statusCode).toBe(200);
    const first = all.json<ListPage>();
    expect(first.data).toHaveLength(3);
    expect(first.meta.nextCursor).toBeTypeOf('string');
    const second = get(
      `/api/v1/admin/markets?limit=3&cursor=${encodeURIComponent(first.meta.nextCursor!)}`,
    );
    const rest = (await second).json<ListPage>();
    expect(rest.data).toHaveLength(2);
    expect(rest.meta.nextCursor).toBeNull();
    const seen = [...first.data, ...rest.data].map((row) => row.id);
    expect(new Set(seen).size).toBe(5);
    // Exact order: created_at desc, id desc as the tiebreak (the public list's keyset).
    expect(seen).toEqual(expected);
    expect([...seen].sort()).toEqual([...ids].sort());

    const drafts = get('/api/v1/admin/markets?status=draft');
    expect((await drafts).json<ListPage>().data.map((row) => row.status)).toEqual([
      'draft',
      'draft',
    ]);
    expect((await get('/api/v1/admin/markets?status=nope')).statusCode).toBe(400);
  });

  it('shows the LMSR state, net collected P, open interest and the event log on the detail', async () => {
    const row = await market({ status: 'open', qYes: 250, qNo: 30 });
    const trader = (await createUser(t.db)).user.id;
    await hold({ userId: trader, marketId: row.id, outcome: 'YES', qty: 12, costBasisP: 600n });
    await hold({ userId: trader, marketId: row.id, outcome: 'NO', qty: 5, costBasisP: 200n });
    await createPosition(t.db, {
      userId: (await createUser(t.db)).user.id,
      marketId: row.id,
      outcome: 'YES',
      qty: 7,
      costBasisP: 300n,
      settled: true,
    });
    const [order] = await t.db
      .insert(schema.orders)
      .values({
        userId: trader,
        marketId: row.id,
        outcome: 'YES',
        side: 'buy',
        type: 'market',
        qty: 12,
        filledQty: 12,
        status: 'filled',
        idempotencyKey: randomUUID(),
      })
      .returning();
    await t.db.insert(schema.fills).values([
      {
        marketId: row.id,
        orderId: order!.id,
        counterpartyType: 'amm',
        outcome: 'YES',
        side: 'buy',
        qty: 12,
        amountP: 600n,
        priceAvgBp: 5_000,
      },
      {
        marketId: row.id,
        orderId: order!.id,
        counterpartyType: 'amm',
        outcome: 'YES',
        side: 'sell',
        qty: 2,
        amountP: 110n,
        priceAvgBp: 5_500,
      },
    ]);
    await t.db.insert(schema.marketEvents).values([
      { marketId: row.id, type: 'created', actorId: admin.id, payload: { source: 'test' } },
      { marketId: row.id, type: 'opened', actorId: null, payload: null },
    ]);

    const res = await get(`/api/v1/admin/markets/${row.id}`);
    expect(res.statusCode).toBe(200);
    const shown = detail(res);
    expect(shown).toMatchObject({
      id: row.id,
      qYes: '250.0000000000',
      qNo: '30.0000000000',
      liquidityB: '1000.000000',
      initialProbBp: 5_000,
      reserveP: maxLossP(0.5, 1_000).toString(),
      createdBy: admin.id,
      netCollectedP: '490',
      openInterest: { yes: 12, no: 5 },
      pYesBp: probabilityBp({ qYes: 250, qNo: 30, b: 1_000 }),
    });
    expect(shown.events.map((event) => [event.type, event.actorId])).toEqual([
      ['opened', null],
      ['created', admin.id],
    ]);
    expect(shown.events[1]!.payload).toEqual({ source: 'test' });

    expect((await get(`/api/v1/admin/markets/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get('/api/v1/admin/markets/nope')).statusCode).toBe(400);
  });

  // --- guards ---------------------------------------------------------------------------
  it('is closed to members and anonymous callers, on reads and writes alike', async () => {
    const row = await market({ status: 'draft' });
    for (const [method, url, payload] of [
      ['GET', '/api/v1/admin/markets', undefined],
      ['GET', `/api/v1/admin/markets/${row.id}`, undefined],
      ['POST', '/api/v1/admin/markets', createBody()],
      ['PATCH', `/api/v1/admin/markets/${row.id}`, { title: 'x' }],
      ['POST', `/api/v1/admin/markets/${row.id}/open`, undefined],
      ['POST', `/api/v1/admin/markets/${row.id}/close`, undefined],
      ['POST', `/api/v1/admin/markets/${row.id}/void`, { reason: 'x' }],
    ] as const) {
      const asMember = await t.app.inject({
        method,
        url,
        headers: { ...jsonHeaders, cookie: member.cookie },
        payload,
      });
      expect({ method, url, status: asMember.statusCode }).toEqual({ method, url, status: 403 });
      expect(errorOf(asMember).code).toBe('FORBIDDEN');

      const anonymous = await t.app.inject({ method, url, headers: jsonHeaders, payload });
      expect({ method, url, status: anonymous.statusCode }).toEqual({ method, url, status: 401 });
      expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
    }
    expect((await marketRow(row.id)).status).toBe('draft');
    expect(await t.db.select().from(schema.markets)).toHaveLength(1);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
  });

  it('refuses a cookie-authenticated mutation whose Origin is not ours (CSRF)', async () => {
    const row = await market({ status: 'draft' });
    for (const origin of ['https://evil.example', 'null']) {
      const created = await t.app.inject({
        method: 'POST',
        url: '/api/v1/admin/markets',
        headers: { origin, 'content-type': 'application/json', cookie: admin.cookie },
        payload: createBody(),
      });
      expect({ origin, status: created.statusCode }).toEqual({ origin, status: 403 });
      expect(errorOf(created).code).toBe('FORBIDDEN');
      const opened = await t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/markets/${row.id}/open`,
        headers: { origin, cookie: admin.cookie },
      });
      expect(opened.statusCode).toBe(403);
    }
    expect(await t.db.select().from(schema.markets)).toHaveLength(1);
    expect((await marketRow(row.id)).status).toBe('draft');
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);

    // No Origin at all (curl, a server) is not a browser and passes; reads are never checked.
    const curl = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${row.id}/open`,
      headers: { cookie: admin.cookie },
    });
    expect(curl.statusCode).toBe(200);
    const read = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/markets',
      headers: { origin: 'https://evil.example', cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
  });
});
