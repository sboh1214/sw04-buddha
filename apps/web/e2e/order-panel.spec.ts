import type { APIResponse, Locator, Page, Request, Route } from '@playwright/test';
import { type AdminMarket, type Order, formatCoin, parseCoinAmount } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  adminAccount,
  createOpenMarket,
  dataOf,
  expect,
  freshEmail,
  meOf,
  placeOrder,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 주문 패널과 주문 확인 화면 (#66, ADR-0140; ADR-0135 D1~D13, E3, H6, owner answers 66-Q1~Q4), on
 * markets each test opens for itself, with a fresh browser member M and a fresh counterparty C who
 * makes the book through the API (orders.spec.ts's helpers). C's two buys sum below 100, so C's
 * own orders never cross; each member sends six orders or fewer, under the test intake's 20 a
 * minute (global-setup.ts). The width is read off the market, 5 in the test setup: an immediate
 * YES buy against a YES ask of 60 is sent with 65, an immediate YES sell against a bid of 40 with
 * 35 — never the 99 or 1 a quote starts from.
 *
 * Both projects: below md the panel is the sheet the 매수 bar opens, from md the order column —
 * one state behind both (`OrderPanelProvider`). The 1-hour expiry, the reasons' sentences, the
 * arithmetic of 확인, the debounce and a restricted account are the unit tests'
 * (lib/order-*.test.ts).
 */

const ORDERS_PATH = (marketId: string) => `/api/v1/markets/${marketId}/orders`;

/**
 * The panel on this width: the order column from md, the sheet the 매수 bar opens below it — on
 * `contract` when one is named (its button pressed), as it stands otherwise.
 */
async function openPanel(page: Page, contract?: 'YES' | 'NO'): Promise<Locator> {
  const id = contract === 'NO' ? 'no' : 'yes';
  let place: Locator;
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    place = page.getByTestId('order-area');
  } else {
    place = page.getByTestId('order-sheet');
    if (!(await place.isVisible())) await page.getByTestId(`order-entry-${id}`).click();
  }
  await expect(place.getByTestId('order-panel')).toBeVisible();
  if (contract !== undefined) await place.getByTestId(`order-contract-${id}`).click();
  return place;
}

interface PanelOrder {
  side?: 'buy' | 'sell';
  kind?: 'ioc' | 'gtc';
  qty?: number;
  budget?: number;
  limit?: number;
}

/** Fills the panel's choices and fields, and waits for the quote of exactly them. */
async function fillOrder(panel: Locator, order: PanelOrder): Promise<void> {
  await panel.getByTestId(`order-side-${order.side ?? 'buy'}`).click();
  await panel.getByTestId(`order-kind-${order.kind ?? 'ioc'}`).click();
  if (order.budget !== undefined) {
    await panel.getByTestId('order-size-budget').click();
    await panel.getByTestId('order-budget').fill(String(order.budget));
  } else {
    if ((order.side ?? 'buy') === 'buy' && (order.kind ?? 'ioc') === 'ioc') {
      await panel.getByTestId('order-size-qty').click();
    }
    await panel.getByTestId('order-qty').fill(String(order.qty ?? 1));
  }
  if (order.limit !== undefined) await panel.getByTestId('order-limit').fill(String(order.limit));
}

/** The order bodies and request ids this page sends to the market's intake. */
function watchOrders(page: Page, marketId: string): { bodies: unknown[]; keys: string[] } {
  const seen = { bodies: [] as unknown[], keys: [] as string[] };
  page.on('request', (request: Request) => {
    if (request.method() !== 'POST' || !request.url().endsWith(ORDERS_PATH(marketId))) return;
    seen.bodies.push(request.postDataJSON());
    seen.keys.push(request.headers()['idempotency-key'] ?? '');
  });
  return seen;
}

/** 주문 확인, then the frozen table. */
async function openReview(panel: Locator): Promise<Locator> {
  await expect(panel.getByTestId('order-quote')).toBeVisible();
  await expect(panel.getByTestId('order-confirm-open')).toBeEnabled();
  await panel.getByTestId('order-confirm-open').click();
  const review = panel.getByTestId('order-review');
  await expect(review).toBeVisible();
  return review;
}

/** M's orders on the market, through the API. */
async function ordersOn(page: Page, marketId: string): Promise<Order[]> {
  return dataOf<Order[]>(await page.request.get(`/api/v1/me/orders?marketId=${marketId}`));
}

async function widthOf(admin: Parameters<typeof createOpenMarket>[0], marketId: string) {
  const market = await dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${marketId}`));
  if (market.priceProtectionTicks === null) throw new Error('no 가격 보호 폭: global-setup.ts');
  return market.priceProtectionTicks;
}

test.describe('주문 패널 (#66)', () => {
  test('즉시 거래 네 경로와 금액 주문: 확인 화면의 한도가 보내는 한도이고, 남은 수량은 취소되며, 두 번 눌러도 주문은 하나다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const width = await widthOf(admin, market.id);
    const cContext = await browser.newContext();
    try {
      const cPage = await cContext.newPage();
      await signUp(cPage, freshEmail());
      await signUp(page, freshEmail());
      const c = cPage.request;
      // C: a NO bid of 40 is a YES ask of 60 (one), and a YES bid of 40 is a NO ask of 60 (three).
      const gtc = { timeInForce: 'gtc', limitPriceCoin: 40 } as const;
      await placeOrder(c, market.id, crypto.randomUUID(), {
        ...gtc,
        outcome: 'NO',
        side: 'buy',
        qty: 1,
      });
      await placeOrder(c, market.id, crypto.randomUUID(), {
        ...gtc,
        outcome: 'YES',
        side: 'buy',
        qty: 3,
      });
      const sent = watchOrders(page, market.id);
      await page.goto(`/markets/${market.slug}`);
      // The header's 가용 코인 before any order, as `GET /me` has it.
      const chip = page.getByTestId('balance-chip');
      const coinBefore = parseCoinAmount((await meOf(page.request)).balance.availableCoin);
      await expect(chip).toContainText(formatCoin(coinBefore));

      // --- YES 수량 매수 2 against one: 1 fills, the rest is cancelled (즉시 거래 잔량).
      let panel = await openPanel(page, 'YES');
      await fillOrder(panel, { qty: 2 });
      let review = await openReview(panel);
      for (const row of [
        'contract',
        'kind',
        'size',
        'limit',
        'filled',
        'avg',
        'pay',
        'max-spend',
      ]) {
        await expect(review.getByTestId(`order-review-${row}`), row).toBeVisible();
      }
      for (const row of ['fee', 'payout-win', 'net', 'payout-lose', 'payout-void', 'unfilled']) {
        await expect(review.getByTestId(`order-review-${row}`), row).toBeVisible();
      }
      const buyLimit = Math.min(99, 60 + width);
      await expect(review.getByTestId('order-review-limit')).toContainText(
        `${buyLimit.toFixed(2)} Coin`,
      );
      // 66-Q1: on the expected fill, one contract.
      await expect(review.getByTestId('order-review-payout-win')).toContainText('100 Coin');
      await expect(review.getByTestId('order-review-payout-void')).toContainText('합계 50 Coin');
      // Prices are Coin per contract: no probability anywhere in 확인.
      await expect(review).not.toContainText('%');
      // A double press sends one order.
      await review.getByTestId('order-submit').dblclick();
      let result = panel.getByTestId('order-result');
      await expect(result).toHaveAttribute('data-status', 'cancelled');
      await expect(panel.getByTestId('order-result-reason')).toContainText('즉시 거래 잔량');
      await expect(panel.getByTestId('order-result-filled-qty')).toContainText('1계약');
      await expect(panel.getByTestId('order-result-cancelled')).toContainText('1계약');
      expect(sent.bodies).toHaveLength(1);
      expect(sent.bodies[0]).toMatchObject({
        outcome: 'YES',
        side: 'buy',
        limitPriceCoin: buyLimit,
      });
      expect((await ordersOn(page, market.id)).length).toBe(1);
      // The result reads `me` again: the header's 가용 코인 is the server's, the fill paid.
      const coinAfter = parseCoinAmount((await meOf(page.request)).balance.availableCoin);
      expect(coinAfter).toBeLessThan(coinBefore);
      await expect(chip).toContainText(formatCoin(coinAfter));

      // --- C makes more YES supply (a NO bid of 40 is three YES asks of 60).
      await placeOrder(c, market.id, crypto.randomUUID(), {
        ...gtc,
        outcome: 'NO',
        side: 'buy',
        qty: 3,
      });

      // --- NO 금액 매수: too little for one contract is blocked by the quote's reason, then 100.
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page, 'NO');
      await fillOrder(panel, { budget: 30 });
      await expect(panel.getByTestId('order-block')).toHaveAttribute(
        'data-reason',
        'budget_too_small',
      );
      await expect(panel.getByTestId('order-confirm-open')).toBeDisabled();
      await panel.getByTestId('order-budget').fill('100');
      review = await openReview(panel);
      await expect(review.getByTestId('order-review-size')).toContainText('100 Coin');
      await expect(review.getByTestId('order-review-unspent')).toContainText('40 Coin');
      await review.getByTestId('order-submit').click();
      result = panel.getByTestId('order-result');
      await expect(result).toHaveAttribute('data-status', 'filled');
      await expect(panel.getByTestId('order-result-unspent')).toContainText('40 Coin');
      expect(sent.bodies[1]).toMatchObject({
        outcome: 'NO',
        budgetCoin: '100',
        limitPriceCoin: buyLimit,
      });

      // --- YES 즉시 매도 1 against C's bid of 40: sent with 40 − the width, never 1.
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page, 'YES');
      await fillOrder(panel, { side: 'sell', qty: 1 });
      await expect(panel.getByTestId('order-sellable')).toContainText('매도 가능 1계약');
      review = await openReview(panel);
      const sellLimit = Math.max(1, 40 - width);
      await expect(review.getByTestId('order-review-limit')).toContainText(
        `${sellLimit.toFixed(2)} Coin`,
      );
      // No 최소 수령, no payout or VOID on a sell.
      for (const row of ['min-receive', 'payout-win', 'net', 'payout-void']) {
        await expect(review.getByTestId(`order-review-${row}`), row).toHaveCount(0);
      }
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'filled');
      expect(sent.bodies[2]).toMatchObject({
        outcome: 'YES',
        side: 'sell',
        limitPriceCoin: sellLimit,
      });

      // --- NO 즉시 매도 1 against C's NO bids of 40.
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page, 'NO');
      await fillOrder(panel, { side: 'sell', qty: 1 });
      review = await openReview(panel);
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'filled');
      expect(sent.bodies[3]).toMatchObject({
        outcome: 'NO',
        side: 'sell',
        limitPriceCoin: sellLimit,
      });
      expect(sent.bodies).toHaveLength(4);
      expect(new Set(sent.keys).size).toBe(4);
      expect((await ordersOn(page, market.id)).length).toBe(4);
    } finally {
      await cContext.close();
    }
  });

  test('지정가 네 경로: 즉시 체결분과 대기분을 나누고(D8), 확인 중 호가가 바뀌면 알리되 고정한 숫자로 제출한다(D7)', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const width = await widthOf(admin, market.id);
    const cContext = await browser.newContext();
    try {
      const cPage = await cContext.newPage();
      await signUp(cPage, freshEmail());
      await signUp(page, freshEmail());
      const c = cPage.request;
      await placeOrder(c, market.id, crypto.randomUUID(), {
        outcome: 'NO',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        qty: 1,
      });
      // C's YES bid of 40 is a NO ask of 60: M buys one NO now, to sell it with a limit.
      await placeOrder(c, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        qty: 1,
      });
      const sent = watchOrders(page, market.id);
      await page.goto(`/markets/${market.slug}`);

      // --- NO 즉시 매수 1, then NO 지정가 매도 1 at 90: above every NO bid, so it rests.
      let panel = await openPanel(page, 'NO');
      await fillOrder(panel, { qty: 1 });
      let review = await openReview(panel);
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'filled');
      expect(sent.bodies.at(-1)).toMatchObject({
        outcome: 'NO',
        side: 'buy',
        limitPriceCoin: Math.min(99, 60 + width),
      });
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page, 'NO');
      await fillOrder(panel, { side: 'sell', kind: 'gtc', qty: 1, limit: 90 });
      review = await openReview(panel);
      await expect(review.getByTestId('order-review-min-receive')).toContainText('90 Coin');
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'open');
      expect(sent.bodies.at(-1)).toMatchObject({
        outcome: 'NO',
        side: 'sell',
        timeInForce: 'gtc',
        limitPriceCoin: 90,
      });

      // --- YES 지정가 매수 1 at 50: below the ask of 60, so it rests.
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page, 'YES');
      await fillOrder(panel, { kind: 'gtc', qty: 1, limit: 50 });
      review = await openReview(panel);
      await expect(review.getByTestId('order-review-immediate')).toContainText('0계약');
      await expect(review.getByTestId('order-review-resting')).toContainText('1계약');
      await expect(review.getByTestId('order-review-pay-full')).toContainText('50 Coin');
      await expect(review.getByTestId('order-review-immediate-notice')).toHaveCount(0);
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'open');
      expect(sent.bodies.at(-1)).toMatchObject({ timeInForce: 'gtc', limitPriceCoin: 50 });

      // --- YES 지정가 매수 2 at 62: crosses the ask of 60 — one now, one rests (D8).
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page, 'YES');
      await fillOrder(panel, { kind: 'gtc', qty: 2, limit: 62 });
      await expect(panel.getByTestId('order-immediate-notice')).toBeVisible();
      review = await openReview(panel);
      await expect(review.getByTestId('order-review-immediate-notice')).toContainText('1계약');
      await expect(review.getByTestId('order-review-immediate')).toContainText('1계약');
      await expect(review.getByTestId('order-review-resting')).toContainText('1계약');
      // 60 now and 62 for the rest; the whole pays 200, so 순이익 is 200 − 122.
      await expect(review.getByTestId('order-review-pay-full')).toContainText('122 Coin');
      await expect(review.getByTestId('order-review-net')).toContainText('78 Coin');
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute(
        'data-status',
        'partially_filled',
      );

      // --- YES 지정가 매도 1 at 90: rests, and the holding it locks is shown apart (D11).
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page, 'YES');
      await fillOrder(panel, { side: 'sell', kind: 'gtc', qty: 1, limit: 90 });
      review = await openReview(panel);
      await expect(review.getByTestId('order-review-min-receive')).toContainText('90 Coin');
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'open');
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page, 'YES');
      await panel.getByTestId('order-side-sell').click();
      await expect(panel.getByTestId('order-sellable')).toHaveText(
        '매도 가능 0계약(대기 매도 잠금 1계약)',
      );
      await expect(panel.getByTestId('order-qty')).toBeDisabled();

      // --- NO 지정가 매수 1 at 30, under 확인 while C moves the book (D7).
      panel = await openPanel(page, 'NO');
      await fillOrder(panel, { kind: 'gtc', qty: 1, limit: 30 });
      await expect(panel.getByTestId('order-quote')).toBeVisible();
      review = await openReview(panel);
      // The baseline is in — a book read that answered after the frozen quote — before C moves.
      await expect(review).toHaveAttribute('data-baseline', 'true');
      const frozenLimit = await review.getByTestId('order-review-limit').textContent();
      // C's YES bid of 20 is a NO ask of 80, beside M's own NO ask of 90: the side M's NO buy
      // meets has moved.
      await placeOrder(c, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 20,
        qty: 1,
      });
      await expect(review.getByTestId('order-review-book-changed')).toContainText(
        copy.orderBookChanged,
        { timeout: 15_000 },
      );
      // The line and 다시 견적 ride in the sticky bar above the buttons: never under it.
      const bar = review.getByTestId('order-review-actions');
      await expect(bar.getByTestId('order-review-book-changed')).toBeVisible();
      await expect(bar.getByTestId('order-review-requote')).toBeVisible();
      // The numbers stay frozen, and 주문 제출 is not blocked.
      await expect(review.getByTestId('order-review-limit')).toHaveText(frozenLimit ?? '');
      await expect(review.getByTestId('order-submit')).toBeEnabled();
      // 다시 견적 makes a new confirmation (its new request id is pinned in the provider's static
      // test): said in the bar's line, and the focus goes back to 확인's title.
      await review.getByTestId('order-review-requote').click();
      await expect(bar.getByTestId('order-review-requoted')).toHaveText(copy.orderRequoted);
      await expect(review.getByRole('heading', { name: copy.orderReviewTitle })).toBeFocused();
      await expect(review.getByTestId('order-submit')).toBeEnabled();
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'open');
      expect(sent.bodies.at(-1)).toMatchObject({
        outcome: 'NO',
        timeInForce: 'gtc',
        limitPriceCoin: 30,
      });
      expect(new Set(sent.keys).size).toBe(sent.keys.length);
    } finally {
      await cContext.close();
    }
  });

  test('호가 없음 방향의 즉시 거래는 막고 지정가를 안내하며, 보유 없는 매도는 꺼지고, 관리자에게는 견적까지 보이고 주문 확인만 끈다(D2·D9·D11·D13)', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const cContext = await browser.newContext();
    const adminContext = await browser.newContext();
    try {
      const cPage = await cContext.newPage();
      await signUp(cPage, freshEmail());
      await signUp(page, freshEmail());
      // Only YES has asks: C's NO bid of 40 is a YES ask of 60; NO has none.
      await placeOrder(cPage.request, market.id, crypto.randomUUID(), {
        outcome: 'NO',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        qty: 1,
      });
      const sent = watchOrders(page, market.id);
      await page.goto(`/markets/${market.slug}`);

      // D2: the best ask, or 호가 없음 — on the bar below md, on the contract buttons from md.
      if ((page.viewportSize()?.width ?? 0) < 768) {
        await expect(page.getByTestId('order-entry-yes-price')).toHaveText('60.00 Coin');
        await expect(page.getByTestId('order-entry-no-price')).toHaveText(copy.marketBookEmpty);
      }
      const panel = await openPanel(page, 'NO');
      await expect(panel.getByTestId('order-contract-yes')).toContainText('60.00 Coin');
      await expect(panel.getByTestId('order-contract-no')).toContainText(copy.marketBookEmpty);

      // D9: an immediate NO buy meets nothing — blocked, with the way to a limit order.
      await fillOrder(panel, { qty: 1 });
      await expect(panel.getByTestId('order-block')).toHaveAttribute('data-reason', 'no_quote');
      await expect(panel.getByTestId('order-block')).toContainText(copy.orderBlockNoQuote);
      await expect(panel.getByTestId('order-confirm-open')).toBeDisabled();
      // 호가 없음 is not a market that stopped: no input-closed line, the input stays on.
      await expect(panel.getByTestId('order-input-closed')).toHaveCount(0);
      await expect(panel.getByTestId('order-qty')).toBeEnabled();
      // A budget the same way.
      await panel.getByTestId('order-size-budget').click();
      await panel.getByTestId('order-budget').fill('100');
      await expect(panel.getByTestId('order-block')).toHaveAttribute('data-reason', 'no_quote');
      await panel.getByTestId('order-switch-gtc').click();
      await expect(panel.getByTestId('order-kind-gtc')).toHaveAttribute('aria-pressed', 'true');
      await expect(panel.getByTestId('order-block')).toHaveCount(0);

      // D11: nothing held, nothing to sell.
      await panel.getByTestId('order-side-sell').click();
      await expect(panel.getByTestId('order-sellable')).toHaveText(
        '매도 가능 0계약(대기 매도 잠금 0계약)',
      );
      await expect(panel.getByTestId('order-qty')).toBeDisabled();
      await expect(panel.getByTestId('order-confirm-open')).toBeDisabled();
      expect(sent.bodies).toHaveLength(0);

      // D13 (owner answer 66-Q3): an admin reads the book and a quote; 주문 확인 and the sell entry
      // are off, and one line says why.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/markets/${market.slug}`);
      const adminPanel = await openPanel(adminPage, 'YES');
      await expect(adminPanel.getByTestId('order-account-blocked')).toContainText(copy.orderAdmin);
      await expect(adminPanel.getByTestId('order-side-sell')).toBeDisabled();
      // The sell entry points at that line too (결정 2-23).
      await expect(adminPanel.getByTestId('order-side-sell')).toHaveAttribute(
        'aria-describedby',
        /order-account-blocked/,
      );
      await adminPanel.getByTestId('order-qty').fill('1');
      await expect(adminPanel.getByTestId('order-quote')).toBeVisible();
      await expect(adminPanel.getByTestId('order-confirm-open')).toBeDisabled();
      await expect(adminPanel.getByTestId('order-confirm-open')).toHaveAttribute(
        'aria-describedby',
        /order-account-blocked/,
      );
    } finally {
      await cContext.close();
      await adminContext.close();
    }
  });

  test('비로그인 입력은 견적까지 되고, 로그인한 뒤 같은 탭에서만 되살아나며 저절로 제출하지 않는다(D3·D4·66-Q4)', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const memberContext = await browser.newContext();
    try {
      // An account to sign in with, made elsewhere.
      const email = freshEmail();
      await signUp(await memberContext.newPage(), email);
      const sent = watchOrders(page, market.id);
      await page.goto(`/markets/${market.slug}`);

      let panel = await openPanel(page, 'YES');
      await fillOrder(panel, { kind: 'gtc', qty: 3, limit: 40 });
      await expect(panel.getByTestId('order-quote')).toBeVisible();
      await panel.getByTestId('order-confirm-open').click();
      await expect(panel.getByTestId('order-sign-in')).toContainText(copy.orderSignIn);
      const back = `/markets/${market.slug}`;
      await expect(panel.getByTestId('order-sign-in-login')).toHaveAttribute(
        'href',
        `/login?next=${encodeURIComponent(back)}`,
      );

      // Another tab of the same browser signs in by that link and comes back to the market: its
      // sessionStorage is its own, so nothing is given back there — while the first tab's draft
      // is still kept.
      const other = await page.context().newPage();
      await other.goto(`/login?next=${encodeURIComponent(back)}`);
      await other.getByLabel(copy.email).fill(email);
      await other.getByLabel(copy.password, { exact: true }).fill(E2E_PASSWORD);
      await other.getByRole('button', { name: copy.loginWithEmail }).click();
      await expect(other).toHaveURL(back);
      // No contract pressed: a press is an edit, which would take a restored notice away.
      const otherPanel = await openPanel(other);
      await expect(otherPanel.getByTestId('order-restored')).toHaveCount(0);
      await expect(otherPanel.getByTestId('order-qty')).toHaveValue('');
      const draftsIn = (tab: Page) =>
        tab.evaluate(() =>
          Object.keys(window.sessionStorage).filter((key) => key.startsWith('buddha.orderDraft:')),
        );
      expect(await draftsIn(other)).toEqual([]);
      expect(await draftsIn(page)).toHaveLength(1);
      await other.close();

      // The first tab opens the market again, signed in by the same cookie: the input is given
      // back, and nothing is sent.
      await page.goto(back);
      panel =
        (page.viewportSize()?.width ?? 0) >= 768
          ? page.getByTestId('order-area')
          : page.getByTestId('order-sheet');
      // Below md the sheet opens by itself on the restored contract.
      await expect(panel.getByTestId('order-restored')).toHaveText(copy.orderRestored);
      await expect(panel.getByTestId('order-kind-gtc')).toHaveAttribute('aria-pressed', 'true');
      await expect(panel.getByTestId('order-qty')).toHaveValue('3');
      await expect(panel.getByTestId('order-limit')).toHaveValue('40');
      await expect(panel.getByTestId('order-review')).toHaveCount(0);
      expect(await draftsIn(page)).toEqual([]);

      // And a reload of it gives nothing back twice.
      await page.reload();
      panel = await openPanel(page);
      await expect(panel.getByTestId('order-restored')).toHaveCount(0);
      expect(sent.bodies).toHaveLength(0);
    } finally {
      await memberContext.close();
    }
  });

  test('닫힌 접수와 폭 없음은 문장으로, 답을 잃은 주문은 같은 요청 ID로 다시 읽고 다시 보내 한 건만 남기며, 응답 전에는 체결 소식이 와도 접수 중이다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const cContext = await browser.newContext();
    try {
      const cPage = await cContext.newPage();
      await signUp(cPage, freshEmail());
      await signUp(page, freshEmail());
      // Supply for immediate YES buys: a NO bid of 40 is five YES asks of 60.
      await placeOrder(cPage.request, market.id, crypto.randomUUID(), {
        outcome: 'NO',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        qty: 5,
      });
      const sent = watchOrders(page, market.id);
      await page.goto(`/markets/${market.slug}`);
      const intake = `**${ORDERS_PATH(market.id)}`;

      // --- (a) D12: closed intake, no details — its sentence, the input kept.
      await page.route(intake, (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'ORDER_INTAKE_CLOSED', message: 'closed' } }),
        }),
      );
      let panel = await openPanel(page, 'YES');
      await fillOrder(panel, { qty: 1 });
      let review = await openReview(panel);
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-error')).toHaveAttribute(
        'data-code',
        'ORDER_INTAKE_CLOSED',
      );
      await expect(panel.getByTestId('order-error')).toContainText(copy.orderIntakeClosed);
      await panel.getByTestId('order-new').click();
      await expect(panel.getByTestId('order-qty')).toHaveValue('1');
      await page.unroute(intake);

      // --- (b) A market with no 가격 보호 폭: its immediate quote refused — that only is off.
      const quotePath = `**/api/v1/markets/${market.id}/quote`;
      await page.route(quotePath, async (route) => {
        const body = route.request().postDataJSON() as { timeInForce?: string };
        if (body.timeInForce !== 'ioc') return route.continue();
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'ORDER_INTAKE_CLOSED',
              message: 'no width',
              details: [{ path: ['priceProtection'], message: 'undecided' }],
            },
          }),
        });
      });
      await panel.getByTestId('order-qty').fill('2');
      await expect(panel.getByTestId('order-block')).toHaveAttribute('data-reason', 'no_width');
      await panel.getByTestId('order-switch-gtc').click();
      await panel.getByTestId('order-limit').fill('40');
      await expect(panel.getByTestId('order-block')).toHaveCount(0);
      await expect(panel.getByTestId('order-confirm-open')).toBeEnabled();
      await page.unroute(quotePath);

      // --- (c) The answer lost after the server took it: read back by the same id, one order.
      await page.route(intake, async (route) => {
        await route.fetch();
        await route.abort('connectionreset');
      });
      await panel.getByTestId('order-kind-ioc').click();
      await panel.getByTestId('order-qty').fill('1');
      review = await openReview(panel);
      const readBack = page.waitForRequest((request) =>
        request.url().includes('/api/v1/me/orders/request/'),
      );
      await review.getByTestId('order-submit').click();
      // '다시 확인하는 중' may last no longer than the first read: the result is what counts.
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'filled');
      await page.unroute(intake);
      // Read back by the id it was sent with, and never sent again: one POST each for (a) and (c).
      expect((await readBack).url()).toContain(`/api/v1/me/orders/request/${sent.keys.at(-1)}`);
      expect(sent.bodies).toHaveLength(2);
      expect(new Set(sent.keys).size).toBe(2);
      expect((await ordersOn(page, market.id)).length).toBe(1);

      // --- (d) Lost again, and the page reloaded while the read-back waits: it reads, never sends.
      await panel.getByTestId('order-new').click();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lookups: string[] = [];
      await page.route('**/api/v1/me/orders/request/*', async (route: Route) => {
        lookups.push(route.request().url());
        await gate;
        await route.continue().catch(() => undefined);
      });
      await page.route(intake, async (route) => {
        await route.fetch();
        await route.abort('connectionreset');
      });
      panel = await openPanel(page, 'YES');
      await fillOrder(panel, { qty: 1 });
      review = await openReview(panel);
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-recovering')).toBeVisible();
      await page.unroute(intake);
      const postsBefore = sent.bodies.length;
      const lookedUp = page.waitForRequest((request) =>
        request.url().includes('/api/v1/me/orders/request/'),
      );
      await page.reload();
      await lookedUp;
      release();
      // Below md the sheet is closed after the reload, so the result ends where no panel shows it:
      // its toast, kept until it is closed (결정 2-7). Waited for before the sheet opens — a
      // result that landed after it would raise none.
      const narrow = (page.viewportSize()?.width ?? 0) < 768;
      // The result card is a status too: the toast is the one in the notifications region.
      const toast = page
        .getByRole('region', { name: /Notifications/ })
        .getByRole('status')
        .filter({ hasText: copy.orderResultTitle });
      if (narrow) await expect(toast).toBeVisible();
      // No contract pressed: the panel holds the result, which has no contract buttons.
      panel = await openPanel(page);
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'filled');
      expect(sent.bodies.length).toBe(postsBefore);
      // The toast stands above the open sheet, never on what the sheet asks for (결정 2-24): the
      // next order below is typed and sent under it.
      if (narrow) {
        await expect
          .poll(async () => {
            const [toastBox, sheetBox] = await Promise.all([
              toast.boundingBox(),
              panel.boundingBox(),
            ]);
            if (toastBox === null || sheetBox === null) return null;
            return toastBox.y >= 0 && toastBox.y + toastBox.height <= sheetBox.y;
          })
          .toBe(true);
      }
      expect(lookups.length).toBeGreaterThanOrEqual(1);
      await page.unroute('**/api/v1/me/orders/request/*');
      expect((await ordersOn(page, market.id)).length).toBe(2);

      // --- (e) Never reached the server: three NOT_FOUNDs, the card with what was sent, then the
      // original arrives late and 같은 요청 다시 보내기 answers it — one order, replayed.
      await panel.getByTestId('order-new').click();
      let held: { key: string; body: unknown } | null = null;
      await page.route(intake, async (route) => {
        held = {
          key: route.request().headers()['idempotency-key'] ?? '',
          body: route.request().postDataJSON(),
        };
        await route.abort('connectionreset');
      });
      panel = await openPanel(page, 'YES');
      await fillOrder(panel, { qty: 1 });
      review = await openReview(panel);
      await review.getByTestId('order-submit').click();
      const unsent = panel.getByTestId('order-unsent');
      await expect(unsent).toBeVisible({ timeout: 20_000 });
      await expect(panel.getByTestId('order-unsent-size')).toContainText('1계약');
      await expect(panel.getByTestId('order-unsent-limit')).toContainText('Coin');
      await expect(panel.getByTestId('order-discard-warning')).toHaveText(copy.orderDiscardWarning);
      await page.unroute(intake);
      const original = held as { key: string; body: unknown } | null;
      if (original === null) throw new Error('the order was never sent');
      await page.request.post(ORDERS_PATH(market.id), {
        headers: { 'Idempotency-Key': original.key },
        data: original.body,
      });
      const replayed = page.waitForResponse(
        (response) =>
          response.url().endsWith(ORDERS_PATH(market.id)) && response.request().method() === 'POST',
      );
      await panel.getByTestId('order-resend').click();
      const answer = (await (await replayed).json()) as { data: { replayed: boolean } };
      expect(answer.data.replayed).toBe(true);
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'filled');
      expect((await ordersOn(page, market.id)).length).toBe(3);
      expect(sent.keys.at(-1)).toBe(original.key);

      // --- (f) 접수 중 until the answer: the server took the order and its fill reaches the page
      // (`market:trade`) before the answer does; the card then shows the server's row.
      await panel.getByTestId('order-new').click();
      const fillRows = page.getByTestId('market-fills').locator('[data-testid^="market-fill-"]');
      const fillsBefore = await dataOf<unknown[]>(
        await page.request.get(`/api/v1/markets/${market.id}/fills`),
      );
      let tookIt: (response: APIResponse) => void = () => undefined;
      const serverTook = new Promise<APIResponse>((resolve) => {
        tookIt = resolve;
      });
      let letAnswer: () => void = () => undefined;
      const answerHeld = new Promise<void>((resolve) => {
        letAnswer = resolve;
      });
      await page.route(intake, async (route) => {
        const response = await route.fetch();
        tookIt(response);
        await answerHeld;
        await route.fulfill({ response });
      });
      panel = await openPanel(page, 'YES');
      await fillOrder(panel, { qty: 1 });
      review = await openReview(panel);
      await review.getByTestId('order-submit').click();
      await serverTook;
      await expect(fillRows).toHaveCount(fillsBefore.length + 1, { timeout: 15_000 });
      await expect(panel.getByTestId('order-submitting')).toBeVisible();
      await expect(panel.getByTestId('order-submit')).toHaveAttribute('aria-busy', 'true');
      await expect(panel.getByTestId('order-result')).toHaveCount(0);
      letAnswer();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'filled');
      await expect(panel.getByTestId('order-result-filled-qty')).toContainText('1계약');
      await page.unroute(intake);
      expect((await ordersOn(page, market.id)).length).toBe(4);
    } finally {
      await cContext.close();
    }
  });

  test('마감 경합의 결과는 서버 행대로 보이고, 거래 중인데 호가가 마감을 말하면 입력이 꺼진다(ADR-0140 결정 2-16)', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const base: Order = {
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      marketId: market.id,
      marketSlug: market.slug,
      marketTitle: market.title,
      outcome: 'YES',
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
      status: 'rejected',
      rejectReason: 'closed',
      cancelReason: null,
      createdAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    const answers: Order[] = [
      base,
      // A limit order the close met after one fill: the rest expires (ADR-0115), its quantity
      // in `cancelledQty`, with no cancel reason.
      {
        ...base,
        filledQty: 1,
        filledAmountCoin: '40',
        cancelledQty: 1,
        status: 'expired',
        rejectReason: null,
        cancelReason: null,
      },
    ];
    const intake = `**${ORDERS_PATH(market.id)}`;
    await page.route(intake, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { order: answers.shift(), replayed: false } }),
      }),
    );
    await page.goto(`/markets/${market.slug}`);

    // A 마감 row: what the server decided at the fill instant.
    let panel = await openPanel(page, 'YES');
    await fillOrder(panel, { kind: 'gtc', qty: 2, limit: 40 });
    let review = await openReview(panel);
    await review.getByTestId('order-submit').click();
    await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'rejected');
    await expect(panel.getByTestId('order-result-reason')).toHaveText(copy.orderRejectClosed);
    // A fill before the close and the rest expired at it.
    await panel.getByTestId('order-new').click();
    panel = await openPanel(page, 'YES');
    review = await openReview(panel);
    await review.getByTestId('order-submit').click();
    await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'expired');
    await expect(panel.getByTestId('order-result-filled-qty')).toContainText('1계약');
    await expect(panel.getByTestId('order-result-cancelled')).toContainText('1계약');
    await page.unroute(intake);

    // Open, but the book says 마감 (the window before the worker's close): the input goes off.
    await page.route(`**/api/v1/markets/${market.id}/book`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            marketId: market.id,
            marketRejectReason: 'closed',
            contracts: [
              { outcome: 'YES', asks: [], bids: [], bestAskCoin: null, bestBidCoin: null },
              { outcome: 'NO', asks: [], bids: [], bestAskCoin: null, bestBidCoin: null },
            ],
          },
        }),
      }),
    );
    await page.reload();
    // No contract pressed: its buttons are off with the rest of the input.
    panel = await openPanel(page);
    await expect(panel.getByTestId('order-input-closed')).toHaveText(copy.marketBookReasonClosed);
    // The contract buttons name the reason where the price stands, not '호가 없음' (결정 2-23).
    await expect(panel.getByTestId('order-contract-yes')).toContainText(
      copy.orderClosedShortClosed,
    );
    await expect(panel.getByTestId('order-contract-yes')).not.toContainText(copy.marketBookEmpty);
    await expect(panel.getByTestId('order-qty')).toBeDisabled();
    await expect(panel.getByTestId('order-confirm-open')).toBeDisabled();
    // The button it turns off points at that line.
    const closedId = await panel.getByTestId('order-input-closed').getAttribute('id');
    expect(closedId).toBeTruthy();
    await expect(panel.getByTestId('order-confirm-open')).toHaveAttribute(
      'aria-describedby',
      closedId ?? '',
    );
  });
});
