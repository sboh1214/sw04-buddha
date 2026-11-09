/**
 * 주문 접수와 본인의 주문·체결 (#119, ADR-0112) through the API against the docker `test` profile:
 * `POST /markets/:id/orders` and `/me/orders`, `/me/fills`, and the admin's after-open change of a
 * market's 가격 보호 폭. Skips when TEST_* are unset (fails under CI=true, see the harness). The
 * intake itself (every path, lock, race and invariant) is packages/db orders.test.ts's; here are
 * the checks that answer an error and write no row, the race of the service's own locks with a
 * role grant, the answers' shapes, the owner's reads, the order limit and the realtime events.
 * And the owner's cancel (#178, ADR-0113: `POST /me/orders/:id/cancel`): the final state as the
 * answer, the lock back, nothing revealed of another account's order, no order limit, intake,
 * onboarding, restriction or role check, the ledger-held market's refusal, and its race with a
 * crossing order; the cancel processing itself is packages/db order-cancel.test.ts's. And the
 * `market:book` signal (#179, ADR-0114) both publish after COMMIT when the live book changed, and
 * an intake that filled publishes its anonymous `market:trade` rows and one `market:tick` after it
 * (#121, ADR-0116).
 */
import { randomUUID } from 'node:crypto';
import { lockAdminRoles, lockLedgerAccounts, lockMarket, schema } from '@buddha/db';
import {
  balanceOf,
  checkOrderInvariants,
  closeTestMarket,
  completeOnboarding,
  createMarket,
  createMarketPause,
  createModerationAction,
  createStartGrant,
  createUser,
  fundMarketMakerFunds,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  resumeMarket,
  setReleaseSetting,
  TEST_PRICE_PROTECTION_TICKS,
  tradeOnce,
} from '@buddha/db/test';
import {
  ORDER_ACCEPTING_SETTING,
  ORDER_RATE_LIMIT_SETTING,
  orderBookSchema,
  marketTickEventSchema,
  marketTradeEventSchema,
  myFillSchema,
  orderSchema,
  placeOrderResultSchema,
  type AdminMarket,
  type Fill,
  type Market,
  type MarketRealtimeEvent,
  type MyFill,
  type Order,
  type PlaceOrderResult,
} from '@buddha/shared';
import { count, eq } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { OrderService } from './order.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const ORIGIN = 'http://localhost:3000';

/** Each member's start Coin. */
const START_COIN = 10_000n;

type MarketRow = typeof schema.markets.$inferSelect;
type Res = { statusCode: number; body: string; headers: Record<string, unknown> };

