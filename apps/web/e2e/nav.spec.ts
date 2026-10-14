import type { Locator, Page } from '@playwright/test';
import { copy } from '../src/copy';
import { createOpenMarket, expect, freshEmail, logOut, signUp, test } from './helpers';

/**
 * 최상위 IA (#16, owner decision 2026-10-13): the desktop header's row 1 and the mobile tab bar
 * list the same three areas — 시장 탐색 · 커뮤니티 · MY — and MY only once someone is signed in;
 * the header's row 2 (전체 and the categories) is drawn on 시장 탐색 only. Both projects run every
 * test, so each one asserts the two lists and then walks whichever of them the viewport shows.
 *
 * The MY addresses' login redirect and the 404 of the old personal addresses are my.spec.ts's.
 */

const PUBLIC_AREAS = [copy.navExplore, copy.navCommunity];
const ALL_AREAS = [...PUBLIC_AREAS, copy.navMy];

/**
 * Header row 1's items and the tab bar's. Both are in the DOM at every width, one of them behind
 * `display: none`, so they are found by CSS rather than by role (which skips hidden elements).
 */
function headerItems(page: Page): Locator {
  return page.locator(`header nav[aria-label="${copy.navPrimary}"] a`);
}
function tabItems(page: Page): Locator {
  return page.locator('[data-testid="bottom-tabs"] a');
}

/** The list a reader at this width actually has: the tab bar below md, row 1 from md up. */
function shownNav(page: Page): Locator {
  const width = page.viewportSize()?.width ?? 0;
  return width < 768
    ? page.getByTestId('bottom-tabs')
    : page.getByRole('navigation', { name: copy.navPrimary });
}

async function expectAreas(page: Page, labels: string[]) {
  await expect(headerItems(page)).toHaveText(labels);
  await expect(tabItems(page)).toHaveText(labels);
  await expect(shownNav(page)).toBeVisible();
}

/** Follows an area's link in the shown list and checks it lands and is marked as current. */
async function goToArea(page: Page, label: string, url: string) {
  await shownNav(page).getByRole('link', { name: label, exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(shownNav(page).getByRole('link', { name: label, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
}

test.describe('최상위 메뉴', () => {
  test('로그인하지 않은 방문자는 두 공개 영역만, 로그인하면 MY까지 세 영역을 어느 폭에서나 본다', async ({
    page,
  }) => {
    await page.goto('/');
    await expectAreas(page, PUBLIC_AREAS);
    await goToArea(page, copy.navCommunity, '/community');
    await goToArea(page, copy.navExplore, '/');

    await signUp(page, freshEmail());
    await expectAreas(page, ALL_AREAS);
    await goToArea(page, copy.navMy, '/my');
    // Every MY tab keeps MY marked; 시장 탐색 and 커뮤니티 are not.
    await page.getByTestId('my-tabs').getByRole('link', { name: copy.myWallet }).click();
    await expect(page).toHaveURL('/my/wallet');
    const shown = shownNav(page);
    await expect(shown.getByRole('link', { name: copy.navMy })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(shown.locator('[aria-current="page"]')).toHaveCount(1);
    await goToArea(page, copy.navCommunity, '/community');

    // The balance chip is the header's way into 지갑; nothing else of the account is up there. It
    // shows the available Coin alone, under the label 잔고 (owner decisions 2026-10-13).
    await expect(page.getByTestId('balance-chip')).toContainText(copy.balance);
    await expect(page.getByTestId('balance-chip')).toContainText('10,000 Coin');
    await page.getByTestId('balance-chip').click();
    await expect(page).toHaveURL('/my/wallet');
    await expect(page.locator('header [role="menu"], header [aria-haspopup="menu"]')).toHaveCount(
      0,
    );

    await logOut(page);
    await expectAreas(page, PUBLIC_AREAS);
  });

  test('헤더 2단(전체·카테고리)은 시장 탐색(홈·시장 상세)에서만 보인다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const row = page.getByTestId('nav-categories');

    for (const path of ['/', `/markets/${market.slug}`]) {
      await page.goto(path);
      await expect(row, path).toBeVisible();
      await expect(row.getByTestId('nav-category-all'), path).toBeVisible();
    }
    for (const path of ['/community', '/login', '/terms']) {
      await page.goto(path);
      await expect(page.getByTestId('site-footer'), path).toBeVisible();
      await expect(row, path).toHaveCount(0);
    }

    await signUp(page, freshEmail());
    await expect(row).toBeVisible();
    for (const path of ['/my', '/my/settings']) {
      await page.goto(path);
      await expect(page.getByTestId('my-tabs'), path).toBeVisible();
      await expect(row, path).toHaveCount(0);
    }
  });
});
