import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type { Market, Notification, Order } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  REALTIME_BUDGET_MS,
  type OrderTerms,
  createOpenMarket,
  dataOf,
  documentSurvived,
  expect,
  freshEmail,
  markDocument,
  pauseMarket,
  placeOrder,
  signUp,
  test,
  workerProbeDisabled,
} from './helpers';

/**
 * 거래 알림 (#134, ADR-0158; owner answers 52-2…52-6, 134-1…134-4) on the screens, every event
 * through the API as production makes it: MY › 알림's rows of `order_filled`, `orders_cancelled`
 * and `orders_expired`, their words (the copy approved as shown, 134-4), the count beside MY that
 * a fill's `user:notification` raises without a reload, and where each row leads — an order's
 * 주문 상세 (#123), or 거래·정산 이력 filtered to the market (#124).
 *
 * The 마켓메이커 of a `createOpenMarket` market posts no quotes under the regression profile (stage
 * thresholds 0/0/0), so a member's immediate buy meets only the other member's resting bids. 1: A's
 * resting NO bid fills against B's immediate YES buys (pair mints at A's 40) — one notice per
 * order, merged while unread (52-6), a new one after the read with the order's whole beside '이번'
 * (134-3), a replayed request adding nothing (AC 9), and B, the incoming side, never notified
 * (52-2). 2: an admin's 일시 중단 cancels A's two resting bids — one notice to the market's ended
 * orders (52-4). 3: the worker's close expires the rest of a partly filled bid — a notice of its
 * own beside the fill's (53-4) that opens the order, 만료 with its filled and ended quantities
 * (AC 7). A sends two orders in the first two tests and one in the last; B five in the first (and
 * one sent again) and one in the last — all well under the 20 a minute (global-setup.ts).
 */

/** One read of the count after the signal: what a page may take past the realtime budget. */
const ONE_READ_MS = 5_000;

/** The unread count's read, as the browser asks it through the web's `/api` rewrite. */
const UNREAD_COUNT_PATH = '/api/v1/me/notifications/unread-count';

/** The count beside MY where this width shows it: the bottom tabs below md, the header from it. */
function myUnread(page: Page): Locator {
  const width = page.viewportSize()?.width ?? 0;
  return page.getByTestId(width < 768 ? 'bottom-tab-my-unread' : 'nav-primary-my-unread');
}

/** The rows MY › 알림 draws, in order. */
function rows(page: Page): Locator {
  return page.getByTestId('my-notifications-list').getByTestId('notification-row');
}

function row(page: Page, id: string): Locator {
  return page.locator(`[data-testid="notification-row"][data-notification-id="${id}"]`);
}

/** The ids of the rows drawn, in order. */
function rowIds(page: Page): Promise<(string | null)[]> {
  return rows(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-notification-id')),
  );
}

/** Opens `path` and waits for the unread count's first read, so an absence after it means 0. */
async function openCounted(page: Page, path: string): Promise<void> {
  const counted = page.waitForResponse(
    (response) => new URL(response.url()).pathname === UNREAD_COUNT_PATH && response.ok(),
  );
  await page.goto(path);
  await counted;
}

/** The member's inbox through the API, newest first (one page is plenty here). */
async function inboxOf(context: APIRequestContext): Promise<Notification[]> {
  return dataOf<Notification[]>(await context.get('/api/v1/me/notifications'));
}

async function unreadCountOf(context: APIRequestContext): Promise<number> {
  return (
    await dataOf<{ unreadCount: number }>(
      await context.get('/api/v1/me/notifications/unread-count'),
    )
  ).unreadCount;
}

/** A 지정가(GTC) NO buy at 40: the resting bid B's immediate YES buys meet as pair mints. */
const NO_BID = (qty: number): OrderTerms => ({
  outcome: 'NO',
  side: 'buy',
  timeInForce: 'gtc',
  limitPriceCoin: 40,
  qty,
});

/** B's 즉시 거래(IOC) YES buy of one: it meets A's NO bid at A's price (YES 60). */
const YES_TAKE: OrderTerms = {
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin: 99,
  qty: 1,
};

