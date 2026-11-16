import type { APIRequestContext, Page } from '@playwright/test';
import type {
  AdminMarket,
  Fill,
  Market,
  MyFill,
  Order,
  OrderBook,
  OrderQuote,
  Position,
  PriceSeries,
  Sellable,
} from '@buddha/shared';
import { tickBucketSeconds } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  type OrderTerms,
  adminAccount,
  createOpenMarket,
  dataOf,
  documentSurvived,
  expect,
  freshEmail,
  markDocument,
  meOf,
  pauseMarket,
  placeOrder,
  quote,
  sendOrder,
  signIn,
  signUp,
  subscribed,
  test,
  workerProbeDisabled,
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
 * 공개 호가와 견적 (#179, ADR-0114), through the API too — the order panel is #66's and the
 * holdings screen #67's: a visitor with no cookie reads the book of a market where
 * A rests a NO bid and a YES bid and B a YES sell — A's NO bid once as a YES ask merged with B's
 * sell at one price, once as a NO bid, every level summed and nothing else — and '호가 없음' as a
 * null best price; the visitor's quotes (an empty book, a budget, a quantity) are what member C's
 * same orders with the quoted limit then fill; B's 매도 가능액 is its unlocked YES quoted with the
 * resting sell apart, and what B's own sell then fills; A's stops at A's own bid where the public
 * quote fills it (ADR-0111 P9). Quotes and reads are no orders: A and B send three orders, C two.
 * The detail's 호가창 (#122, ADR-0138) rides on the same market rather than a test of its own: a
 * signed-out page of the visitor's and B's draw the same rows; the visitor's, never reloaded,
 * follows the book to '호가 없음' and 최근 체결 to C's fills; then A rests five more YES bids of
 * one (A sends eight orders in all), both deep sides fold to five with a 더 보기, one opened opens
 * that side only and turns into 접기, which folds it back, and a reload folds it again.
 *
 * 시장 마감과 주문 만료 (#120, ADR-0115), through the API too — the MY lists are #123's and #124's,
 * the notice #134's: on a market whose close is 70 s away (a worker to wait on, as pause.spec.ts's
 * close), A's NO bid rests and fills one, B's YES sell of that one rests; an order sent past the
 * close is a 마감 row; the worker closes the market and ends both orders as 만료 — A's fill kept,
 * every lock back, both holdings as they were — and the book is empty with the reason 마감, which
 * a visitor's open 호가창 then says without a reload (#122, ADR-0138). A sends one order, B three.
 *
 * 시장 통계 (#121, ADR-0116; ADR-0107 결정 1 #177 11·12·13항, 결정 4 #121 행), through the API
 * too — the cards, chart and recent-fill area that draw them are #61's, #64's and #122's: a
 * visitor reads a fresh market as '체결 없음' (no price, no fill time, no 24-hour-ago price, zero
 * volume, trades and participants, no public fill, no chart point); after A's NO bid and B's
 * immediate YES buy meet as one pair mint at 60, the market price is that fill's YES value at its
 * server time, the volume is counted once (60, not 60 + 40), the participants are two, and the
 * public fill is one anonymous row; B's second buy adds a trade and volume but no participant; a
 * NO trade at 45 makes the price its YES value 55 — on the card (#61) and in the detail's header
 * with '최근 체결 <절대 시각>', where the chart puts the last fill's dot and the dotted hold after it
 * (#64, ADR-0139). The bot's exclusion from the participants is the db and api suites' (no spec
 * runs the bot). A sends two orders, B three.
 */

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

/** One side of one contract in the detail's 호가창 (#122, ADR-0138), as its test ids name it. */
type BookSideId = 'yes-asks' | 'yes-bids' | 'no-asks' | 'no-bids';

/** The rows a side draws, best first, each `[price, quantity]`; none is '호가 없음'. */
type BookSideRows = readonly (readonly [priceCoin: number, qty: number])[];

/** A price per contract as the 호가창 writes it (`formatPricePerContract`): '60.00 Coin'. */
const bookPrice = (priceCoin: number) => `${priceCoin.toFixed(2)} Coin`;

/**
 * The 호가창 side `side` on `page` draws exactly `rows`, in order: each level's price and summed
 * quantity, and on its title line the best price — the first row's, as the book answers it — or
 * '호가 없음' with no row at all. Nothing else is asserted to be there: a row is two cells.
 */
async function expectBookSide(page: Page, side: BookSideId, rows: BookSideRows): Promise<void> {
  const testId = `market-order-book-${side}`;
  await expect(page.getByTestId(testId)).toBeVisible();
  const levels = page.getByTestId(testId).locator(`[data-testid^="${testId}-level-"]`);
  await expect(levels).toHaveCount(rows.length);
  const [best] = rows;
  if (best === undefined) {
    await expect(page.getByTestId(`${testId}-empty`)).toHaveText(copy.marketBookEmpty);
    await expect(page.getByTestId(`${testId}-best`)).toHaveCount(0);
    return;
  }
  await expect(page.getByTestId(`${testId}-best`)).toHaveText(
    `${copy.marketBookBest} ${bookPrice(best[0])}`,
  );
  for (const [index, [priceCoin, qty]] of rows.entries()) {
    const row = levels.nth(index);
    await expect(row).toHaveAttribute('data-testid', `${testId}-level-${String(priceCoin)}`);
    await expect(row).toContainText(bookPrice(priceCoin));
    await expect(row).toContainText(`${String(qty)}${copy.unitContracts}`);
  }
}

/** Below md the 호가 and 거래 내역 panels take turns behind the switch (ADR-0067). */
async function showActivity(page: Page, view: 'book' | 'history'): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) >= 768) return;
  const label = view === 'book' ? copy.marketDetailViewBook : copy.marketTradeHistory;
  await page.getByTestId('market-activity-switch').getByText(label, { exact: true }).click();
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

      // --- 호가창 (#122, ADR-0138) on screen: a signed-out visitor's detail (a page of the
      // visitor's context: no new sign-up) and member B's draw the same rows — the book's levels
      // and best prices as they are, A's NO bid once as the YES ask beside B's sell and once as
      // the NO bid, and YES 60 beside NO 70 with nothing making them 100. Each joins the room
      // first.
      const visitorPage = await visitorContext.newPage();
      const firstBook: Record<BookSideId, BookSideRows> = {
        'yes-asks': [[60, 2]],
        'yes-bids': [[30, 3]],
        'no-asks': [[70, 3]],
        'no-bids': [[40, 1]],
      };
      for (const reader of [visitorPage, page]) {
        const joined = subscribed(reader, market.id);
        await reader.goto(`/markets/${market.slug}`);
        await joined;
        for (const [side, rows] of Object.entries(firstBook) as [BookSideId, BookSideRows][]) {
          await expectBookSide(reader, side, rows);
        }
      }
      await markDocument(visitorPage);
      const fillsBefore = await dataOf<Fill[]>(
        await visitor.get(`/api/v1/markets/${market.id}/fills`),
      );

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
      // …and on the visitor's detail, never reloaded (`market:book`): '호가 없음' on those two
      // sides, the other two as they were; 최근 체결 holds C's fills too (`market:trade`).
      await expectBookSide(visitorPage, 'yes-asks', []);
      await expectBookSide(visitorPage, 'no-bids', []);
      await expectBookSide(visitorPage, 'yes-bids', [[30, 3]]);
      await expectBookSide(visitorPage, 'no-asks', [[70, 3]]);
      const fillsAfter = await dataOf<Fill[]>(
        await visitor.get(`/api/v1/markets/${market.id}/fills`),
      );
      expect(fillsAfter.length).toBeGreaterThan(fillsBefore.length);
      await showActivity(visitorPage, 'history');
      const fillRows = visitorPage.getByTestId('market-fills');
      await expect(fillRows.locator('[data-testid^="market-fill-"]')).toHaveCount(
        fillsAfter.length,
      );
      for (const fill of fillsAfter) {
        await expect(fillRows.getByTestId(`market-fill-${fill.id}`)).toBeVisible();
      }
      await showActivity(visitorPage, 'book');
      expect(await documentSurvived(visitorPage)).toBe(true);

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

      // --- Five levels a side, then 더 보기 (ADR-0135 B2): A rests YES bids of one at 14 down to
      // 10, after B's sale left A's 30 with one. YES 매수호가 is six levels, and so is NO 매도호가 —
      // each of A's YES bids converted, once. Both fold to five with a 더 보기 on the open page.
      for (const limitPriceCoin of [14, 13, 12, 11, 10]) {
        await placeOrder(a, market.id, crypto.randomUUID(), {
          ...gtc,
          outcome: 'YES',
          limitPriceCoin,
          qty: 1,
        });
      }
      const deepYesBids: BookSideRows = [30, 14, 13, 12, 11, 10].map((p) => [p, 1] as const);
      const deepNoAsks: BookSideRows = [70, 86, 87, 88, 89, 90].map((p) => [p, 1] as const);
      await expectBookSide(visitorPage, 'yes-bids', deepYesBids.slice(0, 5));
      await expectBookSide(visitorPage, 'no-asks', deepNoAsks.slice(0, 5));
      const yesMore = visitorPage.getByTestId('market-order-book-yes-bids-more');
      const noMore = visitorPage.getByTestId('market-order-book-no-asks-more');
      for (const more of [yesMore, noMore]) {
        await expect(more).toHaveText(copy.marketBookShowAll);
        await expect(more).toHaveAttribute('aria-expanded', 'false');
      }
      await expect(yesMore).toHaveAttribute(
        'aria-label',
        `${copy.yes} ${copy.marketBookBids} ${copy.marketBookShowAll}`,
      );
      // Pressed, it opens that side only: six YES bids, NO asks still five with their 더 보기.
      // Below md the 매수 bar's scroll padding keeps a scrolled-to control above it.
      await yesMore.scrollIntoViewIfNeeded();
      await yesMore.click();
      await expectBookSide(visitorPage, 'yes-bids', deepYesBids);
      // The same button stays as 접기 and keeps the focus (owner decision 2026-11-16, ADR-0138).
      await expect(yesMore).toHaveText(copy.marketBookCollapse);
      await expect(yesMore).toHaveAttribute('aria-expanded', 'true');
      await expect(yesMore).toHaveAttribute(
        'aria-label',
        `${copy.yes} ${copy.marketBookBids} ${copy.marketBookCollapse}`,
      );
      await expect(yesMore).toBeFocused();
      await expectBookSide(visitorPage, 'no-asks', deepNoAsks.slice(0, 5));
      await expect(noMore).toHaveText(copy.marketBookShowAll);
      await expect(noMore).toHaveAttribute('aria-expanded', 'false');
      // 접기 folds that side back to five, and the button reads 더 보기 again.
      await yesMore.scrollIntoViewIfNeeded();
      await yesMore.click();
      await expectBookSide(visitorPage, 'yes-bids', deepYesBids.slice(0, 5));
      await expect(yesMore).toHaveText(copy.marketBookShowAll);
      await expect(yesMore).toHaveAttribute('aria-expanded', 'false');
      await expect(yesMore).toBeFocused();
      await expectBookSide(visitorPage, 'no-asks', deepNoAsks.slice(0, 5));
      expect(await documentSurvived(visitorPage)).toBe(true);
      // Opened again, a reload reads the same book, folded again.
      await yesMore.scrollIntoViewIfNeeded();
      await yesMore.click();
      await expectBookSide(visitorPage, 'yes-bids', deepYesBids);
      await visitorPage.reload();
      await expectBookSide(visitorPage, 'yes-bids', deepYesBids.slice(0, 5));
      await expectBookSide(visitorPage, 'no-asks', deepNoAsks.slice(0, 5));
      await expect(yesMore).toHaveText(copy.marketBookShowAll);
    } finally {
      await visitorContext.close();
      await aContext.close();
      await cContext.close();
    }
  });
});

