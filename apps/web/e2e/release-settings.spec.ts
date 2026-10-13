import type { APIResponse } from '@playwright/test';
import { copy } from '../src/copy';
import { adminAccount, expect, freshEmail, signIn, signUp, test } from './helpers';

/**
 * 출시 설정 (#170, ADR-0055) as the shipped build has it: the registry is empty until the issues
 * that own the values register them (docs/SETTINGS.md), so the screen shows its empty state and
 * the API lists nothing. Registering, changing and recording an item are fixed by the API suite
 * with injected test items (`createTestApp({ releaseSettings })`); a browser cannot register one.
 */

const LIST = '/api/v1/admin/release-settings';
const CHANGES = '/api/v1/admin/release-settings/changes';

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

async function expectForbidden(response: APIResponse): Promise<void> {
  expect(response.status(), response.url()).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
}

test.describe('출시 설정 (#170)', () => {
  test('관리자 메뉴에서 열면 등록된 항목이 없다고 보이고, 미정만 보기에서도 같다', async ({
    page,
    admin,
  }) => {
    // The API agrees: no item, undecided or not, and no item to change.
    expect(await dataOf<unknown[]>(await admin.get(LIST))).toEqual([]);
    expect(await dataOf<unknown[]>(await admin.get(`${LIST}?status=undecided`))).toEqual([]);
    const unknown = await admin.patch(`${LIST}/e2e.unregistered`, {
      data: { status: 'undecided', reason: 'e2e' },
    });
    expect(unknown.status()).toBe(404);

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/markets');
    await page
      .getByTestId('admin-nav')
      .getByRole('link', { name: copy.adminReleaseSettings, exact: true })
      .click();
    await expect(page).toHaveURL('/admin/settings');

    const empty = page.getByTestId('release-settings-empty');
    await expect(empty).toHaveText(copy.adminReleaseSettingsEmpty);
    await expect(page.getByTestId('release-settings-count')).toHaveText('전체 0개 · 미정 0개');
    // The legend names all four statuses, so 설계 제안 and 시험값 never pass for 승인됨.
    const legend = page.getByTestId('release-settings-legend');
    for (const hint of [
      copy.adminReleaseSettingUndecidedHint,
      copy.adminReleaseSettingProposalHint,
      copy.adminReleaseSettingTestHint,
      copy.adminReleaseSettingApprovedHint,
    ]) {
      await expect(legend).toContainText(hint);
    }

    // 미정만 보기 on an empty registry still says the registry is empty, not that none is 미정.
    const toggle = page.getByTestId('release-settings-undecided-only');
    await toggle.getByText(copy.adminReleaseSettingsUndecidedOnly).click();
    await expect(toggle.locator('input')).toBeChecked();
    await expect(empty).toHaveText(copy.adminReleaseSettingsEmpty);
    await expect(page.locator('[data-testid^="release-setting-edit-"]')).toHaveCount(0);

    // Nothing can be changed, so a fresh database has no record; a persistent one may hold
    // records of a key a developer registered for a while — shown, either way, under its heading.
    const changes = page.getByTestId('release-setting-changes');
    await expect(
      changes.getByRole('heading', { name: copy.adminReleaseSettingChanges }),
    ).toBeVisible();
    await expect(
      changes
        .getByTestId('release-setting-changes-empty')
        .or(changes.locator('[data-testid^="release-setting-change-"]').first()),
    ).toBeVisible();
  });

  test('관리자가 아닌 계정은 /admin/settings를 열 수 없고, API는 목록·변경·기록을 거절한다', async ({
    page,
  }) => {
    // Signed out: the admin gate sends the visitor to sign in, and back here afterwards.
    await page.goto('/admin/settings');
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/settings');

    // A member: the admin layout sends it home without rendering the screen.
    await signUp(page, freshEmail());
    await page.goto('/admin/settings');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('release-settings')).toHaveCount(0);

    // And the API refuses the member whatever the screen does (N04 §6: the records included).
    await expectForbidden(await page.request.get(LIST));
    await expectForbidden(await page.request.get(`${LIST}?status=undecided`));
    await expectForbidden(await page.request.get(CHANGES));
    await expectForbidden(
      await page.request.patch(`${LIST}/e2e.unregistered`, {
        data: { status: 'undecided', reason: 'e2e' },
      }),
    );
  });
});
