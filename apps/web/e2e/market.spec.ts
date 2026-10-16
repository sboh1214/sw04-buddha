import { type Locator, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  REALTIME_BUDGET_MS,
  adminAccount,
  closeMarket,
  createOpenMarket,
  detailCopyTestId,
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
 * its price reads 체결 없음, its chart is empty (N02 §5) and its order area says 거래 준비 중 — the
 * desktop column, and below md the sheet its YES 매수 · NO 매수 bar opens for a member, a sign-in
 * prompt in that sheet for a signed-out visitor (#122, ADR-0067).
 * What a real fill moves — the live price, the chart's line and its keyboard readout — comes back
 * with the order panel and its screen tests (#189); the priced header alone (YES, its move's
 * badge, the NO complement) is drawn here from the API's answers with a price put in.
 *
 * The frame itself (#122): N02 §4's order at each width, the two columns from md up, the mobile
 * 호가·거래 내역 switch, the 매수 bar on the tab bar and its sheet, the 준비 중 slots, which of
 * them only a signed-in reader gets and the one sign-in prompt a visitor gets instead — '시장 상세 ·
 * 375px', '시장 상세 · 1280px' and '시장 상세 · 상태와 로그인' below.
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
    const background = `배경 문단 ${String(Date.now())}`;
    const market = await createOpenMarket(admin, { description: background });

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
    // …and 체결 없음 is the header's one reading: no NO complement beside it, since there is no
    // fill to take 100 − YES of (ADR-0061 decision 1, item 2; #122).
    expect(html).not.toContain('data-testid="market-probability-no"');

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

    /*
     * The frame (#122). 배경 is the server's too, as plain text under its heading. The mobile
     * 매수 bar is in the HTML of an open market with its two entry points and no price on either;
     * its sheet is not (it mounts on a press). The public 준비 중 slots are there — 공개 판정 기록,
     * like 배경 and 규칙, once for each width's place, since the two widths draw them in different
     * places and each reads its own copy where it is drawn (ADR-0067); CSS shows one. The personal
     * areas — 내 포지션, 내 거래, 내 대기 주문 — never are, for nobody, and neither is the one
     * sign-in prompt a signed-out visitor gets in their place (owner decision 2026-10-17): the
     * admin context's HTML below carries a session cookie and must hold no more than the
     * anonymous one, and the anonymous one no more than the admin's (ADR-0061 decision 1, item 18).
     */
    expect(html).toMatch(new RegExp(`<h2[^>]*>${copy.marketBackground}</h2>`));
    expect(html).toContain(background);
    expect(html).toContain('data-testid="order-entry-bar"');
    expect(html).toMatch(/data-testid="order-entry-yes"[^>]*>YES 매수</);
    expect(html).toMatch(/data-testid="order-entry-no"[^>]*>NO 매수</);
    expect(html).not.toContain('data-testid="order-sheet');
    // …and 관련 시장 (#65) after them, public too and one shared section at both widths, with its
    // notice for a market nothing is linked to.
    for (const slot of ['market-order-book', 'market-discussion', 'market-related']) {
      expect(html, slot).toContain(`data-testid="${slot}"`);
    }
    expect(html).toContain(copy.marketRelatedEmpty);
    for (const width of ['md', 'base']) {
      for (const section of ['market-background', 'market-rules', 'market-judging-record']) {
        expect(html, `${section}-${width}`).toContain(`data-testid="${section}-${width}"`);
      }
    }
    const memberHtml = await (await admin.get(`/markets/${market.slug}`)).text();
    for (const page of [html, memberHtml]) {
      expect(page).not.toContain('data-testid="market-my-position"');
      expect(page).not.toContain('data-testid="market-my-trades"');
      expect(page).not.toContain('data-testid="market-my-open-orders"');
      expect(page).not.toContain('data-testid="market-personal-signed-out');
      expect(page).not.toContain(copy.marketPersonalSignedOut);
    }
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
      // Open, so the order area is there, saying 거래 준비 중 and nothing else — the desktop
      // column and, below md, the 매수 bar (each in the DOM at both widths, drawn at one).
      await expect(detailB.getByTestId('order-area-notice')).toHaveText(copy.tradePreparing);
      await expect(detailB.getByTestId('order-entry-bar')).toHaveCount(1);
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
      // The 매수 bar leaves with the column (#122, ADR-0048).
      await expect(detailB.getByTestId('market-status-notice')).toContainText(
        copy.marketClosedNotice,
      );
      await expect(detailB.getByTestId('order-area')).toHaveCount(0);
      await expect(detailB.getByTestId('order-entry-bar')).toHaveCount(0);

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

  test('상세 머리의 가격: 체결이 없으면 체결 없음 한 번이고 NO 보완값은 없다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();

    // The header says 체결 없음 and nothing else — no 'NO —' row like the card's, no NO reading
    // at all (#122): the NO complement is 100 − YES of a fill there is not. Once a fill exists
    // the reading appears beside YES (the next test).
    const reading = page.getByTestId('market-probability');
    await expect(reading).toHaveText(copy.noFills);
    await expect(reading.getByTestId('market-probability-value')).toHaveText(copy.noFills);
    await expect(page.getByTestId('market-probability-no')).toHaveCount(0);
    await expect(page.getByTestId('market-summary')).not.toContainText(`${copy.no} `);
  });

  test('상세 머리의 가격: 체결이 있으면 YES 옆에 그 변화 배지, 아래 줄에 NO 보완값이 누를 수 없는 글자로 있고, 배지가 사라져도 NO는 그 자리다', async ({
    admin,
    page,
  }) => {
    /*
     * No spec can make a fill before the order path exists (#189), so the browser's own reads of
     * this market are answered with the API's real answers and a price put in: the row is at 63%
     * after two trades, and its 1D series has the last move, 61 → 63. The server's HTML stays the
     * real, unpriced one. The price arrives the way an admin's edit reaches an open detail: the
     * edit publishes `market:status`, and the reader refetches the row and every range of its
     * series (realtime-provider.tsx) — the two requests these routes answer. `joinMarket` and
     * `joinSeries` take both, since two trades supersede none.
     */
    const market = await createOpenMarket(admin);
    const rowPath = `/api/v1/markets/${market.id}`;
    await page.route(
      (url) => url.pathname === rowPath,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: object };
        await route.fulfill({
          response,
          json: { ...body, data: { ...body.data, lastPrice: 63, tradeCount: 2 } },
        });
      },
    );
    await page.route(
      (url) => url.pathname === `${rowPath}/ticks`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: { to: string } };
        const to = Date.parse(body.data.to);
        const fill = (agoMs: number, pYesBp: number) => ({
          ts: new Date(to - agoMs).toISOString(),
          pYesBp,
          trigger: 'trade',
        });
        await route.fulfill({
          response,
          json: {
            ...body,
            data: {
              ...body.data,
              tradeCount: 2,
              points: [fill(120_000, 6100), fill(60_000, 6300)],
            },
          },
        });
      },
    );
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    await expect(page.getByTestId('watch-button')).toBeVisible();
    const edited = await admin.patch(`/api/v1/admin/markets/${market.id}`, {
      data: { description: '가격을 다시 읽게 하는 편집' },
    });
    expect(edited.ok(), await edited.text()).toBe(true);

    const reading = page.getByTestId('market-probability');
    const yes = reading.getByTestId('market-probability-value');
    const badge = reading.getByTestId('market-probability-delta');
    const no = reading.getByTestId('market-probability-no');
    // YES and its display complement together (ADR-0061 decision 1, item 2). The rolling figure's
    // digit stacks are `aria-hidden`; its words are the visually hidden label beside them.
    await expect(yes.getByText(`${copy.yes} 63%`, { exact: true })).toHaveCount(1);
    await expect(no).toHaveText(`${copy.no} 37%`);
    // The badge lives five seconds (PLAN 11.4), so it is read as soon as it is up.
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('+2%p');

    // The badge is YES's move, so it stands right after the YES figure on the YES line, and NO has
    // the line under it (owner decision 2026-10-17, 'NO를 아래 줄로'): a badge after 'NO 37%' reads
    // as NO's own move, which went the other way, and NO beside the badge moved over each time it
    // came and went.
    const order = await reading.evaluate((root) =>
      Array.from(root.querySelectorAll('[data-testid^="market-probability-"]')).map((element) =>
        element.getAttribute('data-testid'),
      ),
    );
    expect(order).toEqual([
      'market-probability-value',
      'market-probability-delta',
      'market-probability-no',
    ]);
    const [readingBox, yesBox, badgeBox, noBox] = await Promise.all([
      boxOf(page, 'market-probability'),
      boxOf(page, 'market-probability-value'),
      boxOf(page, 'market-probability-delta'),
      boxOf(page, 'market-probability-no'),
    ]);
    // Line 1: the badge after the figure, level with it.
    expect(badgeBox.x).toBeGreaterThanOrEqual(yesBox.x + yesBox.width);
    expect(badgeBox.y).toBeLessThan(yesBox.y + yesBox.height);
    expect(badgeBox.y + badgeBox.height).toBeGreaterThan(yesBox.y);
    // Line 2: NO under both, from the reading's left edge — not after the badge.
    expect(noBox.y).toBeGreaterThanOrEqual(
      Math.max(yesBox.y + yesBox.height, badgeBox.y + badgeBox.height),
    );
    expect(Math.abs(noBox.x - readingBox.x)).toBeLessThanOrEqual(1);

    // A reading, not a price to press (ADR-0061 decision 1, item 2; the card's look, ADR-0062):
    // no button or link by that name, and plain text — no outline, ring, fill or pointer.
    await expect(page.getByRole('button', { name: /NO 37/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /NO 37/ })).toHaveCount(0);
    const look = await no.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        role: element.getAttribute('role'),
        border: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        shadow: style.boxShadow,
        background: style.backgroundColor,
        cursor: style.cursor,
      };
    });
    expect(look).toEqual({
      tag: 'SPAN',
      role: null,
      border: ['0px', '0px', '0px', '0px'],
      shadow: 'none',
      background: 'rgba(0, 0, 0, 0)',
      cursor: 'auto',
    });

    // Five seconds on (PLAN 11.4) the badge goes, and NO has not moved: nothing it does reaches
    // the line NO stands on.
    await expect(badge).toHaveCount(0, { timeout: 10_000 });
    await expect(no).toHaveText(`${copy.no} 37%`);
    const noAfter = await boxOf(page, 'market-probability-no');
    expect(Math.abs(noAfter.x - noBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(noAfter.y - noBox.y)).toBeLessThanOrEqual(0.5);
  });

  test('배경은 쓴 줄을 지키는 글자이고(마크다운·HTML 없음), 열린 동안 고친 설명을 리프레시 없이 따른다', async ({
    admin,
    page,
  }) => {
    // Two lines, and markup that a markdown or HTML renderer would turn into elements.
    const description = '첫 줄\n둘째 줄 **굵게** <b>x</b>';
    const market = await createOpenMarket(admin, { description });
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    await expect(page.getByTestId('watch-button')).toBeVisible();

    // `innerText` is the text as drawn: a `pre-wrap` block keeps the line break where it was
    // written, an ordinary one folds it into a space. The markup stays characters. Read off the
    // copy this width draws (ADR-0067).
    const id = detailCopyTestId(page, 'market-background');
    const section = page.getByTestId(id);
    const text = section.getByTestId(`${id}-text`);
    const drawn = () => text.evaluate((element) => (element as HTMLElement).innerText);
    expect(await drawn()).toBe(description);
    await expect(section.locator('b, strong, em')).toHaveCount(0);

    // The description is editable while the market is open, and the section follows the live
    // row: the edit's `market:status` refetches it (realtime-provider.tsx), with no reload.
    await markDocument(page);
    const rewritten = '고친 배경\n새 둘째 줄';
    const edited = await admin.patch(`/api/v1/admin/markets/${market.id}`, {
      data: { description: rewritten },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    await expect.poll(drawn).toBe(rewritten);
    expect(await documentSurvived(page)).toBe(true);
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

  test('AC 5: 스크롤 없이 가격과 하단 탭, 그 위의 YES·NO 매수 바가 보인다', async ({
    admin,
    page,
  }) => {
    // Deliberately changed by #122 (ADR-0067). AC 5 is PLAN 13 M4's "모바일 뷰포트(375px)에서 상세
    // 화면 스크롤 없이" the price and the YES/NO buttons are seen. #125 took the trade panel and its
    // fixed YES/NO bar away, so this test narrowed to the price and the bottom tabs and asserted
    // there was NO bar (`trade-bar`), the order area being an ordinary block further down saying
    // 거래 준비 중. The owner's #122 row (ADR-0061 decision 3) brings a bar back on an open market —
    // YES 매수 · NO 매수, no prices, opening the order sheet — so the criterion as PLAN wrote it holds
    // again: the price and the two buttons are on the first screen. The bar stands ON the tab bar
    // instead of taking its place, so the tabs #125 added to this test are still there too.
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);

    await expect(page.getByTestId('market-probability')).toBeVisible();
    await expect(page.getByTestId('bottom-tabs')).toBeVisible();
    await expect(page.getByTestId('order-entry-bar')).toBeVisible();
    // The desktop's order column is not drawn here: the sheet is this width's order panel.
    await expect(page.getByTestId('order-area')).toBeHidden();

    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport size');
    // Nothing was scrolled to get here, so a bounding box IS the position on the first screen.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    for (const testId of ['market-probability', 'bottom-tabs', 'order-entry-bar']) {
      const box = await boxOf(page, testId);
      expect(box.y, testId).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, testId).toBeLessThanOrEqual(viewport.height);
    }
    // The bar ends where the tabs begin (lib/nav.ts BOTTOM_TABS_HEIGHT_PX): neither covers the
    // other, and no strip of page shows between them.
    const [bar, tabs, price] = await Promise.all([
      boxOf(page, 'order-entry-bar'),
      boxOf(page, 'bottom-tabs'),
      boxOf(page, 'market-probability'),
    ]);
    expect(Math.abs(bar.y + bar.height - tabs.y)).toBeLessThanOrEqual(1);
    expect(price.y + price.height).toBeLessThanOrEqual(bar.y);
    // Edge to edge, as the tabs under it are: the bar reaches out over the page container's 24px
    // padding (`mx="-6"` against page.tsx's `px="6"`), and no further.
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(Math.abs(bar.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bar.width - clientWidth)).toBeLessThanOrEqual(1);
  });

  test('매수 바는 끝까지 내려도 마지막 섹션을 가리지 않고, 상세의 끝에서 상세와 함께 올라가 푸터를 가리지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);
    // Hydrated (the toggle has left its placeholder), so no late height change moves the end.
    await expect(page.getByTestId('watch-button')).toBeVisible();
    await expect(page.getByTestId('order-entry-bar')).toBeVisible();

    // One position, the end of the document, where a sticky bar and a `fixed` one part: the
    // first screen (AC 5 above) has both meeting the tab bar. Here the last section (관련 시장,
    // #65 — it took 토론's place as the last, ADR-0068) ends above the bar, and the bar has come off
    // the tab bar with the detail — it is the detail's last box, above the footer — instead of
    // staying over the footer as a fixed bar would (ADR-0067).
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const [last, bar, detail, footer, tabs] = await Promise.all([
      boxOf(page, 'market-related'),
      boxOf(page, 'order-entry-bar'),
      boxOf(page, 'market-detail'),
      boxOf(page, 'site-footer'),
      boxOf(page, 'bottom-tabs'),
    ]);
    expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
    // Back in its place in the flow: the bottom of the detail, so above the footer…
    expect(Math.abs(bar.y + bar.height - (detail.y + detail.height))).toBeLessThanOrEqual(1);
    expect(bar.y + bar.height).toBeLessThanOrEqual(footer.y);
    // …and so off the tab bar, with page between them (a fixed bar would end exactly on it).
    expect(bar.y + bar.height).toBeLessThan(tabs.y - 1);
    // And it never pushes the page sideways.
    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  });

  test('키보드 초점은 매수 바와 하단 탭 밑에 숨지 않는다: 그 띠에 있던 컨트롤은 초점을 받으며 바 위로 올라온다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();
    await expect(page.getByTestId('order-entry-bar')).toBeVisible();

    /*
     * WCAG 2.2 SC 2.4.11 (Focus Not Obscured): the page's own sticky and fixed boxes must not hide
     * the control that has the focus. A browser scrolls a newly focused control into view only
     * when it is outside the scrollport, and an overlay does not make it so — so below md a
     * control resting in the band the 매수 bar and the tab bar cover took the focus with no scroll
     * and its ring was drawn under the bar, unless the page reserves that band for focus
     * scrolling (`scroll-padding-bottom`, order-entry-bar.tsx).
     *
     * A phone a little shorter than this project's puts the 호가·거래 내역 switch, a focus stop,
     * wholly inside that band on the first screen. The height that does it is measured rather
     * than fixed, so the test holds however the question wraps.
     */
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport size');
    const [tabs, switcher] = await Promise.all([
      boxOf(page, 'bottom-tabs'),
      boxOf(page, 'market-activity-switch'),
    ]);
    const height = Math.round(switcher.y + switcher.height + tabs.height + 8);
    await page.setViewportSize({ width: viewport.width, height });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const covering = await boxOf(page, 'order-entry-bar');
    expect(switcher.y, 'the switch starts under the bar').toBeGreaterThanOrEqual(covering.y);
    expect(switcher.y + switcher.height, 'and ends above the bottom').toBeLessThanOrEqual(height);

    // Every focus stop of the sections, from the first one (the category trail) to the bar's own
    // YES 매수: each ends above the bar — with the 4px of its focus ring — once it has the focus.
    await page.getByTestId('market-detail-category').focus();
    const stops: string[] = [];
    for (let press = 0; press < 20; press += 1) {
      const focused = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return null;
        // A radio's input is visually hidden; the ring is drawn on the item it sits in.
        const drawn = active.closest('label') ?? active;
        const rect = drawn.getBoundingClientRect();
        return {
          name: `${active.tagName} ${drawn.textContent ?? ''}`.trim(),
          inSections: active.closest('[data-testid="market-detail-sections"]') !== null,
          inBar: active.closest('[data-testid="order-entry-bar"]') !== null,
          top: rect.top,
          bottom: rect.bottom,
        };
      });
      if (focused === null || focused.inBar) break;
      if (focused.inSections) {
        stops.push(focused.name);
        const bar = await boxOf(page, 'order-entry-bar');
        expect(focused.bottom + 4, `${focused.name} clears the bar`).toBeLessThanOrEqual(bar.y);
        expect(focused.top, `${focused.name} is on screen`).toBeGreaterThanOrEqual(0);
      }
      await page.keyboard.press('Tab');
    }
    // The walk did reach the switch, which is the stop that was under the band.
    expect(stops.some((stop) => stop.includes(copy.marketDetailViewBook))).toBe(true);
  });

  test('YES 매수·NO 매수는 가격 없이 같은 시트를 열고, 시트는 누른 계약을 제목에 두고 비로그인에게 로그인 안내를 보인다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);
    // The toggle leaves its placeholder only after hydration: from here a press reaches React.
    await expect(page.getByTestId('watch-button')).toBeVisible();

    const yes = page.getByTestId('order-entry-yes');
    const no = page.getByTestId('order-entry-no');
    // The owner's #122 row: two entry points and no price on either (#66 brings the prices).
    await expect(yes).toHaveText('YES 매수');
    await expect(no).toHaveText('NO 매수');
    await expect(page.getByTestId('order-entry-bar')).not.toContainText(/\d|%|Coin/);
    // Each says it opens a dialog, and that the dialog is closed.
    for (const entry of [yes, no]) {
      await expect(entry).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(entry).toHaveAttribute('aria-expanded', 'false');
    }

    const sheet = page.getByRole('dialog');
    await yes.click();
    await expect(sheet).toBeVisible();
    // A dialog named after the contract pressed. This reader is signed out, and an order is placed
    // signed in (N02 §2), so the sheet asks them to sign in — coming back to this market — instead
    // of saying 거래 준비 중 (owner decision 2026-10-17); a member's sheet is the next test.
    await expect(sheet).toHaveAccessibleName('YES 매수');
    await expect(page.getByTestId('order-sheet-title')).toHaveText('YES 매수');
    const prompt = sheet.getByTestId('order-sheet-sign-in');
    await expect(prompt).toContainText(copy.orderSheetSignedOut);
    await expect(sheet.getByRole('link', { name: copy.login })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/markets/${market.slug}`)}`,
    );
    await expect(page.getByTestId('order-sheet-notice')).toHaveCount(0);
    // A bottom sheet (N02 §4 '별도 시트'; `placement="bottom"`): once it has slid in it rests on
    // the bottom edge across the whole width, and its top is well below the top of the screen —
    // not a side drawer (the full height, part of the width) nor a top one.
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport size');
    await expect
      .poll(async () => {
        const box = await boxOf(page, 'order-sheet');
        return Math.abs(box.y + box.height - viewport.height);
      })
      .toBeLessThanOrEqual(1);
    const sheetBox = await boxOf(page, 'order-sheet');
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(Math.abs(sheetBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(sheetBox.width - clientWidth)).toBeLessThanOrEqual(1);
    expect(sheetBox.y).toBeGreaterThanOrEqual(viewport.height * 0.15);
    // The pressed entry point is the expanded one, and it names the dialog it controls.
    await expect(yes).toHaveAttribute('aria-expanded', 'true');
    await expect(no).toHaveAttribute('aria-expanded', 'false');
    const sheetId = await sheet.getAttribute('id');
    expect(sheetId).not.toBeNull();
    await expect(yes).toHaveAttribute('aria-controls', sheetId ?? '');
    // The focus moved into the sheet and stays in it: Tab and Shift+Tab never reach the bar or the
    // tabs behind the backdrop.
    const focusInSheet = () =>
      sheet.evaluate((element) => element.contains(document.activeElement));
    await expect.poll(focusInSheet).toBe(true);
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await focusInSheet(), key).toBe(true);
    }
    // Escape closes it, giving the focus back to the button.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(yes).toBeFocused();
    await expect(yes).toHaveAttribute('aria-expanded', 'false');

    // The other entry point opens the same sheet on its own contract, and the Korean close button
    // closes it.
    await no.click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAccessibleName('NO 매수');
    await expect(sheet.getByTestId('order-sheet-sign-in')).toContainText(copy.orderSheetSignedOut);
    await sheet.getByRole('button', { name: copy.close }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('order-sheet')).toHaveCount(0);
    await expect(no).toBeFocused();

    // A press that does not focus the button — Safari and iOS never focus one on a click or a
    // tap; a dispatched click is the same in Chromium — still gets the focus back to the button
    // that was pressed, not to <body> where it was.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await yes.dispatchEvent('click');
    await expect(sheet).toHaveAccessibleName('YES 매수');
    await expect.poll(focusInSheet).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(yes).toBeFocused();
  });

  test('로그인한 회원이 누르면 시트는 같은 제목에 거래 준비 중이고, 로그인 안내는 없다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    // The seed admin, whose contact the `admin` fixture filled in (helpers.ts).
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();

    const sheet = page.getByRole('dialog');
    for (const [entry, title] of [
      ['order-entry-yes', 'YES 매수'],
      ['order-entry-no', 'NO 매수'],
    ] as const) {
      await page.getByTestId(entry).click();
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAccessibleName(title);
      // Until the order panel (#66), the one line the desktop's order column says (ADR-0048).
      await expect(sheet.getByTestId('order-sheet-notice')).toHaveText(copy.tradePreparing);
      await expect(sheet.getByTestId('order-sheet-sign-in')).toHaveCount(0);
      await expect(sheet.getByRole('link', { name: copy.login })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    }
  });

  test('열린 시트는 폭이 md에 닿으면 닫히고, 다시 좁아져도 닫힌 채다', async ({ admin, page }) => {
    const market = await createOpenMarket(admin);
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();

    const sheet = page.getByRole('dialog');
    await page.getByTestId('order-entry-no').click();
    await expect(sheet).toBeVisible();

    // A tablet turned to landscape: from md the order panel is the column beside the sections and
    // the bar is gone, so the sheet does not stay over them (ADR-0067).
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByTestId('order-sheet')).toHaveCount(0);
    await expect(page.getByTestId('order-area-notice')).toBeVisible();
    await expect(page.getByTestId('order-entry-bar')).toBeHidden();

    // Turned back, nothing reopens it: the bar is there and the sheet waits for a press.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByTestId('order-entry-bar')).toBeVisible();
    await expect(page.getByTestId('order-sheet')).toHaveCount(0);
  });

  test('요약과 차트 다음에 호가·거래 내역을 전환하고, 배경·규칙은 그 아래에 있다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin, { description: '배경 문단' });
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();

    // N02 §4: the first screen is 요약 and the chart, the switch under them, then the rest in the
    // list's order (lib/market-detail.ts `drawnOrder('base')`). This reader is signed out, so 내
    // 포지션's place holds the one sign-in prompt (below, '시장 상세 · 상태와 로그인'). 배경, 규칙 and
    // 공개 판정 기록 are this width's copies (`-base`), after the switch in the DOM as on screen.
    const switcher = page.getByTestId('market-activity-switch');
    await expectInOrder(page, [
      'market-summary',
      'probability-chart',
      'market-activity-switch',
      'market-activity-book',
      'market-background-base',
      'market-rules-base',
      'market-judging-record-base',
      'market-personal-signed-out',
      'market-discussion',
      'market-related',
    ]);
    await expectSummaryOrder(page);
    await expectReadingOrder(page, [
      market.title,
      copy.marketOrderBook,
      copy.marketBackground,
      copy.rulesSectionTitle,
      copy.marketJudgingRecord,
      copy.marketDiscussion,
      copy.marketRelated,
    ]);

    // It opens on 호가 — N02 §4's short name on the switch, the slot under it titled 호가창 (owner
    // decision 2026-10-17); 거래 내역 is 최근 체결 (and 내 거래 for a member, below).
    const book = page.getByTestId('market-order-book');
    const fills = page.getByTestId('market-fills');
    // Exact: Playwright matches a name as a substring, and '호가창' would pass for '호가'.
    await expect(
      switcher.getByRole('radio', { name: copy.marketDetailViewBook, exact: true }),
    ).toBeChecked();
    await expect(book).toBeVisible();
    await expect(book.getByRole('heading', { level: 2 })).toHaveText(copy.marketOrderBook);
    await expect(book).toContainText(copy.comingSoon);
    await expect(fills).toBeHidden();

    await switcher.getByText(copy.marketTradeHistory).click();
    await expect(switcher.getByRole('radio', { name: copy.marketTradeHistory })).toBeChecked();
    await expect(fills).toBeVisible();
    await expect(book).toBeHidden();
    // A visitor's 거래 내역 is 최근 체결 alone: no 내 거래, and no second sign-in prompt in its place.
    const history = page.getByTestId('market-activity-history');
    await expect(history.getByTestId('market-my-trades')).toHaveCount(0);
    await expect(history.getByRole('link', { name: copy.login })).toHaveCount(0);

    await switcher.getByText(copy.marketDetailViewBook, { exact: true }).click();
    await expect(book).toBeVisible();
    await expect(fills).toBeHidden();
  });
});

