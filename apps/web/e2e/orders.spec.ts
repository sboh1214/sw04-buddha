import type { APIRequestContext, APIResponse } from '@playwright/test';
import type {
  AdminMarket,
  MyFill,
  Order,
  OrderBook,
  OrderQuote,
  PlaceOrderResult,
  Sellable,
} from '@buddha/shared';
import { copy } from '../src/copy';
import {
  adminAccount,
  createOpenMarket,
  expect,
  freshEmail,
  meOf,
  pauseMarket,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 주문 접수와 체결 (#119, ADR-0112; ADR-0107 결정 1 #177 2·3·7·8·9·11·12·15항), through the API —
 * the order panel is #66 — on a market the spec opens for itself, with two fresh members: A's
 * 지정가(GTC) NO buy rests, B's 즉시 거래(IOC) YES buy meets it as one pair mint at the resting
 * price, its limit narrowed to the reference quote plus the market's 가격 보호 폭; a refused order
 * is an order row with its reason; a request id sent again answers the order as it stands, and
 * with other terms is refused; each member reads its own orders and fills — the counterparty
 * anonymous — and its 주문 이력 on MY. Then an admin changes the market's width on its detail,
 * and the next immediate order takes the new one.
 *
 * The global setup opens the intake with the test values (global-setup.ts, ADR-0107 결정 3: 접수
 * true, 20 orders a minute per account, 5 ticks): each member here sends well under 20. The width
 * the market copied is read, not assumed — a developer's database may hold another. Nothing is
 * left to settle: the market stays open, and A's resting buy ends filled by the last order.
 *
 * 주문 취소 (#178, ADR-0113), through the API too — the button and '취소 요청 중' are #123's: A's
 * partly filled order is cancelled by A, the rest given back and what filled kept, in the request
 * (the answer is the final state, the same again on a repeat); A's resting order with nothing
 * filled ends whole with its whole lock back; B naming A's order with B's own account is
 * NOT_FOUND, as an id naming none; and an admin's pause cancels A's resting order on another
 * market as 일시 중단. Each member sends a handful of orders, well under the limit.
 *
 * 공개 호가와 견적 (#179, ADR-0114), through the API too — the 호가창 is #122's, the order panel
 * #66's and the holdings screen #67's: a visitor with no cookie reads the book of a market where
 * A rests a NO bid and a YES bid and B a YES sell — A's NO bid once as a YES ask merged with B's
 * sell at one price, once as a NO bid, every level summed and nothing else — and '호가 없음' as a
 * null best price; the visitor's quotes (an empty book, a budget, a quantity) are what member C's
 * same orders with the quoted limit then fill; B's 매도 가능액 is its unlocked YES quoted with the
 * resting sell apart, and what B's own sell then fills; A's stops at A's own bid where the public
 * quote fills it (ADR-0111 P9). Quotes and reads are no orders: A and B send three orders, C two.
 */

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/**
 * The order fields a request sends besides the account (`PlaceOrderBody`): a quantity, or for an
 * immediate buy a Coin budget (#177 3항).
 */
interface OrderTerms {
  outcome: 'YES' | 'NO';
  side: 'buy' | 'sell';
  timeInForce: 'ioc' | 'gtc';
  limitPriceCoin: number;
  qty?: number;
  budgetCoin?: string;
}

/** `POST /markets/:id/orders` as `context`'s member, under `requestId`. */
async function sendOrder(
  context: APIRequestContext,
  marketId: string,
  requestId: string,
  terms: OrderTerms,
): Promise<APIResponse> {
  return context.post(`/api/v1/markets/${marketId}/orders`, {
    headers: { 'Idempotency-Key': requestId },
    data: { ...terms, expectedAccountId: (await meOf(context)).id },
  });
}

/** The same, read as the answer it must be. */
async function placeOrder(
  context: APIRequestContext,
  marketId: string,
  requestId: string,
  terms: OrderTerms,
): Promise<PlaceOrderResult> {
  return dataOf<PlaceOrderResult>(await sendOrder(context, marketId, requestId, terms));
}

/** What a member's own fill carries, and nothing of the counterparty (ADR-0107 결정 5). */
const MY_FILL_KEYS = [
  'amountCoin',
  'createdAt',
  'feeCoin',
  'id',
  'marketId',
  'marketSlug',
  'marketTitle',
  'orderId',
  'outcome',
  'priceCoin',
  'qty',
  'side',
  'yesPriceCoin',
];

test.describe('주문 접수 (#119)', () => {
  test('지정가 매수가 대기하고 즉시 거래가 가격 보호 안에서 쌍 발행으로 체결되며, 거절도 주문으로 남고 요청 ID로 다시 읽으며, 관리자가 바꾼 보호 폭은 다음 주문부터다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const width = (await dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${market.id}`)))
      .priceProtectionTicks;
    if (width === null) throw new Error('the market copied no 가격 보호 폭: global-setup.ts');

    const otherContext = await browser.newContext();
    const adminContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await signUp(otherPage, freshEmail());
      await signUp(page, freshEmail());
      const a = otherPage.request;
      const b = page.request;

      // --- A's GTC NO buy, 2 at 40: nothing to meet, so it rests (대기) with its lock.
      const restingId = crypto.randomUUID();
      const resting = (
        await placeOrder(a, market.id, restingId, {
          outcome: 'NO',
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: 40,
          qty: 2,
        })
      ).order;
      expect(resting).toMatchObject({
        requestId: restingId,
        status: 'open',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        protectedLimitPriceCoin: 40,
        filledQty: 0,
        filledAmountCoin: '0',
        rejectReason: null,
        endedAt: null,
      });
      expect((await meOf(a)).balance.lockedCoin).toBe('80');

      // --- B's IOC YES buy, 1 at a limit of 99: the reference is A's bid as a YES ask (100 − 40),
      // so the limit is narrowed to 60 + the width (an API 99 is no market order), and it meets A
      // as ONE pair mint at the resting price — B pays 60, A 40.
      const takerId = crypto.randomUUID();
      const takerTerms: OrderTerms = {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        qty: 1,
      };
      const taken = await placeOrder(b, market.id, takerId, takerTerms);
      expect(taken.replayed).toBe(false);
      expect(taken.order).toMatchObject({
        status: 'filled',
        limitPriceCoin: 99,
        protectedLimitPriceCoin: Math.min(99, 60 + width),
        qty: 1,
        filledQty: 1,
        filledAmountCoin: '60',
        cancelledQty: 0,
      });

      // Each side's own fill: its order's outcome at its own price, the YES price recorded, fee 0
      // — and no other order, account, account type or kind (anonymous counterparty).
      const [bFill] = await dataOf<MyFill[]>(await b.get('/api/v1/me/fills'));
      expect(Object.keys(bFill ?? {}).sort()).toEqual(MY_FILL_KEYS);
      expect(bFill).toMatchObject({
        orderId: taken.order.id,
        marketId: market.id,
        outcome: 'YES',
        side: 'buy',
        qty: 1,
        priceCoin: 60,
        amountCoin: '60',
        yesPriceCoin: 60,
        feeCoin: '0',
      });
      const [aFill] = await dataOf<MyFill[]>(await a.get('/api/v1/me/fills'));
      expect(aFill).toMatchObject({
        id: bFill?.id,
        orderId: resting.id,
        outcome: 'NO',
        priceCoin: 40,
        amountCoin: '40',
        yesPriceCoin: 60,
      });
      const aResting = await dataOf<Order>(await a.get(`/api/v1/me/orders/${resting.id}`));
      expect(aResting).toMatchObject({
        status: 'partially_filled',
        filledQty: 1,
        filledAmountCoin: '40',
      });
      expect((await meOf(a)).balance.lockedCoin).toBe('40');

      // --- A request id sent again: the same terms answer the order as it stands, writing
      // nothing; other terms are refused; the id is read back by itself. Another account's order
      // is no order of B's.
      const replay = await placeOrder(b, market.id, takerId, takerTerms);
      expect(replay).toEqual({ order: taken.order, replayed: true });
      const conflict = await sendOrder(b, market.id, takerId, { ...takerTerms, qty: 2 });
      expect(conflict.status()).toBe(409);
      expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
        'DUPLICATE_REQUEST',
      );
      expect(await dataOf<Order>(await b.get(`/api/v1/me/orders/request/${takerId}`))).toEqual(
        taken.order,
      );
      expect((await b.get(`/api/v1/me/orders/${resting.id}`)).status()).toBe(404);

      // --- B's IOC sell of its YES: no YES bid to meet (A's NO bid is a YES ask), so 호가 부족 —
      // an order row with its reason, nothing sold, the contract still B's.
      const refused = (
        await placeOrder(b, market.id, crypto.randomUUID(), {
          outcome: 'YES',
          side: 'sell',
          timeInForce: 'ioc',
          limitPriceCoin: 1,
          qty: 1,
        })
      ).order;
      expect(refused).toMatchObject({ status: 'rejected', rejectReason: 'no_quote', filledQty: 0 });
      const bOrders = await dataOf<Order[]>(await b.get(`/api/v1/me/orders?marketId=${market.id}`));
      expect(bOrders.map((order) => order.id)).toEqual([refused.id, taken.order.id]);
      expect(
        (await dataOf<Order[]>(await b.get('/api/v1/me/orders?state=live'))).map(
          (order) => order.id,
        ),
      ).toEqual([]);

      // --- MY: B's 주문 이력 holds both ended orders, the fill's average and amount on the
      // filled one and none on the refusal; A's 대기 주문 holds the resting one.
      await page.goto('/my/history');
      const history = page.getByTestId('my-order-history');
      const filledRow = history.getByTestId(`portfolio-order-${taken.order.id}`);
      await expect(filledRow).toContainText(copy.orderStatusFilled);
      await expect(filledRow).toContainText('60.00 Coin');
      const refusedRow = history.getByTestId(`portfolio-order-${refused.id}`);
      await expect(refusedRow).toContainText(copy.orderStatusRejected);
      await otherPage.goto('/my/orders');
      await expect(
        otherPage.getByTestId('my-orders').getByTestId(`portfolio-order-${resting.id}`),
      ).toContainText(copy.orderStatusPartiallyFilled);

      // --- The admin's detail: the width the market holds, changed by one admin with a reason,
      // recorded in the 이벤트 로그; A's resting order keeps its terms.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/markets/${market.id}`);
      await expect(adminPage.getByTestId('market-detail-price-protection-value')).toHaveText(
        `${String(width)}${copy.adminMarketPriceProtectionTicks}`,
      );
      const next = width === 3 ? 4 : 3;
      await adminPage.getByTestId('market-price-protection-change').click();
      const dialog = adminPage.getByTestId('market-price-protection-dialog');
      await dialog.getByTestId('market-price-protection-ticks').fill(String(width));
      await dialog.getByTestId('market-price-protection-reason').fill('e2e: 보호 폭을 바꿉니다.');
      // The width held: nothing to send.
      await expect(dialog.getByTestId('market-price-protection-dialog-confirm')).toBeDisabled();
      await dialog.getByTestId('market-price-protection-ticks').fill(String(next));
      await dialog.getByTestId('market-price-protection-dialog-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(adminPage.getByTestId('market-detail-price-protection-value')).toHaveText(
        `${String(next)}${copy.adminMarketPriceProtectionTicks}`,
      );
      const detail = await dataOf<AdminMarket>(
        await admin.get(`/api/v1/admin/markets/${market.id}`),
      );
      const changed = detail.events.find((event) => event.type === 'price_protection_changed');
      expect(changed?.payload).toEqual({
        before: width,
        after: next,
        reason: 'e2e: 보호 폭을 바꿉니다.',
      });
      await expect(adminPage.getByTestId(`market-event-${String(changed?.id)}`)).toContainText(
        copy.eventPriceProtectionChanged,
      );
      expect(await dataOf<Order>(await a.get(`/api/v1/me/orders/${resting.id}`))).toEqual(aResting);

      // --- The next immediate order takes the new width; it fills A's last contract.
      const after = (await placeOrder(b, market.id, crypto.randomUUID(), { ...takerTerms })).order;
      expect(after).toMatchObject({
        status: 'filled',
        protectedLimitPriceCoin: Math.min(99, 60 + next),
        filledAmountCoin: '60',
      });
      expect(await dataOf<Order>(await a.get(`/api/v1/me/orders/${resting.id}`))).toMatchObject({
        status: 'filled',
        filledQty: 2,
        filledAmountCoin: '80',
      });
      expect((await meOf(a)).balance.lockedCoin).toBe('0');
    } finally {
      await otherContext.close();
      await adminContext.close();
    }
  });
});

test.describe('주문 취소 (#178)', () => {
  test('본인 취소는 남은 수량 전부를 그 요청 안에서 끝내 잠금을 돌려주고, 다른 계정의 주문은 없는 주문처럼 404이며, 일시 중단은 대기 주문을 취소한다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const other = await createOpenMarket(admin);
    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await signUp(otherPage, freshEmail());
      await signUp(page, freshEmail());
      const a = otherPage.request;
      const b = page.request;
      const cancel = async (context: APIRequestContext, orderId: string) =>
        context.post(`/api/v1/me/orders/${orderId}/cancel`, {
          data: { expectedAccountId: (await meOf(context)).id },
        });

      // --- A's GTC NO buy, 2 at 40, rests; B's IOC YES buy of one meets it at 40 (a pair mint).
      const resting = (
        await placeOrder(a, market.id, crypto.randomUUID(), {
          outcome: 'NO',
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: 40,
          qty: 2,
        })
      ).order;
      await placeOrder(b, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        qty: 1,
      });
      expect((await meOf(a)).balance.lockedCoin).toBe('40');

      // --- B naming A's order with B's own account: NOT_FOUND, the same as an id naming none.
      const foreign = await cancel(b, resting.id);
      const none = await cancel(b, crypto.randomUUID());
      expect(foreign.status()).toBe(404);
      expect(await foreign.text()).toBe(await none.text());
      expect(await dataOf<Order>(await a.get(`/api/v1/me/orders/${resting.id}`))).toMatchObject({
        status: 'partially_filled',
        filledQty: 1,
      });

      // --- A cancels: the rest ends in the request, what filled stays, the lock comes back.
      const cancelled = await dataOf<Order>(await cancel(a, resting.id));
      expect(cancelled).toMatchObject({
        id: resting.id,
        status: 'cancelled',
        cancelReason: 'by_owner',
        qty: 2,
        filledQty: 1,
        filledAmountCoin: '40',
        cancelledQty: 1,
      });
      expect(cancelled.endedAt).not.toBeNull();
      expect(await dataOf<Order>(await a.get(`/api/v1/me/orders/${resting.id}`))).toEqual(
        cancelled,
      );
      expect((await meOf(a)).balance.lockedCoin).toBe('0');
      // Asked again: the same final state, nothing more released.
      expect(await dataOf<Order>(await cancel(a, resting.id))).toEqual(cancelled);

      // --- A's own resting GTC with nothing filled: all of it cancelled, its whole lock back.
      const unfilled = (
        await placeOrder(a, market.id, crypto.randomUUID(), {
          outcome: 'YES',
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: 20,
          qty: 3,
        })
      ).order;
      expect((await meOf(a)).balance.lockedCoin).toBe('60');
      expect(await dataOf<Order>(await cancel(a, unfilled.id))).toMatchObject({
        status: 'cancelled',
        cancelReason: 'by_owner',
        filledQty: 0,
        filledAmountCoin: '0',
        cancelledQty: 3,
      });
      expect((await meOf(a)).balance.lockedCoin).toBe('0');

      // --- A's GTC buy on the other market rests; an admin's pause cancels it as 일시 중단.
      const waiting = (
        await placeOrder(a, other.id, crypto.randomUUID(), {
          outcome: 'YES',
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: 30,
          qty: 1,
        })
      ).order;
      expect((await meOf(a)).balance.lockedCoin).toBe('30');
      await pauseMarket(admin, other.id);
      expect(await dataOf<Order>(await a.get(`/api/v1/me/orders/${waiting.id}`))).toMatchObject({
        status: 'cancelled',
        cancelReason: 'paused',
        cancelledQty: 1,
      });
      expect((await meOf(a)).balance.lockedCoin).toBe('0');
    } finally {
      await otherContext.close();
    }
  });
});