/**
 * How far ahead the market the worker closes has its close: room for its making and opening and
 * four orders to land before it, on a slow box too (both members sign up before it is set) —
 * pause.spec.ts's budget.
 */
const CLOSE_IN_MS = 70_000;

/**
 * How long the test waits for the close: the close, and then a whole minute more for the
 * per-minute scan should the delayed job be lost (pause.spec.ts's).
 */
const CLOSE_WAIT_MS = 150_000;

test.describe('시장 마감과 주문 만료 (#120)', () => {
  test('거래 마감 시각이 지난 시장의 새 주문은 마감으로 거절되고, 워커가 마감하며 남은 대기 주문을 만료로 끝내 체결 수량을 두고 잠금을 돌려주며, 보유는 그대로다', async ({
    admin,
    browser,
    page,
  }) => {
    test.skip(
      workerProbeDisabled(),
      'WORKER_HEALTH_PORT=0: no worker probe; the suite cannot wait for a worker',
    );
    test.slow(); // the close is more than a real minute away
    // Both members sign up before the clock starts: CLOSE_IN_MS budgets the market's making and
    // the orders, not two sign-ups as well.
    const bContext = await browser.newContext();
    const visitorContext = await browser.newContext();
    try {
      const bPage = await bContext.newPage();
      await signUp(page, freshEmail());
      await signUp(bPage, freshEmail());
      const a = page.request;
      const b = bPage.request;
      const closeAt = new Date(Date.now() + CLOSE_IN_MS).toISOString();
      const market = await createOpenMarket(admin, { closeAt });

      // --- A's GTC NO buy, 3 at 40, rests; B's IOC YES buy of one meets it at 40 (a pair mint);
      // B's GTC YES sell of that one at 90 rests with nothing to meet (A's NO bid is a YES ask).
      const resting = (
        await placeOrder(a, market.id, crypto.randomUUID(), {
          outcome: 'NO',
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: 40,
          qty: 3,
        })
      ).order;
      await placeOrder(b, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        qty: 1,
      });
      const sell = (
        await placeOrder(b, market.id, crypto.randomUUID(), {
          outcome: 'YES',
          side: 'sell',
          timeInForce: 'gtc',
          limitPriceCoin: 90,
          qty: 1,
        })
      ).order;
      expect(sell).toMatchObject({ status: 'open', filledQty: 0 });
      const aFilled = (await meOf(a)).balance;
      expect(aFilled.lockedCoin).toBe('80');
      expect(
        (await dataOf<Sellable>(await b.get(`/api/v1/me/markets/${market.id}/sellable`)))
          .contracts[0],
      ).toMatchObject({ outcome: 'YES', qty: 1, restingSellQty: 1, unlockedQty: 0 });

      // --- A visitor's detail, opened inside the 70 s window, after the orders, and in the
      // market's room: the 호가창 (#122, ADR-0138) draws the contracts, with no reason line.
      const visitorPage = await visitorContext.newPage();
      const joined = subscribed(visitorPage, market.id);
      await visitorPage.goto(`/markets/${market.slug}`);
      await joined;
      await expect(visitorPage.getByTestId('market-order-book-yes')).toBeVisible();
      await expect(visitorPage.getByTestId('market-order-book-reason')).toHaveCount(0);
      await markDocument(visitorPage);

      // --- From close_at a new order is a 마감 row, whoever answers it: the intake's own clock
      // while the market is still OPEN, or the status once the worker has closed it (which one
      // is not deterministic here; the db, API and shared tests hold the OPEN window).
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(closeAt) + 1_000 - Date.now())),
      );
      const late = (
        await placeOrder(b, market.id, crypto.randomUUID(), {
          outcome: 'YES',
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: 50,
          qty: 1,
        })
      ).order;
      expect(late).toMatchObject({
        status: 'rejected',
        rejectReason: 'closed',
        filledQty: 0,
        limitPriceCoin: 50,
      });

      // --- The worker closes it at its close — the delayed job the approval registered at the
      // open, or the per-minute scan behind it — and ends the orders left in the same transaction.
      await expect
        .poll(
          async () =>
            (await dataOf<Market>(await bPage.request.get(`/api/v1/markets/${market.id}`))).status,
          { timeout: CLOSE_WAIT_MS, intervals: [2_000] },
        )
        .toBe('closed');
      // The visitor's 호가창, never reloaded, says 마감 in place of the contracts — by the close's
      // `market:status` here; the read a second past close_at is the unit tests' (order-book.test).
      await expect(visitorPage.getByTestId('market-order-book-reason')).toHaveText(
        copy.marketBookReasonClosed,
      );
      await expect(visitorPage.getByTestId('market-order-book-yes')).toHaveCount(0);
      expect(await documentSurvived(visitorPage)).toBe(true);

      // A's order: 만료 (no cancel reason — 만료 is a state), the fill kept, the rest ended.
      const expired = await dataOf<Order>(await a.get(`/api/v1/me/orders/${resting.id}`));
      expect(expired).toMatchObject({
        status: 'expired',
        cancelReason: null,
        rejectReason: null,
        qty: 3,
        filledQty: 1,
        filledAmountCoin: '40',
        cancelledQty: 2,
      });
      expect(Date.parse(expired.endedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(closeAt));
      // Its lock back, the 80 the two left held: nothing else moved A's Coin.
      expect((await meOf(a)).balance).toEqual({
        availableCoin: String(BigInt(aFilled.availableCoin) + 80n),
        lockedCoin: '0',
      });
      // B's sell: 만료 too, its contract unlocked and still B's — the close moves no holding.
      expect(await dataOf<Order>(await b.get(`/api/v1/me/orders/${sell.id}`))).toMatchObject({
        status: 'expired',
        cancelReason: null,
        filledQty: 0,
        cancelledQty: 1,
      });
      expect(
        (await dataOf<Sellable>(await b.get(`/api/v1/me/markets/${market.id}/sellable`)))
          .contracts[0],
      ).toMatchObject({ outcome: 'YES', qty: 1, restingSellQty: 0, unlockedQty: 1 });
      const held = async (context: APIRequestContext) =>
        (await dataOf<Position[]>(await context.get('/api/v1/me/positions?status=open')))
          .filter((position) => position.marketId === market.id)
          .map(({ outcome, qty }) => ({ outcome, qty }));
      expect(await held(a)).toEqual([{ outcome: 'NO', qty: 1 }]);
      expect(await held(b)).toEqual([{ outcome: 'YES', qty: 1 }]);
      expect(await dataOf<Order[]>(await a.get('/api/v1/me/orders?state=live'))).toEqual([]);

      // --- The public book: nothing left, every side '호가 없음', the market's reason 마감.
      const book = await readBook(bContext.request, market.id);
      expect(book.marketRejectReason).toBe('closed');
      for (const contract of book.contracts) {
        expect(contract).toMatchObject({
          asks: [],
          bids: [],
          bestAskCoin: null,
          bestBidCoin: null,
        });
      }

      // --- MY: A's 거래·정산 이력 holds the order as 만료.
      await page.goto('/my/history');
      await expect(
        page.getByTestId('my-order-history').getByTestId(`portfolio-order-${resting.id}`),
      ).toContainText(copy.orderStatusExpired);
    } finally {
      await bContext.close();
      await visitorContext.close();
    }
  });
});

