import type { APIResponse } from '@playwright/test';
import type { ReleaseSetting, ReleaseSettingStatus } from '@buddha/shared';
import { copy } from '../src/copy';
import { adminAccount, expect, freshEmail, signIn, signUp, test } from './helpers';

/**
 * 출시 설정 (#170, ADR-0055) as the shipped build has it: one registered item since #70 — 시작 지급액
 * (`grant.start_coin`, ADR-0071) — which the screen and the API list alike. Changing and recording
 * an item are fixed by the API suite with injected test items (`createTestApp({ releaseSettings
 * })`), and paying the start Coin once a value is entered by the API and worker suites; a browser
 * cannot register one.
 *
 * Nothing here changes the item. A value entered in a run would be paid by the worker to every
 * waiting grant and stay for the runs after it, so the spec reads the status the database holds —
 * 미정 on a fresh one, as nothing writes a value (docs/SETTINGS.md) — and checks the screen against
 * it. Its change dialog is opened and cancelled only.
 */

const LIST = '/api/v1/admin/release-settings';
const CHANGES = '/api/v1/admin/release-settings/changes';

/** The one key the shipped registry holds (`START_COIN_SETTING`). */
const START_COIN_KEY = 'grant.start_coin';

/**
 * The badge names (`RELEASE_SETTING_STATUS_LABELS`), restated: these specs import only types from
 * `@buddha/shared` (helpers.ts).
 */
const STATUS_LABEL: Readonly<Record<ReleaseSettingStatus, string>> = {
  undecided: '미정',
  proposal: '설계 제안',
  test: '시험값',
  approved: '승인됨',
};

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
  test('관리자 메뉴에서 열면 시작 지급액 하나가 보이고, 미정만 보기는 그 상태대로 거른다', async ({
    page,
    admin,
  }) => {
    // The API: the one item, as #70 registered it — a whole number of Coin.
    const items = await dataOf<ReleaseSetting[]>(await admin.get(LIST));
    expect(items.map((item) => item.key)).toEqual([START_COIN_KEY]);
    const [startCoin] = items;
    if (startCoin === undefined) throw new Error('unreachable');
    expect(startCoin).toMatchObject({ key: START_COIN_KEY, label: '시작 지급액', unit: 'Coin' });
    expect(startCoin.valueSchema.type).toBe('integer');
    const undecided = startCoin.status === 'undecided';
    expect(undecided).toBe(startCoin.value === null);
    expect(
      (await dataOf<ReleaseSetting[]>(await admin.get(`${LIST}?status=undecided`))).map(
        (item) => item.key,
      ),
    ).toEqual(undecided ? [START_COIN_KEY] : []);
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

    // The screen: the item with its name, key, status, value and unit — and nothing else.
    await expect(page.getByTestId('release-settings-empty')).toHaveCount(0);
    await expect(page.getByTestId('release-settings-count')).toHaveText(
      `전체 1개 · 미정 ${undecided ? '1' : '0'}개`,
    );
    await expect(page.locator('[data-testid^="release-setting-edit-"]')).toHaveCount(1);
    const row = page.getByTestId(`release-setting-${START_COIN_KEY}`);
    await expect(row).toContainText('시작 지급액');
    await expect(row).toContainText(START_COIN_KEY);
    await expect(row).toContainText(startCoin.description);
    await expect(row.getByTestId('release-setting-status')).toHaveText(
      STATUS_LABEL[startCoin.status],
    );
    if (undecided) await expect(row.getByTestId('release-setting-value')).toHaveText('—');
    await expect(row).toContainText(`${copy.adminReleaseSettingUnit}Coin`);
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

    // Its change dialog takes a value as one line of JSON (a whole number), once a status with a
    // value is picked; cancelled, nothing is written.
    await page.getByTestId(`release-setting-edit-${START_COIN_KEY}`).click();
    const dialog = page.getByTestId('release-setting-dialog');
    await expect(dialog).toContainText('시작 지급액');
    await dialog.getByTestId('release-setting-status-test').click();
    const valueInput = dialog.getByTestId('release-setting-value-input');
    await expect(valueInput).toBeVisible();
    expect(await valueInput.evaluate((element) => element.tagName)).toBe('INPUT');
    await expect(dialog).toContainText(copy.adminReleaseSettingValueJsonHint);
    await dialog.getByTestId('release-setting-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect((await dataOf<ReleaseSetting[]>(await admin.get(LIST)))[0]).toEqual(startCoin);

    // 미정만 보기 keeps the item while it is 미정 and otherwise says none is 미정.
    const toggle = page.getByTestId('release-settings-undecided-only');
    await toggle.getByText(copy.adminReleaseSettingsUndecidedOnly).click();
    await expect(toggle.locator('input')).toBeChecked();
    if (undecided) {
      await expect(row).toBeVisible();
    } else {
      await expect(page.getByTestId('release-settings-empty')).toHaveText(
        copy.adminReleaseSettingsNoUndecided,
      );
      await expect(row).toHaveCount(0);
    }

    // A fresh database has no record; a persistent one may hold records of changes a developer
    // made — shown, either way, under its heading.
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
    // Least of all the amount every waiting account would be paid (#70).
    await expectForbidden(
      await page.request.patch(`${LIST}/${START_COIN_KEY}`, {
        data: { status: 'test', value: 1, reason: 'e2e' },
      }),
    );
  });
});