/** What a public book carries (#179): no order, account, account type or count (결정 5). */
const BOOK_KEYS = ['contracts', 'marketId', 'marketRejectReason'];
const CONTRACT_KEYS = ['asks', 'bestAskCoin', 'bestBidCoin', 'bids', 'outcome'];
const QUOTE_KEYS = [
  'cancelReason',
  'feeCoin',
  'filledAmountCoin',
  'filledQty',
  'maxSpendCoin',
  'protectedLimitPriceCoin',
  'rejectReason',
  'remainingQty',
  'status',
  'stop',
  'unspentCoin',
];

/** `GET /markets/:id/book` as `context` (a visitor's, or a member's: the same answer). */
async function readBook(context: APIRequestContext, marketId: string): Promise<OrderBook> {
  return dataOf<OrderBook>(await context.get(`/api/v1/markets/${marketId}/book`));
}

/** `POST /markets/:id/quote`: the terms with no account and no request id. */
async function quote(
  context: APIRequestContext,
  marketId: string,
  terms: Omit<OrderTerms, 'limitPriceCoin'> & { limitPriceCoin?: number },
): Promise<OrderQuote> {
  return dataOf<OrderQuote>(
    await context.post(`/api/v1/markets/${marketId}/quote`, { data: terms }),
  );
}