/**
 * The order of elements on the page, as drawn and as read: each one is drawn (it has a box — the
 * copy of a section that this width hides has none, so it cannot stand in for the drawn one),
 * starts below the one before it, and comes after it in the document, which is the order a screen
 * reader reads and the keyboard walks (WCAG 1.3.2). A CSS `order` that lifts a section on screen
 * only passes the first two and fails the third: that is what the detail had below md before
 * ADR-0067 drew each width's 배경, 규칙 and 공개 판정 기록 from a copy of its own.
 */
async function expectInOrder(page: Page, testIds: readonly string[]): Promise<void> {
  const found = await page.evaluate(
    (ids) => {
      const elements = ids.map((id) => document.querySelector(`[data-testid="${id}"]`));
      return elements.map((element, index) => {
        if (element === null) return null;
        const rect = element.getBoundingClientRect();
        const previous = index === 0 ? null : elements[index - 1];
        return {
          top: rect.top + window.scrollY,
          drawn: rect.width > 0 || rect.height > 0,
          // FOLLOWING: after the one before it in tree order.
          read:
            previous == null ||
            (previous.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        };
      });
    },
    [...testIds],
  );
  found.forEach((item, index) => {
    const id = testIds[index] ?? '';
    expect(item, `${id} is on the page`).not.toBeNull();
    expect(item?.drawn, `${id} is drawn`).toBe(true);
  });
  for (let i = 1; i < testIds.length; i += 1) {
    const label = `${testIds[i] ?? ''} after ${testIds[i - 1] ?? ''}`;
    expect(found[i]!.top, `${label}: below it`).toBeGreaterThan(found[i - 1]!.top);
    expect(found[i]!.read, `${label}: in the document`).toBe(true);
  }
}

/**
 * The detail's section headings as a screen reader lists them: in document order, leaving out
 * what is `display: none` — the copies of 배경, 규칙 and 공개 판정 기록 for the other width, the
 * switch's other panel (WCAG 1.3.2, ADR-0067). The question comes first; each section's title
 * follows in the order the width draws them.
 */
async function expectReadingOrder(page: Page, headings: readonly string[]): Promise<void> {
  await expect(
    page.getByTestId('market-detail-sections').getByRole('heading', { level: 2 }),
  ).toHaveText([...headings]);
}

/**
 * Inside 요약, at either width (ADR-0067 decision 2, owner decision 2026-10-17 from the screenshots):
 * the first row — the category trail first, 관심 등록 at its end — then the question under it, then
 * the price, then 거래량. Before #122 the question was above the first row.
 */
async function expectSummaryOrder(page: Page): Promise<void> {
  await expectInOrder(page, [
    'market-detail-category',
    'market-detail-question',
    'market-probability',
    'market-detail-volume',
  ]);
  await expectInOrder(page, ['watch-button', 'market-detail-question']);
}

/**
 * The md-and-up frame (#122, ADR-0067), pinned at the desktop project's width so it runs in both
 * projects: the sections in N02 §4's order beside the order panel, which stays beside them as the
 * page scrolls (N02 §4 "차트·호가와 주문 패널을 병렬 배치").
 */
test.describe('시장 상세 · 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('섹션 열과 주문 패널 열이 나란히 있고, 섹션은 N02 §4의 순서다', async ({ admin, page }) => {
    const market = await createOpenMarket(admin, { description: '배경 문단' });
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();

    // Signed out, so the one sign-in prompt where 내 포지션 would be (below, '시장 상세 · 상태와
    // 로그인'). The slots carry the owner's titles, 호가창 and 공개 판정 기록 (2026-10-17). 배경, 규칙
    // and 공개 판정 기록 are this width's copies (`-md`), before the chart in the DOM as on screen.
    await expectInOrder(page, [
      'market-summary',
      'market-background-md',
      'market-rules-md',
      'market-judging-record-md',
      'probability-chart',
      'market-order-book',
      'market-fills',
      'market-personal-signed-out',
      'market-discussion',
      'market-related',
    ]);
    await expect(
      page.getByTestId('market-order-book').getByRole('heading', { level: 2 }),
    ).toHaveText(copy.marketOrderBook);
    await expect(
      page.getByTestId('market-judging-record-md').getByRole('heading', { level: 2 }),
    ).toHaveText(copy.marketJudgingRecord);
    await expectSummaryOrder(page);
    await expectReadingOrder(page, [
      market.title,
      copy.marketBackground,
      copy.rulesSectionTitle,
      copy.marketJudgingRecord,
      copy.marketOrderBook,
      copy.marketRecentFills,
      copy.marketDiscussion,
      copy.marketRelated,
    ]);

    // No switch and no 매수 bar at this width: 호가 and 최근 체결 stand one under the other, and the
    // order panel is the right column.
    await expect(page.getByTestId('market-activity-switch')).toBeHidden();
    await expect(page.getByTestId('order-entry-bar')).toBeHidden();
    await expect(page.getByTestId('market-order-book')).toBeVisible();
    await expect(page.getByTestId('market-fills')).toBeVisible();
    await expect(page.getByTestId('order-area-notice')).toHaveText(copy.tradePreparing);

    const [sections, summary, panel] = await Promise.all([
      boxOf(page, 'market-detail-sections'),
      boxOf(page, 'market-summary'),
      boxOf(page, 'order-area'),
    ]);
    // Side by side: the panel starts right of the sections and level with their top.
    expect(panel.x).toBeGreaterThanOrEqual(sections.x + sections.width);
    expect(panel.y).toBeLessThan(summary.y + summary.height);
    // In the home's and the header's container (1320px wide, 24px padding — page.tsx), so at this
    // width the two columns run from the header's left content edge to its right one rather than
    // sitting in a narrower centred box.
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(Math.abs(sections.x - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.x + panel.width - (clientWidth - 24))).toBeLessThanOrEqual(1);

    // Scrolled down to the chart and the 호가, the panel is still beside them (sticky).
    await page.getByTestId('market-order-book').scrollIntoViewIfNeeded();
    const [book, panelThen] = await Promise.all([
      boxOf(page, 'market-order-book'),
      boxOf(page, 'order-area'),
    ]);
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport size');
    expect(panelThen.y).toBeGreaterThanOrEqual(0);
    expect(panelThen.y + panelThen.height).toBeLessThanOrEqual(viewport.height);
    expect(panelThen.x).toBeGreaterThanOrEqual(book.x + book.width);
  });
});