describe.skipIf(!hasTestInfra)('orders (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let a: TestUser;
  let b: TestUser;
  /** OPEN, width TEST_PRICE_PROTECTION_TICKS (5), no order yet. */
  let market: MarketRow;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    admin = await anAdmin();
    a = await member();
    b = await member();
    market = await createMarket(t.db);
  });

  /** An onboarded member, with its start Coin unless `coin` is false. */
  async function member(coin = true): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    if (coin) await createStartGrant(t.db, { userId: user.id, amountCoin: START_COIN });
    return user;
  }
  async function anAdmin(): Promise<TestUser> {
    const user = await member(false);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }
  const open = (rateLimit?: number) =>
    openOrderIntake(t.db, { adminId: admin.id, ...(rateLimit ? { rateLimit } : {}) });

  /** A GTC buy of one YES at 40 unless `body` says otherwise. */
  const send = (
    who: TestUser | null,
    body: Record<string, unknown> = {},
    options: { marketId?: string; requestId?: string | null } = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${options.marketId ?? market.id}/orders`,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        ...(options.requestId === null
          ? {}
          : { 'idempotency-key': options.requestId ?? randomUUID() }),
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: JSON.stringify({
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        qty: 1,
        expectedAccountId: who?.id,
        ...body,
      }),
    });
  const read = (url: string, who: TestUser | null) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: who ? { cookie: who.cookie } : {},
    });
  const dataOf = <T>(res: Res, status = 200): T => {
    expect(res.statusCode, res.body).toBe(status);
    return (JSON.parse(res.body) as { data: T }).data;
  };
  const errorOf = (res: Res, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    const { error } = JSON.parse(res.body) as { error: { code: string; details: unknown } };
    expect(error.code).toBe(code);
    return error.details;
  };
  const placed = (res: Res): PlaceOrderResult =>
    placeOrderResultSchema.parse(dataOf<PlaceOrderResult>(res));
  const orderRows = async () => (await t.db.select({ n: count() }).from(schema.orders))[0]!.n;

  it('takes no order while intake is closed, and the request id stays free (결정 3)', async () => {
    const requestId = randomUUID();
    for (const value of [undefined, false]) {
      if (value === false) {
        await setReleaseSetting(t.db, {
          adminId: admin.id,
          key: ORDER_ACCEPTING_SETTING.key,
          status: 'test',
          value,
        });
      }
      const details = errorOf(await send(a, {}, { requestId }), 409, 'ORDER_INTAKE_CLOSED');
      expect(details).toBeUndefined();
      errorOf(await read(`/me/orders/request/${requestId}`, a), 404, 'NOT_FOUND');
    }
    expect(await orderRows()).toBe(0);
    // The reads stay open.
    expect(dataOf<Order[]>(await read('/me/orders', a))).toEqual([]);

    await open();
    const { order, replayed } = placed(await send(a, {}, { requestId }));
    expect(replayed).toBe(false);
    expect(order).toMatchObject({ requestId, status: 'open' });
  });

  it('answers a re-sent request id while intake is closed: its order, or DUPLICATE_REQUEST', async () => {
    await open();
    const requestId = randomUUID();
    const { order } = placed(await send(a, { qty: 2 }, { requestId }));
    for (const value of [false, null]) {
      await setReleaseSetting(t.db, {
        adminId: admin.id,
        key: ORDER_ACCEPTING_SETTING.key,
        status: value === null ? 'undecided' : 'test',
        value,
      });
      // The lost answer is read again, by the POST as by the lookup.
      expect(placed(await send(a, { qty: 2 }, { requestId }))).toEqual({ order, replayed: true });
      expect(dataOf<Order>(await read(`/me/orders/request/${requestId}`, a))).toEqual(order);
      errorOf(await send(a, { qty: 3 }, { requestId }), 409, 'DUPLICATE_REQUEST');
      errorOf(await send(a, { qty: 2 }), 409, 'ORDER_INTAKE_CLOSED');
    }
    expect(await orderRows()).toBe(1);
  });

  it('names no market an order was rejected on once it went back to a draft (#78, ADR-0099)', async () => {
    await open();
    const scheduled = await createMarket(t.db, { status: 'scheduled' });
    const requestId = randomUUID();
    const { order } = placed(await send(a, {}, { requestId, marketId: scheduled.id }));
    expect(order).toMatchObject({
      rejectReason: 'not_open_yet',
      marketSlug: scheduled.slug,
      marketTitle: scheduled.title,
    });
    // #78's 되돌리기, then the admin fixes the draft's title and slug.
    await t.db
      .update(schema.markets)
      .set({ status: 'draft', title: '고치는 중인 질문', slug: 'draft-being-fixed' })
      .where(eq(schema.markets.id, scheduled.id));
    const hidden = { ...order, marketSlug: null, marketTitle: null };
    const answers = [
      dataOf<Order[]>(await read('/me/orders', a))[0],
      dataOf<Order>(await read(`/me/orders/${order.id}`, a)),
      dataOf<Order>(await read(`/me/orders/request/${requestId}`, a)),
      placed(await send(a, {}, { requestId, marketId: scheduled.id })).order,
    ];
    for (const answer of answers) expect(orderSchema.parse(answer)).toEqual(hidden);
    expect(JSON.stringify(answers)).not.toMatch(/고치는 중인 질문|draft-being-fixed/);
  });

  it('answers every refusal before the intake with an error and writes no order', async () => {
    await open();
    const draft = await createMarket(t.db, { status: 'draft' });
    // A market submitted before #119 has no width: its immediate orders wait for one.
    const noWidth = await createMarket(t.db, { priceProtectionTicks: null });
    const restricted = await member();
    await createModerationAction(t.db, {
      userId: restricted.id,
      createdBy: admin.id,
      type: 'account_restriction',
      approvedBy: (await createUser(t.db, { role: 'admin' })).user.id,
    });
    const notOnboarded = await signUpTestUser(t);

    // The request id and the body (PLAN 7.4: the path that is wrong).
    expect(errorOf(await send(a, {}, { requestId: null }), 400, 'VALIDATION_ERROR')).toEqual([
      expect.objectContaining({ path: ['Idempotency-Key'] }),
    ]);
    for (const [body, path] of [
      [{ budgetCoin: '100' }, 'budgetCoin'],
      [{ qty: undefined }, 'qty'],
      [{ qty: undefined, budgetCoin: '100', timeInForce: 'gtc' }, 'budgetCoin'],
      [{ qty: undefined, budgetCoin: '100', side: 'sell', timeInForce: 'ioc' }, 'budgetCoin'],
      [{ limitPriceCoin: 0 }, 'limitPriceCoin'],
      [{ limitPriceCoin: 100 }, 'limitPriceCoin'],
      [{ limitPriceCoin: 40.5 }, 'limitPriceCoin'],
      [{ qty: 1_000_001 }, 'qty'],
      [{ qty: undefined, budgetCoin: '1000001', timeInForce: 'ioc' }, 'budgetCoin'],
      // No amend and no partial cancel (#177 9항): an unknown field is refused.
      [{ amendOf: randomUUID() }, ''],
    ] as const) {
      const details = errorOf(await send(a, body), 400, 'VALIDATION_ERROR') as {
        path: string[];
      }[];
      expect(
        details.map((detail) => detail.path.join('.')),
        JSON.stringify(body),
      ).toContain(path);
    }
    errorOf(await send(null), 401, 'UNAUTHENTICATED');
    // An account that has not finished the onboarding only reads (#57-8).
    errorOf(await send(notOnboarded), 409, 'ONBOARDING_REQUIRED');
    // The account the screen shows (ADR-0092), and an admin, who never trades (결정 5).
    errorOf(await send(a, { expectedAccountId: b.id }), 403, 'FORBIDDEN');
    errorOf(await send(admin), 403, 'FORBIDDEN');
    // An account restriction stops trading (#139); a writing restriction does not (below).
    expect(errorOf(await send(restricted), 403, 'RESTRICTED')).toMatchObject({ kind: 'account' });
    errorOf(await send(a, {}, { marketId: draft.id }), 404, 'NOT_FOUND');
    errorOf(await send(a, {}, { marketId: randomUUID() }), 404, 'NOT_FOUND');
    expect(
      errorOf(
        await send(a, { timeInForce: 'ioc', limitPriceCoin: 60 }, { marketId: noWidth.id }),
        409,
        'ORDER_INTAKE_CLOSED',
      ),
    ).toEqual([{ path: ['priceProtection'], message: 'undecided' }]);
    expect(await orderRows()).toBe(0);
    expect(await balanceOf(t.db, a.id)).toMatchObject({
      availableCoin: START_COIN,
      lockedCoin: 0n,
    });

    // A limit order never uses the width; a writing restriction does not stop trading.
    await createModerationAction(t.db, {
      userId: b.id,
      createdBy: admin.id,
      type: 'writing_restriction',
    });
    const resting = placed(await send(b, {}, { marketId: noWidth.id })).order;
    expect(resting.status).toBe('open');
    expect(await orderRows()).toBe(1);

    // ADR-0085 결과 5: a restricted account's order is refused off any screen and meets nothing —
    // b's resting buy stays as it was — and once the restriction has ended it orders again.
    errorOf(
      await send(
        restricted,
        { outcome: 'NO', timeInForce: 'gtc', limitPriceCoin: 60 },
        { marketId: noWidth.id },
      ),
      403,
      'RESTRICTED',
    );
    expect(dataOf<Order>(await read(`/me/orders/${resting.id}`, b))).toEqual(resting);
    const ended = await member();
    await createModerationAction(t.db, {
      userId: ended.id,
      createdBy: admin.id,
      type: 'account_restriction',
      approvedBy: (await createUser(t.db, { role: 'admin' })).user.id,
      createdAt: new Date(Date.now() - 3 * 86_400_000),
      endsAt: new Date(Date.now() - 86_400_000),
    });
    const after = placed(
      await send(
        ended,
        { outcome: 'NO', timeInForce: 'gtc', limitPriceCoin: 60 },
        { marketId: noWidth.id },
      ),
    ).order;
    expect(after).toMatchObject({ status: 'filled', filledQty: 1 });
  });

  it('lets a role grant in flight commit first: the order then reads the admin and writes nothing (결정 5)', async () => {
    await open();
    const observer = await t.db.$client.connect();
    let written = () => {};
    const writing = new Promise<void>((resolve) => {
      written = resolve;
    });
    let commit = () => {};
    const committing = new Promise<void>((resolve) => {
      commit = resolve;
    });
    // A grant as AdminAccountsService makes it: the admin roles' lock, then the role. The order
    // reads the role FOR SHARE under the market's lock, which waits for that update (its
    // `assertCanTrade` FOR KEY SHARE before the market's lock does not).
    const granting = t.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      await tx
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, a.id));
      written();
      await committing;
    });
    try {
      await Promise.race([writing, granting]);
      const ordering = send(a);
      await waitForLockWaiter(observer, 'the order behind the role grant in flight');
      commit();
      await granting;
      errorOf(await ordering, 403, 'FORBIDDEN');
    } finally {
      commit();
      observer.release();
    }
    expect(await orderRows()).toBe(0);
    expect(await balanceOf(t.db, a.id)).toMatchObject({
      availableCoin: START_COIN,
      lockedCoin: 0n,
    });
  });

  it('holds up no other account’s order behind a role grant in flight (10-16)', async () => {
    await open();
    let written = () => {};
    const writing = new Promise<void>((resolve) => {
      written = resolve;
    });
    let commit = () => {};
    const committing = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const granting = t.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      await tx
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, a.id));
      written();
      await committing;
    });
    try {
      await Promise.race([writing, granting]);
      // B's order goes through while the grant still holds the roles' lock and A's profile.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the order waited for the grant')), 5_000);
      });
      const res = await Promise.race([send(b), stalled]).finally(() => clearTimeout(timer));
      expect(placed(res).order).toMatchObject({ status: 'open' });
    } finally {
      commit();
      await granting;
    }
  });

  it('makes a role grant wait for the account’s order in flight, which commits as a member’s (10-16)', async () => {
    await open();
    const observer = await t.db.$client.connect();
    let release = () => {};
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    // A's Coin account, held here, parks A's order after it has read its role under the market's
    // lock (`lockOrderHolders` comes later).
    const gate = t.db.transaction(async (tx) => {
      await lockLedgerAccounts(tx, [{ kind: 'user', userId: a.id }]);
      held();
      await opened;
    });
    try {
      await Promise.race([holding, gate]);
      const ordering = send(a);
      await waitForLockWaiter(observer, 'the order behind A’s Coin account');
      const granting = t.db.transaction(async (tx) => {
        await lockAdminRoles(tx, 'exclusive');
        await tx
          .update(schema.profiles)
          .set({ role: 'admin' })
          .where(eq(schema.profiles.userId, a.id));
      });
      await waitForLockWaiter(observer, 'the grant behind the order’s profile', 2);
      release();
      await gate;
      expect(placed(await ordering).order).toMatchObject({ status: 'open' });
      await granting;
    } finally {
      release();
      observer.release();
    }
    const [row] = await t.db.select().from(schema.orders);
    expect(row).toMatchObject({ userId: a.id, status: 'open' });
    // And an order after the grant reads it.
    errorOf(await send(a), 403, 'FORBIDDEN');
  });

  it('never closes a circle with a role grant and an admin’s market action that wants the roles’ lock (10-16)', async () => {
    await open();
    const observer = await t.db.$client.connect();
    let ask = () => {};
    const asking = new Promise<void>((resolve) => {
      ask = resolve;
    });
    let held = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    let rolesTaken = () => {};
    const taking = new Promise<void>((resolve) => {
      rolesTaken = resolve;
    });
    // An admin's market action as MarketAdminService's class takes its locks (a 규칙 보충 or 일시
    // 중단 request, a judgement, a dispute decision): the market's lock, then the admin roles'.
    const action = t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      held();
      await asking;
      await lockAdminRoles(tx, 'shared');
    });
    let granting: Promise<void> | undefined;
    try {
      await Promise.race([holding, action]);
      // A's order parks on that market's lock, holding A's profile FOR KEY SHARE only.
      const ordering = send(a);
      await waitForLockWaiter(observer, 'the order behind the market action');
      // A grant to A: the roles' lock, then A's role — which an order waiting on a market's lock
      // does not hold up. Had the order held its profile FOR SHARE there, the grant would wait
      // on it, the action on the grant, the order on the action: 40P01 for one of the three.
      granting = t.db.transaction(async (tx) => {
        await lockAdminRoles(tx, 'exclusive');
        rolesTaken();
        await tx
          .update(schema.profiles)
          .set({ role: 'admin' })
          .where(eq(schema.profiles.userId, a.id));
      });
      await Promise.race([taking, granting]);
      ask();
      await granting;
      await action;
      // The order then reads the role the grant wrote.
      errorOf(await ordering, 403, 'FORBIDDEN');
    } finally {
      ask();
      await Promise.allSettled([action, granting]);
      observer.release();
    }
    expect(await orderRows()).toBe(0);
    expect(await balanceOf(t.db, a.id)).toMatchObject({
      availableCoin: START_COIN,
      lockedCoin: 0n,
    });
  });

  it('matches a resting order and answers both owners’ orders, fills and positions, the counterparty anonymous', async () => {
    await open();
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
    // A bids NO at 40 for 2: it rests, its Coin locked, and no `user:` event is published (a lock
    // alone; its `market:book` is the next test's).
    const resting = placed(await send(a, { outcome: 'NO', qty: 2 }));
    expect(resting.order).toMatchObject({
      outcome: 'NO',
      side: 'buy',
      timeInForce: 'gtc',
      limitPriceCoin: 40,
      protectedLimitPriceCoin: 40,
      qty: 2,
      budgetCoin: null,
      filledQty: 0,
      filledAmountCoin: '0',
      cancelledQty: 0,
      unspentCoin: null,
      status: 'open',
      rejectReason: null,
      cancelReason: null,
      endedAt: null,
    });
    expect(await balanceOf(t.db, a.id)).toMatchObject({
      availableCoin: START_COIN - 80n,
      lockedCoin: 80n,
    });
    expect(publish).not.toHaveBeenCalled();

    // B buys YES at once with a limit of 99: narrowed to the ask 60 + 5 ticks, it mints two pairs
    // at 60 against A's bid (#177 2·4항).
    const requestId = randomUUID();
    const incoming = placed(
      await send(b, { timeInForce: 'ioc', limitPriceCoin: 99, qty: 2 }, { requestId }),
    );
    expect(incoming).toEqual({
      replayed: false,
      order: {
        id: expect.any(String) as unknown,
        requestId,
        marketId: market.id,
        marketSlug: market.slug,
        marketTitle: market.title,
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        protectedLimitPriceCoin: 65,
        qty: 2,
        budgetCoin: null,
        filledQty: 2,
        filledAmountCoin: '120',
        cancelledQty: 0,
        unspentCoin: null,
        status: 'filled',
        rejectReason: null,
        cancelReason: null,
        createdAt: expect.any(String) as unknown,
        endedAt: incoming.order.createdAt,
      },
    });
    const aOrder = dataOf<Order>(await read(`/me/orders/${resting.order.id}`, a));
    expect(aOrder).toMatchObject({ status: 'filled', filledQty: 2, filledAmountCoin: '80' });
    expect(await balanceOf(t.db, a.id)).toMatchObject({
      availableCoin: START_COIN - 80n,
      lockedCoin: 0n,
    });
    expect(await balanceOf(t.db, b.id)).toMatchObject({
      availableCoin: START_COIN - 120n,
      lockedCoin: 0n,
    });

    // Each side's fill as its own order took it: the price per contract on its side, the YES
    // price recorded, and nothing of the other side — no order, account or account type.
    const fillsOf = (who: TestUser) => read('/me/fills', who);
    const aFills = await fillsOf(a);
    const bFills = await fillsOf(b);
    const [aFill] = dataOf<MyFill[]>(aFills);
    const [bFill] = dataOf<MyFill[]>(bFills);
    expect(myFillSchema.parse(aFill)).toEqual({
      id: bFill!.id,
      orderId: resting.order.id,
      marketId: market.id,
      marketSlug: market.slug,
      marketTitle: market.title,
      outcome: 'NO',
      side: 'buy',
      qty: 2,
      priceCoin: 40,
      amountCoin: '80',
      yesPriceCoin: 60,
      feeCoin: '0',
      createdAt: incoming.order.createdAt,
    });
    expect(Object.keys(aFill!).sort()).toEqual(Object.keys(myFillSchema.shape).sort());
    expect(bFill).toMatchObject({
      orderId: incoming.order.id,
      outcome: 'YES',
      priceCoin: 60,
      amountCoin: '120',
      yesPriceCoin: 60,
    });
    for (const [res, other, otherOrder] of [
      [aFills, b, incoming.order.id],
      [bFills, a, resting.order.id],
    ] as const) {
      expect(res.body).not.toContain(other.id);
      expect(res.body).not.toContain(otherOrder);
      expect(res.body).not.toMatch(/accountType|member|market_maker|pair_mint|kind/);
    }

    expect(await positionsOf(a)).toEqual([['NO', 2, '80']]);
    expect(await positionsOf(b)).toEqual([['YES', 2, '120']]);

    // After COMMIT: each person's balance, keyed by its last ledger entry, and its position row.
    const sent = publish.mock.calls.map(([userId, event]) => [userId, event.type]);
    expect(sent.sort()).toEqual(
      [
        [a.id, 'user:balance'],
        [a.id, 'user:position'],
        [b.id, 'user:balance'],
        [b.id, 'user:position'],
      ].sort(),
    );
    const balanceEvents = publish.mock.calls.filter(([, event]) => event.type === 'user:balance');
    for (const [userId, event] of balanceEvents) {
      const row = await balanceOf(t.db, userId);
      expect(event).toMatchObject({
        availableCoin: String(row!.availableCoin),
        lockedCoin: '0',
      });
    }

    // B offers one of its YES at 70: nothing meets it, it rests and locks one contract of its
    // position row — that row is published, and no balance (no ledger entry; ADR-0112 결정 8).
    publish.mockClear();
    const sell = placed(await send(b, { side: 'sell', limitPriceCoin: 70 }));
    expect(sell.order).toMatchObject({ side: 'sell', status: 'open', filledQty: 0 });
    expect(publish.mock.calls.map(([userId, event]) => [userId, event.type])).toEqual([
      [b.id, 'user:position'],
    ]);
    expect(publish.mock.calls[0]![1]).toMatchObject({
      marketId: market.id,
      outcome: 'YES',
      qty: 2,
    });

    // A takes that YES at once: a trade at 70 (the ask 70 + 5 ticks bounds it). Both people's
    // balance and YES row go out — the resting seller's too, whose screen did nothing.
    publish.mockClear();
    const taken = placed(await send(a, { timeInForce: 'ioc', limitPriceCoin: 99 }));
    expect(taken.order).toMatchObject({
      status: 'filled',
      protectedLimitPriceCoin: 75,
      filledAmountCoin: '70',
    });
    expect(publish.mock.calls.map(([userId, event]) => [userId, event.type]).sort()).toEqual(
      [
        [a.id, 'user:balance'],
        [a.id, 'user:position'],
        [b.id, 'user:balance'],
        [b.id, 'user:position'],
      ].sort(),
    );
    for (const [userId, event] of publish.mock.calls) {
      if (event.type === 'user:balance') {
        const row = await balanceOf(t.db, userId);
        expect(event).toMatchObject({
          availableCoin: String(row!.availableCoin),
          lockedCoin: '0',
        });
      } else {
        // A bought its one; B sold one of its two.
        expect(event).toMatchObject({ marketId: market.id, outcome: 'YES', qty: 1 });
      }
    }
    expect(await balanceOf(t.db, b.id)).toMatchObject({
      availableCoin: START_COIN - 120n + 70n,
    });
  });

  it('publishes market:book after COMMIT for an order that rested or filled, and none for one that changed no live order (#179)', async () => {
    const publisher = t.app.get(MarketPublisher);
    // Each signal with the public book read the moment it is sent: the change is committed.
    const signals: { marketId: string; ts: string; book: unknown }[] = [];
    vi.spyOn(publisher, 'publishMarket').mockImplementation(async (marketId, event) => {
      // A fill's `market:trade` and `market:tick` (#121) are the next test's.
      if (event.type === 'market:trade' || event.type === 'market:tick') return;
      expect(event.type).toBe('market:book');
      const book = orderBookSchema.parse(dataOf(await read(`/markets/${marketId}/book`, null)));
      signals.push({ marketId, ts: event.ts, book: book.contracts[0] });
    });
    const expectSignals = (count: number) => {
      expect(signals).toHaveLength(count);
      signals.length = 0;
    };
    // Intake closed: nothing written, nothing published.
    errorOf(await send(a), 409, 'ORDER_INTAKE_CLOSED');
    expectSignals(0);
    await open();

    // A rests a GTC NO buy at 40 for 2: the YES side shows 60 × 2, at the order's own instant.
    const requestId = randomUUID();
    const bid = placed(await send(a, { outcome: 'NO', qty: 2 }, { requestId })).order;
    expect(signals).toEqual([
      {
        marketId: market.id,
        ts: bid.createdAt,
        book: {
          outcome: 'YES',
          asks: [{ priceCoin: 60, qty: 2 }],
          bids: [],
          bestAskCoin: 60,
          bestBidCoin: null,
        },
      },
    ]);
    signals.length = 0;
    // Its replay changes nothing.
    expect(placed(await send(a, { outcome: 'NO', qty: 2 }, { requestId })).replayed).toBe(true);
    expectSignals(0);
    // An IOC YES buy that fills one: the level shrinks, read after the commit.
    placed(await send(b, { timeInForce: 'ioc', limitPriceCoin: 99 }));
    expect(signals).toMatchObject([{ book: { asks: [{ priceCoin: 60, qty: 1 }] } }]);
    signals.length = 0;
    // A GTC YES buy for 3 at 70 that fills the last one and rests 2 at 70: one signal.
    const rested = placed(await send(b, { limitPriceCoin: 70, qty: 3 })).order;
    expect(rested).toMatchObject({ status: 'partially_filled', filledQty: 1 });
    expect(signals).toMatchObject([{ book: { asks: [], bids: [{ priceCoin: 70, qty: 2 }] } }]);
    signals.length = 0;
    // An immediate order that fills nothing writes a rejected row and changes no book: no signal.
    // B's YES bid at 70 is NO supply at 30, beyond an IOC NO buy limited to 29.
    expect(
      placed(await send(a, { outcome: 'NO', timeInForce: 'ioc', limitPriceCoin: 29 })).order,
    ).toMatchObject({ status: 'rejected', rejectReason: 'price_limit', filledQty: 0 });
    expectSignals(0);
    // A rejected order (a scheduled market) writes a row and changes no book: no signal.
    const scheduled = await createMarket(t.db, { status: 'scheduled' });
    expect(placed(await send(a, {}, { marketId: scheduled.id })).order.status).toBe('rejected');
    expectSignals(0);

    // The owner's cancel: one signal at the cancel's instant; asked again (ended), none.
    const cancel = (id: string) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/me/orders/${id}/cancel`,
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: b.cookie },
        payload: JSON.stringify({ expectedAccountId: b.id }),
      });
    const ended = dataOf<Order>(await cancel(rested.id));
    expect(signals).toEqual([
      {
        marketId: market.id,
        ts: ended.endedAt,
        book: {
          outcome: 'YES',
          asks: [],
          bids: [],
          bestAskCoin: null,
          bestBidCoin: null,
        },
      },
    ]);
    signals.length = 0;
    dataOf<Order>(await cancel(rested.id));
    expectSignals(0);
    // A live order held for a ledger failure: refused, nothing changed, nothing published.
    const held = placed(await send(b, { limitPriceCoin: 30 })).order;
    signals.length = 0;
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure' });
    errorOf(await cancel(held.id), 409, 'MARKET_NOT_OPEN');
    expectSignals(0);
  });

  it('publishes nothing when the transaction rolls back after the intake (#179)', async () => {
    await open();
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');
    // The order's own answer fails after `placeOrder` wrote it: the whole transaction rolls back.
    vi.spyOn(
      OrderService.prototype as unknown as { marketRef: () => Promise<never> },
      'marketRef',
    ).mockRejectedValueOnce(new Error('after the intake'));
    expect((await send(a)).statusCode).toBe(500);
    expect(await orderRows()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes one market:tick and each fill as an anonymous market:trade after COMMIT, and neither for an intake that filled nothing (#121)', async () => {
    const publisher = t.app.get(MarketPublisher);
    // Every market event in issue order; at each tick the public detail, read the moment it is
    // sent — the statistics it carries are committed.
    const events: MarketRealtimeEvent[] = [];
    const detailAtTick: Market[] = [];
    vi.spyOn(publisher, 'publishMarket').mockImplementation(async (marketId, event) => {
      events.push(event);
      if (event.type === 'market:tick') {
        detailAtTick.push(dataOf<Market>(await read(`/markets/${marketId}`, null)));
      }
    });
    /** The events since the last call, the book signals left out (the #179 test's). */
    const fillEvents = () => {
      const out = events.filter((event) => event.type !== 'market:book');
      events.length = 0;
      return out;
    };
    const c = await member();
    await open();

    // A rests a NO bid at 40 for 2: no fill, no trade, no tick.
    placed(await send(a, { outcome: 'NO', qty: 2 }));
    expect(fillEvents()).toEqual([]);

    // B's IOC YES buy meets it: a pair mint, ONE fill at its YES value 60 (#177 11·12항).
    const requestId = randomUUID();
    placed(await send(b, { timeInForce: 'ioc', limitPriceCoin: 99 }, { requestId }));
    const [bFill] = dataOf<MyFill[]>(await read(`/me/fills?marketId=${market.id}`, b));
    const first = fillEvents();
    // The tick leads the burst (any order works: the gateway sends every event reliably).
    expect(first.map((event) => event.type)).toEqual(['market:tick', 'market:trade']);
    const trade = marketTradeEventSchema.parse(first[1]);
    expect(trade).toEqual({
      type: 'market:trade',
      marketId: market.id,
      fillId: bFill!.id,
      outcome: 'YES',
      priceCoin: 60,
      yesPriceCoin: 60,
      qty: 1,
      amountCoin: '60',
      ts: bFill!.createdAt,
    });
    // Exactly the public row's names: no account, order, taker direction or account type.
    expect(Object.keys(first[1]!).sort()).toEqual(
      [
        'amountCoin',
        'fillId',
        'marketId',
        'outcome',
        'priceCoin',
        'qty',
        'ts',
        'type',
        'yesPriceCoin',
      ].sort(),
    );
    // The same fill as the public recent fills answer it (`publicFill`, one mapping).
    const [row] = dataOf<Fill[]>(await read(`/markets/${market.id}/fills`, null));
    const { fillId, ts, type: _type, marketId: _marketId, ...rest } = trade;
    expect(row).toEqual({ id: fillId, ...rest, createdAt: ts });
    expect(marketTickEventSchema.parse(first[0])).toEqual({
      type: 'market:tick',
      marketId: market.id,
      lastPrice: 60,
      volumeCoin: '60',
      tradeCount: 1,
      traderCount: 2,
      ts: bFill!.createdAt,
    });
    expect(detailAtTick.at(-1)).toMatchObject({
      lastPrice: 60,
      lastFillAt: bFill!.createdAt,
      volumeCoin: '60',
      tradeCount: 1,
      traderCount: 2,
    });
    // Its replay wrote nothing and publishes nothing.
    expect(
      placed(await send(b, { timeInForce: 'ioc', limitPriceCoin: 99 }, { requestId })).replayed,
    ).toBe(true);
    expect(fillEvents()).toEqual([]);

    // A rests a NO bid at 45; B's IOC for 2 takes YES 55 (it) then 60 (the first bid's last):
    // one tick with the intake's final values, then two trades in fill order.
    placed(await send(a, { outcome: 'NO', limitPriceCoin: 45 }));
    expect(fillEvents()).toEqual([]);
    placed(await send(b, { timeInForce: 'ioc', limitPriceCoin: 99, qty: 2 }));
    const two = fillEvents();
    expect(two.map((event) => event.type)).toEqual(['market:tick', 'market:trade', 'market:trade']);
    const [t1, t2] = two.slice(1).map((event) => marketTradeEventSchema.parse(event));
    expect([t1?.yesPriceCoin, t2?.yesPriceCoin]).toEqual([55, 60]);
    expect(BigInt(t1!.fillId)).toBeLessThan(BigInt(t2!.fillId));
    expect(two[0]).toMatchObject({
      lastPrice: 60,
      volumeCoin: '175',
      tradeCount: 3,
      traderCount: 2,
      ts: t2!.ts,
    });

    // A sells one NO at 45 (rests); C's IOC NO buy takes it: a NO row at 45 whose YES value is
    // 55, and a third person.
    placed(await send(a, { outcome: 'NO', side: 'sell', limitPriceCoin: 45 }));
    expect(fillEvents()).toEqual([]);
    placed(await send(c, { outcome: 'NO', timeInForce: 'ioc', limitPriceCoin: 99 }));
    const no = fillEvents();
    expect(no[1]).toMatchObject({
      outcome: 'NO',
      priceCoin: 45,
      yesPriceCoin: 55,
      amountCoin: '45',
    });
    expect(no[0]).toMatchObject({
      lastPrice: 55,
      volumeCoin: '220',
      tradeCount: 4,
      traderCount: 3,
    });
    expect(detailAtTick.at(-1)).toMatchObject({ lastPrice: 55, volumeCoin: '220', traderCount: 3 });

    // No person's id rides in any of them (the 운영 마켓메이커 has none to hide either: #177 13항).
    const wire = JSON.stringify([first, two, no]);
    for (const id of [a.id, b.id, c.id]) expect(wire).not.toContain(id);

    // Nothing for an immediate order that fills nothing, a rejected one, or one that only rests.
    placed(await send(c, { outcome: 'NO', timeInForce: 'ioc', limitPriceCoin: 5 }));
    const scheduled = await createMarket(t.db, { status: 'scheduled' });
    placed(await send(c, {}, { marketId: scheduled.id }));
    placed(await send(c, { limitPriceCoin: 10 }));
    expect(fillEvents()).toEqual([]);

    // A filling intake that rolls back afterwards publishes nothing and moves no statistic: A's
    // IOC NO buy would meet C's YES bid at 10 as NO at 90.
    vi.spyOn(
      OrderService.prototype as unknown as { marketRef: () => Promise<never> },
      'marketRef',
    ).mockRejectedValueOnce(new Error('after the intake'));
    expect(
      (await send(a, { outcome: 'NO', timeInForce: 'ioc', limitPriceCoin: 99 })).statusCode,
    ).toBe(500);
    expect(fillEvents()).toEqual([]);
    expect(dataOf<Market>(await read(`/markets/${market.id}`, null))).toMatchObject({
      tradeCount: 4,
      volumeCoin: '220',
    });
  });

  it('answers a filled order when Redis refuses the trade and tick it publishes after COMMIT (#121)', async () => {
    await open();
    placed(await send(a, { outcome: 'NO' }));
    const publish = vi
      .spyOn(t.app.get<Redis>(REDIS), 'publish')
      .mockRejectedValue(new Error('redis down'));
    const answer = placed(await send(b, { timeInForce: 'ioc', limitPriceCoin: 99 }));
    expect(answer.order).toMatchObject({ status: 'filled', filledQty: 1 });
    const types = publish.mock.calls.map(
      ([, message]) => (JSON.parse(String(message)) as { type: string }).type,
    );
    expect(types).toEqual(expect.arrayContaining(['market:book', 'market:trade', 'market:tick']));
    publish.mockRestore();
    expect(dataOf<Market>(await read(`/markets/${market.id}`, null))).toMatchObject({
      lastPrice: 60,
      tradeCount: 1,
    });
  });

  async function positionsOf(who: TestUser) {
    const res = await read('/me/positions', who);
    return dataOf<{ outcome: string; qty: number; costBasisCoin: string }[]>(res).map((row) => [
      row.outcome,
      row.qty,
      row.costBasisCoin,
    ]);
  }

  it('answers a rejected order as an order row with its reason, the nine reasons each its own', async () => {
    await open();
    const scheduled = await createMarket(t.db, { status: 'scheduled' });
    const paused = await createMarket(t.db, { status: 'paused' });
    const closed = await createMarket(t.db, { status: 'closed' });
    const selfMarket = await createMarket(t.db);
    const poor = await member(false);
    const ioc = { timeInForce: 'ioc', limitPriceCoin: 99 };
    const reasonOf = (res: Res) => {
      const { order } = placed(res);
      expect(order.status, res.body).toBe('rejected');
      expect(order.filledQty).toBe(0);
      return order.rejectReason;
    };
    const reasons = [
      reasonOf(await send(a, {}, { marketId: scheduled.id })),
      reasonOf(await send(a, {}, { marketId: paused.id })),
      reasonOf(await send(a, {}, { marketId: closed.id })),
      reasonOf(await send(poor)),
      reasonOf(await send(a, { side: 'sell' })),
      // Nothing opposite yet.
      reasonOf(await send(a, ioc)),
    ];
    // B bids NO at 40: the YES ask is 60.
    placed(await send(b, { outcome: 'NO', qty: 5 }));
    reasons.push(
      reasonOf(await send(a, { timeInForce: 'ioc', limitPriceCoin: 30 })),
      reasonOf(await send(a, { ...ioc, qty: undefined, budgetCoin: '10' })),
    );
    // A bids NO on another market, then buys YES at once there: its own bid is the next entry.
    placed(await send(a, { outcome: 'NO' }, { marketId: selfMarket.id }));
    reasons.push(reasonOf(await send(a, ioc, { marketId: selfMarket.id })));
    expect(reasons).toEqual([
      'not_open_yet',
      'paused',
      'closed',
      'insufficient_coin',
      'insufficient_contracts',
      'no_quote',
      'price_limit',
      'budget_too_small',
      'self_trade',
    ]);
    // Listed with the rest, newest first; nothing of B's.
    const listed = dataOf<Order[]>(await read('/me/orders?limit=100', a));
    expect(listed.filter((order) => order.status === 'rejected')).toHaveLength(8);
    expect(listed.map((order) => order.rejectReason).filter(Boolean)).toEqual(
      [...reasons.slice(0, 3), ...reasons.slice(4)].reverse(),
    );
  });

  it('answers an order on an OPEN market past its close_at as a 마감 row before the worker closes it (#120)', async () => {
    // The intake's gate judges `close_at` by the DB clock (ADR-0114 결과 5 '#120'): a rejected row
    // with its request id — not ORDER_INTAKE_CLOSED, not MARKET_NOT_OPEN — nothing locked, no
    // market:book; the market stays OPEN and a resting order stays live until the close runs.
    await open();
    const resting = placed(await send(b, { outcome: 'NO', qty: 2 })).order;
    await passMarketClose(t.db, market.id);
    const before = await balanceOf(t.db, a.id);
    const toMarket = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');
    for (const body of [
      {},
      { timeInForce: 'ioc', limitPriceCoin: 65, qty: 2 },
      { timeInForce: 'ioc', limitPriceCoin: 65, qty: undefined, budgetCoin: '200' },
      { side: 'sell' },
    ]) {
      const requestId = randomUUID();
      const answer = placed(await send(a, body, { requestId }));
      expect(answer.replayed).toBe(false);
      expect(answer.order).toMatchObject({
        requestId,
        status: 'rejected',
        rejectReason: 'closed',
        cancelReason: null,
        filledQty: 0,
        filledAmountCoin: '0',
      });
      expect(answer.order.createdAt).toBe(answer.order.endedAt);
      // The same request id answers the same row.
      expect(placed(await send(a, body, { requestId }))).toEqual({ ...answer, replayed: true });
    }
    expect(await balanceOf(t.db, a.id)).toEqual(before);
    expect(toMarket).not.toHaveBeenCalled();
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id));
    expect(row).toMatchObject({ status: 'open' });
    expect(
      (await t.db.select().from(schema.orders).where(eq(schema.orders.id, resting.id)))[0],
    ).toMatchObject({ status: 'open' });
    expect(await checkOrderInvariants(t.db)).toEqual([]);
  });

  it('answers a budget order’s Coin: what it spent, and the rest given back (#177 3항)', async () => {
    await open();
    // B bids NO at 40 for one and at 38 for two: YES asks of 60, then 62 (within 60 + 5).
    placed(await send(b, { outcome: 'NO' }));
    placed(await send(b, { outcome: 'NO', limitPriceCoin: 38, qty: 2 }));
    // 150 buys the 60 and one 62; the 28 left cannot buy the next 62, so it stops, 전량 체결.
    const requestId = randomUUID();
    const { order } = placed(
      await send(
        a,
        { timeInForce: 'ioc', limitPriceCoin: 99, qty: undefined, budgetCoin: '150' },
        { requestId },
      ),
    );
    expect(order).toMatchObject({
      timeInForce: 'ioc',
      protectedLimitPriceCoin: 65,
      qty: null,
      budgetCoin: '150',
      filledQty: 2,
      filledAmountCoin: '122',
      cancelledQty: 0,
      unspentCoin: '28',
      status: 'filled',
      rejectReason: null,
      cancelReason: null,
    });
    expect(dataOf<Order>(await read(`/me/orders/${order.id}`, a))).toEqual(order);
    expect(dataOf<Order>(await read(`/me/orders/request/${requestId}`, a))).toEqual(order);
    // The 28 came back with the fills: nothing stays locked.
    expect(await balanceOf(t.db, a.id)).toMatchObject({
      availableCoin: START_COIN - 122n,
      lockedCoin: 0n,
    });
  });

  it('answers a 취소 완료 order’s unfilled quantity as cancelledQty, and a budget order’s as none (#177 7항)', async () => {
    await open();
    const c = await member();
    // B bids NO at 40 for one: a YES ask of 60. A's IOC for two takes it and cancels the rest.
    placed(await send(b, { outcome: 'NO' }));
    const ioc = placed(await send(a, { timeInForce: 'ioc', limitPriceCoin: 99, qty: 2 })).order;
    expect(ioc).toMatchObject({
      qty: 2,
      filledQty: 1,
      filledAmountCoin: '60',
      cancelledQty: 1,
      unspentCoin: null,
      status: 'cancelled',
      cancelReason: 'ioc_remainder',
    });
    expect(dataOf<Order>(await read(`/me/orders/${ioc.id}`, a))).toEqual(ioc);

    // A GTC buy for three meets B's ask at 60, then A's own resting ask at 61: it stops there
    // (자기 체결 방지) with two left — cancelled, not resting.
    placed(await send(b, { outcome: 'NO' }));
    placed(await send(a, { outcome: 'NO', limitPriceCoin: 39 }));
    const stopped = placed(await send(a, { limitPriceCoin: 65, qty: 3 })).order;
    expect(stopped).toMatchObject({
      timeInForce: 'gtc',
      qty: 3,
      filledQty: 1,
      cancelledQty: 2,
      status: 'cancelled',
      cancelReason: 'self_trade',
    });

    // A budget order left with Coin after the book ran out counts no contracts as cancelled: its
    // rest is the Coin given back (`unspentCoin`).
    const budget = placed(
      await send(c, { timeInForce: 'ioc', limitPriceCoin: 99, qty: undefined, budgetCoin: '150' }),
    ).order;
    expect(budget).toMatchObject({
      qty: null,
      budgetCoin: '150',
      filledQty: 1,
      filledAmountCoin: '61',
      cancelledQty: 0,
      unspentCoin: '89',
      status: 'cancelled',
      cancelReason: 'ioc_remainder',
    });
  });

  it('checks the onboarding again inside the order itself, past the guard (#57-8)', async () => {
    await open();
    // OnboardedGuard answers every request first (above); this is the check that holds the
    // onboarding to the commit. Verified with Coin but no consent and no nickname confirmed — as
    // an account a consent revision asked again (#57-5): only the service's `assertOnboarded`
    // refuses it, so it is called the way the route calls it, past the guard.
    const newcomer = await signUpTestUser(t);
    // `createStartGrant` verifies the phone too.
    await createStartGrant(t.db, { userId: newcomer.id, amountCoin: START_COIN });
    const error: unknown = await t.app
      .get(OrderService)
      .place(newcomer.id, market.id, randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        qty: 1,
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      code: 'ONBOARDING_REQUIRED',
      status: 409,
      details: { steps: expect.arrayContaining(['consent', 'nickname']) as unknown },
    });
    expect((error as { details: { steps: string[] } }).details.steps).not.toContain('verification');
    expect(await orderRows()).toBe(0);
    expect(await balanceOf(t.db, newcomer.id)).toMatchObject({
      availableCoin: START_COIN,
      lockedCoin: 0n,
    });
  });

  it('answers a re-sent request id with its order as it stands, and another order’s terms with DUPLICATE_REQUEST', async () => {
    await open();
    const requestId = randomUUID();
    const first = placed(await send(a, { outcome: 'NO', qty: 2 }, { requestId }));
    // B fills it after; the re-sent request reads it filled, writing nothing.
    placed(await send(b, { timeInForce: 'ioc', limitPriceCoin: 60, qty: 2 }));
    const again = placed(await send(a, { outcome: 'NO', qty: 2 }, { requestId }));
    expect(again).toEqual({
      replayed: true,
      order: {
        ...first.order,
        status: 'filled',
        filledQty: 2,
        filledAmountCoin: '80',
        endedAt: expect.any(String) as unknown,
      },
    });
    expect(dataOf<Order>(await read(`/me/orders/request/${requestId}`, a))).toEqual(again.order);
    for (const terms of [
      { outcome: 'NO', qty: 3 },
      { qty: 2 },
      { outcome: 'NO', qty: 2, limitPriceCoin: 41 },
    ]) {
      expect(
        errorOf(await send(a, terms, { requestId }), 409, 'DUPLICATE_REQUEST'),
      ).toBeUndefined();
    }
    errorOf(
      await send(
        a,
        { outcome: 'NO', qty: 2 },
        { requestId, marketId: (await createMarket(t.db)).id },
      ),
      409,
      'DUPLICATE_REQUEST',
    );
    // Unique per account: B's request id may be A's.
    expect(placed(await send(b, {}, { requestId })).replayed).toBe(false);
    errorOf(await read(`/me/orders/request/${requestId}`, null), 401, 'UNAUTHENTICATED');
    errorOf(await read('/me/orders/request/no', a), 400, 'VALIDATION_ERROR');
  });

  it('counts every submission per account across markets against order.rate_limit, and none while it is unset', async () => {
    await open();
    const second = await createMarket(t.db);
    // Unset: no account limit (the address bucket alone, which inject's loopback never counts).
    for (let i = 0; i < 4; i += 1) expect((await send(a)).statusCode).toBe(200);

    await setReleaseSetting(t.db, {
      adminId: admin.id,
      key: ORDER_RATE_LIMIT_SETTING.key,
      status: 'test',
      value: 3,
    });
    const requestId = randomUUID();
    // A refused body counts; so do two markets.
    expect((await send(a, { qty: 0 })).statusCode).toBe(400);
    expect((await send(a, {}, { requestId })).statusCode).toBe(200);
    expect((await send(a, {}, { marketId: second.id })).statusCode).toBe(200);
    // The fourth in the minute — a re-sent request id too — is refused before anything is read.
    const refused = await send(a, {}, { requestId });
    const details = errorOf(refused, 429, 'RATE_LIMITED') as { retryAfterSeconds: number };
    expect(details.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.headers['retry-after']).toBe(String(details.retryAfterSeconds));
    // Another account has its own count, and A's reads are not counted.
    expect((await send(b)).statusCode).toBe(200);
    expect((await read('/me/orders', a)).statusCode).toBe(200);
    expect(await orderRows()).toBe(7);
  });

  it('lists the owner’s orders newest first by arrival with its filters, and nobody else’s', async () => {
    await open();
    const second = await createMarket(t.db);
    const ids: string[] = [];
    for (const [body, marketId] of [
      [{ qty: 2 }, market.id],
      [{ timeInForce: 'ioc' }, market.id], // no quote: rejected
      [{}, second.id],
      [{ outcome: 'NO' }, market.id],
    ] as const) {
      ids.push(placed(await send(a, body, { marketId })).order.id);
    }
    // B fills one of A's two YES bid at 40 (부분 체결, still live) and A's NO bid whole (ended).
    const ioc = { timeInForce: 'ioc', limitPriceCoin: 60 };
    placed(await send(b, { ...ioc, outcome: 'NO' }));
    placed(await send(b, ioc));
    expect(dataOf<Order>(await read(`/me/orders/${ids[0]!}`, a)).status).toBe('partially_filled');
    expect(dataOf<Order>(await read(`/me/orders/${ids[3]!}`, a)).status).toBe('filled');
    placed(await send(b));
    const page = async (query: string) => {
      const res = await read(`/me/orders${query}`, a);
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as { data: Order[]; meta: { nextCursor: string | null } };
    };
    const first = await page('?limit=3');
    expect(first.data.map((order) => order.id)).toEqual([ids[3], ids[2], ids[1]]);
    for (const order of first.data) orderSchema.parse(order);
    const rest = await page(`?limit=3&cursor=${encodeURIComponent(first.meta.nextCursor!)}`);
    expect(rest.data.map((order) => order.id)).toEqual([ids[0]]);
    expect(rest.meta.nextCursor).toBeNull();
    expect((await page(`?marketId=${second.id}`)).data.map((order) => order.id)).toEqual([ids[2]]);
    expect((await page('?state=live')).data.map((order) => order.id)).toEqual([ids[2], ids[0]]);
    expect((await page('?state=ended')).data.map((order) => order.id)).toEqual([ids[3], ids[1]]);
    // A malformed cursor serves the first page.
    expect((await page('?cursor=x_1')).data).toHaveLength(4);
    errorOf(await read('/me/orders?state=open', a), 400, 'VALIDATION_ERROR');
    // Another account's order is not there for B (N04 §7).
    errorOf(await read(`/me/orders/${ids[0]}`, b), 404, 'NOT_FOUND');
    errorOf(await read(`/me/orders/${randomUUID()}`, a), 404, 'NOT_FOUND');
    errorOf(await read('/me/orders', null), 401, 'UNAUTHENTICATED');
    errorOf(await read('/me/fills', null), 401, 'UNAUTHENTICATED');
  });

  it('never names the 운영 마켓메이커 on a member’s fill, and pages the fills newest first', async () => {
    await open();
    const marketMaker = await fundMarketMakerFunds(t.db, market.id, 10_000n);
    for (let i = 0; i < 3; i += 1) {
      const quote = await placeTestOrder(t.db, {
        ownerId: marketMaker,
        marketId: market.id,
        outcome: 'NO',
        limitPriceCoin: 45,
      });
      expect(quote.kind).toBe('placed');
    }
    // A takes the three bids one at a time: three fills, each a pair mint at 55.
    for (let i = 0; i < 3; i += 1) {
      placed(await send(a, { timeInForce: 'ioc', limitPriceCoin: 55 }));
    }
    const first = await read('/me/fills?limit=2', a);
    const page = JSON.parse(first.body) as { data: MyFill[]; meta: { nextCursor: string } };
    expect(page.data.map((fill) => [fill.outcome, fill.priceCoin, fill.qty])).toEqual([
      ['YES', 55, 1],
      ['YES', 55, 1],
    ]);
    const rest = JSON.parse(
      (await read(`/me/fills?limit=2&cursor=${encodeURIComponent(page.meta.nextCursor)}`, a)).body,
    ) as { data: MyFill[]; meta: { nextCursor: string | null } };
    expect(rest.data).toHaveLength(1);
    expect(rest.meta.nextCursor).toBeNull();
    expect(Number(rest.data[0]!.id)).toBeLessThan(Number(page.data[1]!.id));
    for (const res of [first, await read('/me/orders', a)]) {
      expect(res.body).not.toContain(marketMaker);
      expect(res.body).not.toMatch(/market_maker|accountType/);
    }
    expect(dataOf<MyFill[]>(await read(`/me/fills?marketId=${randomUUID()}`, a))).toEqual([]);
    expect(dataOf<MyFill[]>(await read('/me/fills', b))).toEqual([]);
  });

  it('merges the fills an account took and the fills its resting orders met, one id order across pages', async () => {
    await open();
    // A and B take turns resting a NO bid and taking it with an immediate YES buy, so each holds
    // four fills, its side alternating: A rests, takes, rests, takes (B the other way round).
    const rest = async (who: TestUser, limitPriceCoin: number) =>
      placed(await send(who, { outcome: 'NO', limitPriceCoin })).order;
    const take = async (who: TestUser) =>
      placed(await send(who, { timeInForce: 'ioc', limitPriceCoin: 99 })).order;
    const a1 = await rest(a, 40);
    const b1 = await take(b);
    const b2 = await rest(b, 45);
    const a2 = await take(a);
    const a3 = await rest(a, 30);
    const b3 = await take(b);
    const b4 = await rest(b, 35);
    const a4 = await take(a);
    // Each bid rested whole and each immediate buy took it whole.
    for (const order of [a1, b2, a3, b4]) expect(order.status).toBe('open');
    for (const order of [b1, a2, b3, a4]) expect(order).toMatchObject({ status: 'filled', qty: 1 });

    // Every page, `limit` at a time, following the cursor until it ends.
    const pages = async (who: TestUser, limit: number) => {
      const out: MyFill[][] = [];
      let cursor: string | null = null;
      do {
        const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await read(`/me/fills${query}`, who);
        expect(res.statusCode, res.body).toBe(200);
        const body = JSON.parse(res.body) as {
          data: MyFill[];
          meta: { nextCursor: string | null };
        };
        out.push(body.data);
        cursor = body.meta.nextCursor;
      } while (cursor !== null);
      return out;
    };
    // Newest first, each fill as the account's own order took it: a resting NO bid at its price,
    // an immediate YES buy at 100 − the bid it met.
    const aSees = [
      [a4.id, 'YES', 65],
      [a3.id, 'NO', 30],
      [a2.id, 'YES', 55],
      [a1.id, 'NO', 40],
    ];
    const bSees = [
      [b4.id, 'NO', 35],
      [b3.id, 'YES', 70],
      [b2.id, 'NO', 45],
      [b1.id, 'YES', 60],
    ];
    const ids: string[][] = [];
    for (const [who, sees] of [
      [a, aSees],
      [b, bSees],
    ] as const) {
      for (const [limit, sizes] of [
        [1, [1, 1, 1, 1]],
        [2, [2, 2]],
        [3, [3, 1]],
      ] as const) {
        const got = await pages(who, limit);
        expect(got.map((page) => page.length)).toEqual(sizes);
        const all = got.flat();
        expect(all.map((fill) => [fill.orderId, fill.outcome, fill.priceCoin])).toEqual(sees);
        ids.push(all.map((fill) => fill.id));
      }
    }
    // The same four fills on both sides, their ids strictly falling.
    for (const list of ids) {
      expect(list).toEqual(ids[0]);
      expect(list.map(Number)).toEqual([...list.map(Number)].sort((x, y) => y - x));
      expect(new Set(list).size).toBe(4);
    }
  });

  it('changes an open market’s width by one admin with a reason, for the next orders only (#177 2항)', async () => {
    await open();
    const change = (id: string, body: Record<string, unknown>, who = admin) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/markets/${id}/price-protection`,
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
        payload: JSON.stringify({ expectedAccountId: who.id, reason: '호가 폭 조정', ...body }),
      });
    // B bids NO at 40 for 3: the YES ask is 60. A's immediate buy at 99 is narrowed to 65.
    placed(await send(b, { outcome: 'NO', qty: 3 }));
    const before = placed(await send(a, { timeInForce: 'ioc', limitPriceCoin: 99 }));
    expect(before.order.protectedLimitPriceCoin).toBe(65);

    const changed = dataOf<AdminMarket>(await change(market.id, { priceProtectionTicks: 2 }));
    expect(changed.priceProtectionTicks).toBe(2);
    expect(changed.events[0]).toMatchObject({
      type: 'price_protection_changed',
      actorId: admin.id,
      fromStatus: null,
      toStatus: null,
      payload: { before: 5, after: 2, reason: '호가 폭 조정' },
    });
    const [action] = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.type, 'market_price_protection_change'));
    expect(action).toMatchObject({
      adminId: admin.id,
      targetType: 'market',
      targetId: market.id,
      payload: { before: 5, after: 2, reason: '호가 폭 조정' },
    });
    const after = placed(await send(a, { timeInForce: 'ioc', limitPriceCoin: 99 }));
    expect(after.order.protectedLimitPriceCoin).toBe(62);
    // The order taken before keeps its own.
    expect(
      dataOf<Order>(await read(`/me/orders/${before.order.id}`, a)).protectedLimitPriceCoin,
    ).toBe(65);

    expect(
      errorOf(await change(market.id, { priceProtectionTicks: 2 }), 400, 'VALIDATION_ERROR'),
    ).toEqual([{ path: ['priceProtectionTicks'], message: 'unchanged' }]);
    for (const ticks of [0, 99, 1.5]) {
      errorOf(await change(market.id, { priceProtectionTicks: ticks }), 400, 'VALIDATION_ERROR');
    }
    errorOf(
      await change(market.id, { priceProtectionTicks: 3, reason: '' }),
      400,
      'VALIDATION_ERROR',
    );
    // Every status but OPEN and PAUSED, the service's 400 — for all but a draft the database's
    // `markets_price_protection_fixed` refuses too, and its error would be a 500; a market that
    // closed while an admin's dialog was open reads 'market is closed' (the web re-reads it).
    for (const status of ['draft', 'review', 'scheduled', 'closed'] as const) {
      const wrong = await createMarket(t.db, { status });
      expect(
        errorOf(await change(wrong.id, { priceProtectionTicks: 3 }), 400, 'VALIDATION_ERROR'),
        status,
      ).toEqual([{ path: ['status'], message: `market is ${status}` }]);
      const [row] = await t.db
        .select({ ticks: schema.markets.priceProtectionTicks })
        .from(schema.markets)
        .where(eq(schema.markets.id, wrong.id));
      expect(row?.ticks, status).toBe(wrong.priceProtectionTicks);
    }
    errorOf(await change(market.id, { priceProtectionTicks: 3 }, a), 403, 'FORBIDDEN');
    errorOf(await change(randomUUID(), { priceProtectionTicks: 3 }), 404, 'NOT_FOUND');
    // A market with none (submitted before #119) shows none on its admin detail — no default
    // stands in past the draft, and the open-items check names it — and takes one here, from null.
    const none = await createMarket(t.db, { status: 'paused', priceProtectionTicks: null });
    await openOrderIntake(t.db, { adminId: admin.id, widthTicks: TEST_PRICE_PROTECTION_TICKS });
    const shown = dataOf<AdminMarket>(await read(`/admin/markets/${none.id}`, admin));
    expect(shown.priceProtectionTicks).toBeNull();
    expect(shown.missingOpenItems).toContain('priceProtection');
    expect(
      dataOf<AdminMarket>(await change(none.id, { priceProtectionTicks: 4 })).events[0],
    ).toMatchObject({
      payload: { before: null, after: 4 },
    });
  });
  describe('cancel (#178, ADR-0113)', () => {
    const cancel = (who: TestUser | null, id: string, expectedAccountId = who?.id) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/me/orders/${id}/cancel`,
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          ...(who ? { cookie: who.cookie } : {}),
        },
        payload: JSON.stringify({ expectedAccountId }),
      });
    const cancelled = async (who: TestUser, id: string): Promise<Order> =>
      orderSchema.parse(dataOf<Order>(await cancel(who, id)));
    const orderRow = async (id: string) =>
      (await t.db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0]!;
    const expectSound = async () => expect(await checkOrderInvariants(t.db)).toEqual([]);
    /**
     * The worker's close at `close_at` (`closeMarketAtClose`, #120): the close moved a minute
     * back, then OPEN or PAUSED → CLOSED with every live order ended 만료 (a held market's kept) —
     * CANCELLED instead when no fill a person's account is on happened (#20; `tradeOnce` first).
     */
    async function workerClose(marketId: string) {
      await passMarketClose(t.db, marketId);
      const done = await closeTestMarket(t.db, marketId);
      if (!done.closed) throw new Error(`the close skipped: ${done.reason}`);
      return done;
    }

    it('ends a resting order in the request as 취소 완료(본인 취소), its lock back, and answers what GET reads', async () => {
      await open();
      const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
      const resting = placed(await send(a, { qty: 3 })).order;
      expect(await balanceOf(t.db, a.id)).toMatchObject({ lockedCoin: 120n });
      const answer = await cancelled(a, resting.id);
      expect(answer).toEqual({
        ...resting,
        cancelledQty: 3,
        status: 'cancelled',
        cancelReason: 'by_owner',
        endedAt: expect.any(String) as unknown,
      });
      expect(dataOf<Order>(await read(`/me/orders/${resting.id}`, a))).toEqual(answer);
      expect(await balanceOf(t.db, a.id)).toMatchObject({
        availableCoin: START_COIN,
        lockedCoin: 0n,
      });
      // One instant: the request is the completion (ADR-0112 10-5) — no 'requested' state.
      expect((await orderRow(resting.id)).updatedAt.toISOString()).toBe(answer.endedAt);
      // A buy's release records no ledger entry: nothing to publish (ADR-0112 10-10).
      expect(publish).not.toHaveBeenCalled();
      // Asked again it answers the same, and releases nothing.
      expect(await cancelled(a, resting.id)).toEqual(answer);
      expect(await balanceOf(t.db, a.id)).toMatchObject({ lockedCoin: 0n });
      // The lists: out of the live ones, in the ended ones.
      expect(dataOf<Order[]>(await read('/me/orders?state=live', a))).toEqual([]);
      expect(dataOf<Order[]>(await read('/me/orders?state=ended', a))).toEqual([answer]);
      await expectSound();
    });

    it('keeps what filled and cancels the rest; a sell gives its contracts back and publishes its position', async () => {
      await open();
      // A bids NO at 40 for 3; B's IOC YES buy for one mints a pair at 60 against it.
      const bid = placed(await send(a, { outcome: 'NO', qty: 3 })).order;
      placed(await send(b, { timeInForce: 'ioc', limitPriceCoin: 99, qty: 1 }));
      const answer = await cancelled(a, bid.id);
      expect(answer).toMatchObject({
        qty: 3,
        filledQty: 1,
        filledAmountCoin: '40',
        cancelledQty: 2,
        status: 'cancelled',
        cancelReason: 'by_owner',
      });
      expect(await balanceOf(t.db, a.id)).toMatchObject({
        availableCoin: START_COIN - 40n,
        lockedCoin: 0n,
      });
      // B sells its one YES at 70: it rests on B's position (locked_qty 1).
      const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
      const ask = placed(await send(b, { side: 'sell', limitPriceCoin: 70 })).order;
      publish.mockClear();
      const fills = (await t.db.select({ n: count() }).from(schema.fills))[0]!.n;
      expect(await cancelled(b, ask.id)).toMatchObject({ status: 'cancelled', cancelledQty: 1 });
      const [position] = await t.db
        .select()
        .from(schema.positions)
        .where(eq(schema.positions.userId, b.id));
      expect(position).toMatchObject({ outcome: 'YES', qty: 1, lockedQty: 0 });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(
        b.id,
        expect.objectContaining({ type: 'user:position', outcome: 'YES', qty: 1 }),
      );
      // A cancel is no fill.
      expect((await t.db.select({ n: count() }).from(schema.fills))[0]!.n).toBe(fills);
      await expectSound();
    });

    it('answers an ended order as it is, and another account’s as a random id: NOT_FOUND, nothing changed', async () => {
      await open();
      // An immediate order on an empty book is rejected (no quote); one meeting part of a bid
      // ends 취소 완료 with its rest (즉시 거래 잔량): both answered as they are.
      const rejected = placed(await send(a, { timeInForce: 'ioc', limitPriceCoin: 99 })).order;
      expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'no_quote' });
      expect(await cancelled(a, rejected.id)).toEqual(rejected);
      placed(await send(b, { outcome: 'NO' }));
      const ioc = placed(await send(a, { timeInForce: 'ioc', limitPriceCoin: 99, qty: 2 })).order;
      expect(ioc).toMatchObject({ status: 'cancelled', cancelReason: 'ioc_remainder' });
      expect(await cancelled(a, ioc.id)).toEqual(ioc);
      const resting = placed(await send(a)).order;
      const before = await orderRow(resting.id);
      const foreign = await cancel(b, resting.id);
      const random = await cancel(b, randomUUID());
      errorOf(foreign, 404, 'NOT_FOUND');
      errorOf(random, 404, 'NOT_FOUND');
      expect(foreign.body).toBe(random.body);
      // B naming A is refused before anything is read.
      errorOf(await cancel(b, resting.id, a.id), 403, 'FORBIDDEN');
      errorOf(await cancel(null, resting.id), 401, 'UNAUTHENTICATED');
      errorOf(await cancel(a, 'not-a-uuid'), 400, 'VALIDATION_ERROR');
      expect(await orderRow(resting.id)).toEqual(before);
      expect(await balanceOf(t.db, a.id)).toMatchObject({ lockedCoin: 40n });
      await expectSound();
    });

    it('is no submission for order.rate_limit, and works while intake is closed', async () => {
      await open(1);
      const resting = placed(await send(a)).order;
      // The limit's one submission is spent: the cancel still goes, and the next order does not.
      expect((await cancelled(a, resting.id)).status).toBe('cancelled');
      errorOf(await send(a), 429, 'RATE_LIMITED');
      // Intake closed, then unset: a resting order is still cancelled.
      const others: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const result = await placeTestOrder(t.db, { marketId: market.id, ownerId: b.id });
        if (result.kind !== 'placed') throw new Error(result.kind);
        others.push(result.order.id);
      }
      for (const [i, value] of [false, null].entries()) {
        await setReleaseSetting(t.db, {
          adminId: admin.id,
          key: ORDER_ACCEPTING_SETTING.key,
          status: value === null ? 'undecided' : 'test',
          value,
        });
        expect((await cancelled(b, others[i]!)).status).toBe('cancelled');
      }
      expect(await balanceOf(t.db, b.id)).toMatchObject({ lockedCoin: 0n });
    });

    it('lets a restricted account, one sent back to the terms and one granted the admin role cancel its own', async () => {
      await open();
      const restricted = placed(await send(a)).order;
      const c = await member();
      const granted = placed(await send(c)).order;
      // An account that has not done the onboarding (as one a terms revision sent back to agree
      // again, #57-5): its order placed past the API, which would refuse it.
      const newcomer = await signUpTestUser(t);
      await createStartGrant(t.db, { userId: newcomer.id, amountCoin: START_COIN });
      const pending = await placeTestOrder(t.db, { marketId: market.id, ownerId: newcomer.id });
      if (pending.kind !== 'placed') throw new Error(pending.kind);
      // An account restriction written as approved (the approval's own cancel is the moderation
      // suite's): new orders refused, the owner's cancel open (N02 §9 «신규 주문은 막되»).
      await createModerationAction(t.db, {
        userId: a.id,
        createdBy: admin.id,
        type: 'account_restriction',
        reason: 'multi_account',
        approvedBy: (await anAdmin()).id,
      });
      errorOf(await send(a), 403, 'RESTRICTED');
      expect((await cancelled(a, restricted.id)).cancelReason).toBe('by_owner');
      // Signed in is enough: no OnboardedGuard on the cancel.
      errorOf(await send(newcomer), 409, 'ONBOARDING_REQUIRED');
      expect((await cancelled(newcomer, pending.order.id)).cancelReason).toBe('by_owner');
      // C became an admin after ordering: it never orders again, but cancels the earlier one.
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, c.id));
      await t.app.get(AdminGuard).invalidate(c.id);
      expect((await cancelled(c, granted.id)).cancelReason).toBe('by_owner');
      for (const who of [a, c, newcomer]) {
        expect(await balanceOf(t.db, who.id)).toMatchObject({ lockedCoin: 0n });
      }
      await expectSound();
    });

    it('refuses a live order of a market held for a ledger failure, closed before its recovery too, and answers an expired one as it is', async () => {
      await open();
      const held = placed(await send(a, { qty: 2 })).order;
      const ended = placed(await send(a, { timeInForce: 'ioc', limitPriceCoin: 99 })).order;
      // Two other members' pair, so the close below is CLOSED, not CANCELLED (#20).
      await tradeOnce(t.db, market.id);
      await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure' });
      const before = await orderRow(held.id);
      const refuse = async () => {
        const res = await cancel(a, held.id);
        expect(errorOf(res, 409, 'MARKET_NOT_OPEN')).toEqual([
          { path: ['market'], message: 'paused' },
        ]);
        expect(await orderRow(held.id)).toEqual(before);
        expect(await balanceOf(t.db, a.id)).toMatchObject({ lockedCoin: 80n });
      };
      await refuse();
      // An ended order there answers its final state.
      expect(await cancelled(a, ended.id)).toEqual(ended);
      // Closed at its close before the recovery: still held.
      expect((await workerClose(market.id)).status).toBe('closed');
      await refuse();

      // A CLOSED market not held: the close ended the order 만료 at its instant (#120), and the
      // owner's cancel answers it in that final state — 200, nothing released, nothing published.
      const other = await createMarket(t.db);
      const resting = placed(await send(a, { qty: 3 }, { marketId: other.id })).order;
      await tradeOnce(t.db, other.id);
      const done = await workerClose(other.id);
      expect(done.status).toBe('closed');
      const expired = await orderRow(resting.id);
      expect(expired).toMatchObject({ status: 'expired', cancelReason: null });
      const coin = await balanceOf(t.db, a.id);
      const publisher = t.app.get(MarketPublisher);
      const toMarket = vi.spyOn(publisher, 'publishMarket');
      const toUser = vi.spyOn(publisher, 'publishUser');
      const answer = await cancelled(a, resting.id);
      expect(answer).toMatchObject({
        id: resting.id,
        status: 'expired',
        filledQty: 0,
        cancelledQty: 3,
        cancelReason: null,
        rejectReason: null,
        endedAt: done.closedAt.toISOString(),
      });
      expect(await cancelled(a, resting.id)).toEqual(answer);
      expect(await orderRow(resting.id)).toEqual(expired);
      expect(await balanceOf(t.db, a.id)).toEqual(coin);
      expect(toMarket).not.toHaveBeenCalled();
      expect(toUser).not.toHaveBeenCalled();
      // The ended list has it; the live one does not.
      const endedIds = dataOf<Order[]>(await read('/me/orders?state=ended&limit=100', a)).map(
        (row) => row.id,
      );
      expect(endedIds).toContain(resting.id);
      const liveIds = dataOf<Order[]>(await read('/me/orders?state=live&limit=100', a)).map(
        (row) => row.id,
      );
      expect(liveIds).not.toContain(resting.id);

      // A paused market held until its 재개 is approved: the recovery cancels it 일시 중단.
      const third = await createMarket(t.db);
      const waiting = placed(await send(a, {}, { marketId: third.id })).order;
      await createMarketPause(t.db, { marketId: third.id, reason: 'ledger_failure' });
      errorOf(await cancel(a, waiting.id), 409, 'MARKET_NOT_OPEN');
      await resumeMarket(t.db, third.id);
      expect(await cancelled(a, waiting.id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'paused',
      });
    });

    it('meets a crossing order on the market lock: whichever comes first, one remainder and one lock', async () => {
      await open();
      for (const crossFirst of [true, false]) {
        // A rests a NO bid of 2 at 40 (a YES ask of 60); B buys one YES at once.
        const bid = placed(await send(a, { outcome: 'NO', qty: 2 })).order;
        const observer = await t.db.$client.connect();
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let held = () => {};
        const holding = new Promise<void>((resolve) => {
          held = resolve;
        });
        const holder = t.db.transaction(async (tx) => {
          await lockMarket(tx, market.id);
          held();
          await gate;
        });
        const crossing = () => send(b, { timeInForce: 'ioc', limitPriceCoin: 99 });
        try {
          await holding;
          const first = crossFirst ? crossing() : cancel(a, bid.id);
          await waitForLockWaiter(observer, 'the first request behind the market lock');
          const second = crossFirst ? cancel(a, bid.id) : crossing();
          await waitForLockWaiter(observer, 'the second request behind the market lock', 2);
          release();
          await holder;
          const [one, two] = await Promise.all([first, second]);
          const [crossRes, cancelRes] = crossFirst ? [one, two] : [two, one];
          const cross = placed(crossRes).order;
          const answer = orderSchema.parse(dataOf<Order>(cancelRes));
          if (crossFirst) {
            expect(cross).toMatchObject({ filledQty: 1, status: 'filled' });
            expect(answer).toMatchObject({ filledQty: 1, cancelledQty: 1, status: 'cancelled' });
          } else {
            expect(answer).toMatchObject({ filledQty: 0, cancelledQty: 2, status: 'cancelled' });
            expect(cross).toMatchObject({ status: 'rejected', rejectReason: 'no_quote' });
          }
        } finally {
          release();
          await holder.catch(() => undefined);
          observer.release();
        }
        await expectSound();
      }
    });
  });
});