/** An order's intake as a quote states it: the quote is what the order then did. */
function asQuoted(order: Order): Omit<OrderQuote, 'feeCoin' | 'maxSpendCoin' | 'stop'> {
  return {
    protectedLimitPriceCoin: order.protectedLimitPriceCoin,
    filledQty: order.filledQty,
    filledAmountCoin: order.filledAmountCoin,
    remainingQty: order.qty === null ? null : order.qty - order.filledQty,
    unspentCoin: order.unspentCoin,
    status: order.status,
    rejectReason: order.rejectReason,
    cancelReason: order.cancelReason,
  };
}

/** The quote without the three fields an order row does not carry. */
function quoted({
  feeCoin: _fee,
  maxSpendCoin: _maxSpend,
  stop: _stop,
  ...rest
}: OrderQuote): Omit<OrderQuote, 'feeCoin' | 'maxSpendCoin' | 'stop'> {
  return rest;
}

test.describe('공개 호가와 견적 (#179)', () => {
  test('비로그인 방문자가 환산 공급을 합친 가격대별 수량과 호가 없음을 읽고, 견적은 같은 주문의 즉시 체결과 같으며, 매도 가능액은 본인의 잠기지 않은 보유를 견적한다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const width = (await dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${market.id}`)))
      .priceProtectionTicks;
    if (width === null) throw new Error('the market copied no 가격 보호 폭: global-setup.ts');
    const maxBuy = (best: number) => Math.min(99, best + width);
    const minSell = (best: number) => Math.max(1, best - width);

    const visitorContext = await browser.newContext();
    const aContext = await browser.newContext();
    const cContext = await browser.newContext();
    try {
      const visitor = visitorContext.request;
      const aPage = await aContext.newPage();
      const cPage = await cContext.newPage();
      await signUp(aPage, freshEmail());
      await signUp(page, freshEmail());
      await signUp(cPage, freshEmail());
      const a = aPage.request;
      const b = page.request;
      const c = cPage.request;

      // --- Nothing rests yet: every side empty, both best prices null ('호가 없음'), and the
      // visitor's immediate buy quote finds no quote — its limit left out is 99, narrowed by
      // nothing (no reference), and the whole of it is what the intake would lock.
      const empty = await readBook(visitor, market.id);
      expect(empty).toEqual({
        marketId: market.id,
        marketRejectReason: null,
        contracts: ['YES', 'NO'].map((outcome) => ({
          outcome,
          asks: [],
          bids: [],
          bestAskCoin: null,
          bestBidCoin: null,
        })),
      });
      const none = await quote(visitor, market.id, {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        qty: 1,
      });
      expect(Object.keys(none).sort()).toEqual(QUOTE_KEYS);
      expect(none).toEqual({
        protectedLimitPriceCoin: 99,
        filledQty: 0,
        filledAmountCoin: '0',
        remainingQty: 1,
        unspentCoin: null,
        maxSpendCoin: '99',
        feeCoin: '0',
        stop: 'no_quote',
        status: 'rejected',
        rejectReason: 'no_quote',
        cancelReason: null,
      });

      // --- A rests a NO bid, 4 at 40, and a YES bid, 3 at 30; B's immediate YES buy of 3 meets
      // A's NO bid as pair mints at 60 (B holds 3 YES, A 3 NO, A's bid keeps 1); B rests a YES
      // sell of 1 at 60.
      const gtc = { timeInForce: 'gtc' as const, side: 'buy' as const };
      await placeOrder(a, market.id, crypto.randomUUID(), {
        ...gtc,
        outcome: 'NO',
        limitPriceCoin: 40,
        qty: 4,
      });
      await placeOrder(a, market.id, crypto.randomUUID(), {
        ...gtc,
        outcome: 'YES',
        limitPriceCoin: 30,
        qty: 3,
      });
      const minted = await placeOrder(b, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        qty: 3,
      });
      expect(minted.order).toMatchObject({
        status: 'filled',
        filledQty: 3,
        filledAmountCoin: '180',
      });
      const bSell = await placeOrder(b, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'sell',
        timeInForce: 'gtc',
        limitPriceCoin: 60,
        qty: 1,
      });
      expect(bSell.order.status).toBe('open');

      // --- The visitor's book: YES asks at 60 are A's NO bid converted (100 − 40) and B's sell,
      // ONE quantity for the level; YES bids A's 30; the NO side is A's YES bid converted
      // (100 − 30) as its ask and A's NO bid as its bid — each order once in each view, and no
      // complement of B's sell on the NO side. Price and quantity only; a member reads the same.
      const book = await readBook(visitor, market.id);
      expect(Object.keys(book).sort()).toEqual(BOOK_KEYS);
      for (const contract of book.contracts) {
        expect(Object.keys(contract).sort()).toEqual(CONTRACT_KEYS);
        for (const level of [...contract.asks, ...contract.bids]) {
          expect(Object.keys(level).sort()).toEqual(['priceCoin', 'qty']);
        }
      }
      expect(book).toEqual({
        marketId: market.id,
        marketRejectReason: null,
        contracts: [
          {
            outcome: 'YES',
            asks: [{ priceCoin: 60, qty: 2 }],
            bids: [{ priceCoin: 30, qty: 3 }],
            bestAskCoin: 60,
            bestBidCoin: 30,
          },
          {
            outcome: 'NO',
            asks: [{ priceCoin: 70, qty: 3 }],
            bids: [{ priceCoin: 40, qty: 1 }],
            bestAskCoin: 70,
            bestBidCoin: 40,
          },
        ],
      });
      expect(await readBook(b, market.id)).toEqual(book);

      // --- 매도 가능액: a visitor has none to read; B's YES is 3 held, 1 in its resting sell
      // (shown apart), 2 quoted as an immediate sell into A's 30 within the protection; no NO.
      expect((await visitor.get(`/api/v1/me/markets/${market.id}/sellable`)).status()).toBe(401);
      const zero = { qty: 0, restingSellQty: 0, unlockedQty: 0, quote: null };
      const bSellable = await dataOf<Sellable>(
        await b.get(`/api/v1/me/markets/${market.id}/sellable`),
      );
      expect(bSellable).toEqual({
        marketId: market.id,
        contracts: [
          {
            outcome: 'YES',
            qty: 3,
            restingSellQty: 1,
            unlockedQty: 2,
            quote: {
              protectedLimitPriceCoin: minSell(30),
              filledQty: 2,
              filledAmountCoin: '60',
              remainingQty: 0,
              unspentCoin: null,
              maxSpendCoin: null,
              feeCoin: '0',
              stop: 'filled',
              status: 'filled',
              rejectReason: null,
              cancelReason: null,
            },
          },
          { outcome: 'NO', ...zero },
        ],
      });

      // --- A's NO: the public quote of selling 3 fills 1 into A's own bid; A's own 매도 가능액
      // stops at that bid (자기 거래 방지) with nothing filled — and so does A's real sell.
      const noSell = { outcome: 'NO' as const, side: 'sell' as const, timeInForce: 'ioc' as const };
      expect(await quote(visitor, market.id, { ...noSell, qty: 3 })).toMatchObject({
        protectedLimitPriceCoin: minSell(40),
        filledQty: 1,
        filledAmountCoin: '40',
        remainingQty: 2,
        stop: 'no_quote',
        status: 'cancelled',
        cancelReason: 'ioc_remainder',
      });
      const aSellable = await dataOf<Sellable>(
        await a.get(`/api/v1/me/markets/${market.id}/sellable`),
      );
      expect(aSellable.contracts[0]).toEqual({ outcome: 'YES', ...zero });
      const aNo = aSellable.contracts[1];
      expect(aNo).toMatchObject({ outcome: 'NO', qty: 3, restingSellQty: 0, unlockedQty: 3 });
      expect(aNo?.quote).toMatchObject({
        protectedLimitPriceCoin: minSell(40),
        filledQty: 0,
        stop: 'self_trade',
        status: 'rejected',
        rejectReason: 'self_trade',
      });
      if (!aNo?.quote) throw new Error('A holds NO in an open market with a width: a quote');
      const aSold = await placeOrder(a, market.id, crypto.randomUUID(), {
        ...noSell,
        limitPriceCoin: aNo.quote.protectedLimitPriceCoin,
        qty: 3,
      });
      expect(asQuoted(aSold.order)).toEqual(quoted(aNo.quote));

      // --- A budget quote: 100 Coin buys A's converted NO at 60 first (it rested first), and the
      // next contract at 60 is more than the 40 left — 40 unspent; the most it spends is the
      // budget. Member C's same order with the quoted limit fills exactly that.
      const budget = { outcome: 'YES' as const, side: 'buy' as const, timeInForce: 'ioc' as const };
      const budgetQuote = await quote(visitor, market.id, { ...budget, budgetCoin: '100' });
      expect(budgetQuote).toEqual({
        protectedLimitPriceCoin: maxBuy(60),
        filledQty: 1,
        filledAmountCoin: '60',
        remainingQty: null,
        unspentCoin: '40',
        maxSpendCoin: '100',
        feeCoin: '0',
        stop: 'budget_spent',
        status: 'filled',
        rejectReason: null,
        cancelReason: null,
      });
      const budgetOrder = await placeOrder(c, market.id, crypto.randomUUID(), {
        ...budget,
        limitPriceCoin: budgetQuote.protectedLimitPriceCoin,
        budgetCoin: '100',
      });
      expect(asQuoted(budgetOrder.order)).toEqual(quoted(budgetQuote));

      // --- A quantity quote of 2: B's sell is the last YES ask, so 1 fills and the rest is
      // cancelled; a cookie changes nothing. C's same order fills exactly that.
      const qtyQuote = await quote(visitor, market.id, { ...budget, qty: 2 });
      expect(qtyQuote).toEqual({
        protectedLimitPriceCoin: maxBuy(60),
        filledQty: 1,
        filledAmountCoin: '60',
        remainingQty: 1,
        unspentCoin: null,
        maxSpendCoin: String(maxBuy(60) * 2),
        feeCoin: '0',
        stop: 'no_quote',
        status: 'cancelled',
        rejectReason: null,
        cancelReason: 'ioc_remainder',
      });
      expect(await quote(b, market.id, { ...budget, qty: 2 })).toEqual(qtyQuote);
      const qtyOrder = await placeOrder(c, market.id, crypto.randomUUID(), {
        ...budget,
        limitPriceCoin: qtyQuote.protectedLimitPriceCoin,
        qty: 2,
      });
      expect(asQuoted(qtyOrder.order)).toEqual(quoted(qtyQuote));

      // --- The YES asks and the NO bids are gone: '호가 없음' on those sides, the rest as it was.
      const after = await readBook(visitor, market.id);
      expect(after.contracts).toEqual([
        {
          outcome: 'YES',
          asks: [],
          bids: [{ priceCoin: 30, qty: 3 }],
          bestAskCoin: null,
          bestBidCoin: 30,
        },
        {
          outcome: 'NO',
          asks: [{ priceCoin: 70, qty: 3 }],
          bids: [],
          bestAskCoin: 70,
          bestBidCoin: null,
        },
      ]);

      // --- B's sell was bought: its 2 YES are all unlocked now, and its own immediate sell with
      // the quoted limit fills what its 매도 가능액 said.
      const bNow = (await dataOf<Sellable>(await b.get(`/api/v1/me/markets/${market.id}/sellable`)))
        .contracts[0];
      expect(bNow).toMatchObject({ outcome: 'YES', qty: 2, restingSellQty: 0, unlockedQty: 2 });
      if (!bNow?.quote) throw new Error('B holds YES in an open market with a width: a quote');
      expect(bNow.quote).toMatchObject({ filledQty: 2, filledAmountCoin: '60', stop: 'filled' });
      const bSold = await placeOrder(b, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'sell',
        timeInForce: 'ioc',
        limitPriceCoin: bNow.quote.protectedLimitPriceCoin,
        qty: 2,
      });
      expect(asQuoted(bSold.order)).toEqual(quoted(bNow.quote));
    } finally {
      await visitorContext.close();
      await aContext.close();
      await cContext.close();
    }
  });
});