/** What a public fill carries (#121, ADR-0116): no account, order id, taker side or kind. */
const PUBLIC_FILL_KEYS = [
  'amountCoin',
  'createdAt',
  'id',
  'outcome',
  'priceCoin',
  'qty',
  'yesPriceCoin',
];

test.describe('시장 통계 (#121)', () => {
  test('시장가격은 마지막 체결의 YES 기준 값과 그 서버 시각이고, 거래량은 체결마다 한 번, 참여자는 사람 계정 수이며, 체결 전에는 체결 없음이다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const visitorContext = await browser.newContext();
    const aContext = await browser.newContext();
    try {
      const visitor = visitorContext.request;
      const aPage = await aContext.newPage();
      await signUp(aPage, freshEmail());
      await signUp(page, freshEmail());
      const a = aPage.request;
      const b = page.request;
      const readMarket = async () =>
        dataOf<Market>(await visitor.get(`/api/v1/markets/${market.id}`));
      const readFills = async () =>
        dataOf<Fill[]>(await visitor.get(`/api/v1/markets/${market.id}/fills`));
      const readRawTicks = async () =>
        dataOf<PriceSeries>(await visitor.get(`/api/v1/markets/${market.id}/ticks?resolution=raw`));
      /** B's newest own fill: the server time the market price must carry. */
      const newestFillOfB = async () => {
        const [fill] = await dataOf<MyFill[]>(await b.get('/api/v1/me/fills'));
        if (fill === undefined) throw new Error('B has no fill');
        return fill;
      };

      // --- Before any fill: '체결 없음' — nulls and zeros, no public fill, no chart point. The
      // open writes no price (its 50% is no baseline, ADR-0107 결정 4 #121 행).
      expect(await readMarket()).toMatchObject({
        lastPrice: null,
        lastFillAt: null,
        lastPrice24hAgo: null,
        volumeCoin: '0',
        tradeCount: 0,
        traderCount: 0,
      });
      expect(await readFills()).toEqual([]);
      expect((await readRawTicks()).points).toEqual([]);

      // --- A's GTC NO buy, 2 at 40, rests: an order is no fill, so nothing moves.
      await placeOrder(a, market.id, crypto.randomUUID(), {
        outcome: 'NO',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        qty: 2,
      });
      expect(await readMarket()).toMatchObject({ lastPrice: null, tradeCount: 0, traderCount: 0 });

      // --- B's IOC YES buy of 1 meets it as ONE pair mint at 60 (100 − 40): the price is the
      // fill's YES value at its server time, the volume the incoming contract's price × qty once
      // (60, not 60 + 40), one trade, and both members are participants.
      const yesBuy: OrderTerms = {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        qty: 1,
      };
      expect((await placeOrder(b, market.id, crypto.randomUUID(), yesBuy)).order.filledQty).toBe(1);
      const first = await newestFillOfB();
      expect(await readMarket()).toMatchObject({
        lastPrice: 60,
        lastFillAt: first.createdAt,
        // Nothing traded 24 hours ago: no baseline, so no change badge (#60 5항 is M11's).
        lastPrice24hAgo: null,
        volumeCoin: '60',
        tradeCount: 1,
        traderCount: 2,
      });
      // The public row: one per match, anonymous — no side, order, account or kind.
      const fills = await readFills();
      expect(fills).toHaveLength(1);
      expect(Object.keys(fills[0] ?? {}).sort()).toEqual(PUBLIC_FILL_KEYS);
      expect(fills[0]).toEqual({
        id: first.id,
        outcome: 'YES',
        priceCoin: 60,
        yesPriceCoin: 60,
        qty: 1,
        amountCoin: '60',
        createdAt: first.createdAt,
      });
      // The chart reads the fills as they are: one point, the fill's YES value at its time.
      expect((await readRawTicks()).points).toEqual([
        { ts: first.createdAt, pYesBp: 6000, trigger: 'trade' },
      ]);

      // --- B buys again: another trade and its volume, but B is no new participant.
      await placeOrder(b, market.id, crypto.randomUUID(), yesBuy);
      expect(await readMarket()).toMatchObject({
        lastPrice: 60,
        lastFillAt: (await newestFillOfB()).createdAt,
        volumeCoin: '120',
        tradeCount: 2,
        traderCount: 2,
      });

      // --- A sells one of its NO at 45 and B's IOC NO buy takes it: a direct NO trade, so the
      // market price is its YES value 55 and the row says both prices.
      await placeOrder(a, market.id, crypto.randomUUID(), {
        outcome: 'NO',
        side: 'sell',
        timeInForce: 'gtc',
        limitPriceCoin: 45,
        qty: 1,
      });
      await placeOrder(b, market.id, crypto.randomUUID(), {
        outcome: 'NO',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        qty: 1,
      });
      const last = await newestFillOfB();
      expect(last).toMatchObject({ outcome: 'NO', priceCoin: 45, yesPriceCoin: 55 });
      const after = await readMarket();
      expect(after).toMatchObject({
        lastPrice: 55,
        lastFillAt: last.createdAt,
        lastPrice24hAgo: null,
        volumeCoin: '165',
        tradeCount: 3,
        traderCount: 2,
      });
      const publicFills = await readFills();
      expect(publicFills[0]).toMatchObject({
        id: last.id,
        outcome: 'NO',
        priceCoin: 45,
        yesPriceCoin: 55,
        amountCoin: '45',
      });
      // Volume = Σ of the public rows' amounts (#177 12항).
      expect(publicFills.reduce((sum, fill) => sum + Number(fill.amountCoin), 0)).toBe(165);
      const series = await readRawTicks();
      expect(series.points.map((point) => point.pYesBp)).toEqual([6000, 6000, 5500]);
      expect(series.tradeCount).toBe(3);

      // --- The card (#61, ADR-0136), on the search screen holding exactly this market's card:
      // its question and category, the price — its YES value and NO's complement — with
      // '최근 체결 <절대 시각>' at its fill's server time, in Korean time as this browser's is,
      // and the 2 participants.
      await page.goto(`/search?q=${market.tag}`);
      const card = page.getByTestId(`market-card-${market.id}`);
      await expect(card.getByRole('link', { name: market.title })).toBeVisible();
      await expect(card).toContainText(after.category.nameKo);
      await expect(card.getByTestId('market-card-probability')).toHaveText('55%');
      await expect(card.getByTestId('market-card-probability-no')).toHaveText('45%');
      await expect(card.getByTestId('market-card-last-fill')).toHaveText(
        `${copy.marketLastFillAt} ${formatKst(after.lastFillAt ?? '')}`,
      );
      await expect(card.getByTestId('market-card-traders')).toHaveText(`${copy.marketTraders} 2`);
      // A card that has traded still draws no payout multiple ('1.59x', O-21), no 거래량 and no
      // price trend line (ADR-0061 decision 1, item 4): the first spec to read one (market.spec).
      await expect(card).not.toContainText(/\d\.\d{2}x/);
      await expect(card).not.toContainText(copy.marketVolume);
      await expect(card.getByTestId('market-card-volume')).toHaveCount(0);
      await expect(card.getByTestId('market-card-sparkline')).toHaveCount(0);
      // The footer's two boxes stay inside the tile's padding and on screen at this project's
      // width (375 or 1280), and the page does not scroll sideways. Not the tile's outer box: a
      // one-column grid (`1fr` at 375) lets a `nowrap` piece too long for its column widen the
      // tile with it, so the tile always holds it, and at 1280 its padding and stroke would hide
      // 17px of overflow. The page width catches the first; the padded body the second.
      const inner = await card.evaluate((shell) => {
        const body = shell.firstElementChild;
        if (body === null) throw new Error('the card has no body');
        const rect = body.getBoundingClientRect();
        const style = getComputedStyle(body);
        return {
          left: rect.left + parseFloat(style.paddingLeft),
          right: rect.right - parseFloat(style.paddingRight),
          bottom: rect.bottom - parseFloat(style.paddingBottom),
        };
      });
      const viewport = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(viewport.scrollWidth, 'page width').toBeLessThanOrEqual(viewport.width);
      for (const testId of ['market-card-traders', 'market-card-last-fill']) {
        const box = await card.getByTestId(testId).boundingBox();
        if (box === null) throw new Error(`${testId} has no bounding box`);
        expect(box.x, testId).toBeGreaterThanOrEqual(inner.left - 0.5);
        expect(box.x + box.width, testId).toBeLessThanOrEqual(inner.right + 0.5);
        expect(box.x + box.width, testId).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height, testId).toBeLessThanOrEqual(inner.bottom + 0.5);
      }

      // --- The detail (#64, ADR-0139): the same price and fill time in its header, one line
      // in Korean time, and on its 1일 chart the last fill's dot with the dotted hold after it.
      // The solid line needs a recorded step before that fill: the 1일 grid (5 minutes) puts the
      // earlier fills' price on its next boundary, so there is one only when a boundary falls
      // between the first fill and the last.
      await page.goto(`/markets/${market.slug}`);
      const reading = page.getByTestId('market-probability');
      await expect(
        reading.getByTestId('market-probability-value').getByText(`${copy.yes} 55%`, {
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(reading.getByTestId('market-detail-last-fill')).toHaveText(
        `${copy.marketLastFillAt} ${formatKst(after.lastFillAt ?? '')}`,
      );
      // The grid the server picks for 1일's `1m` request over a day (ticksQueryFor('1D')).
      const stepMs = tickBucketSeconds('1m', 86_400_000) * 1_000;
      const stepped =
        Math.ceil(Date.parse(first.createdAt) / stepMs) * stepMs < Date.parse(last.createdAt);
      const chart = page.getByTestId('probability-chart');
      await expect(chart.getByTestId('probability-chart-dot')).toHaveCount(1);
      await expect(chart.getByTestId('probability-chart-dotted')).toHaveCount(1);
      await expect(chart.getByTestId('probability-chart-line')).toHaveCount(stepped ? 1 : 0);
      // While trading goes on the summary ends on '현재' (ADR-0139).
      await expect(chart.getByTestId('probability-chart-svg')).toHaveAttribute(
        'aria-label',
        new RegExp(`${copy.chartSummaryCurrent} \\d+%$`),
      );
    } finally {
      await aContext.close();
      await visitorContext.close();
    }
  });
});
