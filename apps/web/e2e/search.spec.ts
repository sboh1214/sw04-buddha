import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  closeMarket,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  nextMeRead,
  signUp,
  switchAccountUnderScreen,
  switchMeBeforeSession,
  test,
} from './helpers';

/**
 * 시장 검색 (#15, ADR-0066; owner decisions in ADR-0061 decision 1, items 13·14·18, and decision
 * 3, the #15 rows): the results are a screen of their own (`/search`), reached from the header's
 * box, on every public status until one is picked — so a closed market is found, and by 거래 마감
 * alone too — matched on the title (and on a tag's whole name since #17: market-tags.spec.ts),
 * sorted as the home is. 'No results', loading and a failure are
 * different states, and a failure is never 'no results' (N02 §3). With no term a member sees
 * their own recent searches (distinct, newest first, each deletable, and all at once) and a
 * visitor a prompt; only a member's submitted term — and a recent search they pick, as a new
 * search (owner decision 2026-10-16) — is recorded, never a filter change, never a visitor's
 * search. The server draws the first page of results when there are any, so the HTML holds them
 * without JavaScript (owner decision 2026-10-16); 'no results' and a failure are the browser's.
 * A tab whose account switched to another while it showed the screen records, deletes and clears
 * nothing of either: each write names the account the screen was drawn for and is refused; a
 * list whose `['me']` turned to another account before the session did is that account's own,
 * read afresh, before an entry can be deleted; and a term typed in either box for the one account
 * is gone from it once the box is the other's — in either order, and in a box opened while the
 * tab waited for the other's `GET /me` too — while a term typed before
 * `GET /me`'s first answer stays, and is that answer's account's (owner decision 2026-10-26 «첫 답
 * 전에 친 글자는 남김»). A `GET /me` that fails without answering leaves the list unread, said with
 * 다시 시도 (ADR-0091).
 */

/**
 * `MARKET_SEARCH_TERM_MAX` and `MARKET_TITLE_MAX` of `@buddha/shared`, written out: the specs
 * import that package for types only (helpers.ts says why).
 */
const TERM_MAX = 100;
const TITLE_MAX = 120;

const results = (page: Page) => page.getByTestId('search-results');
const card = (page: Page, id: string) => page.getByTestId(`market-card-${id}`);
const recent = (page: Page) => page.getByTestId('recent-search');

/** The `data-testid`s of the result cards, in their order on screen. */
function cardIds(page: Page): Promise<(string | null)[]> {
  return results(page)
    .getByRole('article')
    .evaluateAll((cards) => cards.map((element) => element.getAttribute('data-testid')));
}

/**
 * Waits for the session to be known, which is when a submit knows whether to record: the header
 * shows the 로그인 pair or the 잔고 chip only from then on (auth-buttons.tsx).
 */
async function sessionKnown(page: Page, signedIn: boolean): Promise<void> {
  await expect(
    signedIn
      ? page.getByTestId('balance-chip')
      : page.locator('header').getByRole('link', { name: copy.login }),
  ).toBeVisible();
}

/** Submits `term` from the header's box: the field at md and up, the icon's form below. */
async function searchFromHeader(page: Page, term: string): Promise<void> {
  const field = page.getByTestId('nav-search');
  if (await field.isVisible()) {
    await field.fill(term);
    await field.press('Enter');
    return;
  }
  await page.getByTestId('nav-search-toggle').click();
  const mobile = page.getByTestId('nav-search-mobile');
  await mobile.fill(term);
  await mobile.press('Enter');
}

/**
 * The header's search field: the one in row 1 at md and up; below it the form its icon opens,
 * opened here. Ask once the page has hydrated — the icon opens nothing before.
 */
async function headerBox(page: Page): Promise<Locator> {
  const field = page.getByTestId('nav-search');
  if (await field.isVisible()) return field;
  await page.getByTestId('nav-search-toggle').click();
  const mobile = page.getByTestId('nav-search-mobile');
  await expect(mobile).toBeVisible();
  return mobile;
}

/**
 * Holds every `GET /me` the page sends from now until `release` is called. `asked` resolves once
 * the first one is sent. Armed before the page is opened, that is its first read: the browser
 * knows the session by then, so the page has hydrated and nothing on it knows the account yet.
 * Armed on an open page before its session turns to another account, it is SessionCacheGuard's
 * read after the reset, so nothing on the page knows any account until `release`.
 */
async function holdMeReads(page: Page): Promise<{ asked: Promise<unknown>; release: () => void }> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const isMeRead = (url: URL) => url.pathname === '/api/v1/me';
  await page.route(isMeRead, async (route) => {
    if (route.request().method() === 'GET') await released;
    await route.fallback();
  });
  const asked = page.waitForRequest(
    (request) => request.method() === 'GET' && isMeRead(new URL(request.url())),
  );
  return { asked, release };
}

/** Submits `term` from the search screen's own box. */
async function searchOnScreen(page: Page, term: string): Promise<void> {
  const field = page.getByTestId('search-input');
  await field.fill(term);
  await field.press('Enter');
}

/** The header's own HTML in a page's server render: everything from `<header` to `</header>`. */
function headerHtml(html: string): string {
  const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0];
  expect(header, 'the server HTML has a header').toBeDefined();
  return header ?? '';
}

/** The market cards in a page's server render, by their `data-testid`, in order. */
function cardIdsIn(html: string): string[] {
  return [...html.matchAll(/data-testid="(market-card-[0-9a-f-]{36})"/g)].map((match) => match[1]!);
}

