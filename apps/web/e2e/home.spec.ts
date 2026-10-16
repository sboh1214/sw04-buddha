import { type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  closeMarket,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  logOut,
  signUp,
  test,
  watchThroughApi,
} from './helpers';

/**
 * 탐색 홈 (#63, ADR-0065; owner decisions in ADR-0061 decision 1, items 9–13, and decision 3, the
 * #63 row, and ADR-0065's of 2026-10-16): one list of open markets with no status control, sorted
 * 추천 · 신규 · 마감 임박 (추천 first), and a 관심 시장 toggle over the category. Signed out, the
 * toggle is there and picking it goes to the login page and back to the home with it on; signed
 * in, it lists the member's watched open markets only — of the category too, when one is picked,
 * in the sidebar or in the header, which keeps the view on — starting on 최근 관심 등록 순, the
 * last of its four orders. Turning it off is the public list on 추천. The watchlist is the
 * member's alone, so the server's HTML of that view carries none of it, and its header is the
 * same for every visitor.
 */

const toggle = (page: Page) => page.getByTestId('market-watchlist-toggle');
const sortSelect = (page: Page) => page.getByTestId('market-sort');
const grid = (page: Page) => page.getByTestId('markets-grid');

/** The header's own HTML in a page's server render: everything from `<header` to `</header>`. */
function headerHtml(html: string): string {
  const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0];
  expect(header, 'the server HTML has a header').toBeDefined();
  return header ?? '';
}

/** The `data-testid`s of the cards in the home grid, in their order on screen. */
function cardIds(page: Page): Promise<(string | null)[]> {
  return grid(page)
    .getByRole('article')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid')));
}

/**
 * Waits for the tab to have hydrated and the session to be known, which is when the toggle's press
 * knows where to go: the header shows the 로그인 pair or the 잔고 chip only from then on
 * (auth-buttons.tsx holds a skeleton through hydration).
 */
async function sessionKnown(page: Page, signedIn: boolean): Promise<void> {
  await expect(
    signedIn
      ? page.getByTestId('balance-chip')
      : page.locator('header').getByRole('link', { name: copy.login }),
  ).toBeVisible();
}