/**
 * Who sees what (#122): the order area only on an open market (ADR-0048), and the personal areas —
 * 내 포지션, 내 거래, 내 대기 주문 — only for a signed-in reader (ADR-0061 decision 1, item 18), with
 * one sign-in prompt in their place for a signed-out visitor (owner decision 2026-10-17). Both
 * projects.
 */
test.describe('시장 상세 · 상태와 로그인', () => {
  test('열린 시장이 아니면 매수 진입점도 시트도 주문 영역도 없고, 상태 안내가 설명한다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();

    await expect(page.getByTestId('market-status-notice')).toContainText(copy.marketClosedNotice);
    await expect(page.getByTestId('order-entry-bar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'YES 매수' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'NO 매수' })).toHaveCount(0);
    await expect(page.getByTestId('order-area')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The rest of the frame is the same for every public status (공개 판정 기록: this width's copy).
    for (const slot of [
      'market-order-book',
      detailCopyTestId(page, 'market-judging-record'),
      'market-discussion',
      'market-related',
    ]) {
      await expect(page.getByTestId(slot), slot).toHaveCount(1);
    }
  });

  test('로그인하지 않으면 개인 영역 대신 그 자리에 로그인 안내 하나가 있고, 로그인하면 내 포지션과 준비 중인 두 자리가 보인다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const narrow = (page.viewportSize()?.width ?? 0) < 768;

    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();
    // The session is known (the toggle is drawn), and it is nobody's: no personal area at all
    // (ADR-0061 decision 1, item 18; #122's '내 포지션·대기 주문 영역은 로그인한 본인에게만')…
    await expect(page.getByTestId('market-my-position')).toHaveCount(0);
    await expect(page.getByTestId('market-my-trades')).toHaveCount(0);
    await expect(page.getByTestId('market-my-open-orders')).toHaveCount(0);
    await expect(page.getByText(copy.marketMyPosition, { exact: true })).toHaveCount(0);
    // …and ONE sign-in prompt where 내 포지션 · 내 대기 주문 would stand, which says what signing in
    // shows and comes back to this market (owner decision 2026-10-17, '로그인 안내 하나').
    const prompt = page.getByTestId('market-personal-signed-out');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(copy.marketPersonalSignedOut);
    await expect(prompt.getByRole('link', { name: copy.login })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/markets/${market.slug}`)}`,
    );
    await expectInOrder(page, [
      detailCopyTestId(page, 'market-judging-record'),
      'market-personal-signed-out',
      'market-discussion',
    ]);
    // The only 로그인 in the detail, 거래 내역 included: 내 거래 gets no prompt of its own.
    const detail = page.getByTestId('market-detail');
    if (narrow) {
      await page.getByTestId('market-activity-switch').getByText(copy.marketTradeHistory).click();
      await expect(page.getByTestId('market-fills')).toBeVisible();
    }
    await expect(detail.getByRole('link', { name: copy.login })).toHaveCount(1);
    await expect(page.getByText(copy.marketPersonalSignedOut)).toHaveCount(1);
    // A market without a description has no 배경 section either, in neither width's place.
    await expect(page.locator('[data-testid^="market-background"]')).toHaveCount(0);

    // The seed admin, whose contact the `admin` fixture filled in (helpers.ts).
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();
    const position = page.getByTestId('market-my-position');
    await expect(position).toBeVisible();
    await expect(position).toContainText(copy.marketMyPosition);
    // A member's detail has the areas and not the prompt.
    await expect(page.getByTestId('market-personal-signed-out')).toHaveCount(0);
    // 내 포지션 keeps its place after 판정 기록 at both widths (ADR-0067 decision 2).
    await expectInOrder(page, [
      detailCopyTestId(page, 'market-judging-record'),
      'market-my-position',
    ]);
    const openOrders = page.getByTestId('market-my-open-orders');
    await expect(openOrders).toBeVisible();
    await expect(openOrders).toContainText(copy.marketMyOpenOrders);
    await expect(openOrders).toContainText(copy.comingSoon);
    // 내 대기 주문 is under 내 포지션 (N02 §4 '내 포지션·대기 주문') and before 토론, at both widths.
    await expectInOrder(page, ['market-my-position', 'market-my-open-orders', 'market-discussion']);
    // 내 거래 is in 거래 내역: beside 최근 체결 from md up, behind the switch below md.
    if (narrow) {
      await page.getByTestId('market-activity-switch').getByText(copy.marketTradeHistory).click();
    }
    const myTrades = page.getByTestId('market-activity-history').getByTestId('market-my-trades');
    await expect(myTrades).toBeVisible();
    await expect(myTrades).toContainText(copy.marketMyTrades);
    await expect(myTrades).toContainText(copy.comingSoon);
    // …after 최근 체결 in it, and the two personal slots in the order the owner approved (ADR-0067).
    await expectInOrder(page, [
      'market-fills',
      'market-my-trades',
      'market-my-position',
      'market-my-open-orders',
      'market-discussion',
    ]);
  });
});
