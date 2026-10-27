import type { APIResponse } from '@playwright/test';
import type { AdminSmsStatus } from '@buddha/shared';
import { copy } from '../src/copy';
import { adminAccount, expect, freshEmail, logOut, signIn, signUp, test } from './helpers';

/**
 * SMS 발송 현황 (#183, owner decision 2026-10-18, second round, ADR-0070): an admin reads the counts
 * of the 본인확인 texts on /admin/sms — the last 24 hours against the service's daily limit, and
 * seven Korean days — and a member reads nothing. The suite's own sign-ups send texts through the
 * development sender while other workers send too, so a test can say that its own send is among
 * the counts, not what the totals are. Nor can it say that by the last 24 hours: that window
 * moves, and on a database kept between runs the sends of a run a day earlier leave it while
 * this one sends — as fast as new ones arrive when the two runs send alike. Today's Korean day
 * only grows while it lasts (a send row goes only when the provider refuses it, which the
 * development sender does only when Mailpit fails; the specs' refusals are answered in the
 * browser), so the growth is read there, unless the run crosses midnight in Seoul.
 */

const STATUS = '/api/v1/admin/sms/status';

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

/** The sends the screen shows for the last 24 hours: the `N` of `N / 500건`. */
function shownSends(text: string): number {
  const match = /^([\d,]+) \/ ([\d,]+)건$/.exec(text.trim());
  if (match === null) throw new Error(`not a count against the limit: ${text}`);
  return Number(match[1]!.replaceAll(',', ''));
}

/** A count the seven days' table shows: the `N` of `N건`. */
function shownCount(text: string): number {
  const match = /^([\d,]+)건$/.exec(text.trim());
  if (match === null) throw new Error(`not a count: ${text}`);
  return Number(match[1]!.replaceAll(',', ''));
}

test.describe('SMS 발송 현황 (#183)', () => {
  test('관리자가 메뉴에서 열면 최근 24시간과 7일의 발송 수가 보이고, 방금 한 본인확인이 오늘의 수에 든다', async ({
    page,
    admin,
  }) => {
    const before = await dataOf<AdminSmsStatus>(await admin.get(STATUS));
    expect(before.last24Hours.serviceLimit).toBe(500);
    expect(before.days).toHaveLength(7);
    const todayBefore = before.days[0]!;

    // A member signs up: its 본인확인 sends one text (the development sender, through Mailpit).
    await signUp(page, freshEmail());
    await logOut(page);

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/markets');
    await page
      .getByTestId('admin-nav')
      .getByRole('link', { name: copy.adminSms, exact: true })
      .click();
    await expect(page).toHaveURL('/admin/sms');

    const screen = page.getByTestId('admin-sms');
    await expect(screen).toContainText(copy.adminSmsIntro);
    const last24 = page.getByTestId('admin-sms-last-24-hours');
    await expect(last24).toContainText(copy.adminSmsLast24Hours);
    await expect(page.getByTestId('admin-sms-as-of')).toContainText(copy.adminSmsAsOf);
    // The sends counted against the 500: the member's text, seconds old, is one of them. Only
    // the shape and that it is there — the window moves (see above).
    await expect(page.getByTestId('admin-sms-sent')).toHaveText(/^[\d,]+ \/ 500건$/);
    expect(shownSends(await page.getByTestId('admin-sms-sent').innerText())).toBeGreaterThanOrEqual(
      1,
    );
    await expect(page.getByTestId('admin-sms-unknown')).toHaveText(/^[\d,]+건$/);
    await expect(page.getByTestId('admin-sms-refused')).toHaveText(/^[\d,]+건$/);
    for (const label of [copy.adminSmsSent, copy.adminSmsUnknown, copy.adminSmsRefused]) {
      await expect(last24).toContainText(label);
    }

    // Seven Korean days, newest first, today marked — the API's own, row for row.
    const rows = page.getByTestId('admin-sms-days').locator('tbody tr');
    await expect(rows).toHaveCount(7);
    await expect(rows.first()).toContainText(copy.adminSmsToday);
    const after = await dataOf<AdminSmsStatus>(await admin.get(STATUS));
    for (const day of after.days) {
      await expect(page.getByTestId(`admin-sms-day-${day.date}`)).toBeVisible();
    }

    // The member's text is in today's sends: read before the sign-up, on the screen after it,
    // and from the API after the screen. Across midnight in Seoul it may be in either day.
    const todayAfter = after.days[0]!;
    if (todayAfter.date === todayBefore.date) {
      expect(todayAfter.sent).toBeGreaterThanOrEqual(todayBefore.sent + 1);
      const todayRow = page.getByTestId(`admin-sms-day-${todayAfter.date}`);
      await expect(todayRow).toContainText(copy.adminSmsToday);
      const shownToday = shownCount(await todayRow.locator('td').nth(1).innerText());
      expect(shownToday).toBeGreaterThanOrEqual(todayBefore.sent + 1);
      expect(shownToday).toBeLessThanOrEqual(todayAfter.sent);
    } else {
      test.info().annotations.push({
        type: 'note',
        description: 'the run crossed midnight in Seoul: today’s growth is not compared',
      });
    }
    // Counts only: no number, name or account on the screen.
    await expect(screen).not.toContainText('@');
    await expect(screen).not.toContainText(/01[016789]\d{7,8}/);
  });

  test('관리자가 아닌 계정은 /admin/sms를 열 수 없고, API는 거절한다', async ({ page }) => {
    // Signed out: the admin gate sends the visitor to sign in, and back here afterwards.
    await page.goto('/admin/sms');
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/sms');

    // A member: the admin layout sends it home without rendering the screen.
    await signUp(page, freshEmail());
    await page.goto('/admin/sms');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('admin-sms')).toHaveCount(0);
    const refused = await page.request.get(STATUS);
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });
});