test.describe('거래 알림 (#134)', () => {
  test('대기하던 주문의 체결은 새로 고침 없이 안 읽은 수를 올리고, 읽기 전까지 한 알림에 합쳐 전량 체결이 되며, 읽은 뒤의 체결은 이번 수량과 주문 전체를 보이는 새 알림이고, 같은 요청을 다시 보내도, 상대인 즉시 주문자에게도 알림이 없다', async ({
    admin,
    browser,
    page,
  }) => {
    test.slow(); // two members, a market through the review and seven orders
    const bContext = await browser.newContext();
    try {
      const bPage = await bContext.newPage();
      await signUp(page, freshEmail());
      await signUp(bPage, freshEmail());
      const a = page.request;
      const b = bPage.request;
      const market = await createOpenMarket(admin);
      const filledTitle = (rest: string) => `${market.title} NO 매수 주문 ${rest}`;

      // --- A's NO bid of 3 at 40 rests; A keeps MY open, its count read (none) and its socket
      // in A's room (within the realtime budget, as notifications.spec.ts waits).
      const first = (await placeOrder(a, market.id, crypto.randomUUID(), NO_BID(3))).order;
      expect(first).toMatchObject({ status: 'open', filledQty: 0 });
      await openCounted(page, '/my');
      await expect(myUnread(page)).toHaveCount(0);
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      await markDocument(page);

      // --- B's immediate YES buy meets it (a pair mint at A's 40): A's count turns 1 without a
      // reload — the signal's first round is read at once (53-9's window, leading edge).
      const taken = await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE);
      expect(taken.order.status).toBe('filled');
      await expect(myUnread(page)).toHaveText('1', { timeout: REALTIME_BUDGET_MS + ONE_READ_MS });
      expect(await documentSurvived(page)).toBe(true);
      // B, the incoming side, has the result card of its request and no notice (52-2).
      expect(await inboxOf(b)).toEqual([]);

      // --- MY › 알림: one row, 거래, unread — the resting order's contract, 부분 체결, the fill's
      // quantity and average price (134-1, the copy approved as shown, 134-4).
      const [firstNotice] = await inboxOf(a);
      if (firstNotice === undefined) throw new Error('A has no notice of the fill');
      expect(firstNotice).toMatchObject({
        type: 'order_filled',
        category: 'trade',
        target: { kind: 'order', orderId: first.id },
        eventCount: 1,
        readAt: null,
      });
      await page.goto('/my/notifications');
      await expect(rows(page)).toHaveCount(1);
      const firstRow = row(page, firstNotice.id);
      await expect(firstRow).toHaveAttribute('data-read', 'false');
      await expect(firstRow.getByTestId('notification-row-category')).toHaveText(
        copy.notificationCategoryTrade,
      );
      await expect(firstRow.getByTestId('notification-row-title')).toHaveText(
        filledTitle('부분 체결 · 1계약 · 평균 40.00 Coin'),
      );
      await expect(firstRow).toHaveAttribute('href', `/my/orders/${first.id}`);

      // --- B again, while A has not read it: the same row, 체결 2회 · 누적 2계약, still on top
      // (52-6, 134-2 — its time the latest fill's).
      await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE);
      await page.reload();
      await expect(rows(page)).toHaveCount(1);
      expect(await rowIds(page)).toEqual([firstNotice.id]);
      await expect(firstRow.getByTestId('notification-row-title')).toHaveText(
        filledTitle('부분 체결 · 체결 2회 · 누적 2계약 · 평균 40.00 Coin'),
      );

      // --- A presses it: the order's 주문 상세, 부분 체결 with 2 of 3 filled; back on 알림 it is read.
      await firstRow.click();
      await expect(page).toHaveURL(`/my/orders/${first.id}`);
      await expect(page.getByTestId('order-detail-status')).toHaveText(
        copy.orderStatusPartiallyFilled,
      );
      await expect(page.getByTestId('order-detail-ordered')).toHaveText('3계약');
      await expect(page.getByTestId('order-detail-filled')).toHaveText('2계약');
      await page.goBack();
      await expect(page).toHaveURL('/my/notifications');
      await expect(firstRow).toHaveAttribute('data-read', 'true');

      // --- B again, after the read: a NEW unread row on top (52-6), 전량 체결 — its own fill as
      // '이번' and the order's whole beside it, since it does not hold the earlier two (134-3).
      await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE);
      await page.reload();
      await expect(rows(page)).toHaveCount(2);
      const [afterRead] = await inboxOf(a);
      if (afterRead === undefined || afterRead.id === firstNotice.id) {
        throw new Error('the fill after the read made no notice of its own');
      }
      expect(await rowIds(page)).toEqual([afterRead.id, firstNotice.id]);
      await expect(row(page, afterRead.id)).toHaveAttribute('data-read', 'false');
      await expect(row(page, afterRead.id).getByTestId('notification-row-title')).toHaveText(
        filledTitle('전량 체결 · 이번 1계약 · 평균 40.00 Coin (주문 3계약 중 3계약 체결)'),
      );
      await expect(firstRow.getByTestId('notification-row-title')).toHaveText(
        filledTitle('부분 체결 · 체결 2회 · 누적 2계약 · 평균 40.00 Coin'),
      );

      // --- A's second NO bid, 2 at 40; B twice: one row, 전량 체결 · 체결 2회 · 누적 2계약 — it
      // holds every fill of that order, so the approved sentence as it stands.
      const second = (await placeOrder(a, market.id, crypto.randomUUID(), NO_BID(2))).order;
      await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE);
      const lastRequest = crypto.randomUUID();
      await placeOrder(b, market.id, lastRequest, YES_TAKE);
      await page.reload();
      await expect(rows(page)).toHaveCount(3);
      const [merged] = await inboxOf(a);
      if (merged === undefined) throw new Error('A has no notice of the second order');
      expect(merged).toMatchObject({
        target: { kind: 'order', orderId: second.id },
        eventCount: 2,
        readAt: null,
      });
      expect(await rowIds(page)).toEqual([merged.id, afterRead.id, firstNotice.id]);
      await expect(row(page, merged.id).getByTestId('notification-row-title')).toHaveText(
        filledTitle('전량 체결 · 체결 2회 · 누적 2계약 · 평균 40.00 Coin'),
      );

      // --- B sends its last request again under the same request id: `replayed`, and A's
      // notices and count as they were (AC 9).
      const before = { inbox: await inboxOf(a), unread: await unreadCountOf(a) };
      expect(before.unread).toBe(2);
      const replayed = await placeOrder(b, market.id, lastRequest, YES_TAKE);
      expect(replayed.replayed).toBe(true);
      expect({ inbox: await inboxOf(a), unread: await unreadCountOf(a) }).toEqual(before);

      // --- B's own 알림 says there is none: the incoming side is never notified (52-2).
      expect(await inboxOf(b)).toEqual([]);
      await openCounted(bPage, '/my/notifications');
      await expect(bPage.getByTestId('my-notifications-empty')).toHaveText(copy.notificationsEmpty);
      await expect(myUnread(bPage)).toHaveCount(0);
    } finally {
      await bContext.close();
    }
  });

  test('일시 중단이 취소한 대기 주문은 사건마다 한 알림이고, 누르면 그 시장으로 거른 거래·정산 이력이 열린다', async ({
    admin,
    page,
  }) => {
    await signUp(page, freshEmail());
    const a = page.request;
    const market = await createOpenMarket(admin);

    // --- A's two YES bids that meet nothing (no liquidity, no other member).
    const low = (
      await placeOrder(a, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 10,
        qty: 1,
      })
    ).order;
    const high = (
      await placeOrder(a, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 15,
        qty: 2,
      })
    ).order;
    expect([low.status, high.status]).toEqual(['open', 'open']);
    await openCounted(page, '/my/notifications');
    await expect(page.getByTestId('my-notifications-empty')).toHaveText(copy.notificationsEmpty);
    await page.waitForTimeout(REALTIME_BUDGET_MS);

    // --- The admin pauses the market: both bids cancelled as 일시 중단, one notice for the event
    // (52-3, 52-4), which the open page draws without a reload.
    await pauseMarket(admin, market.id);
    await expect(myUnread(page)).toHaveText('1', { timeout: REALTIME_BUDGET_MS + ONE_READ_MS });
    const [notice] = await inboxOf(a);
    if (notice === undefined) throw new Error('A has no notice of the pause');
    expect(notice).toMatchObject({
      type: 'orders_cancelled',
      category: 'trade',
      target: { kind: 'order_history', marketId: market.id },
      eventCount: 1,
    });
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, notice.id).getByTestId('notification-row-title')).toHaveText(
      `${market.title} 일시 중단으로 대기 주문 2건 취소`,
    );

    // --- Pressing it opens 거래·정산 이력 filtered to the market: the two orders, 취소 완료 for
    // 일시 중단.
    await row(page, notice.id).click();
    await expect(page).toHaveURL(`/my/history?market=${market.id}`);
    const history = page.getByTestId('my-order-history');
    for (const order of [low, high]) {
      const each = history.getByTestId(`portfolio-order-${order.id}`);
      await expect(each.getByTestId('history-order-status')).toHaveText(copy.orderStatusCancelled);
      await expect(each.getByTestId('portfolio-order-reason')).toHaveText(
        copy.orderCancelNamePaused,
      );
    }
    await page.goBack();
    await expect(row(page, notice.id)).toHaveAttribute('data-read', 'true');
  });
});

