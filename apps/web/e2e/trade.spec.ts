import { copy } from '../src/copy';
import {
  DASH,
  QUOTE_TIMEOUT_MS,
  chargeOnce,
  createOpenMarket,
  ensureChargePackage,
  expect,
  freshEmail,
  openTradeForm,
  signUp,
  test,
} from './helpers';

/**
 * 매수 패널 (PLAN 13 M4): AC 3 견적 → 확인 → 토스트·잔고 칩·포지션, AC 4 잔고 부족, AC 7 가입
 * → 충전 → 매수 → 포트폴리오.
 *
 * Both tests trade on a market this run created and opened, never on a seeded one: a seeded
 * market keeps `status: 'open'` past its absolute close time and answers every trade with
 * MARKET_CLOSED (A-M3-31), which would turn this suite red on a date nobody would connect to
 * the panel.
 *
 * Every trade-panel selector goes through the prefix `openTradeForm` answers. Below `md` the
 * inline card is still mounted behind `display: none` while the sheet is open, so both id sets
 * are in the DOM and a bare `trade-value` matches two fields — which is also why one spec is
 * enough for both projects: it reads the panel the viewport actually shows.
 */

test.describe('매수 패널', () => {
  test('AC 3 · AC 7: 가입 → 충전 → 매수 → 토스트 · 잔고 칩 · 포지션 · 포트폴리오', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await ensureChargePackage(admin);

    await signUp(page, freshEmail());
    await chargeOnce(page);

    await page.goto(`/markets/${market.slug}`);
    const prefix = await openTradeForm(page, 'YES');

    // --- AC 3, first half: 금액 입력 → 견적. The rows exist before there is anything to price
    // and read as an em dash, so "a quote appeared" is the dash being replaced — not the row
    // becoming visible. The wall clock is deliberately not asserted: the 300ms is the input
    // debounce (PLAN 11.4), and the round trip after it cannot fit inside the same 300ms.
    const shares = page.getByTestId(`${prefix}-summary-shares`);
    await expect(shares).toHaveText(DASH);
    await page.getByTestId(`${prefix}-value`).fill('5000');
    await expect(shares).not.toHaveText(DASH, { timeout: QUOTE_TIMEOUT_MS });
    // The slippage allowance is disclosed as an absolute amount, always on screen (ADR-0031).
    await expect(page.getByTestId(`${prefix}-summary-guard`)).not.toHaveText(DASH);

    const balance = page.getByTestId('balance-chip');
    await expect(balance).toBeVisible();
    const beforeBalance = (await balance.textContent()) ?? '';

    // --- AC 3, second half: 확인 → 토스트 + 잔고 칩 갱신 + 포지션 표시. No confirmation modal:
    // the summary is above the button and the button carries the number (ADR-0031).
    await page.getByTestId(`${prefix}-submit`).click();
    await expect(page.getByText(copy.tradeBought)).toBeVisible();
    await expect(balance).not.toHaveText(beforeBalance);
    await expect(page.getByTestId('market-position-yes')).toBeVisible();

    // --- AC 7: the same holding on 포트폴리오, keyed by market and outcome.
    await page.goto('/portfolio');
    await expect(page.getByTestId(`portfolio-position-${market.id}-YES`)).toBeVisible();
  });

  test('AC 4: 잔고가 모자라면 충전하기 링크가 /wallet으로 간다', async ({ admin, page }) => {
    const market = await createOpenMarket(admin);

    // No 충전 here: the account has nothing but the sign-up bonus (10,000P, migration 0004),
    // so a 20,000P intent is short by construction whatever the market's price is.
    await signUp(page, freshEmail());
    await page.goto(`/markets/${market.slug}`);
    const prefix = await openTradeForm(page, 'YES');
    await page.getByTestId(`${prefix}-value`).fill('20000');

    const charge = page.getByTestId(`${prefix}-charge`);
    await expect(charge).toBeVisible({ timeout: QUOTE_TIMEOUT_MS });
    await expect(charge).toHaveText(copy.tradeCharge);
    // It replaces the submit button rather than sitting beside it: there is nothing to press
    // that could work (trade-panel.ts `tradeCta`).
    await expect(page.getByTestId(`${prefix}-submit`)).toHaveCount(0);

    // A real link, so it works with a middle click and without JavaScript.
    await expect(charge).toHaveAttribute('href', '/wallet');
    await charge.click();
    await expect(page).toHaveURL('/wallet');
  });
});
