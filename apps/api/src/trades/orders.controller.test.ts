/**
 * 주문 접수와 본인의 주문·체결 (#119, ADR-0112) through the API against the docker `test` profile:
 * `POST /markets/:id/orders` and `/me/orders`, `/me/fills`, and the admin's after-open change of a
 * market's 가격 보호 폭. Skips when TEST_* are unset (fails under CI=true, see the harness). The
 * intake itself (every path, lock, race and invariant) is packages/db orders.test.ts's; here are
 * the checks that answer an error and write no row, the race of the service's own locks with a
 * role grant, the answers' shapes, the owner's reads, the order limit and the realtime events.
 */
import { randomUUID } from 'node:crypto';
import { lockAdminRoles, lockLedgerAccounts, lockMarket, schema } from '@buddha/db';
import {
  balanceOf,
  completeOnboarding,
  createMarket,
  createModerationAction,
  createStartGrant,
  createUser,
  fundMarketMakerFunds,
  openOrderIntake,
  placeTestOrder,
  setReleaseSetting,
  TEST_PRICE_PROTECTION_TICKS,
} from '@buddha/db/test';
import {
  ORDER_ACCEPTING_SETTING,
  ORDER_RATE_LIMIT_SETTING,
  myFillSchema,
  orderSchema,
  placeOrderResultSchema,
  type AdminMarket,
  type MyFill,
  type Order,
  type PlaceOrderResult,
} from '@buddha/shared';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
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
    // A bids NO at 40 for 2: it rests, its Coin locked, and nothing is published (a lock alone).
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
});