/** A recorded search straight at the API with the context's cookie. */
async function recordThroughApi(context: APIRequestContext, query: string): Promise<void> {
  const me = await meOf(context);
  const response = await context.post('/api/v1/me/search-history', {
    data: { query, expectedAccountId: me.id },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** The ids of the context's account's recent searches (`GET /me/search-history`), newest first. */
async function recentIds(context: APIRequestContext): Promise<string[]> {
  const response = await context.get('/api/v1/me/search-history');
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: { id: string }[] }).data.map((row) => row.id);
}

/** The context's account's recent searches (`GET /me/search-history`), newest first. */
async function recentOf(context: APIRequestContext): Promise<string[]> {
  const response = await context.get('/api/v1/me/search-history');
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: { query: string }[] }).data.map((row) => row.query);
}

/** Records every search-history write the page sends (`POST /me/search-history…`). */
function historyWrites(page: Page): { path: string; body: unknown }[] {
  const writes: { path: string; body: unknown }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.startsWith('/api/v1/me/search-history')) {
      writes.push({ path, body: request.postDataJSON() });
    }
  });
  return writes;
}

/** Resolves on the next recorded search (`POST /me/search-history`); arm it before the submit. */
function recorded(page: Page) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/me/search-history' &&
      response.request().method() === 'POST',
  );
}

