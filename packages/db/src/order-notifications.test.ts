import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { NOTIFICATION_EVENT_KEY_PATTERN } from '@buddha/shared';
import { asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './client.js';
import { pauseMarket } from './market-pause.js';
import * as marketStats from './market-stats.js';
import {
  createNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationPage,
  type NotificationInput,
  type NotificationOutcome,
} from './notifications.js';
import { cancelLockedOrders, lockAccountOrders, lockMarketOrders } from './order-cancel.js';
import {
  adminActionEventKey,
  fillEventKey,
  marketEventKey,
  moderationActionEventKey,
  orderEndNotificationInputs,
  reconciliationHoldEventKey,
  restingFillNotificationInputs,
  type OrderEndNotice,
  type RestingFill,
} from './order-notifications.js';
import { placeOrder, type OrderRow } from './orders.js';
import { fills, markets, notifications, orders, profiles } from './schema/index.js';
import {
  createConfiguredOpenMarket,
  createMarket,
  createMarketPause,
  createUser,
  TEST_MM_TRADING_LIQUIDITY,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { fundMarketMakerFunds } from './test/ledger.js';
import {
  closeTestMarket,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  type PlaceTestOrderInput,
} from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/*
 * 거래 알림 (#134, ADR-0158): the builders of the three 거래 types (order-notifications.ts), the
 * intake's fill notices through the real intake (`placeTestOrder` delivers them as the API does),
 * the batch notices through the real batches, every builder's output through `createNotifications`
 * (a refused input would roll its event back), reprocessing, the races, and the static pin of
 * who notifies.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const M1 = '0b6f3c1a-5f43-4b7e-9d0e-6a1c2b3d4e5f';
const M2 = '1c7a4d2b-6a54-4c8f-8e1f-7b2d3c4e5f60';
const AT = new Date('2026-11-21T03:00:00.000Z');

/** An ended order row of the shape the batches return. */
const ended = (change: Partial<OrderRow> = {}): OrderRow => ({
  id: randomUUID(),
  userId: 'member-a',
  marketId: M1,
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'gtc',
  limitPrice: 40,
  protectedLimitPrice: 40,
  referencePrice: null,
  protectionTicks: null,
  qty: 3,
  budgetCoin: null,
  filledQty: 0,
  filledAmountCoin: 0n,
  unspentCoin: null,
  status: 'cancelled',
  rejectReason: null,
  cancelReason: 'paused',
  idempotencyKey: randomUUID(),
  arrivalSeq: 1,
  createdAt: AT,
  updatedAt: AT,
  endedAt: AT,
  ...change,
});

const pausedNotice = (marketId = M1): OrderEndNotice => ({
  kind: 'cancelled',
  reason: 'paused',
  market: { id: marketId, title: '첫눈이 올까' },
  eventKey: marketEventKey(7),
  occurredAt: AT,
});

describe('event keys (#134)', () => {
  it('keep each source apart and fit the write path’s key shape', () => {
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const keys = [
      fillEventKey(9),
      marketEventKey(9),
      adminActionEventKey(uuid),
      moderationActionEventKey(uuid),
      reconciliationHoldEventKey(uuid),
    ];
    expect(keys).toEqual([
      'fill:9',
      'market_event:9',
      `admin_action:${uuid}`,
      `moderation_action:${uuid}`,
      `reconciliation_hold:${uuid}`,
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [...keys, fillEventKey(Number.MAX_SAFE_INTEGER)]) {
      expect(NOTIFICATION_EVENT_KEY_PATTERN.test(key), key).toBe(true);
    }
  });
});

describe('restingFillNotificationInputs (52-2, 52-6, 134-1·134-3)', () => {
  const restingFill = (change: Partial<RestingFill> = {}): RestingFill => ({
    fill: { id: 41 },
    resting: {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      owner: { id: 'member-a', human: true },
      outcome: 'NO',
      side: 'buy',
    },
    planned: { qty: 2, restingPriceCoin: 40, restingRemainingQty: 1 },
    order: { qty: 3, filledQty: 2 },
    ...change,
  });

  it('tells the resting person of each fill at the order’s own price, contract and direction', () => {
    // A pair mint: the incoming YES buy paid 60 a contract; the resting NO bid's price is 40.
    expect(
      restingFillNotificationInputs({ marketTitle: '첫눈이 올까', at: AT, fills: [restingFill()] }),
    ).toEqual([
      {
        userId: 'member-a',
        type: 'order_filled',
        eventKey: 'fill:41',
        mergeKey: 'a1b2c3d4-0000-4000-8000-000000000001',
        occurredAt: AT,
        target: { kind: 'order', orderId: 'a1b2c3d4-0000-4000-8000-000000000001' },
        params: {
          marketTitle: '첫눈이 올까',
          outcome: 'NO',
          side: 'buy',
          qty: '2',
          amountCoin: '80',
          fullyFilled: false,
          orderQty: '3',
          orderFilledQty: '2',
        },
      },
    ]);
  });

  it('says 전량 체결 when the order has nothing left, a resting sell included', () => {
    const [input] = restingFillNotificationInputs({
      marketTitle: 't',
      at: AT,
      fills: [
        restingFill({
          resting: {
            id: 'o-sell',
            owner: { id: 'member-b', human: true },
            outcome: 'YES',
            side: 'sell',
          },
          planned: { qty: 3, restingPriceCoin: 35, restingRemainingQty: 0 },
          order: { qty: 5, filledQty: 5 },
        }),
      ],
    });
    expect(input?.params).toMatchObject({
      outcome: 'YES',
      side: 'sell',
      qty: '3',
      amountCoin: '105',
      fullyFilled: true,
      orderQty: '5',
      orderFilledQty: '5',
    });
  });

  it('leaves the 운영 마켓메이커 out, and gives nothing for no fill', () => {
    const bot = restingFill({
      fill: { id: 42 },
      resting: { id: 'o-bot', owner: { id: 'mm', human: false }, outcome: 'YES', side: 'buy' },
    });
    const person = restingFill({ fill: { id: 43 } });
    expect(
      restingFillNotificationInputs({ marketTitle: 't', at: AT, fills: [bot, person] }).map(
        (input) => input.eventKey,
      ),
    ).toEqual(['fill:43']);
    expect(restingFillNotificationInputs({ marketTitle: 't', at: AT, fills: [bot] })).toEqual([]);
    expect(restingFillNotificationInputs({ marketTitle: 't', at: AT, fills: [] })).toEqual([]);
  });
});

describe('orderEndNotificationInputs (52-3, 52-4, 52-5)', () => {
  it('gives each member one notice, sorted, leading to the order when it is one', () => {
    const one = ended({ userId: 'member-b' });
    const two = [ended({ userId: 'member-a' }), ended({ userId: 'member-a' })];
    expect(orderEndNotificationInputs([one, ...two], pausedNotice())).toEqual([
      {
        userId: 'member-a',
        type: 'orders_cancelled',
        eventKey: 'market_event:7',
        occurredAt: AT,
        target: { kind: 'order_history', marketId: M1 },
        params: { reason: 'paused', orderCount: 2, marketCount: 1, marketTitle: '첫눈이 올까' },
      },
      {
        userId: 'member-b',
        type: 'orders_cancelled',
        eventKey: 'market_event:7',
        occurredAt: AT,
        target: { kind: 'order', orderId: one.id },
        params: { reason: 'paused', orderCount: 1, marketCount: 1, marketTitle: '첫눈이 올까' },
      },
    ]);
  });

  it('counts an account event’s orders and markets, leading to every market’s history', () => {
    for (const reason of ['admin_role', 'restricted'] as const) {
      const rows = [
        ended({ cancelReason: reason, marketId: M1 }),
        ended({ cancelReason: reason, marketId: M2 }),
        ended({ cancelReason: reason, marketId: M2 }),
      ];
      const notice: OrderEndNotice = {
        kind: 'cancelled',
        reason,
        eventKey: adminActionEventKey('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
        occurredAt: AT,
      };
      expect(orderEndNotificationInputs(rows, notice)).toEqual([
        {
          userId: 'member-a',
          type: 'orders_cancelled',
          eventKey: notice.eventKey,
          occurredAt: AT,
          target: { kind: 'order_history', marketId: null },
          params: { reason, orderCount: 3, marketCount: 2, marketTitle: null },
        },
      ]);
      const [single] = orderEndNotificationInputs([rows[1]!], notice);
      expect(single).toMatchObject({
        target: { kind: 'order', orderId: rows[1]!.id },
        params: { orderCount: 1, marketCount: 1 },
      });
    }
  });

  it('tells an expiry by the market’s end: 거래 마감 or 시장 취소', () => {
    for (const cause of ['closed', 'cancelled'] as const) {
      const rows = [ended({ status: 'expired', cancelReason: null })];
      const notice: OrderEndNotice = {
        kind: 'expired',
        cause,
        market: { id: M1, title: '첫눈이 올까' },
        eventKey: marketEventKey(11),
        occurredAt: AT,
      };
      expect(orderEndNotificationInputs(rows, notice)).toEqual([
        {
          userId: 'member-a',
          type: 'orders_expired',
          eventKey: 'market_event:11',
          occurredAt: AT,
          target: { kind: 'order', orderId: rows[0]!.id },
          params: { marketTitle: '첫눈이 올까', cause, orderCount: 1 },
        },
      ]);
      expect(
        orderEndNotificationInputs(
          [...rows, ended({ status: 'expired', cancelReason: null })],
          notice,
        )[0],
      ).toMatchObject({
        target: { kind: 'order_history', marketId: M1 },
        params: { orderCount: 2 },
      });
    }
  });

  it('gives nothing for no row', () => {
    expect(orderEndNotificationInputs([], pausedNotice())).toEqual([]);
  });

  it('throws on a row that did not end as the notice says, or of another market (a caller bug)', () => {
    const expiry: OrderEndNotice = {
      kind: 'expired',
      cause: 'closed',
      market: { id: M1, title: 't' },
      eventKey: marketEventKey(1),
      occurredAt: AT,
    };
    const wrong: [OrderRow, OrderEndNotice][] = [
      // A held order is still live: the recovery or the market's end notifies it later.
      [ended({ status: 'open', cancelReason: null }), pausedNotice()],
      [ended({ status: 'partially_filled', cancelReason: null }), expiry],
      [ended({ status: 'filled', cancelReason: null }), pausedNotice()],
      [ended({ cancelReason: 'by_owner' }), pausedNotice()],
      [ended({ cancelReason: 'restricted' }), pausedNotice()],
      [ended({ status: 'expired', cancelReason: null }), pausedNotice()],
      [ended(), expiry],
      [ended({ marketId: M2 }), pausedNotice(M1)],
      [ended({ status: 'expired', cancelReason: null, marketId: M2 }), expiry],
      [
        ended({ cancelReason: 'paused' }),
        { kind: 'cancelled', reason: 'restricted', eventKey: 'x', occurredAt: AT },
      ],
    ];
    for (const [row, notice] of wrong) {
      expect(() => orderEndNotificationInputs([row], notice), JSON.stringify(row.status)).toThrow();
    }
  });
});

// ---- static ------------------------------------------------------------------------------------

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

/**
 * Every production source of every app and package (order-writes.test.ts's scan), relative to the
 * repository root: no test, and no fixture under `packages/db/src/test/` (its helpers call the
 * cores to set tests up — `placeTestOrder` delivers like the API, `closeTestMarket` is the close).
 */
function sourceFiles(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(new URL(`${group}/`, ROOT), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = `${group}/${entry.name}/src`;
        let files: string[];
        try {
          files = readdirSync(new URL(`${src}/`, ROOT), { recursive: true, encoding: 'utf8' });
        } catch {
          return [];
        }
        return files
          .map((file) => file.replaceAll('\\', '/'))
          .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !/\.test\.tsx?$/.test(file))
          .map((file) => `${src}/${file}`)
          .filter((file) => !file.startsWith('packages/db/src/test/'));
      }),
  );
}

/**
 * The cores that fill or end resting orders a notice covers: each takes the transaction first, so
 * a CALL is `name(tx,` or `name(tx)` — not a definition (`name(\n  tx: Tx,`), the API controller's
 * method `placeOrder(` or the web client's `placeOrder({`.
 */
const ORDER_ENDING_CORES = [
  'placeOrder',
  'cancelLockedOrders',
  'expireLockedOrders',
  'pauseMarket',
  'endMarketPause',
  'closeMarketAtClose',
  'recoverReconciliationHold',
  'cancelScheduledMarket',
];
const CORE_CALL = new RegExp(String.raw`\b(${ORDER_ENDING_CORES.join('|')})\(\s*tx\s*[,)]`);

type CallerClass =
  /** Its file holds the event's one `createNotifications` call (ADR-0157 결정 4). */
  | { class: 'notifies'; event: string }
  /** It runs in a transaction whose owner (or callee) notifies, or is excluded: `by`. */
  | { class: 'core'; by: string }
  /** It ends orders no notice covers (ADR-0158 §5). */
  | { class: 'excluded'; reason: string };

/**
 * Every production file that calls a core, classified (ADR-0158). A new caller fails the pin until
 * it is classified here; a stale entry fails too.
 */
const CALLERS: Record<string, CallerClass> = {
  'apps/api/src/trades/order.service.ts': { class: 'notifies', event: 'F1 a member’s intake' },
  'packages/db/src/market-maker-cycle.ts': { class: 'notifies', event: 'F2 the bot’s cycle' },
  'apps/api/src/markets/market-pause.service.ts': {
    class: 'notifies',
    event: 'B the pause, C its approved end',
  },
  'apps/api/src/admin-accounts/admin-accounts.service.ts': {
    class: 'notifies',
    event: 'D the admin-role grant',
  },
  'apps/api/src/moderation/account-restrictions.service.ts': {
    class: 'notifies',
    event: 'E the restriction’s approval',
  },
  'packages/db/src/market-close.ts': { class: 'notifies', event: 'G the close at close_at' },
  'apps/api/src/admin/reconciliation.service.ts': {
    class: 'notifies',
    event: 'H the recovery of a closed held market',
  },
  'packages/db/src/market-pause.ts': {
    class: 'core',
    by: 'apps/api/src/markets/market-pause.service.ts',
  },
  'packages/db/src/reconciliation-recovery.ts': {
    class: 'core',
    by: 'apps/api/src/admin/reconciliation.service.ts',
  },
  'packages/db/src/market-cancel.ts': {
    class: 'core',
    by: 'apps/api/src/markets/market-cancel.service.ts',
  },
  'apps/worker/src/jobs/market-close.ts': { class: 'core', by: 'packages/db/src/market-close.ts' },
  'apps/api/src/account-closure/account-closure.service.ts': {
    class: 'excluded',
    reason: 'account_closed: the closure deletes the inbox in the same transaction (52-3)',
  },
  'apps/api/src/markets/market-cancel.service.ts': {
    class: 'excluded',
    reason: 'a SCHEDULED market has no live order: its expiry is empty (52-5; #54 adds watchers)',
  },
  'packages/db/src/seed.ts': {
    class: 'excluded',
    reason: 'the bootstrap admins: no market has opened without an admin, so nothing is cancelled',
  },
};

/** The argument text of each `name(` call in `source`, up to its closing parenthesis. */
function callTexts(source: string, name: string): string[] {
  const texts: string[] = [];
  const pattern = new RegExp(String.raw`\b${name}\(`, 'g');
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const char = source[end]!;
      if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) {
        if (depth === 0) break;
        depth--;
      }
    }
    texts.push(source.slice(match.index + match[0].length, end));
  }
  return texts;
}

