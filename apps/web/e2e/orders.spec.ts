import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { AdminMarket, MyFill, Order, PlaceOrderResult } from '@buddha/shared';
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
 */

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** The order fields a request sends besides the account (`PlaceOrderBody`). */
interface OrderTerms {
  outcome: 'YES' | 'NO';
  side: 'buy' | 'sell';
  timeInForce: 'ioc' | 'gtc';
  limitPriceCoin: number;
  qty: number;
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
