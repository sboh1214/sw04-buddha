import { type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  REALTIME_BUDGET_MS,
  adminAccount,
  buyThroughPanel,
  chargeOnce,
  createOpenMarket,
  ensureChargePackage,
  expect,
  freshEmail,
  signIn,
  signUp,
  subscribed,
  test,
} from './helpers';

/**
 * 시장 상세 (PLAN 13 M4): AC 1 실시간, AC 2 SSR 첫 페인트, AC 5 375px 레이아웃, plus the
 * accessibility readings AC 6 can actually be held to in a browser (the Lighthouse number
 * itself is a manual run recorded in ADR-0032).
 *
 * Every test creates its own market through the admin API, so nothing here depends on which
 * markets `pnpm db:seed` wrote or on what today's date does to their close times (A-M3-31).
 */

/**
 * The window property a reload would wipe. AC 1 says "리프레시 없이", and the only way to
 * assert that is to prove the document the assertion ran against is the one that was there
 * before the trade.
 */
const NO_RELOAD_MARKER = 'buddhaE2eNoReload';

async function markDocument(page: Page): Promise<void> {
  await page.evaluate((key) => {
    (window as unknown as Record<string, boolean>)[key] = true;
  }, NO_RELOAD_MARKER);
}

function documentSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, boolean | undefined>)[key] === true,
    NO_RELOAD_MARKER,
  );
}

/**
 * The element's box in viewport coordinates, or a failure that names which element had none.
 *
 * `getBoundingClientRect()` in the page rather than `locator.boundingBox()`: under the
 * mobile-375 project (`isMobile: true`) the CDP box-model read answers null for a
 * `position: fixed` element every few runs, while the DOM rect is stable and correct — the
 * bar measured 375x812 sits at y 756 with height 44 on every sample. The rect is also the
 * more honest reading of what this test asserts, which is where the element sits on the
 * first screen.
 */
async function boxOf(page: Page, testId: string) {
  const box = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0
      ? null
      : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, testId);
  if (box === null) throw new Error(`${testId} has no bounding box`);
  return box;
}

