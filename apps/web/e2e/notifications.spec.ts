import type { Locator, Page } from '@playwright/test';
import { copy } from '../src/copy';
import { expectNoExcludedText } from './acceptance';
import {
  REALTIME_BUDGET_MS,
  accountIdOf,
  approvePauseDecisionAsReviewer,
  closeMarket,
  createOpenMarket,
  expect,
  freshEmail,
  pauseMarket,
  requestPauseDecision,
  signUp,
  test,
} from './helpers';
import { notificationFixture } from './notification-fixture';

/**
 * 앱 내 알림함 (#53, ADR-0157; owner answers 53-1…53-11): MY › 알림, its preview on MY 요약, and
 * the unread count beside MY (the header from md, the bottom tabs below it) and on MY's 알림 tab.
 *
 * #53 ships no notification type and no producer (52-20), so a member's rows come from the native
 * fixture (notification-fixture.ts): the tests' own type through the real write path, which the
 * web draws with its category's fallback title ('시장 알림', 53-11 ④). Two members at most are
 * signed up here; the closed market's trade is the helper's own pair (`closeMarket`).
 */

/** One read of the count after the signal: what a second page may take past the realtime budget. */
const ONE_READ_MS = 5_000;

/** The API's page (`GET /me/notifications` with no limit). */
const PAGE = 20;

/** The unread count's read, as the browser asks it through the web's `/api` rewrite. */
const UNREAD_COUNT_PATH = '/api/v1/me/notifications/unread-count';

/** The count beside MY where this width shows it: the bottom tabs below md, the header from it. */
function myUnread(page: Page): Locator {
  const width = page.viewportSize()?.width ?? 0;
  return page.getByTestId(width < 768 ? 'bottom-tab-my-unread' : 'nav-primary-my-unread');
}

/** MY's link where this width shows it, found by its name — which the count leaves as 'MY'. */
function myLink(page: Page): Locator {
  const width = page.viewportSize()?.width ?? 0;
  const nav =
    width < 768
      ? page.getByTestId('bottom-tabs')
      : page.getByRole('navigation', { name: copy.navPrimary });
  return nav.getByRole('link', { name: copy.navMy, exact: true });
}

/** The 알림 tab of MY's tab bar, by its name. */
function notificationsTab(page: Page): Locator {
  return page.getByTestId('my-tabs').getByRole('link', { name: copy.myNotifications, exact: true });
}

/** The rows MY › 알림 draws, in order. */
function rows(page: Page): Locator {
  return page.getByTestId('my-notifications-list').getByTestId('notification-row');
}

/** The ids of the rows drawn, in order. */
function rowIds(page: Page): Promise<(string | null)[]> {
  return rows(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-notification-id')),
  );
}

function row(page: Page, id: string): Locator {
  return page.locator(`[data-testid="notification-row"][data-notification-id="${id}"]`);
}

/** Every count beside MY and on the 알림 tab: none is drawn. */
async function expectNoCount(page: Page): Promise<void> {
  for (const testId of [
    'nav-primary-my-unread',
    'bottom-tab-my-unread',
    'my-tab-notifications-unread',
  ]) {
    await expect(page.getByTestId(testId), testId).toHaveCount(0);
  }
  await expect(myLink(page)).not.toHaveAttribute('aria-describedby', /.+/);
}

/** The count beside MY reads `count`, and the link says so in words (its description). */
async function expectCount(page: Page, count: number): Promise<void> {
  await expect(myUnread(page)).toBeVisible();
  await expect(myUnread(page)).toHaveText(String(count));
  await expect(myLink(page)).toHaveAccessibleDescription(`안 읽은 알림 ${String(count)}개`);
}

