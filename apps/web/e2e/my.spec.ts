import { copy } from '../src/copy';
import { adminAccount, expect, freshEmail, signIn, signUp, test } from './helpers';

/**
 * MY (#16, owner decision 2026-10-13): the reader's own screens under `/my` — a summary and eight
 * tabs behind one server-side session gate — and the old personal addresses gone without a
 * redirect (D23).
 */

const MY_PAGES = [
  '/my',
  '/my/positions',
  '/my/orders',
  '/my/history',
  '/my/wallet',
  '/my/posts',
  '/my/watchlist',
  '/my/notifications',
  '/my/settings',
];

const TABS: { key: string; label: string; href: string }[] = [
  { key: 'positions', label: copy.myPositions, href: '/my/positions' },
  { key: 'orders', label: copy.myOrders, href: '/my/orders' },
  { key: 'history', label: copy.myHistory, href: '/my/history' },
  { key: 'wallet', label: copy.myWallet, href: '/my/wallet' },
  { key: 'posts', label: copy.myPosts, href: '/my/posts' },
  { key: 'watchlist', label: copy.myWatchlist, href: '/my/watchlist' },
  { key: 'notifications', label: copy.myNotifications, href: '/my/notifications' },
  { key: 'settings', label: copy.mySettings, href: '/my/settings' },
];

test.describe('MY', () => {
  test('로그인하지 않은 방문자는 MY의 어느 주소에서도 로그인으로 가고, 옛 개인 화면 주소는 없다', async ({
    page,
  }) => {
    for (const path of MY_PAGES) {
      await page.goto(path);
      // Compared decoded: how much of a server redirect's query string stays percent-encoded is
      // the framework's business (onboarding.spec.ts reads it the same way).
      await page.waitForURL(/\/login\?/);
      expect(new URL(page.url()).searchParams.get('next'), path).toBe(path);
      await expect(page.getByTestId('my-tabs')).toHaveCount(0);
    }

    for (const path of ['/portfolio', '/wallet', '/settings']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page).toHaveURL(path);
    }
  });

  test('로그인하면 요약과 여덟 탭이 보이고, 로그아웃은 MY 안에 있다', async ({ page }) => {
    await signUp(page, freshEmail());
    await page.goto('/my');

    // The summary: 잔고 요약 with a new account's 0 (creating an account grants nothing since #70,
    // ADR-0071), a preview per tab with content, 준비 중 for the rest. 관심 시장 has its content
    // since #89 (ADR-0064): a fresh account's is empty.
    await expect(page.getByTestId('portfolio-available')).toHaveText('0 Coin');
    for (const key of ['positions', 'orders', 'history', 'wallet', 'watchlist']) {
      const preview = page.getByTestId(`my-preview-${key}`);
      await expect(preview).toBeVisible();
      await expect(preview.getByRole('link', { name: copy.myViewAll })).toBeVisible();
    }
    await expect(page.getByTestId('my-preview-watchlist')).toContainText(copy.watchlistEmpty);
    await expect(page.getByTestId('my-preview-watchlist-coming-soon')).toHaveCount(0);
    for (const key of ['posts', 'notifications']) {
      await expect(page.getByTestId(`my-preview-${key}-coming-soon`)).toHaveText(copy.comingSoon);
    }
    // The previews, 준비 중 ones included, run in the tab bar's order (the owner's; 설정 has
    // none), so 관심 시장 is not drawn above 내 글.
    const previews = await page
      .locator('[data-testid^="my-preview-"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
    expect(previews.filter((id) => TABS.some((tab) => id === `my-preview-${tab.key}`))).toEqual(
      TABS.filter((tab) => tab.key !== 'settings').map((tab) => `my-preview-${tab.key}`),
    );
    // A fresh account has never ordered, and 거래·정산 이력's 주문 이력 says that rather than that
    // none has finished (owner decision 2026-10-13); 대기 주문 keeps its own line.
    await expect(page.getByTestId('my-preview-history')).toContainText(copy.portfolioOrdersEmpty);
    await expect(page.getByTestId('my-preview-orders')).toContainText(
      copy.portfolioPendingOrdersEmpty,
    );
    // A member has no way into /admin.
    await expect(page.getByTestId('my-admin')).toHaveCount(0);

    // Every tab is one link away, marked as the page being shown once it is.
    const tabs = page.getByTestId('my-tabs');
    for (const tab of TABS) {
      await tabs.getByRole('link', { name: tab.label, exact: true }).click();
      await expect(page).toHaveURL(tab.href);
      await expect(page.getByTestId(`my-tab-${tab.key}`)).toHaveAttribute('aria-current', 'page');
    }
    await expect(page.getByTestId('account-email')).toBeVisible();

    // Opened by its address, the last tab is scrolled into the strip, which a phone starts at the
    // first tab; a click proves nothing here, since Playwright scrolls what it clicks.
    await page.goto('/my/settings');
    await expect
      .poll(() =>
        tabs.evaluate((strip) => {
          const tab = strip.querySelector('[aria-current="page"]');
          if (tab === null) return null;
          const s = strip.getBoundingClientRect();
          const t = tab.getBoundingClientRect();
          return t.left >= s.left - 1 && t.right <= s.right + 1;
        }),
      )
      .toBe(true);

    await tabs.getByRole('link', { name: copy.myHistory, exact: true }).click();
    const history = page.getByTestId('my-order-history');
    await expect(history).toContainText(copy.portfolioOrdersEmpty);
    await expect(history).not.toContainText(copy.portfolioOrderHistoryEmpty);

    await page.getByTestId('my-logout').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
  });

  test('MY를 연 채 세션이 끝나면 다음 탭으로 옮길 때 로그인으로 간다', async ({ page }) => {
    await signUp(page, freshEmail());
    await page.goto('/my/wallet');
    await expect(page.getByTestId('wallet-balance')).toBeVisible();

    // Another tab's logout or an expiry, as this tab sees it: the cookie is gone while the client
    // still holds the session it had. The MY layout is shared by the tabs and is not re-rendered
    // on a navigation between them, so this is the page's own gate (`requireMySession`).
    await page.context().clearCookies();
    await page
      .getByTestId('my-tabs')
      .getByRole('link', { name: copy.mySettings, exact: true })
      .click();
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/my/settings');
  });

  test('관리자에게는 MY 안에 관리자 진입이 있다', async ({ page, admin }) => {
    // The fixture verifies the seed admin's phone, so the onboarding gate lets it through.
    void admin;
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/my/settings');
    await page.getByTestId('my-admin').click();
    await expect(page).toHaveURL('/admin/users');
  });
});