describe('who notifies of an order’s fill or end (#134, static)', () => {
  const files = sourceFiles();
  const matched = files.filter((file) => CORE_CALL.test(read(file))).sort();

  it('reads the source tree (the scan is not empty)', () => {
    expect(files).toEqual(expect.arrayContaining(['packages/db/src/orders.ts']));
    expect(files.some((file) => file.startsWith('packages/db/src/test/'))).toBe(false);
  });

  it('matches call sites only: a definition, a controller method and a client call are none', () => {
    for (const text of [
      'await placeOrder(tx, input)',
      'const result = await placeOrder(\n        tx,\n        {',
      'db.transaction((tx) => closeMarketAtClose(tx, marketId))',
      'recoverReconciliationHold(tx)',
      'cancelLockedOrders( tx , locked, { reason })',
    ]) {
      expect(CORE_CALL.test(text), text).toBe(true);
    }
    for (const text of [
      'export async function placeOrder(\n  tx: Tx,\n  input: PlaceOrderInput,',
      'placeOrder(\n    @Body() body: PlaceOrderBody,',
      'const result = await placeOrder({ marketId })',
      'cancelLockedOrders(trx, locked)',
      'replaceOrder(tx, input)',
    ]) {
      expect(CORE_CALL.test(text), text).toBe(false);
    }
    // The three real ones: the definition, the API controller's method, the web client's call.
    for (const file of [
      'packages/db/src/orders.ts',
      'apps/api/src/trades/orders.controller.ts',
      'apps/web/src/components/market/order-panel-provider.tsx',
    ]) {
      expect(read(file), file).toMatch(/\bplaceOrder\(/);
      expect(callTexts(read(file), 'placeOrder').length, file).toBeGreaterThan(0);
      expect(matched, file).not.toContain(file);
    }
  });

  it('classifies every caller: the pinned map is the matched set exactly', () => {
    expect(matched).toEqual(Object.keys(CALLERS).sort());
  });

  it('delivers through createNotifications wherever a caller notifies', () => {
    const missing = Object.entries(CALLERS)
      .filter(([, caller]) => caller.class === 'notifies')
      .map(([file]) => file)
      .filter((file) => !/\bcreateNotifications\(/.test(read(file)));
    expect(missing).toEqual([]);
  });

  it('names, for each core, a transaction owner the map classifies as notifying or excluded', () => {
    for (const [file, caller] of Object.entries(CALLERS)) {
      if (caller.class !== 'core') continue;
      const by = CALLERS[caller.by];
      expect(by?.class, `${file} → ${caller.by}`).toMatch(/^(notifies|excluded)$/);
    }
  });

  it('cancels one order only as its owner’s own cancel (by_owner, 52-3)', () => {
    // `OrderCancelProcessReason` admits paused, restricted and admin_role too: a single-order
    // cancel with one would end an order no notice covers. Every call passes `by_owner` literally.
    const callers = files.filter((file) => /\bcancelOrder\(\s*tx\s*,/.test(read(file))).sort();
    expect(callers).toEqual(
      [
        'apps/api/src/trades/order.service.ts',
        'packages/db/src/market-maker-control.ts',
        'packages/db/src/market-maker-cycle.ts',
        'packages/db/src/orders.ts',
      ].sort(),
    );
    for (const file of callers) {
      const calls = callTexts(read(file), 'cancelOrder').filter((text) => /^\s*tx\s*,/.test(text));
      expect(calls.length, file).toBeGreaterThan(0);
      for (const text of calls) expect(text, file).toMatch(/\breason:\s*'by_owner'/);
    }
  });
});

// ---- integration -------------------------------------------------------------------------------

describe.skipIf(!hasTestDb())('거래 알림 against the test database (#134)', () => {
  let t: TestDb;
  let adminId: string;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
  });

  const member = async (coin = 1_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
  const market = async (title?: string) =>
    (await createMarket(t.db, { createdBy: adminId, ...(title === undefined ? {} : { title }) }))
      .id;
  const titleOf = async (marketId: string) =>
    (await t.db.select({ title: markets.title }).from(markets).where(eq(markets.id, marketId)))[0]!
      .title;
  async function placed(input: PlaceTestOrderInput) {
    const result = await placeTestOrder(t.db, input);
    if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
    return result;
  }
  /** A GTC buy that rests (nothing meets it in an empty book). */
  const rest = (
    ownerId: string,
    marketId: string,
    outcome: 'YES' | 'NO',
    price: number,
    qty: number,
  ) => placed({ ownerId, marketId, outcome, side: 'buy', limitPriceCoin: price, qty });
  /** An IOC buy of `outcome` at `price`: a pair mint against an opposite bid at 100 − price. */
  const hit = (ownerId: string, marketId: string, outcome: 'YES' | 'NO', price: number, qty = 1) =>
    placed({
      ownerId,
      marketId,
      outcome,
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: price,
      qty,
    });
  /** The member's notifications, oldest first. */
  const rowsOf = (userId: string) =>
    t.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(asc(notifications.createdAt), asc(notifications.id));
  const allRows = async () => (await t.db.select({ n: count() }).from(notifications))[0]!.n;
  const fillsOf = (orderId: string) =>
    t.db.select().from(fills).where(eq(fills.restingOrderId, orderId)).orderBy(asc(fills.id));
  const deliver = (inputs: readonly NotificationInput[]) =>
    t.db.transaction((tx) => createNotifications(tx, inputs));
  const kinds = (outcomes: readonly NotificationOutcome[]) => outcomes.map((o) => o.kind);

  describe('order_filled through the real intake (F, 52-2·52-6, 134-1·134-2·134-3)', () => {
    it('tells the resting person of a partial fill, at the order’s own price and contract', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      const bid = await rest(a, m, 'NO', 40, 3);
      const done = await hit(b, m, 'YES', 60);
      // The fill row is the incoming YES buy's, at 60: the notice is A's NO bid at 40.
      expect(done.fills).toMatchObject([
        { outcome: 'YES', priceCoin: 60, restingOrderId: bid.order.id },
      ]);
      const [fill] = await fillsOf(bid.order.id);
      expect(done.notifications).toEqual([
        {
          userId: a,
          type: 'order_filled',
          eventKey: `fill:${String(fill!.id)}`,
          mergeKey: bid.order.id,
          occurredAt: fill!.createdAt,
          target: { kind: 'order', orderId: bid.order.id },
          params: {
            marketTitle: await titleOf(m),
            outcome: 'NO',
            side: 'buy',
            qty: '1',
            amountCoin: '40',
            fullyFilled: false,
            orderQty: '3',
            orderFilledQty: '1',
          },
        },
      ]);
      const [row] = await rowsOf(a);
      expect(row).toMatchObject({
        type: 'order_filled',
        category: 'trade',
        mergeKey: bid.order.id,
        eventCount: 1,
        occurredAt: fill!.createdAt,
        readAt: null,
        target: { kind: 'order', orderId: bid.order.id },
        params: done.notifications[0]!.params,
      });
      // 52-2: the incoming side is the placing request's own result.
      expect(await rowsOf(b)).toEqual([]);
    });

    it('merges the order’s fills while unread, raises 발생 시각 and turns 전량 체결 (52-6, 134-2)', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      const bid = await rest(a, m, 'NO', 40, 3);
      const other = await rest(a, m, 'YES', 30, 1);
      await hit(b, m, 'YES', 60);
      const [first] = await rowsOf(a);
      // Another order's notice comes in between, newer: it is on top for now.
      await hit(b, m, 'NO', 70);
      expect((await rowsOf(a)).map((row) => row.mergeKey)).toEqual([bid.order.id, other.order.id]);
      await hit(b, m, 'YES', 60);
      const [merged] = await rowsOf(a);
      const second = (await fillsOf(bid.order.id))[1]!;
      expect(merged).toMatchObject({
        id: first!.id,
        eventCount: 2,
        occurredAt: second.createdAt,
        params: {
          qty: '2',
          amountCoin: '80',
          fullyFilled: false,
          orderQty: '3',
          orderFilledQty: '2',
        },
        target: { kind: 'order', orderId: bid.order.id },
      });
      expect(merged!.occurredAt.getTime()).toBeGreaterThan(first!.occurredAt.getTime());
      const page = await notificationPage(t.db, a, { after: null, limit: 10 });
      expect(page.items.map((row) => row.id)).toEqual([first!.id, (await rowsOf(a))[1]!.id]);
      // The completing fill: still one notice for the order, now 전량 체결.
      await hit(b, m, 'YES', 60);
      expect((await rowsOf(a)).filter((row) => row.mergeKey === bid.order.id)).toEqual([
        expect.objectContaining({
          id: first!.id,
          eventCount: 3,
          params: {
            marketTitle: await titleOf(m),
            outcome: 'NO',
            side: 'buy',
            qty: '3',
            amountCoin: '120',
            fullyFilled: true,
            orderQty: '3',
            orderFilledQty: '3',
          },
        }),
      ]);
    });

    it('makes a new notice after the member read one, carrying the order’s totals (52-6, 134-3)', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      const bid = await rest(a, m, 'NO', 40, 5);
      await hit(b, m, 'YES', 60);
      const [first] = await rowsOf(a);
      expect(await markNotificationRead(t.db, a, first!.id)).toMatchObject({ changed: true });
      await hit(b, m, 'YES', 60, 2);
      await hit(b, m, 'YES', 60);
      const rows = await rowsOf(a);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: first!.id, eventCount: 1, params: { qty: '1' } });
      // The new one holds the fills since the read; the order's totals say 4 of 5 filled.
      expect(rows[1]).toMatchObject({
        eventCount: 2,
        readAt: null,
        params: {
          qty: '3',
          amountCoin: '120',
          fullyFilled: false,
          orderQty: '5',
          orderFilledQty: '4',
        },
      });
      // '모두 읽음' too: the completing fill after it is a notice of its own, 전량 체결 · 이번 1계약.
      expect(await markAllNotificationsRead(t.db, a)).toEqual({ changed: 1 });
      await hit(b, m, 'YES', 60);
      const last = (await rowsOf(a))[2]!;
      expect(last).toMatchObject({
        eventCount: 1,
        params: {
          qty: '1',
          amountCoin: '40',
          fullyFilled: true,
          orderQty: '5',
          orderFilledQty: '5',
        },
      });
      expect(bid.order.id).toBe(last.mergeKey);
    });

    it('tells nothing of a GTC order’s fills at intake, then its later resting fills (52-2)', async () => {
      const m = await market();
      const [a, b, c] = [await member(), await member(), await member()];
      await rest(b, m, 'NO', 40, 1);
      const gtc = await placed({
        ownerId: a,
        marketId: m,
        outcome: 'YES',
        limitPriceCoin: 60,
        qty: 3,
      });
      expect(gtc.order).toMatchObject({ status: 'partially_filled', filledQty: 1 });
      expect(gtc.notifications.map((input) => input.userId)).toEqual([b]);
      expect(await rowsOf(a)).toEqual([]);
      await hit(c, m, 'NO', 40);
      const rows = await rowsOf(a);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        mergeKey: gtc.order.id,
        eventCount: 1,
        // "그 뒤 체결부터": this notice holds the later fill; the order has 2 of 3 filled.
        params: {
          outcome: 'YES',
          side: 'buy',
          qty: '1',
          amountCoin: '60',
          fullyFilled: false,
          orderQty: '3',
          orderFilledQty: '2',
        },
      });
      expect(await rowsOf(c)).toEqual([]);
    });

    it('tells nothing of an IOC remainder, a self-trade stop or a rejection (52-2)', async () => {
      const m = await market();
      const [a, b, poorer] = [await member(), await member(), await member(10n)];
      await rest(b, m, 'NO', 40, 1);
      const ioc = await hit(a, m, 'YES', 60, 3);
      expect(ioc.order).toMatchObject({
        status: 'cancelled',
        cancelReason: 'ioc_remainder',
        filledQty: 1,
      });
      expect(ioc.notifications.map((input) => input.userId)).toEqual([b]);
      await rest(a, m, 'NO', 40, 1);
      const self = await hit(a, m, 'YES', 60);
      expect(self.order).toMatchObject({ status: 'rejected', rejectReason: 'self_trade' });
      const poor = await rest(poorer, m, 'YES', 50, 5);
      expect(poor.order).toMatchObject({ status: 'rejected', rejectReason: 'insufficient_coin' });
      for (const result of [self, poor]) expect(result.notifications).toEqual([]);
      expect(await rowsOf(a)).toEqual([]);
      expect(await rowsOf(poorer)).toEqual([]);
      expect((await rowsOf(b)).map((row) => row.type)).toEqual(['order_filled']);
    });

    it('leaves the 운영 마켓메이커’s resting order out', async () => {
      const m = (
        await createConfiguredOpenMarket(t.db, {
          createdBy: adminId,
          liquiditySettings: TEST_MM_TRADING_LIQUIDITY,
        })
      ).id;
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      await rest(mm, m, 'NO', 40, 3);
      const a = await member();
      const done = await hit(a, m, 'YES', 65, 2);
      expect(done.fills).toMatchObject([{ restingAccountType: 'market_maker' }]);
      expect(done.notifications).toEqual([]);
      expect(await allRows()).toBe(0);
    });

    it('writes nothing new for a re-sent request (AC 9)', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      await rest(a, m, 'NO', 40, 3);
      const requestId = randomUUID();
      const first = await placed({
        ownerId: b,
        marketId: m,
        outcome: 'YES',
        timeInForce: 'ioc',
        limitPriceCoin: 60,
        qty: 1,
        requestId,
      });
      const before = await rowsOf(a);
      const again = await placeTestOrder(t.db, {
        ownerId: b,
        marketId: m,
        outcome: 'YES',
        timeInForce: 'ioc',
        limitPriceCoin: 60,
        qty: 1,
        requestId,
      });
      expect(again).toEqual({ kind: 'replayed', order: first.order });
      expect(await rowsOf(a)).toEqual(before);
    });

    it('rolls the notice back with the fill when the intake fails after it', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      await rest(a, m, 'NO', 40, 3);
      vi.spyOn(marketStats, 'recordFillStats').mockRejectedValueOnce(new Error('stats failed'));
      await expect(hit(b, m, 'YES', 60)).rejects.toThrow('stats failed');
      // And a transaction that delivered the notice and then failed keeps neither.
      await expect(
        t.db.transaction(async (tx) => {
          const result = await placeOrder(tx, {
            ownerId: b,
            marketId: m,
            requestId: randomUUID(),
            outcome: 'YES',
            side: 'buy',
            timeInForce: 'ioc',
            limitPriceCoin: 60,
            qty: 1,
            budgetCoin: null,
          });
          if (result.kind !== 'placed') throw new Error(result.kind);
          expect(kinds(await createNotifications(tx, result.notifications))).toEqual(['created']);
          throw new Error('later failure');
        }),
      ).rejects.toThrow('later failure');
      expect(await t.db.select().from(fills)).toEqual([]);
      expect(await allRows()).toBe(0);
    });

    it('stores a 120-code-point title of astral characters (a refused input would refuse the fill)', async () => {
      const title = '𝔸'.repeat(120);
      const m = await market(title);
      const [a, b] = [await member(), await member()];
      await rest(a, m, 'NO', 40, 1);
      const done = await hit(b, m, 'YES', 60);
      expect(done.order.status).toBe('filled');
      expect((await rowsOf(a))[0]?.params).toMatchObject({ marketTitle: title, fullyFilled: true });
    });
  });

  describe('reprocessing (AC 9, 53-4)', () => {
    it('answers duplicate for a fill’s notice delivered again, merged or read, and changes nothing', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      await rest(a, m, 'NO', 40, 3);
      const first = await hit(b, m, 'YES', 60);
      const second = await hit(b, m, 'YES', 60);
      const merged = await rowsOf(a);
      expect(merged).toHaveLength(1);
      expect(kinds(await deliver([...first.notifications, ...second.notifications]))).toEqual([
        'duplicate',
        'duplicate',
      ]);
      expect(await rowsOf(a)).toEqual(merged);
      // After the member read it, the same fill again finds no unread row: it inserts one, its key
      // claim fails, and the row goes again — still duplicate, nothing new.
      await markNotificationRead(t.db, a, merged[0]!.id);
      const read = await rowsOf(a);
      expect(kinds(await deliver(second.notifications))).toEqual(['duplicate']);
      expect(await rowsOf(a)).toEqual(read);
    });

    it('answers duplicate for a batch’s notices delivered again', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      await rest(a, m, 'NO', 40, 1);
      await rest(a, m, 'NO', 41, 1);
      await rest(b, m, 'YES', 30, 1);
      await passMarketClose(t.db, m);
      const done = await closeTestMarket(t.db, m);
      if (!done.closed) throw new Error('closed');
      const inputs = orderEndNotificationInputs(done.expired.expired, {
        kind: 'expired',
        cause: done.status,
        market: { id: m, title: await titleOf(m) },
        eventKey: marketEventKey(done.statusEventId),
        occurredAt: done.closedAt,
      });
      const before = [...(await rowsOf(a)), ...(await rowsOf(b))];
      expect(before).toHaveLength(2);
      expect(kinds(await deliver(inputs))).toEqual(['duplicate', 'duplicate']);
      expect([...(await rowsOf(a)), ...(await rowsOf(b))]).toEqual(before);
    });
  });

  describe('batch notices through the real batches (B, D, E)', () => {
    /** As the API pauses (market-pause.test.ts's `pause`), delivering its notices last. */
    function pauseAndNotify(marketId: string, reason: 'basis_change' | 'ledger_failure') {
      return t.db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        const [row] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
        const locked = await lockMarketOrders(tx, marketId);
        const now = await clockTimestamp(tx);
        const result = await pauseMarket(tx, {
          market: row!,
          orders: locked,
          now,
          actorId: adminId,
          reason,
          note: '기준이 바뀌어 거래를 멈춘다.',
          resultPublishedAt: null,
        });
        if (!result.paused) throw new Error(result.reason);
        const outcomes = await createNotifications(
          tx,
          orderEndNotificationInputs(result.cancelled.cancelled, {
            kind: 'cancelled',
            reason: 'paused',
            market: { id: result.market.id, title: result.market.title },
            eventKey: marketEventKey(result.eventId),
            occurredAt: now,
          }),
        );
        return { result, outcomes, now };
      });
    }

    /** As the grant or the restriction's approval cancels an account's orders, notifying last. */
    function accountBatch(ownerId: string, reason: 'admin_role' | 'restricted') {
      return t.db.transaction(async (tx) => {
        await tx.select().from(profiles).where(eq(profiles.userId, ownerId)).for('update');
        const locked = await lockAccountOrders(tx, ownerId);
        const at = await clockTimestamp(tx);
        const done = await cancelLockedOrders(tx, locked, { reason, at });
        const eventKey =
          reason === 'admin_role'
            ? adminActionEventKey(randomUUID())
            : moderationActionEventKey(randomUUID());
        const inputs = orderEndNotificationInputs(done.cancelled, {
          kind: 'cancelled',
          reason,
          eventKey,
          occurredAt: at,
        });
        return { done, inputs, outcomes: await createNotifications(tx, inputs), at };
      });
    }

    it('B: one notice per member — two orders lead to the market’s history, one to the order', async () => {
      const m = await createConfiguredOpenMarket(t.db, {
        createdBy: adminId,
        liquiditySettings: TEST_MM_TRADING_LIQUIDITY,
      });
      const mm = await fundMarketMakerFunds(t.db, m.id, 1_000n);
      const [a, b] = [await member(), await member()];
      const a1 = await rest(a, m.id, 'NO', 40, 3);
      const a2 = await rest(a, m.id, 'YES', 30, 1);
      const b1 = await rest(b, m.id, 'YES', 20, 1);
      await rest(mm, m.id, 'NO', 35, 1);
      const { result, outcomes, now } = await pauseAndNotify(m.id, 'basis_change');
      expect(result.cancelled.cancelled).toHaveLength(4);
      // The bot's notice is skipped at the gate (no inbox, 53-5).
      const byUser = (list: readonly NotificationOutcome[]) =>
        Object.fromEntries(list.map((outcome) => [outcome.userId, outcome.kind]));
      expect(byUser(outcomes)).toEqual({ [a]: 'created', [b]: 'created', [mm]: 'skipped' });
      const key = `market_event:${String(result.eventId)}`;
      const [rowA] = await rowsOf(a);
      expect(rowA).toMatchObject({
        type: 'orders_cancelled',
        category: 'trade',
        mergeKey: null,
        occurredAt: now,
        target: { kind: 'order_history', marketId: m.id },
        params: { reason: 'paused', orderCount: 2, marketCount: 1, marketTitle: m.title },
      });
      expect(await rowsOf(b)).toEqual([
        expect.objectContaining({
          target: { kind: 'order', orderId: b1.order.id },
          params: { reason: 'paused', orderCount: 1, marketCount: 1, marketTitle: m.title },
        }),
      ]);
      expect(result.cancelled.cancelled.map((row) => row.id)).toEqual(
        expect.arrayContaining([a1.order.id, a2.order.id, b1.order.id]),
      );
      // The same event again (53-4): duplicate for both members, the bot still skipped.
      const again = await deliver(
        orderEndNotificationInputs(result.cancelled.cancelled, {
          kind: 'cancelled',
          reason: 'paused',
          market: { id: m.id, title: m.title },
          eventKey: key,
          occurredAt: now,
        }),
      );
      expect(byUser(again)).toEqual({ [a]: 'duplicate', [b]: 'duplicate', [mm]: 'skipped' });
    });

    it('B: a ledger-failure pause cancels nothing, so tells nothing', async () => {
      const m = await market();
      const a = await member();
      await rest(a, m, 'NO', 40, 1);
      const { result, outcomes } = await pauseAndNotify(m, 'ledger_failure');
      expect(result.cancelled.cancelled).toEqual([]);
      expect(outcomes).toEqual([]);
      expect(await rowsOf(a)).toEqual([]);
    });

    it('B: a partly filled order cancelled by the pause gets its own notice beside the fill’s (AC 11)', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      const bid = await rest(a, m, 'NO', 40, 3);
      await hit(b, m, 'YES', 60);
      await pauseAndNotify(m, 'basis_change');
      const rows = await rowsOf(a);
      expect(rows.map((row) => [row.type, row.target])).toEqual([
        ['order_filled', { kind: 'order', orderId: bid.order.id }],
        ['orders_cancelled', { kind: 'order', orderId: bid.order.id }],
      ]);
      const [order] = await t.db.select().from(orders).where(eq(orders.id, bid.order.id));
      expect(order).toMatchObject({ status: 'cancelled', cancelReason: 'paused', filledQty: 1 });
    });

    it.each(['admin_role', 'restricted'] as const)(
      'D/E (%s): one notice of N orders in M markets, a held market’s order left out and live',
      async (reason) => {
        const [m1, m2, held] = [await market(), await market(), await market()];
        const a = await member(2_000n);
        await rest(a, m1, 'NO', 40, 1);
        await rest(a, m2, 'NO', 40, 1);
        await rest(a, m2, 'YES', 30, 1);
        const kept = await rest(a, held, 'NO', 20, 1);
        await createMarketPause(t.db, { marketId: held, reason: 'ledger_failure', by: adminId });
        const { done, outcomes } = await accountBatch(a, reason);
        expect(done.cancelled).toHaveLength(3);
        expect(done.held.map((row) => row.id)).toEqual([kept.order.id]);
        expect(kinds(outcomes)).toEqual(['created']);
        expect(await rowsOf(a)).toEqual([
          expect.objectContaining({
            type: 'orders_cancelled',
            target: { kind: 'order_history', marketId: null },
            params: { reason, orderCount: 3, marketCount: 2, marketTitle: null },
          }),
        ]);
        const [still] = await t.db.select().from(orders).where(eq(orders.id, kept.order.id));
        expect(still?.status).toBe('open');
        // No orders: no input, no row.
        const none = await accountBatch(await member(), reason);
        expect(none.inputs).toEqual([]);
        expect(none.outcomes).toEqual([]);
      },
    );
  });

  describe('races on the market lock (AC 3·4)', () => {
    /** A gate one transaction waits at until the test opens it. */
    function gate() {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { open, opened };
    }

    /** The restriction's batch of `ownerId`'s orders with its notices, in `tx`. */
    async function restrict(tx: Tx, ownerId: string) {
      await tx.select().from(profiles).where(eq(profiles.userId, ownerId)).for('update');
      const locked = await lockAccountOrders(tx, ownerId);
      const at = await clockTimestamp(tx);
      const done = await cancelLockedOrders(tx, locked, { reason: 'restricted', at });
      return createNotifications(
        tx,
        orderEndNotificationInputs(done.cancelled, {
          kind: 'cancelled',
          reason: 'restricted',
          eventKey: moderationActionEventKey(randomUUID()),
          occurredAt: at,
        }),
      );
    }

    it('a fill that commits before a restriction’s batch leaves only the fill’s notice', async () => {
      // "남은 수량이 먼저 모두 체결되면 취소 완료 알림이 생기지 않는다."
      const m = await market();
      const [a, b] = [await member(), await member()];
      const bid = await rest(a, m, 'NO', 40, 1);
      let batch!: Promise<NotificationOutcome[]>;
      await t.db.transaction(async (tx) => {
        const result = await placeOrder(tx, {
          ownerId: b,
          marketId: m,
          requestId: randomUUID(),
          outcome: 'YES',
          side: 'buy',
          timeInForce: 'ioc',
          limitPriceCoin: 60,
          qty: 1,
          budgetCoin: null,
        });
        if (result.kind !== 'placed') throw new Error(result.kind);
        await createNotifications(tx, result.notifications);
        // The batch starts now and waits for the intake's market lock.
        batch = t.db.transaction((other) => restrict(other, a));
        await waitForLockWaiter(t.db.$client, 'the batch waits for the intake');
      });
      expect(await batch).toEqual([]);
      expect((await rowsOf(a)).map((row) => [row.type, row.mergeKey])).toEqual([
        ['order_filled', bid.order.id],
      ]);
    });

    it('a batch that commits before a fill leaves only its notice: the fill meets nothing', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      const bid = await rest(a, m, 'NO', 40, 1);
      const written = gate();
      const release = gate();
      const batch = t.db.transaction(async (tx) => {
        const outcomes = await restrict(tx, a);
        written.open();
        await release.opened;
        return outcomes;
      });
      await written.opened;
      const fill = hit(b, m, 'YES', 60);
      await waitForLockWaiter(t.db.$client, 'the intake waits for the batch');
      release.open();
      expect(kinds(await batch)).toEqual(['created']);
      const filled = await fill;
      expect(filled.fills).toEqual([]);
      expect(filled.notifications).toEqual([]);
      expect((await rowsOf(a)).map((row) => [row.type, row.target])).toEqual([
        ['orders_cancelled', { kind: 'order', orderId: bid.order.id }],
      ]);
      expect(await rowsOf(b)).toEqual([]);
    });

    it('a fill waits for the member’s mark-read of the unread notice, then makes a new one', async () => {
      const m = await market();
      const [a, b] = [await member(), await member()];
      const bid = await rest(a, m, 'NO', 40, 3);
      await hit(b, m, 'YES', 60);
      const [first] = await rowsOf(a);
      const client = await t.db.$client.connect();
      await client.query('BEGIN');
      await client.query(`UPDATE notifications SET read_at = now() WHERE id = $1`, [first!.id]);
      const fill = hit(b, m, 'YES', 60);
      await waitForLockWaiter(client, 'the merge waits for the mark-read');
      await client.query('COMMIT');
      client.release();
      const done = await fill;
      expect(done.order.status).toBe('filled');
      const rows = await rowsOf(a);
      expect(
        rows.map((row) => [row.id === first!.id, row.eventCount, row.readAt === null]),
      ).toEqual([
        [true, 1, false],
        [false, 1, true],
      ]);
      expect(rows[1]).toMatchObject({
        mergeKey: bid.order.id,
        params: { qty: '1', orderQty: '3', orderFilledQty: '2' },
      });
    });
  });

  it('G: the close tells each member of their expired orders, keyed by the status event', async () => {
    const m = await market();
    const [a, b] = [await member(), await member()];
    await rest(a, m, 'NO', 40, 1);
    await passMarketClose(t.db, m);
    const done = await closeTestMarket(t.db, m);
    if (!done.closed) throw new Error('closed');
    // No person filled: CANCELLED, so 시장 취소.
    expect(done.status).toBe('cancelled');
    expect(done.notified).toEqual([a]);
    expect(await rowsOf(a)).toEqual([
      expect.objectContaining({
        type: 'orders_expired',
        occurredAt: done.closedAt,
        params: { marketTitle: await titleOf(m), cause: 'cancelled', orderCount: 1 },
      }),
    ]);
    expect(await rowsOf(b)).toEqual([]);
  });
});