test.describe('탐색 홈', () => {
  test('정렬은 추천·신규·마감 임박뿐이고 처음은 추천이며, 상태 선택은 없다', async ({ page }) => {
    await page.goto('/');
    await expect(sortSelect(page).locator('option')).toHaveText([
      copy.sortRecommended,
      copy.sortNewest,
      copy.sortClosing,
    ]);
    await expect(sortSelect(page)).toHaveValue('recommended');
    await expect(page.getByTestId('market-status-select')).toHaveCount(0);
    await expect(page.getByTestId('market-filters')).not.toContainText(copy.sortWatched);

    // A bookmarked status or volume order is ignored rather than redirected: the same home, on
    // 추천, at the address it was opened with.
    await page.goto('/?status=closed&sort=volume');
    await expect(page).toHaveURL('/?status=closed&sort=volume');
    await expect(sortSelect(page)).toHaveValue('recommended');
    await expect(sortSelect(page).locator('option')).toHaveCount(3);

    await page.goto('/');
    await sessionKnown(page, false);
    await sortSelect(page).selectOption('newest');
    await expect(page).toHaveURL('/?sort=newest');
    await expect(sortSelect(page)).toHaveValue('newest');
    await sortSelect(page).selectOption('recommended');
    await expect(page).toHaveURL('/');

    // That the order picked reaches GET /markets is pinned on the search screen, whose results
    // a run can isolate by a term (search.spec.ts) and which takes the same orders (ADR-0061
    // decision 1, item 14): this test isolated two markets on the home with `/?q=<group>`, which
    // the home no longer reads (ADR-0066), so that half moved there. The home's own requests —
    // the server's prefetch and the browser's queryFn — are pinned per order by
    // lib/api.server.test.ts and hooks/use-markets.test.ts.
  });

  test('옛 /?q= 주소는 검색하지 않고 리디렉트 없이 홈을 보인다', async ({ page, admin }) => {
    // The search is a screen of its own (ADR-0061 decision 1, item 14; ADR-0066): the home no
    // longer reads `q`, and an old `/?q=` link opens the home itself (D23: no redirect). A term
    // no market holds would have emptied a home that searched; one open market at least is there,
    // so the list is not empty. This replaces the home's empty-search test: the home has no search
    // to come back empty any more (its 'no results' is the search screen's, search.spec.ts).
    await createOpenMarket(admin);
    const term = freshTag();
    await page.goto(`/?q=${term}`);
    await expect(page).toHaveURL(`/?q=${term}`);
    await expect(grid(page).getByRole('article').first()).toBeVisible();
    await expect(page.getByTestId('markets-empty')).toHaveCount(0);
    await expect(page.getByTestId('search-results')).toHaveCount(0);
    // The header's box describes no search off the search screen (md and up, where it is open).
    const box = page.getByTestId('nav-search');
    if (await box.isVisible()) await expect(box).toHaveValue('');
  });

  test('로그인하지 않은 방문자도 관심 시장을 보고, 고르면 로그인한 뒤 관심 시장을 켠 홈으로 돌아온다', async ({
    page,
    admin,
  }) => {
    const email = freshEmail();
    await signUp(page, email);
    await logOut(page);
    const market = await createOpenMarket(admin);

    await page.goto(`/?category=${market.categorySlug}`);
    await sessionKnown(page, false);
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveText(copy.homeWatchlistToggle);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await toggle(page).click();
    await page.waitForURL(/\/login\?/);
    const back = `/?category=${market.categorySlug}&watchlist=1`;
    expect(new URL(page.url()).searchParams.get('next')).toBe(back);

    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password, { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.loginWithEmail }).click();
    await expect(page).toHaveURL(back);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    // A new member has watched nothing: the view's own empty state, not the public list's — and
    // MY's hint on how a market gets there (owner decision 2026-10-16).
    await expect(page.getByTestId('markets-empty')).toHaveText(copy.watchlistViewEmpty);
    await expect(page.getByTestId('markets-empty')).toContainText(
      '시장 상세에서 관심 등록을 누르면 여기에 모입니다.',
    );
    await expect(sortSelect(page)).toHaveValue('watched');

    // Opened signed out — a shared link — the view asks to sign in, and the way there comes back.
    await logOut(page);
    await page.goto('/?watchlist=1');
    const prompt = page.getByTestId('markets-signed-out');
    await expect(prompt).toContainText(copy.watchlistViewSignedOut);
    await expect(prompt.getByRole('link', { name: copy.login })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent('/?watchlist=1')}`,
    );
    // A header category keeps the view on for a visitor too, so the prompt stays — now for the
    // view of that category (owner decisions 2026-10-16).
    await page.getByTestId(`nav-category-${market.categorySlug}`).click();
    await expect(page).toHaveURL(back);
    await expect(prompt.getByRole('link', { name: copy.login })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(back)}`,
    );
    // And turning it off needs no account.
    await toggle(page).click();
    await expect(page).toHaveURL(`/?category=${market.categorySlug}`);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('회원이 관심 시장을 켜면 관심 등록한 거래 중 시장만, 카테고리와 겹쳐 고르면 그 카테고리의 것만 보인다', async ({
    page,
    admin,
    request,
  }) => {
    await signUp(page, freshEmail());
    // `first` and `unwatched` in a category no other spec opens markets in (helpers.ts
    // `topLevelCategory`), so the public list of it on 신규 holds both on its first page.
    const first = await createOpenMarket(admin, { topLevelCategory: 2 });
    const elsewhere = await createOpenMarket(admin, { topLevelCategory: 1 });
    const unwatched = await createOpenMarket(admin, { topLevelCategory: 2 });
    const ended = await createOpenMarket(admin);
    expect(elsewhere.categorySlug).not.toBe(first.categorySlug);
    // Watched the other way round from how they were opened (`first` opened before `elsewhere`),
    // so 최근 관심 등록 순 reads [first, elsewhere] and 신규 [elsewhere, first]: the switch below
    // can only pass if the order picked reaches GET /me/watchlist. The ended one is watched last
    // and then closed, and the home lists open markets only (MY keeps it).
    for (const market of [elsewhere, first, ended]) await watchThroughApi(page, market.id);
    await closeMarket(admin, ended.id);
    const byWatch = [`market-card-${first.id}`, `market-card-${elsewhere.id}`];
    const byOpening = [`market-card-${elsewhere.id}`, `market-card-${first.id}`];

    await page.goto('/');
    await sessionKnown(page, true);
    await toggle(page).click();
    await expect(page).toHaveURL('/?watchlist=1');
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    // The view's order starts on 최근 관심 등록 순, the one option only it has, listed last
    // (owner decision 2026-10-16).
    await expect(sortSelect(page).locator('option')).toHaveText([
      copy.sortRecommended,
      copy.sortNewest,
      copy.sortClosing,
      copy.sortWatched,
    ]);
    await expect(sortSelect(page)).toHaveValue('watched');
    await expect.poll(() => cardIds(page)).toEqual(byWatch);
    await expect(page.getByTestId(`market-card-${unwatched.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`market-card-${ended.id}`)).toHaveCount(0);

    // The view is the member's alone: its HTML, asked for with the member's own cookie, is the
    // placeholder grid every visitor gets, and none of the watched markets.
    const html = await (await page.request.get('/?watchlist=1')).text();
    expect(html).toContain('data-testid="markets-skeleton"');
    expect(html).not.toContain(first.id);
    expect(html).not.toContain(elsewhere.id);

    // Another order of the same view: the public 신규 over the watched markets. The view has no
    // SSR, so its read is the only way the order reaches the server — the grid must change to
    // that order from the watched one it showed, and the read must have asked for it.
    const listReads: { sort: string | null; status: string | null }[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/api/v1/me/watchlist') {
        listReads.push({
          sort: url.searchParams.get('sort'),
          status: url.searchParams.get('status'),
        });
      }
    });
    await sortSelect(page).selectOption('newest');
    await expect(page).toHaveURL('/?sort=newest&watchlist=1');
    await expect.poll(() => cardIds(page)).toEqual(byOpening);
    expect(listReads).toContainEqual({ sort: 'newest', status: 'open' });

    // With a category from the header: in the view, row 2 moves the view to that category and
    // keeps it on, in the order picked (owner decision 2026-10-16) — only that category's
    // watched market, still on 신규.
    const inView = `/?category=${first.categorySlug}&sort=newest&watchlist=1`;
    await page.getByTestId(`nav-category-${first.categorySlug}`).click();
    await expect(page).toHaveURL(inView);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(sortSelect(page)).toHaveValue('newest');
    await expect(grid(page).getByRole('article')).toHaveCount(1);
    await expect(grid(page).getByTestId(`market-card-${first.id}`)).toBeVisible();
    // Every item of row 2 stays in the view: 전체 widens it back out, another category moves it.
    await expect(page.getByTestId('nav-category-all')).toHaveAttribute(
      'href',
      '/?sort=newest&watchlist=1',
    );
    await expect(page.getByTestId(`nav-category-${elsewhere.categorySlug}`)).toHaveAttribute(
      'href',
      `/?category=${elsewhere.categorySlug}&sort=newest&watchlist=1`,
    );
    // 375px: the controls wrap rather than push the page sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // The header reads the URL and never the session: the server renders the same header for
    // the member's cookie and for a visitor with none, and its 전체 already stays in the view.
    const memberHeader = headerHtml(await (await page.request.get(inView)).text());
    const visitorHeader = headerHtml(await (await request.get(inView)).text());
    expect(memberHeader).toContain('href="/?sort=newest&amp;watchlist=1"');
    expect(visitorHeader).toBe(memberHeader);

    // Off again: the public list of the category, on 추천 although the view was on 신규 (owner
    // decision 2026-10-16) — and row 2 is back to its plain links. Then that public list on 신규:
    // the unwatched market is on it beside the watched one, so the member's home is the public
    // list again and not the view. Both were opened last in their category, so its first page of
    // 신규 holds them whatever earlier runs left (`/?category=…&q=<tag>` until the home stopped
    // reading `q`, ADR-0066).
    await toggle(page).click();
    await expect(page).toHaveURL(`/?category=${first.categorySlug}`);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(sortSelect(page)).toHaveValue('recommended');
    await expect(grid(page)).toBeVisible();
    await expect(page.getByTestId('nav-category-all')).toHaveAttribute('href', '/');
    await expect(page.getByTestId(`nav-category-${elsewhere.categorySlug}`)).toHaveAttribute(
      'href',
      `/?category=${elsewhere.categorySlug}`,
    );
    await sortSelect(page).selectOption('newest');
    await expect(page).toHaveURL(`/?category=${first.categorySlug}&sort=newest`);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(grid(page).getByTestId(`market-card-${unwatched.id}`)).toBeVisible();
    await expect(grid(page).getByTestId(`market-card-${first.id}`)).toBeVisible();
    await expect(grid(page).getByTestId(`market-card-${elsewhere.id}`)).toHaveCount(0);
    // The same list served cold, from the server's prefetch: the unwatched market is in its HTML.
    const publicHtml = await (
      await page.request.get(`/?category=${first.categorySlug}&sort=newest`)
    ).text();
    expect(publicHtml).toContain(`market-card-${unwatched.id}`);
  });
});