test.describe('시장 상세', () => {
  test('AC 2: 첫 응답 HTML에 질문·확률·정산 기준이 들어 있다', async ({ admin, request }) => {
    const market = await createOpenMarket(admin);

    /*
     * The RESPONSE body, not `page.content()`: the second is the DOM after hydration, which is
     * exactly the thing this criterion exists to rule out ("view-source 확인"). The `request`
     * fixture carries no session cookie either, so this is also the anonymous visitor's HTML —
     * `api.server.ts` forwards no cookie and `dehydratePublic` drops every private root, so a
     * signed-in one is byte-identical.
     */
    const response = await request.get(`/markets/${market.slug}`);
    expect(response.status()).toBe(200);
    const html = await response.text();

    // 질문 — rendered by the server component itself, outside any cache-dependent branch.
    expect(html).toContain(market.title);
    expect(html).toContain('data-testid="market-detail-question"');

    // 확률 — hydrated from the seeded `['market', id]` entry, so it reaches the HTML too:
    // "예 50%" from the rolling number's readable copy, "50.00%" beside it.
    expect(html).toContain(`${copy.yes} ${String(market.lastPrice)}%`);
    expect(html).toContain(`${(market.pYesBp / 100).toFixed(2)}%`);

    // rules — never collapsed, and never behind a cache BRANCH (PLAN 11.1's Kalshi
    // principle). `LiveRulesSection` is a client component now, which is fine: it renders
    // inside the page's HydrationBoundary and falls back to the row the server fetched
    // (`?? fallback`), so this holds whether or not the seeded query is readable. Delete
    // that fallback and this assertion goes red, which is why it is not optional polish.
    expect(html).toContain(copy.rulesSectionTitle);
    expect(html).toContain(market.rules);

    /*
     * The chart is in the first paint as SVG geometry, not as a client-only mount. `d="M` is
     * what pins the zero-dependency decision (ADR-0032): recharts' ResponsiveContainer and
     * visx-responsive render nothing before they have measured the DOM, and uPlot is a canvas,
     * so none of them could put a path in this string.
     */
    expect(html).toContain('data-testid="probability-chart"');
    expect(html).toContain('d="M');
  });

  test('AC 1: A의 매수가 B의 상세와 홈 카드를 1초 안에, 리프레시 없이 갱신한다', async ({
    browser,
    admin,
  }) => {
    const market = await createOpenMarket(admin);
    await ensureChargePackage(admin);

    // B reads while signed in as another account (the seed admin — a second mailbox round trip
    // would buy nothing here); C reads with no cookie at all.
    const readerContext = await browser.newContext();
    const anonymousContext = await browser.newContext();
    const traderContext = await browser.newContext();
    try {
      const detailB = await readerContext.newPage();
      await signIn(detailB, adminAccount.email, adminAccount.password);
      // Armed BEFORE the navigation: the socket opens during the load, and a spec that trades
      // before the room is joined would be measuring the connect gap, not the gateway.
      const detailBJoined = subscribed(detailB, market.id);
      await detailB.goto(`/markets/${market.slug}`);
      await detailBJoined;

      // `?q=<tag>` is a home page holding exactly this market's card, whatever else the
      // database contains and whichever way the default 거래량 sort would have ranked it.
      const homeB = await readerContext.newPage();
      const homeBJoined = subscribed(homeB, market.id);
      await homeB.goto(`/?q=${market.tag}`);
      await homeBJoined;

      const homeC = await anonymousContext.newPage();
      const homeCJoined = subscribed(homeC, market.id);
      await homeC.goto(`/?q=${market.tag}`);
      await homeCJoined;

      const probabilityB = detailB.getByTestId('market-probability-value');
      const cardB = homeB
        .getByTestId(`market-card-${market.id}`)
        .getByTestId('market-card-probability');
      const cardC = homeC
        .getByTestId(`market-card-${market.id}`)
        .getByTestId('market-card-probability');
      await expect(probabilityB).toBeVisible();
      await expect(cardB).toBeVisible();
      await expect(cardC).toBeVisible();

      const balanceB = detailB.getByTestId('balance-chip');
      await expect(balanceB).toBeVisible();
      const beforeProbability = (await probabilityB.textContent()) ?? '';
      const beforeCardB = (await cardB.textContent()) ?? '';
      const beforeCardC = (await cardC.textContent()) ?? '';
      const beforeBalanceB = (await balanceB.textContent()) ?? '';
      for (const reader of [detailB, homeB, homeC]) {
        await markDocument(reader);
      }

      // --- A: 가입 → 충전 → 매수. 5,000P on a b=10,000 market is 50% → ~66%.
      const trader = await traderContext.newPage();
      await signUp(trader, freshEmail());
      await chargeOnce(trader);
      await trader.goto(`/markets/${market.slug}`);
      await buyThroughPanel(trader, 'YES', '5000');

      // --- the criterion. The three readers were sent one `market:tick` at the same instant,
      // so the budget is spent by the first assertion and the others are already satisfied.
      await expect(probabilityB).not.toHaveText(beforeProbability, {
        timeout: REALTIME_BUDGET_MS,
      });
      await expect(cardB).not.toHaveText(beforeCardB, { timeout: REALTIME_BUDGET_MS });
      await expect(cardC).not.toHaveText(beforeCardC, { timeout: REALTIME_BUDGET_MS });

      for (const reader of [detailB, homeB, homeC]) {
        expect(await documentSurvived(reader), reader.url()).toBe(true);
      }

      // Nothing personal crosses a room: B still shows B's own balance, and C — which never
      // sent a cookie — is offered 로그인 rather than a balance at all.
      await expect(balanceB).toHaveText(beforeBalanceB);
      await expect(homeC.getByTestId('balance-chip')).toHaveCount(0);
      await expect(homeC.getByRole('link', { name: copy.login })).toBeVisible();
    } finally {
      await traderContext.close();
      await anonymousContext.close();
      await readerContext.close();
    }
  });

  test('차트: 이름 있는 그래픽 · 기간 라디오 · 키보드 읽기', async ({ admin, page }) => {
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);

    // The series is a `role="img"` whose name is 확률 추이 + the question + the spoken summary,
    // so a screen reader gets the shape of the line and not just "graphic".
    const chart = page.getByTestId('probability-chart');
    await expect(chart.getByRole('img', { name: new RegExp(copy.chartLabel) })).toBeVisible();
    // 1일 / 1주 / 전체 as real radios inside a named group, not three styled divs.
    await expect(page.getByTestId('chart-range').getByRole('radio')).toHaveCount(3);

    // The plot is focusable and readable without a pointer: an arrow moves the readout, Escape
    // clears it (probability-chart.tsx `onKeyDown`).
    //
    // Wait for the LINE, not just the figure: the `role="img"` and its focusable plot exist
    // while the series is still in flight, and an arrow pressed then is deliberately a no-op
    // (there is no point to read yet), so pressing too early would assert against an empty
    // series rather than against the keyboard. The mobile project is slow enough to lose
    // that race on most runs.
    await expect(chart.getByTestId('probability-chart-line')).toBeVisible();
    const readout = page.getByTestId('chart-readout');
    await expect(readout).toHaveText('');
    await chart.locator('[tabindex="0"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(readout).not.toHaveText('');
    await page.keyboard.press('Escape');
    await expect(readout).toHaveText('');
  });
});

/**
 * AC 5 is a statement about a 375px viewport, not about a project: pinning the size here runs
 * the measurement in both projects and keeps it true even if the project list changes.
 */
test.describe('시장 상세 · 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('AC 5: 스크롤 없이 확률과 예/아니오 버튼이 보인다', async ({ admin, page }) => {
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);

    await expect(page.getByTestId('market-probability')).toBeVisible();
    await expect(page.getByTestId('trade-bar-yes')).toBeVisible();
    await expect(page.getByTestId('trade-bar-no')).toBeVisible();

    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport size');
    // Nothing was scrolled to get here, so a bounding box IS the position on the first screen.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    for (const testId of ['market-probability', 'trade-bar-yes', 'trade-bar-no']) {
      const box = await boxOf(page, testId);
      expect(box.y, testId).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, testId).toBeLessThanOrEqual(viewport.height);
    }
  });
});