/**
 * How far ahead the market the worker closes has its close: room for its making and opening and
 * two orders to land before it, on a slow box too (both members sign up before it is set) —
 * orders.spec.ts' budget.
 */
const CLOSE_IN_MS = 70_000;

/**
 * How long the test waits for the close: the close, and then a whole minute more for the
 * per-minute scan should the delayed job be lost (orders.spec.ts').
 */
const CLOSE_WAIT_MS = 150_000;

test.describe('거래 알림 — 거래 마감의 만료 (#134)', () => {
  test('워커가 마감하며 만료한 대기 주문은 체결 알림과 따로 한 알림이고, 새로 고침 없이 오며, 누르면 체결 수량과 끝난 수량을 함께 보이는 주문 상세가 열린다', async ({
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
    try {
      const bPage = await bContext.newPage();
      await signUp(page, freshEmail());
      await signUp(bPage, freshEmail());
      const a = page.request;
      const b = bPage.request;
      const closeAt = new Date(Date.now() + CLOSE_IN_MS).toISOString();
      const market = await createOpenMarket(admin, { closeAt });

      // --- A's NO bid of 2 at 40 rests; B's immediate YES buy fills one: A's 부분 체결 notice.
      const resting = (await placeOrder(a, market.id, crypto.randomUUID(), NO_BID(2))).order;
      await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE);
      const [fill] = await inboxOf(a);
      if (fill === undefined) throw new Error('A has no notice of the fill');
      expect(fill).toMatchObject({ type: 'order_filled', eventCount: 1 });

      // --- A's 알림 open before the close, the one row drawn and the page marked.
      await openCounted(page, '/my/notifications');
      await expect(rows(page)).toHaveCount(1);
      await expect(row(page, fill.id).getByTestId('notification-row-title')).toHaveText(
        `${market.title} NO 매수 주문 부분 체결 · 1계약 · 평균 40.00 Coin`,
      );
      await expect(myUnread(page)).toHaveText('1');
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      await markDocument(page);

      // --- The worker closes the market at its close and expires the rest of A's bid.
      await expect
        .poll(
          async () => (await dataOf<Market>(await b.get(`/api/v1/markets/${market.id}`))).status,
          { timeout: CLOSE_WAIT_MS, intervals: [2_000] },
        )
        .toBe('closed');

      // --- Its notice comes without a reload (the close's `user:notification`): a row of its own
      // on top of the fill's — another type, so another notice (53-4) — leading to the order.
      await expect(myUnread(page)).toHaveText('2', { timeout: REALTIME_BUDGET_MS + ONE_READ_MS });
      await expect(rows(page)).toHaveCount(2);
      expect(await documentSurvived(page)).toBe(true);
      const [expiry] = await inboxOf(a);
      if (expiry === undefined || expiry.id === fill.id) {
        throw new Error('the close made no notice of its own');
      }
      expect(expiry).toMatchObject({
        type: 'orders_expired',
        category: 'trade',
        target: { kind: 'order', orderId: resting.id },
        eventCount: 1,
      });
      expect(await rowIds(page)).toEqual([expiry.id, fill.id]);
      await expect(row(page, expiry.id).getByTestId('notification-row-title')).toHaveText(
        `${market.title} 거래 마감으로 대기 주문 1건 만료`,
      );

      // --- Pressed: the order's 주문 상세, 만료 with what filled and what ended together (AC 7).
      await row(page, expiry.id).click();
      await expect(page).toHaveURL(`/my/orders/${resting.id}`);
      await expect(page.getByTestId('order-detail-status')).toHaveText(copy.orderStatusExpired);
      await expect(page.getByTestId('order-detail-filled')).toHaveText('1계약');
      await expect(page.getByTestId('order-detail-cancelled')).toHaveText('1계약');
      expect(await dataOf<Order>(await a.get(`/api/v1/me/orders/${resting.id}`))).toMatchObject({
        status: 'expired',
        filledQty: 1,
        cancelledQty: 1,
      });
    } finally {
      await bContext.close();
    }
  });
});
