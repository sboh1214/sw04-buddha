import { type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  REALTIME_BUDGET_MS,
  closeMarket,
  createOpenMarket,
  documentSurvived,
  expect,
  freshEmail,
  logOut,
  markDocument,
  signUp,
  subscribed,
  test,
  type TestMarket,
  watchThroughApi,
} from './helpers';

/**
 * 관심 시장 (#89, ADR-0064; owner decisions in ADR-0061 decision 3): the button on the market
 * detail, MY's 관심 시장 tab and its preview on the summary. A signed-out press goes to the login
 * page and back to the same market with nothing registered; a member's watch puts the market's
 * card in MY, newest first; an unwatch takes it out; an ended market stays with its status, its
 * card moving live and opening its detail; the summary previews the newest three. The state is
 * nobody's but the member's, so the detail's HTML carries none of it.
 */

/** The detail's toggle, once it has left its placeholder. */
const watchButton = (page: Page) => page.getByTestId('watch-button');

async function openDetail(page: Page, slug: string): Promise<void> {
  await page.goto(`/markets/${slug}`);
  await expect(page.getByTestId('market-detail')).toBeVisible();
}

/** The `data-testid`s of the market cards under `scope`, in their order on screen. */
function cardIds(page: Page, scope: string): Promise<(string | null)[]> {
  return page
    .getByTestId(scope)
    .getByRole('article')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid')));
}

/** Presses the toggle and waits for the server's answer, so the next screen reads the new state. */
async function press(page: Page, expected: 'true' | 'false'): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/api/v1/me/watchlist/') &&
      response.ok(),
  );
  await watchButton(page).click();
  await expect(watchButton(page)).toHaveAttribute('aria-pressed', expected);
  await saved;
}

