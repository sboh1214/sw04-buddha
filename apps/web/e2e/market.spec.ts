import { type Locator, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  REALTIME_BUDGET_MS,
  adminAccount,
  closeMarket,
  createOpenMarket,
  expect,
  signIn,
  subscribed,
  test,
} from './helpers';

/**
 * 시장 상세 (PLAN 13 M4): AC 1 실시간, AC 2 SSR 첫 페인트, AC 5 375px 레이아웃, plus the
 * accessibility readings AC 6 can actually be held to in a browser (the Lighthouse number
 * itself is a manual run recorded in ADR-0032).
 *
 * There is no way to trade until the CLOB lands (#119, #66; D13): a market here has no fill, so
 * its price reads 체결 없음, its chart is empty (N02 §5) and its order area says 거래 준비 중.
 * What a fill moves — the live price, the chart's line and its keyboard readout — comes back
 * with the order panel and its screen tests (#189).
 *
 * Every test creates its own market through the admin API, so nothing here depends on which
 * markets `pnpm db:seed` wrote or on what today's date does to their close times (A-M3-31).
 */

/**
 * The window property a reload would wipe. AC 1 says "리프레시 없이", and the only way to
 * assert that is to prove the document the assertion ran against is the one that was there
 * before the change.
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
 * `position: fixed` element every few runs, while the DOM rect is stable and correct. The rect
 * is also the more honest reading of what this test asserts, which is where the element sits on
 * the first screen.
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

/** A box inside a card that is in normal flow (not `position: fixed`, unlike `boxOf`'s). */
async function boxIn(scope: Locator, testId: string) {
  const box = await scope.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} has no bounding box`);
  return box;
}

test.describe('시장 상세', () => {
  test('AC 2: 첫 응답 HTML에 질문·가격·규칙이 들어 있다', async ({ admin, request }) => {
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

    // 질문 — a client component now (`LiveQuestionHeading`, so an admin's title edit reaches
    // the heading the way it already reaches the chart label), which is why this assertion
    // is the guard and not a formality: it renders inside the page's HydrationBoundary and
    // falls back to the row the server fetched (`?? fallback`). Move it above the boundary
    // and the seed is not there yet — measured, that also strips 시장가격 and the chart out of
    // this same HTML. Delete the fallback and this line goes red.
    expect(html).toContain(market.title);
    expect(html).toContain('data-testid="market-detail-question"');

    // 가격 — hydrated from the seeded `['market', id]` entry, so it reaches the HTML too. With no
    // fill it is 체결 없음 (N02 §5), and no opening setting may stand in for it: the 50% a
    // direct-AMM market used to open at must not be anywhere on the page (#125).
    expect(html).toContain(copy.noFills);
    expect(html).not.toContain(`${copy.yes} 50%`);

    // rules — never collapsed, and never behind a cache BRANCH (PLAN 11.1's Kalshi
    // principle). `LiveRulesSection` is a client component now, which is fine: it renders
    // inside the page's HydrationBoundary and falls back to the row the server fetched
    // (`?? fallback`), so this holds whether or not the seeded query is readable. Delete
    // that fallback and this assertion goes red, which is why it is not optional polish.
    // The heading as an element: '규칙' alone is a word other text on the page could carry.
    expect(html).toMatch(new RegExp(`<h2[^>]*>${copy.rulesSectionTitle}</h2>`));
    expect(html).toContain(market.rules);

    /*
     * The chart is in the first paint, and with no fill it is the 체결 없음 state rather than a
     * line: opening writes no price tick (N02 §5). The SVG-geometry check that pinned the
     * zero-dependency decision (ADR-0032) needs a fill to draw, so it returns with the order
     * panel (#189).
     */
    expect(html).toContain('data-testid="probability-chart"');
    expect(html).toContain('data-testid="probability-chart-empty"');

    // 주문 영역 of an open market: 거래 준비 중 where the direct-AMM trade panel was (owner
    // decision #125 (a)), and nothing of that panel left to quote or trade with.
    expect(html).toContain('data-testid="order-area-notice"');
    expect(html).toContain(copy.tradePreparing);
    expect(html).not.toContain('data-testid="trade-');
  });

  test('AC 1: 관리자의 마감이 B의 상세와 홈 카드, C의 검색 결과 카드를 1초 안에, 리프레시 없이 갱신한다', async ({
    browser,
    admin,
  }) => {
    // The change used to be A's buy; with no way to trade (#125) it is the admin's 마감, which
    // reaches the readers through the same rooms as `market:status`. In a category no other spec
    // opens markets in (helpers.ts `topLevelCategory`), so B finds it on the home's 신규.
    const market = await createOpenMarket(admin, { topLevelCategory: 3 });

    // B reads while signed in as another account (the seed admin — a second mailbox round trip
    // would buy nothing here); C reads with no cookie at all.
    const readerContext = await browser.newContext();
    const anonymousContext = await browser.newContext();
    try {
      const detailB = await readerContext.newPage();
      await signIn(detailB, adminAccount.email, adminAccount.password);
      // Armed BEFORE the navigation: the socket opens during the load, and a spec that changes
      // the market before the room is joined would be measuring the connect gap, not the gateway.
      const detailBJoined = subscribed(detailB, market.id);
      await detailB.goto(`/markets/${market.slug}`);
      await detailBJoined;

      // B reads the HOME: its list is the server's prefetch, dehydrated and hydrated under the
      // home's key, and that entry has to take the socket's writes. The market was opened last in
      // its category, so the home's 신규 of that category has it on the first page whatever else
      // the database holds (`/?q=<tag>` until the home stopped reading `q`, ADR-0066). C reads
      // the search screen, whose first page is the server's read too, hydrated under the search's
      // own key (owner decision 2026-10-16, ADR-0066): `/search?q=<tag>` holds exactly this card.
      const listB = await readerContext.newPage();
      const listBJoined = subscribed(listB, market.id);
      await listB.goto(`/?category=${market.categorySlug}&sort=newest`);
      await listBJoined;

      const listC = await anonymousContext.newPage();
      const listCJoined = subscribed(listC, market.id);
      await listC.goto(`/search?q=${market.tag}`);
      await listCJoined;

      const statusB = detailB.getByTestId('market-status-badge');
      const cardB = listB.getByTestId(`market-card-${market.id}`);
      const cardC = listC.getByTestId(`market-card-${market.id}`);
      await expect(statusB).toHaveText(copy.marketStatusOpen);
      // Open, so the order area is there, saying 거래 준비 중 and nothing else.
      await expect(detailB.getByTestId('order-area-notice')).toHaveText(copy.tradePreparing);
      // An open card names no status — its countdown is its state — and has no fill to price:
      // its YES and NO rows stay, '—' in each pill, with 체결 없음 beside them (ADR-0048).
      await expect(cardB.getByTestId('market-card-no-fills')).toHaveText(copy.noFills);
      await expect(cardB.getByTestId('market-card-probability')).toHaveText('—');
      await expect(cardB.getByTestId('market-card-probability-no')).toHaveText('—');
      await expect(cardB.getByRole('progressbar')).toHaveCount(0);
      // Laid out as the rows of a priced card: one pill per row on one right edge, and 체결 없음
      // to the left of them rather than pushing a pill onto a row of its own.
      const [yesPill, noPill, noFills] = await Promise.all([
        boxIn(cardB, 'market-card-probability'),
        boxIn(cardB, 'market-card-probability-no'),
        boxIn(cardB, 'market-card-no-fills'),
      ]);
      expect(noPill.y).toBeGreaterThanOrEqual(yesPill.y + yesPill.height);
      expect(noPill.x).toBeCloseTo(yesPill.x, 0);
      expect(noFills.x + noFills.width).toBeLessThanOrEqual(yesPill.x);
      await expect(cardB).not.toContainText(copy.marketStatusClosed);
      await expect(cardC).not.toContainText(copy.marketStatusClosed);

      const balanceB = detailB.getByTestId('balance-chip');
      await expect(balanceB).toBeVisible();
      const beforeBalanceB = (await balanceB.textContent()) ?? '';
      for (const reader of [detailB, listB, listC]) {
        await markDocument(reader);
      }

      await closeMarket(admin, market.id);

      // --- the criterion. The three readers were sent one `market:status` at the same instant,
      // so the budget is spent by the first assertion and the others are already satisfied.
      await expect(statusB).toHaveText(copy.marketStatusClosed, { timeout: REALTIME_BUDGET_MS });
      await expect(cardB).toContainText(copy.marketStatusClosed, { timeout: REALTIME_BUDGET_MS });
      await expect(cardC).toContainText(copy.marketStatusClosed, { timeout: REALTIME_BUDGET_MS });

      // A market that is not open has no order area at all: the status notice says what it is.
      await expect(detailB.getByTestId('market-status-notice')).toContainText(
        copy.marketClosedNotice,
      );
      await expect(detailB.getByTestId('order-area')).toHaveCount(0);

      for (const reader of [detailB, listB, listC]) {
        expect(await documentSurvived(reader), reader.url()).toBe(true);
      }

      // Nothing personal crosses a room: B still shows B's own balance, and C — which never
      // sent a cookie — is offered 로그인 rather than a balance at all.
      await expect(balanceB).toHaveText(beforeBalanceB);
      await expect(listC.getByTestId('balance-chip')).toHaveCount(0);
      await expect(listC.getByRole('link', { name: copy.login })).toBeVisible();
    } finally {
      await anonymousContext.close();
      await readerContext.close();
    }
  });

  test('차트: 기간 라디오 · 체결 없음', async ({ admin, page }) => {
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);

    const chart = page.getByTestId('probability-chart');
    // 1일 / 1주 / 전체 as real radios inside a named group, not three styled divs.
    await expect(page.getByTestId('chart-range').getByRole('radio')).toHaveCount(3);
    // Fills only (N02 §5): a market nobody has traded draws no line, not a flat one at the
    // opening setting. The named line and its keyboard readout need a fill (#189).
    await expect(chart.getByTestId('probability-chart-empty')).toHaveText(copy.noFills);
    await expect(chart.getByTestId('probability-chart-line')).toHaveCount(0);
    await expect(page.getByTestId('chart-readout')).toHaveText('');
  });
});

/**
 * The card's contents (#61, ADR-0062): what ADR-0061 put on it and what it took off. Runs in both
 * projects, so the footer line is measured at 375px and at 1280px.
 */
test.describe('시장 카드', () => {
  test('YES·NO 두 줄과 참여자 0, 배수·거래량·추이 선은 없다', async ({ admin, page }) => {
    const market = await createOpenMarket(admin);
    // `/search?q=<tag>` holds exactly this market's card (`/?q=` until ADR-0066).
    await page.goto(`/search?q=${market.tag}`);
    const card = page.getByTestId(`market-card-${market.id}`);

    // No fill yet: both rows stay with '—' in each pill and 체결 없음 once (ADR-0048).
    await expect(card.getByTestId('market-card-probability')).toHaveText('—');
    await expect(card.getByTestId('market-card-probability-no')).toHaveText('—');
    await expect(card.getByTestId('market-card-no-fills')).toHaveText(copy.noFills);

    // The participant count, and a 0 is written as 0 rather than hidden (ADR-0061 decision 1,
    // item 4), in the detail header's spelling.
    const traders = card.getByTestId('market-card-traders');
    await expect(traders).toHaveText(`${copy.marketTraders} 0`);

    // What the card no longer draws: no 거래량 and no price trend line (ADR-0061 decision 1,
    // item 4) — both were on every card, priced or not, so these two fail on the old one.
    // The payout multiple ('1.59x', O-21) is checked here too, but that line proves nothing yet:
    // a card with no fill never showed one (ADR-0048) and an e2e market cannot get a fill until
    // the order path exists (#119, #189). What pins its removal today is the source scan in
    // lib/market-card.test.ts; this line starts to count once a spec can trade.
    await expect(card).not.toContainText(/\d\.\d{2}x/);
    await expect(card).not.toContainText(copy.marketVolume);
    await expect(card.getByTestId('market-card-volume')).toHaveCount(0);
    await expect(card.getByTestId('market-card-sparkline')).toHaveCount(0);

    // The footer is one line under the two rows and inside the tile, and the page does not
    // scroll sideways at either width.
    const [cardBox, noPill, footer] = await Promise.all([
      card.boundingBox(),
      boxIn(card, 'market-card-probability-no'),
      boxIn(card, 'market-card-traders'),
    ]);
    if (cardBox === null) throw new Error('the card has no bounding box');
    expect(footer.y).toBeGreaterThanOrEqual(noPill.y + noPill.height);
    expect(footer.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(footer.x + footer.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    expect(footer.y + footer.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
    // One line: two glyph runs share a line when their vertical extents overlap (coin.spec.ts).
    const lines = await traders.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const found: { top: number; bottom: number }[] = [];
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        const line = found.find((l) => rect.top < l.bottom && rect.bottom > l.top);
        if (line === undefined) found.push({ top: rect.top, bottom: rect.bottom });
      }
      return found.length;
    });
    expect(lines).toBe(1);
    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  });
});

/**
 * AC 5 is a statement about a 375px viewport, not about a project: pinning the size here runs
 * the measurement in both projects and keeps it true even if the project list changes.
 */
test.describe('시장 상세 · 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('AC 5: 스크롤 없이 가격과 하단 탭이 보인다', async ({ admin, page }) => {
    // The fixed YES/NO bar this used to measure went with the trade panel (#125); the tab bar
    // takes the bottom of the screen on this route like on every other, and the order area is
    // an ordinary block further down saying 거래 준비 중.
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);

    await expect(page.getByTestId('market-probability')).toBeVisible();
    await expect(page.getByTestId('bottom-tabs')).toBeVisible();
    await expect(page.getByTestId('trade-bar')).toHaveCount(0);

    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport size');
    // Nothing was scrolled to get here, so a bounding box IS the position on the first screen.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    for (const testId of ['market-probability', 'bottom-tabs']) {
      const box = await boxOf(page, testId);
      expect(box.y, testId).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, testId).toBeLessThanOrEqual(viewport.height);
    }

    await expect(page.getByTestId('order-area-notice')).toHaveText(copy.tradePreparing);
  });
});
