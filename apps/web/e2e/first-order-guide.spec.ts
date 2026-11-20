import type { Locator, Page } from '@playwright/test';
import { copy } from '../src/copy';
import { createOpenMarket, expect, freshEmail, meOf, placeOrder, signUp, test } from './helpers';

/**
 * 첫 주문 안내 (#59, ADR-0154; owner answers 2026-11-21 #59-1~4) on 확인, with a fresh member M and
 * a counterparty C who makes a YES ask of 60 through the API (C's NO bid of 40). The guide is open
 * until M has an order the server took — a refused one does not count — and folded under 다시 보기
 * after; its topics follow the confirmed order's way. Both projects: the order column from md, the
 * sheet below it (order-panel.spec.ts's helpers, restated). The topic texts are the unit tests'
 * (lib/first-order-guide.test.ts).
 */

async function openPanel(page: Page): Promise<Locator> {
  let place: Locator;
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    place = page.getByTestId('order-area');
  } else {
    place = page.getByTestId('order-sheet');
    if (!(await place.isVisible())) await page.getByTestId('order-entry-yes').click();
  }
  await expect(place.getByTestId('order-panel')).toBeVisible();
  await place.getByTestId('order-contract-yes').click();
  return place;
}

/** A YES buy of one contract: immediate, or limit at `limit`; then 주문 확인. */
async function reviewBuy(panel: Locator, kind: 'ioc' | 'gtc', limit?: number): Promise<Locator> {
  await panel.getByTestId('order-side-buy').click();
  await panel.getByTestId(`order-kind-${kind}`).click();
  if (kind === 'ioc') await panel.getByTestId('order-size-qty').click();
  await panel.getByTestId('order-qty').fill('1');
  if (limit !== undefined) await panel.getByTestId('order-limit').fill(String(limit));
  await expect(panel.getByTestId('order-quote')).toBeVisible();
  await expect(panel.getByTestId('order-confirm-open')).toBeEnabled();
  await panel.getByTestId('order-confirm-open').click();
  const review = panel.getByTestId('order-review');
  await expect(review).toBeVisible();
  return review;
}

test.describe('첫 주문 안내 (#59)', () => {
  test('첫 주문이 접수될 때까지 확인 화면에 펼쳐 보이고(거절은 세지 않는다), 그 뒤에는 다시 보기로 연다', async ({
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
      await placeOrder(cPage.request, market.id, crypto.randomUUID(), {
        outcome: 'NO',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 40,
        qty: 1,
      });
      // A refused order first: a limit buy far above M's Coin ends 거절 and takes nothing.
      const refused = await placeOrder(page.request, market.id, crypto.randomUUID(), {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 99,
        qty: 1_000_000,
      });
      expect(refused.order.status).toBe('rejected');
      expect((await meOf(page.request)).firstOrderPlaced).toBe(false);

      await page.goto(`/markets/${market.slug}`);
      let panel = await openPanel(page);
      // An immediate buy: payout, partial fill and price protection — open, nothing to fold.
      let review = await reviewBuy(panel, 'ioc');
      let guide = review.getByTestId('first-order-guide');
      await expect(guide).toHaveAttribute('data-folded', 'false');
      await expect(guide.getByTestId('first-order-guide-toggle')).toHaveCount(0);
      await expect(guide.getByTestId('first-order-guide-body')).toBeVisible();
      for (const topic of ['payout', 'partial', 'protection']) {
        await expect(guide.getByTestId(`first-order-guide-${topic}`), topic).toBeVisible();
      }
      await expect(guide.getByTestId('first-order-guide-resting')).toHaveCount(0);
      await expect(guide.getByTestId('first-order-guide-protection')).toContainText(
        copy.orderMaxBuyPrice,
      );

      // Back to 수정 and a limit buy at 30 instead: payout, resting and partial fill.
      await review.getByTestId('order-review-edit').click();
      review = await reviewBuy(panel, 'gtc', 30);
      guide = review.getByTestId('first-order-guide');
      await expect(guide).toHaveAttribute('data-folded', 'false');
      for (const topic of ['payout', 'resting', 'partial']) {
        await expect(guide.getByTestId(`first-order-guide-${topic}`), topic).toBeVisible();
      }
      await expect(guide.getByTestId('first-order-guide-protection')).toHaveCount(0);
      // It rests: taken. The guide is done for this account.
      await review.getByTestId('order-submit').click();
      await expect(panel.getByTestId('order-result')).toHaveAttribute('data-status', 'open');
      expect((await meOf(page.request)).firstOrderPlaced).toBe(true);

      // The next 확인 folds it under 다시 보기, which opens the same topics.
      await panel.getByTestId('order-new').click();
      panel = await openPanel(page);
      review = await reviewBuy(panel, 'gtc', 30);
      guide = review.getByTestId('first-order-guide');
      await expect(guide).toHaveAttribute('data-folded', 'true');
      await expect(guide.getByTestId('first-order-guide-body')).toBeHidden();
      const toggle = guide.getByTestId('first-order-guide-toggle');
      await expect(toggle).toHaveText(copy.firstOrderGuideShow);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveText(copy.firstOrderGuideHide);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(guide.getByTestId('first-order-guide-body')).toBeVisible();
      await expect(guide.getByTestId('first-order-guide-resting')).toBeVisible();
    } finally {
      await cContext.close();
    }
  });
});