test.describe('시장 검색', () => {
  test('헤더 검색창은 검색 화면으로 가고, 시장의 고유 태그로 그 카드 하나를 찾아 상세로 간다', async ({
    page,
    admin,
  }) => {
    const market = await createOpenMarket(admin);
    await page.goto('/');
    await sessionKnown(page, false);
    await searchFromHeader(page, market.tag);

    await expect(page).toHaveURL(`/search?q=${market.tag}`);
    await expect(page.getByRole('heading', { level: 2, name: copy.searchTitle })).toBeVisible();
    await expect(results(page).getByRole('article')).toHaveCount(1);
    await expect(card(page, market.id)).toBeVisible();
    // The screen's own box carries the term; the header's category row is not on this screen
    // (ADR-0054: the home and the details only), though 시장 탐색 is lit here (nav.spec.ts).
    await expect(page.getByTestId('search-input')).toHaveValue(market.tag);
    await expect(page.getByTestId('nav-categories')).toHaveCount(0);
    // Two search landmarks on this screen (the header's at md and up), named apart: the screen's
    // searches within the filters picked, the header's afresh.
    await expect(
      page.getByRole('search', { name: copy.searchRefineLabel, exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('searchbox', { name: copy.searchRefineLabel, exact: true }),
    ).toHaveValue(market.tag);
    if (await page.getByTestId('nav-search').isVisible()) {
      await expect(page.getByRole('search', { name: copy.searchLabel, exact: true })).toHaveCount(
        1,
      );
      await expect(
        page.getByRole('searchbox', { name: copy.searchLabel, exact: true }),
      ).toHaveAttribute('data-testid', 'nav-search');
    }
    // The filters start on every status and 추천 (ADR-0061 decision 1, items 13 and 14).
    await expect(page.getByTestId('search-status')).toHaveValue('all');
    await expect(page.getByTestId('search-sort')).toHaveValue('recommended');
    await expect(page.getByTestId('search-sort').locator('option')).toHaveText([
      copy.sortRecommended,
      copy.sortNewest,
      copy.sortClosing,
    ]);
    // 375px: nothing on the screen runs off its edge.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // A result is the market card, and it opens the detail.
    await card(page, market.id).getByRole('link', { name: market.title }).click();
    await expect(page).toHaveURL(`/markets/${market.slug}`);
  });

  test('모든 상태가 처음이라 마감된 시장도 찾고, 거래 마감만 골라도 찾으며, 거래 중에는 없다', async ({
    page,
    admin,
  }) => {
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);

    await page.goto(`/search?q=${market.tag}`);
    await expect(page.getByTestId('search-status')).toHaveValue('all');
    await expect(card(page, market.id)).toBeVisible();
    await expect(card(page, market.id)).toContainText(copy.marketStatusClosed);
    // The card is the server's (it is in the HTML), so it says nothing of hydration: the select's
    // change reaches the router once the session is known.
    await sessionKnown(page, false);

    // '모든 상태' and one choice per public status label, in lifecycle order, 취소 included and no
    // 무효 (ADR-0061 decision 1, item 13; ADR-0093 decision 3, the #174 row).
    await expect(page.getByTestId('search-status').locator('option')).toHaveText([
      copy.searchStatusAll,
      copy.marketStatusScheduled,
      copy.marketStatusOpen,
      copy.marketStatusPaused,
      copy.marketStatusClosed,
      copy.marketStatusProvisional,
      copy.marketStatusResolved,
      copy.marketStatusSettling,
      copy.marketStatusSettled,
      copy.marketStatusCancelled,
    ]);

    await page.getByTestId('search-status').selectOption('closed');
    await expect(page).toHaveURL(`/search?q=${market.tag}&status=closed`);
    await expect(card(page, market.id)).toBeVisible();
    await expect(results(page).getByRole('article')).toHaveCount(1);

    await page.getByTestId('search-status').selectOption('open');
    await expect(page).toHaveURL(`/search?q=${market.tag}&status=open`);
    await expect(page.getByTestId('markets-empty')).toHaveText(copy.marketsSearchEmpty);

    // Back to every status: the address drops its default again, and the closed market is there.
    await page.getByTestId('search-status').selectOption('all');
    await expect(page).toHaveURL(`/search?q=${market.tag}`);
    await expect(card(page, market.id)).toBeVisible();
  });

  test('화면의 검색창은 고른 조건 안에서 찾고, 헤더 검색창은 조건 없이 새로 찾는다', async ({
    page,
    admin,
  }) => {
    // ADR-0066 decision 6 ('두 검색창의 차이'): the screen's box carries the filters on screen as
    // hidden fields, the header's goes to a bare `/search?q=…` from wherever it is.
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    const params = () => Object.fromEntries(new URL(page.url()).searchParams);

    // No term yet, filters picked: they stay in the address, and the box searches within them.
    await page.goto('/search?status=closed&sort=newest');
    await expect(page.getByTestId('search-status')).toHaveValue('closed');
    await searchOnScreen(page, market.tag);
    // next/form writes the hidden fields first, so the order is not `searchPath`'s: compare the
    // parameters, not the string.
    await expect.poll(params).toEqual({ status: 'closed', sort: 'newest', q: market.tag });
    await expect(card(page, market.id)).toBeVisible();
    await expect(page.getByTestId('search-status')).toHaveValue('closed');
    await expect(page.getByTestId('search-sort')).toHaveValue('newest');

    // The header from the same filtered screen: a fresh search, every status and 추천.
    await searchFromHeader(page, market.tag);
    await expect(page).toHaveURL(`/search?q=${market.tag}`);
    await expect(page.getByTestId('search-status')).toHaveValue('all');
    await expect(page.getByTestId('search-sort')).toHaveValue('recommended');
    await expect(card(page, market.id)).toBeVisible();

    // Both boxes follow the URL's term while the screen and the header stay mounted (each is
    // keyed on it): another term from the screen's box shows in the header's (typed into for the
    // first term at md and up), and Back puts the first term back in both.
    const other = freshTag();
    await searchOnScreen(page, other);
    await expect(page).toHaveURL(`/search?q=${other}`);
    await expect(page.getByTestId('markets-empty')).toBeVisible();
    await expect(page.getByTestId('nav-search')).toHaveValue(other);
    await page.goBack();
    await expect(page).toHaveURL(`/search?q=${market.tag}`);
    await expect(card(page, market.id)).toBeVisible();
    await expect(page.getByTestId('search-input')).toHaveValue(market.tag);
    await expect(page.getByTestId('nav-search')).toHaveValue(market.tag);
  });

  test('검색창은 검색어의 최대 길이까지만 받아, 붙여 넣은 긴 글도 검색 결과 화면이 된다', async ({
    page,
  }) => {
    // A term past the API's bound would read as no term, and the screen would answer a search
    // just typed with its prompt. Both boxes hold the bound at most (`SEARCH_INPUT_MAX_LENGTH`),
    // so a longer paste is cut to it and is searched: here nothing matches, so 'no results'.
    const long = `${freshTag()}${'긴'.repeat(TITLE_MAX)}`.slice(0, TITLE_MAX);
    const kept = long.slice(0, TERM_MAX);
    await page.goto('/search');
    await sessionKnown(page, false);
    await page.getByTestId('search-input').fill(long);
    await expect(page.getByTestId('search-input')).toHaveValue(kept);
    await page.getByTestId('search-input').press('Enter');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(kept);
    await expect(page.getByTestId('markets-empty')).toHaveText(copy.marketsSearchEmpty);
    await expect(page.getByTestId('search-prompt')).toHaveCount(0);

    // The header's box, at either width.
    await page.goto('/');
    await sessionKnown(page, false);
    await searchFromHeader(page, long);
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(kept);
    await expect(page.getByTestId('markets-empty')).toHaveText(copy.marketsSearchEmpty);
    await expect(page.getByTestId('search-prompt')).toHaveCount(0);
  });

  test('카테고리 필터가 결과를 좁히고, 고른 정렬이 결과의 순서를 바꾼다', async ({
    page,
    admin,
  }) => {
    // Two markets of one run's group (`/search?q=<group>` lists exactly them), in two top-level
    // categories, opened one after the other — so the later opened is the later to close: 마감
    // 임박 reads [first, second], 신규 [second, first], and so does 추천, neither having a fill
    // (ties by the latest opening). The order must reach GET /markets — the server's read of the
    // first page, and the browser's when there is none — since the select's value comes from the
    // URL, and the API answers an order it was not sent with 추천, its own default. This half was
    // the home's test until the home stopped reading `q` (ADR-0066).
    const group = freshTag();
    const first = await createOpenMarket(admin, { group });
    const second = await createOpenMarket(admin, { group, topLevelCategory: 1 });
    const byOpening = [`market-card-${second.id}`, `market-card-${first.id}`];
    const byClosing = [`market-card-${first.id}`, `market-card-${second.id}`];

    await page.goto(`/search?q=${group}`);
    await expect.poll(() => cardIds(page)).toEqual(byOpening);
    await sessionKnown(page, false);
    await page.getByTestId('search-sort').selectOption('closing');
    await expect(page).toHaveURL(`/search?q=${group}&sort=closing`);
    await expect.poll(() => cardIds(page)).toEqual(byClosing);
    await page.getByTestId('search-sort').selectOption('newest');
    await expect(page).toHaveURL(`/search?q=${group}&sort=newest`);
    await expect.poll(() => cardIds(page)).toEqual(byOpening);
    await page.getByTestId('search-sort').selectOption('closing');
    await expect.poll(() => cardIds(page)).toEqual(byClosing);
    await page.getByTestId('search-sort').selectOption('recommended');
    await expect(page).toHaveURL(`/search?q=${group}`);
    await expect.poll(() => cardIds(page)).toEqual(byOpening);

    // The category: the top level of the second market's alone.
    await page.getByTestId('search-category').selectOption(second.categorySlug);
    await expect(page).toHaveURL(`/search?q=${group}&category=${second.categorySlug}`);
    await expect.poll(() => cardIds(page)).toEqual([`market-card-${second.id}`]);
    await page.getByTestId('search-category').selectOption('');
    await expect(page).toHaveURL(`/search?q=${group}`);
    await expect.poll(() => cardIds(page)).toEqual(byOpening);
  });

  test('어떤 시장도 없는 검색어는 검색 결과가 없다는 안내다', async ({ page }) => {
    await page.goto(`/search?q=${freshTag()}`);
    await expect(page.getByTestId('markets-empty')).toHaveText(copy.marketsSearchEmpty);
    await expect(page.getByTestId('markets-grid')).toHaveCount(0);
    await expect(page.getByTestId('markets-error')).toHaveCount(0);
  });

  test('연결이 끊기거나 API가 내려가면 연결 오류, API의 오류 답이면 일반 오류이고, 결과 없음으로 보이지 않는다', async ({
    page,
    admin,
  }) => {
    // The server reads a search's first page too, but puts it in the HTML only when it holds a
    // card (owner decision 2026-10-16, ADR-0066); with nothing found, the browser reads the page
    // itself. So the search is for a run's group word that no market holds yet: the server finds
    // nothing, and what the browser then gets back is what the visitor sees fail. The market comes
    // only before the connection is back. Three failures, each its own way:
    // - `abort`: the request gets no answer at all (offline, the web origin gone);
    // - `proxy`: the API is down, and Next's `/api/*` rewrite answers for it with a plain-text 500
    //   (what `next dev`/`next start` send when the proxied API refuses the connection);
    // - `api`: the API itself answered an error, in its envelope.
    const group = freshTag();
    let failure: 'abort' | 'proxy' | 'api' = 'abort';
    const isMarketList = (url: URL) => url.pathname === '/api/v1/markets';
    await page.route(isMarketList, (route) =>
      failure === 'abort'
        ? route.abort('internetdisconnected')
        : route.fulfill(
            failure === 'proxy'
              ? { status: 500, contentType: 'text/plain', body: 'Internal Server Error' }
              : {
                  status: 500,
                  contentType: 'application/json',
                  body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
                },
          ),
    );
    const error = page.getByTestId('markets-error');
    const neverEmpty = async () => {
      await expect(page.getByTestId('markets-empty')).toHaveCount(0);
      await expect(page.getByText(copy.marketsSearchEmpty)).toHaveCount(0);
    };

    await page.goto(`/search?q=${group}`);
    await expect(error).toBeVisible();
    await expect(error).toContainText(copy.errNetwork);
    await neverEmpty();

    failure = 'api';
    await error.getByRole('button', { name: copy.retry }).click();
    await expect(error).toContainText(copy.errUnknown);
    await expect(error).not.toContainText(copy.errNetwork);
    await neverEmpty();

    failure = 'proxy';
    await error.getByRole('button', { name: copy.retry }).click();
    await expect(error).toContainText(copy.errNetwork);
    await neverEmpty();

    // A market of the group now, and the connection back: 다시 시도 brings the result.
    const market = await createOpenMarket(admin, { group });
    await page.unroute(isMarketList);
    await error.getByRole('button', { name: copy.retry }).click();
    await expect(card(page, market.id)).toBeVisible();
    await expect(error).toHaveCount(0);
  });

  test('로그인하지 않은 방문자는 검색어 없이 열면 입력 안내를 보고, 검색은 기록되지 않는다', async ({
    page,
    admin,
  }) => {
    const market = await createOpenMarket(admin);
    const records: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/me/search-history')) {
        records.push(`${request.method()} ${request.url()}`);
      }
    });

    await page.goto('/search');
    await sessionKnown(page, false);
    await expect(page.getByTestId('search-prompt')).toHaveText(copy.searchPrompt);
    await expect(page.getByTestId('recent-searches')).toHaveCount(0);

    // The search itself is public (ADR-0061 decision 1, item 18), and a visitor's is not kept.
    await searchOnScreen(page, market.tag);
    await expect(page).toHaveURL(`/search?q=${market.tag}`);
    await expect(card(page, market.id)).toBeVisible();
    await searchFromHeader(page, market.tag);
    await expect(card(page, market.id)).toBeVisible();
    expect(records).toEqual([]);
  });

  test('회원의 최근 검색: 제출한 검색어와 누른 최근 검색만 중복 없이 최근 순으로 남고, 하나씩·전체를 지운다', async ({
    page,
    admin,
  }) => {
    const older = await createOpenMarket(admin);
    const newer = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    await sessionKnown(page, true);

    // A new member has searched nothing.
    await page.goto('/search');
    await expect(page.getByTestId('recent-searches-empty')).toHaveText(copy.recentSearchesEmpty);

    // One term from the screen's box, one from the header's; each submit is recorded.
    let saved = recorded(page);
    await searchOnScreen(page, older.tag);
    await saved;
    await expect(card(page, older.id)).toBeVisible();
    saved = recorded(page);
    await searchFromHeader(page, newer.tag);
    await saved;
    await expect(page).toHaveURL(`/search?q=${newer.tag}`);
    // The screen stayed mounted, and its box (typed into for the older term) now shows the newer
    // one: it is keyed on the URL's term, so a refine from it searches what is on screen.
    await expect(page.getByTestId('search-input')).toHaveValue(newer.tag);

    // Opening an older search by its address and changing a filter records nothing: the term
    // stays second. A request in flight would fail this, so none may start.
    const posts: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/v1/me/search-history'
      ) {
        posts.push(request.url());
      }
    });
    await page.goto(`/search?q=${older.tag}`);
    // The card is in the server's HTML, so it is the session, known only after hydration, that
    // says the select's change reaches the router.
    await expect(card(page, older.id)).toBeVisible();
    await sessionKnown(page, true);
    await page.getByTestId('search-status').selectOption('closed');
    await expect(page).toHaveURL(`/search?q=${older.tag}&status=closed`);
    await page.getByTestId('search-sort').selectOption('newest');
    await expect(page).toHaveURL(`/search?q=${older.tag}&status=closed&sort=newest`);
    expect(posts).toEqual([]);

    // No term: the recent searches, newest first.
    await page.goto('/search');
    await expect(recent(page)).toHaveCount(2);
    await expect(recent(page).getByTestId('recent-search-link')).toHaveText([newer.tag, older.tag]);
    // With filters picked and no term, each entry runs its term within them (ADR-0066 decision
    // 6: a recent search is a term only, so it keeps what is picked now).
    await page.goto('/search?status=closed&sort=newest');
    await expect(recent(page).getByTestId('recent-search-link')).toHaveText([newer.tag, older.tag]);
    for (const [index, tag] of [newer.tag, older.tag].entries()) {
      await expect(recent(page).getByTestId('recent-search-link').nth(index)).toHaveAttribute(
        'href',
        `/search?q=${tag}&status=closed&sort=newest`,
      );
    }
    // The same term again is one entry, moved first.
    saved = recorded(page);
    await searchOnScreen(page, older.tag);
    await saved;
    await page.goto('/search');
    await expect(recent(page).getByTestId('recent-search-link')).toHaveText([older.tag, newer.tag]);

    // An entry runs its search, and picking it is a new search of it (owner decision 2026-10-16,
    // ADR-0066: "새 검색으로 기록"): the second entry, the least recently searched, is recorded
    // again and moves first.
    saved = recorded(page);
    await recent(page).getByRole('link', { name: newer.tag }).click();
    await saved;
    await expect(page).toHaveURL(`/search?q=${newer.tag}`);
    await expect(card(page, newer.id)).toBeVisible();
    await page.goto('/search');
    await expect(recent(page).getByTestId('recent-search-link')).toHaveText([newer.tag, older.tag]);

    // Delete one: it goes, and stays gone after a reload.
    await recent(page)
      .filter({ hasText: older.tag })
      .getByRole('button', { name: `${older.tag} ${copy.recentSearchDelete}` })
      .click();
    await expect(recent(page).getByTestId('recent-search-link')).toHaveText([newer.tag]);
    await page.reload();
    await expect(recent(page).getByTestId('recent-search-link')).toHaveText([newer.tag]);

    // Delete all.
    await page.getByTestId('recent-searches-clear').click();
    await expect(page.getByTestId('recent-searches-empty')).toHaveText(copy.recentSearchesEmpty);
    await page.reload();
    await expect(page.getByTestId('recent-searches-empty')).toBeVisible();
    await expect(recent(page)).toHaveCount(0);
  });

  test('검색 화면의 HTML은 회원의 쿠키로 받아도 최근 검색을 싣지 않는다', async ({
    page,
    request,
  }) => {
    // The recent searches are the session's own, read with its cookie in the browser and never
    // rendered on the server (`PRIVATE_QUERY_ROOTS`, ADR-0066). Until the session is known the
    // screen draws a placeholder — neither the recent searches nor the prompt — so the server's
    // HTML is that placeholder for a member and a visitor alike (ADR-0066 decision 6).
    await signUp(page, freshEmail());
    await sessionKnown(page, true);
    const term = freshTag();
    const saved = recorded(page);
    await searchFromHeader(page, term);
    await saved;

    const cookies = await page.context().cookies();
    const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const asMember = await (await request.get('/search', { headers: { cookie } })).text();
    const anonymous = await (await request.get('/search')).text();
    expect(asMember).not.toContain(term);
    expect(anonymous).not.toContain(term);
    for (const html of [asMember, anonymous]) {
      expect(html).toContain('data-testid="search-pending"');
      expect(html).not.toContain('data-testid="search-prompt"');
      expect(html).not.toContain('data-testid="recent-searches"');
    }
    // And the screen itself shows it, once the browser has asked.
    await page.goto('/search');
    await expect(recent(page).getByTestId('recent-search-link')).toHaveText([term]);
  });

  test('검색 결과의 첫 페이지는 서버가 그려, 스크립트 없이 받은 HTML에 카드가 있고 회원과 방문자에게 같다', async ({
    page,
    admin,
    request,
  }) => {
    // Owner decision 2026-10-16 (ADR-0066): "서버가 첫 페이지도 그린다". The response body, not
    // the DOM after hydration: what a visitor without JavaScript gets (the two search boxes are
    // `next/form`s, which navigate here without it). Read with a member's cookie and with none,
    // the results are the same cards, and the header is the same bytes: the server reads no
    // cookie and seeds nothing private.
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    await sessionKnown(page, true);
    const cookies = await page.context().cookies();
    const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');

    const asMember = await request.get(`/search?q=${market.tag}`, { headers: { cookie } });
    const anonymous = await request.get(`/search?q=${market.tag}`);
    for (const response of [asMember, anonymous]) expect(response.status()).toBe(200);
    const [memberHtml, anonymousHtml] = await Promise.all([asMember.text(), anonymous.text()]);
    for (const html of [memberHtml, anonymousHtml]) {
      expect(html).toContain(market.title);
      expect(html).toContain('data-testid="markets-grid"');
      expect(html).not.toContain('data-testid="markets-skeleton"');
      expect(cardIdsIn(html)).toEqual([`market-card-${market.id}`]);
    }
    expect(headerHtml(memberHtml)).toBe(headerHtml(anonymousHtml));

    // A search that finds nothing is not answered by the server: its HTML is the skeleton, and
    // '검색 결과가 없습니다.' is the browser's to say, from its own read (N02 §3).
    const nothing = await (await request.get(`/search?q=${freshTag()}`)).text();
    expect(nothing).toContain('data-testid="markets-skeleton"');
    expect(nothing).not.toContain('data-testid="markets-empty"');
    expect(nothing).not.toContain(copy.marketsSearchEmpty);
  });
  test('탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 검색 화면이 남아 있으면 최근 검색의 삭제·전체 삭제와 검색의 기록은 그 화면의 계정을 대어 거절되고, 어느 계정의 최근 검색도 바뀌지 않는다', async ({
    browser,
    page,
  }) => {
    // ADR-0091 (ADR-0090 결과 5's remaining writes): in the render between the session naming B
    // and SessionCacheGuard's reset the screen still shows A's recent searches while the session
    // already says B, and a write naming the session's account would be taken with B's cookie —
    // B's history cleared from A's list, a term searched on A's screen recorded for B. Each names
    // the account of the `Me` the screen was drawn from, so the server refuses it as another
    // account's. That render is held here: B's cookie in this tab and the session read again,
    // while `GET /me` and the recent list still answer as A (`switchAccountUnderScreen`).
    const theirs = `b-${freshTag()}`;
    const mine = `a-${freshTag()}`;
    const searched = `a-${freshTag()}`;
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await recordThroughApi(other.request, theirs);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);
      await recordThroughApi(page.request, mine);
      await page.goto('/search');
      await expect(recent(page).getByTestId('recent-search-link')).toHaveText([mine]);
      await shownContext.addCookies(await page.context().cookies());
      await switchAccountUnderScreen(
        page,
        shownContext.request,
        { id: b.id, cookies: await otherContext.cookies() },
        (request) =>
          request.method() === 'GET' &&
          new URL(request.url()).pathname === '/api/v1/me/search-history',
      );

      const writes = historyWrites(page);
      const toast = page.locator('[data-scope="toast"]').getByText(copy.sessionChanged);
      const answerOf = (path: string) =>
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && new URL(response.url()).pathname === path,
        );
      // A's list, drawn again from A's `Me` and A's searches after the guard's reset.
      await expect(recent(page).getByTestId('recent-search-link')).toHaveText([mine]);
      const entry = (await recentIds(shownContext.request))[0];
      let answered = answerOf(`/api/v1/me/search-history/${entry}/delete`);
      await recent(page)
        .getByRole('button', { name: `${mine} ${copy.recentSearchDelete}` })
        .click();
      expect((await answered).status()).toBe(403);
      await expect(toast).toBeVisible();
      await expect(recent(page).getByTestId('recent-search-link')).toHaveText([mine]);
      answered = answerOf('/api/v1/me/search-history/clear');
      await page.getByTestId('recent-searches-clear').click();
      expect((await answered).status()).toBe(403);
      await expect(recent(page).getByTestId('recent-search-link')).toHaveText([mine]);
      // A search from the screen's box goes ahead; its record is refused.
      answered = answerOf('/api/v1/me/search-history');
      await searchOnScreen(page, searched);
      expect((await answered).status()).toBe(403);
      await expect(page).toHaveURL(`/search?q=${searched}`);

      expect(writes).toEqual([
        {
          path: `/api/v1/me/search-history/${entry}/delete`,
          body: { expectedAccountId: a.id },
        },
        { path: '/api/v1/me/search-history/clear', body: { expectedAccountId: a.id } },
        { path: '/api/v1/me/search-history', body: { query: searched, expectedAccountId: a.id } },
      ]);
      // Nothing deleted, cleared or recorded, for B or for A.
      expect(await recentOf(other.request)).toEqual([theirs]);
      expect(await recentOf(shownContext.request)).toEqual([mine]);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });

  test('탭의 세션이 아직 앞 계정을 말하는데 검색 화면의 `GET /me`가 다른 회원으로 답하면 최근 검색은 그 회원의 것을 읽을 때까지 비고, 앞 계정의 목록으로 지우지 않는다', async ({
    browser,
    page,
  }) => {
    // ADR-0091 (ADR-0090 결정 4-2's order): `['me']` turns from A to B in place, before the
    // session does, so SessionCacheGuard resets nothing — a window-focus refetch of `GET /me`
    // answered with B's cookie while better-auth's session still says A. The list's answer names
    // no owner: kept under one key for every account, the screen went on showing A's searches
    // under B's `Me`, and its 전체 삭제 named B with B's cookie — B's history cleared from A's
    // list. Kept under the account on screen, it is B's own list, read afresh: nothing to delete
    // until it answers (held here), then B's.
    const theirs = `b-${freshTag()}`;
    const mine = `a-${freshTag()}`;
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await recordThroughApi(other.request, theirs);
      await signUp(page, freshEmail());
      await recordThroughApi(page.request, mine);
      await page.clock.install();
      await page.goto('/search');
      await expect(recent(page).getByTestId('recent-search-link')).toHaveText([mine]);

      // The recent list's reads from here on, held until released.
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        (url) => url.pathname === '/api/v1/me/search-history',
        async (route) => {
          if (route.request().method() === 'GET') await released;
          await route.fallback();
        },
      );
      const writes = historyWrites(page);
      await switchMeBeforeSession(page, shownContext, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });

      // B's list not read yet: none of A's entries, and nothing to delete.
      await expect(recent(page)).toHaveCount(0);
      await expect(page.getByTestId('recent-searches-clear')).toHaveCount(0);
      release();
      // B's own list.
      await expect(recent(page).getByTestId('recent-search-link')).toHaveText([theirs]);

      expect(writes).toEqual([]);
      expect(await recentOf(other.request)).toEqual([theirs]);
      expect(await recentOf(shownContext.request)).toEqual([mine]);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });
  test('탭의 세션이 아직 앞 계정을 말하는데 `GET /me`가 다른 회원으로 답하면 검색창에 적던 검색어는 비워져, 그 회원의 최근 검색으로 가지 않는다', async ({
    browser,
    page,
  }) => {
    // ADR-0091 (ADR-0090 결정 4-2's order): `['me']` turns from A to B in place, before the
    // session does, so SessionCacheGuard resets nothing. A box keeps what is typed in it — the
    // header's never remounts — and its submit records the term for the account the header shows
    // then: a term typed on A's screen, submitted once B is drawn, went into B's 최근 검색 with B's
    // cookie (named the session's A it was refused before). Each box is drawn again when the
    // account known turns into another (`useSearchBoxTurn`), so the term typed for A is gone.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      await page.clock.install();
      await page.goto('/search');
      await sessionKnown(page, true);
      const typed = `a-${freshTag()}`;
      const screenBox = page.getByTestId('search-input');
      await screenBox.fill(typed);
      // The header's field at md and up; below it the box is behind its icon, closed.
      const header = page.getByTestId('nav-search');
      const headerOpen = await header.isVisible();
      if (headerOpen) await header.fill(typed);

      const writes = historyWrites(page);
      await switchMeBeforeSession(page, shownContext, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });
      // B's screen: neither box holds what was typed for A.
      await expect(screenBox).toHaveValue('');
      if (headerOpen) await expect(header).toHaveValue('');

      expect(writes).toEqual([]);
      expect(await recentOf(other.request)).toEqual([]);
      expect(await recentOf(shownContext.request)).toEqual([]);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });

  test('`GET /me`의 첫 답 전에 검색창에 적은 검색어는 그 답 뒤에도 남고, 제출하면 그 답의 회원의 최근 검색으로 간다', async ({
    page,
  }) => {
    // ADR-0091, owner decision 2026-10-26 «첫 답 전에 친 글자는 남김»: the first time the tab knows
    // an account is no change of account — a term typed in either box before `GET /me`'s first
    // answer stays, and is that account's. Drawing each box again for each account had cleared it
    // on that answer (and moved the focus). Held here: the page's `GET /me` until released.
    await signUp(page, freshEmail());
    const a = await meOf(page.request);
    const { asked, release } = await holdMeReads(page);
    try {
      await page.goto('/search');
      await asked;
      const typed = `a-${freshTag()}`;
      const screenBox = page.getByTestId('search-input');
      await screenBox.fill(typed);
      const header = await headerBox(page);
      await header.fill(typed);
      // Nobody known yet: the header holds the chip's placeholder.
      await expect(page.getByTestId('balance-chip')).toHaveCount(0);

      release();
      await expect(page.getByTestId('balance-chip')).toBeVisible();
      await expect(screenBox).toHaveValue(typed);
      await expect(header).toHaveValue(typed);

      // Submitted now, it is recorded for the account that answer named.
      const writes = historyWrites(page);
      const answered = recorded(page);
      await header.press('Enter');
      expect((await answered).status()).toBe(200);
      await expect(page).toHaveURL(`/search?q=${typed}`);
      expect(writes).toEqual([
        { path: '/api/v1/me/search-history', body: { query: typed, expectedAccountId: a.id } },
      ]);
      expect(await recentOf(page.request)).toEqual([typed]);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  test('`GET /me`의 첫 답 전에 적어 그 답 뒤에도 남은 검색어도, 그 뒤 `GET /me`가 다른 회원으로 답하면 검색창에서 비워진다', async ({
    browser,
    page,
  }) => {
    // ADR-0091, owner decision 2026-10-26: what is kept through the first answer is the first
    // account's, and goes once the account known turns into another — here in ADR-0090 결정 4-2's
    // order, `['me']` turning from A to B in place before the session does (no reset).
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    let release: () => void = () => undefined;
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      await page.clock.install();
      const held = await holdMeReads(page);
      release = held.release;
      await page.goto('/search');
      await held.asked;
      const typed = `a-${freshTag()}`;
      const screenBox = page.getByTestId('search-input');
      await screenBox.fill(typed);
      const header = await headerBox(page);
      await header.fill(typed);
      release();
      await expect(page.getByTestId('balance-chip')).toBeVisible();
      await expect(screenBox).toHaveValue(typed);
      await expect(header).toHaveValue(typed);

      const writes = historyWrites(page);
      await switchMeBeforeSession(page, shownContext, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });
      // B's screen: neither box holds what was typed for A.
      await expect(screenBox).toHaveValue('');
      await expect(header).toHaveValue('');

      expect(writes).toEqual([]);
      expect(await recentOf(other.request)).toEqual([]);
      expect(await recentOf(shownContext.request)).toEqual([]);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });

  test('탭의 세션이 다른 회원으로 바뀌어 화면이 그 회원의 것으로 다시 그려지면, 앞 계정에서 검색창에 적던 검색어는 비워져 그 회원의 최근 검색으로 가지 않는다', async ({
    browser,
    page,
  }) => {
    // ADR-0091, owner decision 2026-10-26: the other order. The session says B first and
    // SessionCacheGuard's reset puts `['me']` back to nothing before B's answer comes — a stretch
    // with nobody known that is no first answer: A's draft does not wait in the boxes for B's
    // `Me`, whose submit would record it for B.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      await page.goto('/search');
      await expect(page.getByTestId('balance-chip')).toBeVisible();
      const typed = `a-${freshTag()}`;
      const screenBox = page.getByTestId('search-input');
      await screenBox.fill(typed);
      const header = await headerBox(page);
      await header.fill(typed);
      await shownContext.addCookies(await page.context().cookies());

      const writes = historyWrites(page);
      // B's cookie in the tab, and the session read again on `visibilitychange` (better-auth's
      // own refetch): the guard's reset, then `GET /me` with B's cookie.
      const sessionRead = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/auth/get-session',
      );
      const meRead = nextMeRead(page);
      await page.context().clearCookies();
      await page.context().addCookies(await otherContext.cookies());
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const session = (await (await sessionRead).json()) as { user?: { id?: string } } | null;
      expect(session?.user?.id).toBe(b.id);
      const drawn = (await (await meRead).json()) as { data: { id: string } };
      expect(drawn.data.id).toBe(b.id);
      await expect(screenBox).toHaveValue('');
      await expect(header).toHaveValue('');

      expect(writes).toEqual([]);
      expect(await recentOf(other.request)).toEqual([]);
      expect(await recentOf(shownContext.request)).toEqual([]);
    } finally {
      await otherContext.close();
      await shownContext.close();
    }
  });

  test('탭의 세션이 다른 회원으로 바뀐 뒤 그 회원의 `GET /me`가 답하기 전에 새로 연 검색창에 적은 검색어도, 그 답에 비워져 그 회원의 최근 검색으로 가지 않는다', async ({
    browser,
    page,
  }) => {
    // ADR-0091 결정 5-10 (가): a box drawn while nobody is known — the search screen opened
    // between SessionCacheGuard's reset and B's `GET /me`, the header's form its icon opens then
    // (375px) — starts as the last account the tab knew, so B's answer is no first answer and the
    // box starts again. The test above types only in boxes drawn while A was known, which hold A
    // in their own state; these are drawn after the reset, from what the tab remembers. Held
    // here: every `GET /me` from the cookie swap on — the first is the guard's read for B.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    let release: () => void = () => undefined;
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      await page.goto('/');
      await expect(page.getByTestId('balance-chip')).toBeVisible();
      await shownContext.addCookies(await page.context().cookies());

      const writes = historyWrites(page);
      const held = await holdMeReads(page);
      release = held.release;
      // B's cookie in the tab, and the session read again on `visibilitychange` (better-auth's
      // own refetch): the guard's reset, then `GET /me` with B's cookie — held.
      const sessionRead = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/auth/get-session',
      );
      await page.context().clearCookies();
      await page.context().addCookies(await otherContext.cookies());
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const session = (await (await sessionRead).json()) as { user?: { id?: string } } | null;
      expect(session?.user?.id).toBe(b.id);
      await held.asked;
      // Nobody known: the header holds the chip's placeholder.
      await expect(page.getByTestId('balance-chip')).toHaveCount(0);

      // The search screen, opened now from the header's empty box (at 375px from the form its
      // icon opens now), and then the header's box beside it (at 375px that form opened again).
      await (await headerBox(page)).press('Enter');
      await expect(page).toHaveURL(/\/search(\?q=)?$/);
      const typed = `a-${freshTag()}`;
      const screenBox = page.getByTestId('search-input');
      await screenBox.fill(typed);
      const header = await headerBox(page);
      await header.fill(typed);
      await expect(page.getByTestId('balance-chip')).toHaveCount(0);

      const answer = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/me' &&
          response.request().method() === 'GET',
      );
      release();
      const drawn = (await (await answer).json()) as { data: { id: string } };
      expect(drawn.data.id).toBe(b.id);
      await expect(page.getByTestId('balance-chip')).toBeVisible();
      await expect(screenBox).toHaveValue('');
      await expect(header).toHaveValue('');

      expect(writes).toEqual([]);
      expect(await recentOf(other.request)).toEqual([]);
      expect(await recentOf(shownContext.request)).toEqual([]);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });

  test('`GET /me`를 읽지 못하면 최근 검색은 못 읽었다고 말하고, 다시 시도로 읽으면 목록을 보인다', async ({
    page,
  }) => {
    // ADR-0091: the list is the account's whose `Me` the screen was drawn from, read only once
    // that is known. A `GET /me` that fails without ever answering left it on its skeleton for good
    // — no error, no 다시 시도 — so it is the list's failure rung, saying the profile could not be
    // read, and 다시 시도 reads `GET /me` again.
    await signUp(page, freshEmail());
    const mine = `a-${freshTag()}`;
    await recordThroughApi(page.request, mine);
    let failures = 0;
    const isMeRead = (url: URL) => url.pathname === '/api/v1/me';
    await page.route(isMeRead, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      failures += 1;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'unavailable' } },
      });
    });
    await page.goto('/search');
    // The first read and its two retries (1 s, 2 s) have failed.
    await expect.poll(() => failures, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    const failed = page.getByTestId('recent-searches-error');
    await expect(failed).toContainText(copy.errProfileLoad);
    await expect(recent(page)).toHaveCount(0);

    await page.unroute(isMeRead);
    await failed.getByRole('button', { name: copy.retry }).click();
    await expect(recent(page).getByTestId('recent-search-link')).toHaveText([mine]);
    await expect(failed).toHaveCount(0);
  });
});