test.describe('앱 내 알림함 (#53)', () => {
  test('알림이 없는 회원에게는 알림 탭과 요약이 알림이 없다고 말하고 안 읽은 수도 모두 읽음도 없다', async ({
    page,
  }) => {
    await signUp(page, freshEmail());
    // The count is read (and answers 0) before its absence is checked: an absence before the read
    // would prove nothing.
    const counted = page.waitForResponse(
      (response) => new URL(response.url()).pathname === UNREAD_COUNT_PATH && response.ok(),
    );
    await page.goto('/my/notifications');
    await counted;
    await expect(page.getByTestId('my-notifications-empty')).toHaveText(copy.notificationsEmpty);
    expect(copy.notificationsEmpty).toBe('알림이 없습니다.');
    await expect(page.getByTestId('my-notifications-read-all')).toBeDisabled();
    await expect(notificationsTab(page)).toHaveAttribute('aria-current', 'page');
    await expectNoCount(page);

    await page.goto('/my');
    const preview = page.getByTestId('my-preview-notifications');
    await expect(preview.getByTestId('my-preview-notifications-empty')).toHaveText(
      copy.notificationsEmpty,
    );
    await expect(
      preview.getByRole('link', { name: `${copy.myNotifications} ${copy.myViewAll}` }),
    ).toHaveAttribute('href', '/my/notifications');
    // No '모두 읽음' on the summary: it is the tab's (53-11 ②).
    await expect(preview.getByTestId('my-notifications-read-all')).toHaveCount(0);
    await expectNoCount(page);
  });

  test('로그인하지 않은 방문자는 알림 탭에서 로그인으로 간다', async ({ page }) => {
    await page.goto('/my/notifications');
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/my/notifications');
  });

  test('새 알림은 최신순으로 안 읽음 표시와 함께 보이고, 누르면 그 시장(마감·취소 포함)이 열리며 읽음이 되고, 모두 읽음은 다른 탭의 안 읽은 수도 지운다 @ac189-7 @ac189-11', async ({
    page,
    admin,
  }) => {
    test.slow(); // three markets through the review, one closed and one cancelled
    await signUp(page, freshEmail());
    const userId = await accountIdOf(page.request);

    // A 마감 market (the helper trades one pair first, so it closes rather than cancels), a 취소
    // one (조기 마감 with no fill — cancel.spec.ts' no-fill path) and an open one.
    const [closed, cancelled, open] = await Promise.all([
      createOpenMarket(admin),
      createOpenMarket(admin),
      createOpenMarket(admin),
    ]);
    expect((await closeMarket(admin, closed.id)).status).toBe('closed');
    await pauseMarket(admin, cancelled.id);
    await requestPauseDecision(admin, cancelled.id, 'early_close', { reviewResult: 'judgeable' });
    expect((await approvePauseDecisionAsReviewer(admin, cancelled.id)).status).toBe('cancelled');

    const fixture = await notificationFixture();
    try {
      // Oldest first: two about the closed market, one about the cancelled one, one about the open.
      const [closedFirst, closedSecond] = await fixture.notify({
        userId,
        slug: closed.slug,
        count: 2,
        label: '마감',
      });
      const [aboutCancelled] = await fixture.notify({
        userId,
        slug: cancelled.slug,
        count: 1,
        label: '취소',
      });
      const [aboutOpen] = await fixture.notify({
        userId,
        slug: open.slug,
        count: 1,
        label: '거래',
      });
      if (!closedFirst || !closedSecond || !aboutCancelled || !aboutOpen) {
        throw new Error('the fixture made fewer notifications than asked');
      }
      const newestFirst = [aboutOpen, aboutCancelled, closedSecond, closedFirst];

      // --- MY › 알림: newest first by 발생 시각 (53-3), every one unread and marked so, with its
      // time; the count beside MY and on the 알림 tab, its words the links' descriptions (53-1).
      await page.goto('/my/notifications');
      await expect(rows(page)).toHaveCount(4);
      expect(await rowIds(page)).toEqual(newestFirst);
      for (const id of newestFirst) {
        const each = row(page, id);
        await expect(each).toHaveAttribute('data-read', 'false');
        await expect(each).toContainText(copy.notificationUnread);
        await expect(each.getByTestId('notification-row-title')).toHaveText('시장 알림');
        await expect(each.getByTestId('notification-row-time')).not.toBeEmpty();
      }
      await expect(row(page, closedSecond)).toHaveAttribute('href', `/markets/${closed.slug}`);
      await expectCount(page, 4);
      await expect(page.getByTestId('my-tab-notifications-unread')).toHaveText('4');
      await expect(notificationsTab(page)).toHaveAccessibleDescription('안 읽은 알림 4개');
      await expect(page.getByTestId('my-notifications-read-all')).toBeEnabled();

      // --- MY 요약: the newest three, 전체 보기 to the tab (53-11 ②). Opening lists marks nothing.
      await page.goto('/my');
      const preview = page.getByTestId('my-preview-notifications');
      await expect(preview.getByTestId('notification-row')).toHaveCount(3);
      expect(
        await preview
          .getByTestId('notification-row')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-notification-id'))),
      ).toEqual(newestFirst.slice(0, 3));
      await expect(
        preview.getByRole('link', { name: `${copy.myNotifications} ${copy.myViewAll}` }),
      ).toHaveAttribute('href', '/my/notifications');
      await expectCount(page, 4);

      // --- Pressing one opens its market — 마감 (AC 4) — and marks it read (53-2), the count
      // beside MY following at once.
      await page.goto('/my/notifications');
      await row(page, closedSecond).click();
      await expect(page).toHaveURL(`/markets/${closed.slug}`);
      await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusClosed);
      await expectCount(page, 3);
      await page.goBack();
      await expect(page).toHaveURL('/my/notifications');
      await expect(row(page, closedSecond)).toHaveAttribute('data-read', 'true');
      await expect(row(page, closedSecond)).not.toContainText(copy.notificationUnread);
      await expect(row(page, closedFirst)).toHaveAttribute('data-read', 'false');
      // Read stays read when the page is opened again (AC 5).
      await page.reload();
      await expect(row(page, closedSecond)).toHaveAttribute('data-read', 'true');
      await expect(page.getByTestId('my-tab-notifications-unread')).toHaveText('3');

      // --- A 취소 market opens too (AC 4).
      await row(page, aboutCancelled).click();
      await expect(page).toHaveURL(`/markets/${cancelled.slug}`);
      await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusCancelled);
      await expectCount(page, 2);

      // --- A middle click opens it in a new tab and marks it read as well (53-11 ③).
      await page.goto('/my/notifications');
      await row(page, aboutOpen).click({ button: 'middle' });
      await expect(row(page, aboutOpen)).toHaveAttribute('data-read', 'true');
      await expectCount(page, 1);
      for (const other of page.context().pages()) if (other !== page) await other.close();

      // --- 모두 읽음 here: every row read and the count gone (53-2); another tab of the member
      // hears it through `user:notification` and drops its count too (53-1, no polling).
      const second = await page.context().newPage();
      try {
        await second.goto('/my');
        await expectCount(second, 1);
        // Its socket is in the member's room by now, or within the realtime budget.
        await second.waitForTimeout(REALTIME_BUDGET_MS);
        await page.getByTestId('my-notifications-read-all').click();
        await expect(
          page.locator('[data-testid="notification-row"][data-read="false"]'),
        ).toHaveCount(0);
        await expect(page.getByTestId('my-notifications-read-all')).toBeDisabled();
        await expectNoCount(page);
        await expect(myUnread(second)).toHaveCount(0, {
          timeout: REALTIME_BUDGET_MS + ONE_READ_MS,
        });
      } finally {
        await second.close();
      }

      // --- 더 보기: the next page in the same order (53-3).
      const later = await fixture.notify({ userId, slug: open.slug, count: 25, label: '더' });
      await page.reload();
      await expectCount(page, 25);
      await expect(rows(page)).toHaveCount(PAGE);
      await page.getByTestId('my-notifications-more').click();
      await expect(rows(page)).toHaveCount(25 + 4);
      expect(await rowIds(page)).toEqual([...later].reverse().concat(newestFirst));
      await expect(page.getByTestId('my-notifications-more')).toHaveCount(0);
      await expect(page.locator('[data-testid="notification-row"][data-read="false"]')).toHaveCount(
        25,
      );
      await expectNoExcludedText(page);
    } finally {
      await fixture.close();
    }
  });
});