test.describe('관심 시장', () => {
  test('로그인하지 않은 방문자가 누르면 로그인으로 가고, 로그인하면 그 시장 상세로 돌아오며 등록은 되지 않는다', async ({
    page,
    admin,
  }) => {
    const email = freshEmail();
    await signUp(page, email);
    await logOut(page);
    const market = await createOpenMarket(admin);

    await openDetail(page, market.slug);
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(watchButton(page)).toHaveText(copy.watchToggle);
    await watchButton(page).click();
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe(`/markets/${market.slug}`);

    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password, { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.loginWithEmail }).click();
    await expect(page).toHaveURL(`/markets/${market.slug}`);
    // Back where the press was, and nothing was registered for it (the visitor presses again).
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'false');
    await page.goto('/my/watchlist');
    await expect(page.getByTestId('my-watchlist-empty')).toContainText(copy.watchlistEmpty);
  });

  test('회원이 등록하면 MY 관심 시장과 요약에 카드가 생기고, 해제하면 사라진다', async ({
    page,
    admin,
  }) => {
    await signUp(page, freshEmail());
    const first = await createOpenMarket(admin);
    const second = await createOpenMarket(admin);

    await page.goto('/my/watchlist');
    await expect(page.getByTestId('my-watchlist-empty')).toBeVisible();

    await openDetail(page, first.slug);
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'false');
    await press(page, 'true');
    // The server's state, not the press's: a reload reads it again.
    await page.reload();
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'true');

    // The detail's HTML is the same for this member as for anyone: no state, a placeholder.
    const html = await (await page.request.get(`/markets/${first.slug}`)).text();
    expect(html).toContain('data-testid="watch-button-pending"');
    expect(html).not.toContain('data-testid="watch-button"');

    await openDetail(page, second.slug);
    await press(page, 'true');

    // Newest watch first, each a market card.
    await page.goto('/my/watchlist');
    const grid = page.getByTestId('my-watchlist-grid');
    await expect(grid.getByRole('article')).toHaveCount(2);
    await expect(grid.getByRole('article').nth(0)).toHaveAttribute(
      'data-testid',
      `market-card-${second.id}`,
    );
    await expect(grid.getByRole('article').nth(1)).toHaveAttribute(
      'data-testid',
      `market-card-${first.id}`,
    );
    await expect(grid.getByRole('link', { name: first.title })).toBeVisible();
    // The outline nests: MY (h2) > 관심 시장 (h3) > each card's title (h4), never a card as a
    // peer of MY that files the sections after it under itself.
    await expect(
      page.getByTestId('my-watchlist').getByRole('heading', { level: 3, name: copy.myWatchlist }),
    ).toBeVisible();
    await expect(grid.getByRole('heading', { level: 4, name: first.title })).toBeVisible();
    await expect(grid.getByRole('heading', { level: 2 })).toHaveCount(0);
    // On a phone too, the cards fit the page.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // The summary previews the tab, with the way to it.
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-watchlist');
    await expect(preview.getByTestId(`market-card-${second.id}`)).toBeVisible();
    await expect(preview.getByTestId(`market-card-${first.id}`)).toBeVisible();
    await expect(preview.getByRole('heading', { level: 4, name: second.title })).toBeVisible();
    await expect(preview.getByRole('heading', { level: 2 })).toHaveCount(0);
    await preview.getByRole('link', { name: `${copy.myWatchlist} ${copy.myViewAll}` }).click();
    await expect(page).toHaveURL('/my/watchlist');

    // Unwatched on its detail, the market leaves the list; the other stays.
    await openDetail(page, first.slug);
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'true');
    await press(page, 'false');
    await page.goto('/my/watchlist');
    await expect(page.getByTestId(`market-card-${second.id}`)).toBeVisible();
    await expect(page.getByTestId(`market-card-${first.id}`)).toHaveCount(0);

    await openDetail(page, second.slug);
    await press(page, 'false');
    await page.goto('/my/watchlist');
    await expect(page.getByTestId('my-watchlist-empty')).toBeVisible();
    await expect(page.getByTestId(`market-card-${second.id}`)).toHaveCount(0);
  });

  test('끝난 시장은 해제할 때까지 상태와 함께 남고, 카드는 실시간으로 바뀌며 누르면 그 상세가 열린다', async ({
    page,
    admin,
  }) => {
    await signUp(page, freshEmail());
    const market = await createOpenMarket(admin);
    await openDetail(page, market.slug);
    await press(page, 'true');

    // The card is in its market's room before the 마감: armed BEFORE the navigation, as AC 1 is.
    const joined = subscribed(page, market.id);
    await page.goto('/my/watchlist');
    const card = page.getByTestId(`market-card-${market.id}`);
    await expect(card).toBeVisible();
    await expect(card).not.toContainText(copy.marketStatusClosed);
    await joined;

    // Closed while the tab is open: the badge moves with no reload and no read of the list — the
    // provider writes `market:status` into the watchlist's pages (realtime-provider.tsx).
    const listReads: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        new URL(request.url()).pathname === '/api/v1/me/watchlist'
      ) {
        listReads.push(request.url());
      }
    });
    await markDocument(page);
    await closeMarket(admin, market.id);
    await expect(card).toContainText(copy.marketStatusClosed, { timeout: REALTIME_BUDGET_MS });
    expect(await documentSurvived(page)).toBe(true);
    expect(listReads).toEqual([]);

    // Read afresh, the ended market is still listed with its status.
    await page.reload();
    await expect(card).toContainText(copy.marketStatusClosed);

    // Its card opens its detail (#89 AC: an ended market opens too), where the button is still
    // pressed; unwatching it there is the way out.
    await card.getByRole('link', { name: market.title }).click();
    await expect(page).toHaveURL(`/markets/${market.slug}`);
    await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusClosed);
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'true');
    await press(page, 'false');
    await page.goto('/my/watchlist');
    await expect(page.getByTestId('my-watchlist-empty')).toBeVisible();
  });

  test('요약은 최근에 등록한 셋을 보이고, 탭은 모두 보인다', async ({ page, admin }) => {
    await signUp(page, freshEmail());
    const markets: TestMarket[] = [];
    for (let i = 0; i < 4; i += 1) markets.push(await createOpenMarket(admin));
    // One after another, so each watch is later than the one before it.
    for (const market of markets) await watchThroughApi(page, market.id);
    const newestFirst = [...markets].reverse().map((market) => `market-card-${market.id}`);

    // The summary: the newest three (MY_PREVIEW_ROWS) and no 더 보기 — 전체 보기 is the way on.
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-watchlist');
    await expect(preview.getByRole('article')).toHaveCount(3);
    expect(await cardIds(page, 'my-preview-watchlist')).toEqual(newestFirst.slice(0, 3));
    await expect(preview.getByTestId('my-watchlist-more')).toHaveCount(0);

    // The tab: all four, newest first.
    await preview.getByRole('link', { name: `${copy.myWatchlist} ${copy.myViewAll}` }).click();
    await expect(page).toHaveURL('/my/watchlist');
    await expect(page.getByTestId('my-watchlist-grid').getByRole('article')).toHaveCount(4);
    expect(await cardIds(page, 'my-watchlist-grid')).toEqual(newestFirst);
  });

  test('누른 요청이 가는 동안 다시 눌러도 보내지 않고, 실패하면 되돌려 알리며 버튼은 초점을 지킨다', async ({
    page,
    admin,
  }) => {
    await signUp(page, freshEmail());
    const market = await createOpenMarket(admin);
    // The state reads answer (not watched), and the one write is held until the test lets it
    // fail with a 503.
    const statePath = `/api/v1/me/watchlist/${market.id}`;
    const outage = {
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL', message: 'unavailable' } }),
    };
    let reads = 0;
    const sent: { watched?: unknown }[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === statePath,
      async (route) => {
        const request = route.request();
        if (request.method() === 'GET') {
          reads += 1;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: { watched: false } }),
          });
          return;
        }
        sent.push(request.postDataJSON() as { watched?: unknown });
        await held;
        await route.fulfill(outage).catch(() => undefined); // the tab may have dropped it
      },
    );

    await openDetail(page, market.slug);
    // The first read answered: the toggle, unpressed.
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'false');
    const readsBefore = reads;
    // From here on the toggle is never swapped for its placeholder: that would unmount the
    // focused <button> and drop the keyboard focus.
    await page.evaluate(() => {
      const seen = { placeholder: false };
      Object.assign(window, { watchPlaceholderSeen: seen });
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="watch-button-pending"]') !== null) {
          seen.placeholder = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await watchButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(watchButton(page)).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => sent.length).toBe(1);
    // A second press, by key and by a double-click's second click, while the first is out.
    await page.keyboard.press('Enter');
    await watchButton(page).click();
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'true');

    release();
    // Rolled back at once; the toast says which change failed once the state was read again.
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText(copy.watchAddFailed)).toBeVisible();
    await expect(watchButton(page)).not.toHaveAttribute('aria-busy', 'true');
    expect(reads).toBeGreaterThan(readsBefore);
    await expect(watchButton(page)).toBeFocused();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { watchPlaceholderSeen: { placeholder: boolean } })
            .watchPlaceholderSeen.placeholder,
      ),
    ).toBe(false);
    // One write only: the second press and the click went nowhere.
    expect(sent.map((body) => body.watched)).toEqual([true]);
  });
  test('상태 읽기가 실패하면 버튼을 보이지 않고, 다시 읽어 성공하면 보인다', async ({
    page,
    admin,
  }) => {
    // Owner decision 2026-10-16 (ADR-0064): no button until a read succeeds — an unpressed
    // toggle would tell a member who came to unwatch that the market is not watched.
    await signUp(page, freshEmail());
    const market = await createOpenMarket(admin);
    const statePath = `/api/v1/me/watchlist/${market.id}`;
    let down = true;
    let failures = 0;
    await page.route(
      (url) => url.pathname === statePath,
      async (route) => {
        if (down && route.request().method() === 'GET') {
          failures += 1;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'INTERNAL', message: 'unavailable' } }),
          });
          return;
        }
        await route.fallback();
      },
    );

    await openDetail(page, market.slug);
    // The placeholder stays through the read and its retries, and gives way to nothing once
    // they failed: while `down`, no read can succeed, so its going means the failure settled.
    await expect.poll(() => failures).toBeGreaterThan(0);
    await expect(page.getByTestId('watch-button-pending')).toHaveCount(0);
    await expect(watchButton(page)).toHaveCount(0);

    down = false;
    // A refocus reads the state again: TanStack's focus manager listens for `visibilitychange`
    // on window (the document's event reaches it by bubbling; a synthetic one is sent there).
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect(watchButton(page)).toHaveAttribute('aria-pressed', 'false');
  });
});
