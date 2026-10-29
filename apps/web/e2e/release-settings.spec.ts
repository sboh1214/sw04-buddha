import type { APIResponse } from '@playwright/test';
import type { ReleaseSetting, ReleaseSettingStatus } from '@buddha/shared';
import { copy } from '../src/copy';
import { accountIdOf, adminAccount, expect, freshEmail, signIn, signUp, test } from './helpers';

/**
 * 출시 설정 (#170, ADR-0055) as the shipped build has it: seven registered items — 시작 지급액
 * (`grant.start_coin`, #70, ADR-0071) and the six retention periods (`retention.*` — #184's five,
 * ADR-0087, and #77's market proposals, ADR-0089) — which the screen and the API list alike, in the registry's order. Changing and
 * recording an item are fixed by the API suite with injected test items (`createTestApp({
 * releaseSettings })`), paying the start Coin once a value is entered by the API and worker suites,
 * and deleting what a retention period has kept by the worker's suite; a browser cannot register
 * one.
 *
 * Nothing here changes an item. A value entered in a run would be paid by the worker to every
 * waiting grant — or, for an approved retention period, delete the records older than it at the
 * worker's next daily run — and stay for the runs after it, so the spec reads the status the
 * database holds — 미정 on a fresh one, as nothing writes a value (docs/SETTINGS.md) — and checks
 * the screen against it. The change dialogs are opened and cancelled only.
 */

const LIST = '/api/v1/admin/release-settings';
const CHANGES = '/api/v1/admin/release-settings/changes';

/** The start grant's key (`START_COIN_SETTING`). */
const START_COIN_KEY = 'grant.start_coin';

/**
 * The retention periods (`RETENTION_PERIOD_SETTINGS`, #184 and #77) with their names, restated:
 * these specs import only types from `@buddha/shared` (helpers.ts). Whole days each.
 */
const RETENTION_ITEMS = [
  ['retention.consent_records', '동의 기록 보존기간'],
  ['retention.phone_verification_records', '본인확인 기록 보존기간'],
  ['retention.deleted_posts', '지운 글 원문·수정 이력 보존기간'],
  ['retention.moderation_records', '신고·제재 기록 보존기간'],
  ['retention.removed_profile_items', '운영자가 지운 프로필 항목 보존기간'],
  // #77 (ADR-0087's owner decision 2026-10-24 13): a withdrawn account's market proposals, once
  // processed.
  ['retention.market_proposals', '시장 제안 기록 보존기간'],
] as const;

/** Every key the shipped registry holds, in its order (`RELEASE_SETTINGS`). */
const SHIPPED_KEYS = [START_COIN_KEY, ...RETENTION_ITEMS.map(([key]) => key)];

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
  test('관리자 메뉴에서 열면 시작 지급액과 여섯 보존기간이 보이고, 미정만 보기는 그 상태대로 거른다', async ({
    page,
    admin,
  }) => {
    // The API: the six items, as #70 and #184 registered them — whole numbers of Coin and of days.
    const items = await dataOf<ReleaseSetting[]>(await admin.get(LIST));
    expect(items.map((item) => item.key)).toEqual(SHIPPED_KEYS);
    const startCoin = items.find((item) => item.key === START_COIN_KEY);
    if (startCoin === undefined) throw new Error('unreachable');
    expect(startCoin).toMatchObject({ key: START_COIN_KEY, label: '시작 지급액', unit: 'Coin' });
    expect(startCoin.valueSchema.type).toBe('integer');
    for (const [key, label] of RETENTION_ITEMS) {
      const item = items.find((entry) => entry.key === key);
      expect(item, key).toMatchObject({ key, label, unit: '일' });
      expect(item?.valueSchema.type, key).toBe('integer');
      // ADR-0069 decision 7, in each item's own words: only an approved value deletes.
      expect(item?.description, key).toContain('승인됨일 때만 지우고');
    }
    for (const item of items)
      expect(item.status === 'undecided', item.key).toBe(item.value === null);
    const undecidedKeys = items
      .filter((item) => item.status === 'undecided')
      .map((item) => item.key);
    expect(
      (await dataOf<ReleaseSetting[]>(await admin.get(`${LIST}?status=undecided`))).map(
        (item) => item.key,
      ),
    ).toEqual(undecidedKeys);
    const unknown = await admin.patch(`${LIST}/e2e.unregistered`, {
      data: { status: 'undecided', reason: 'e2e', expectedAccountId: await accountIdOf(admin) },
    });
    expect(unknown.status()).toBe(404);

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/markets');
    await page
      .getByTestId('admin-nav')
      .getByRole('link', { name: copy.adminReleaseSettings, exact: true })
      .click();
    await expect(page).toHaveURL('/admin/settings');

    // The screen: every item with its name, key, status, value and unit, in the registry's order —
    // and nothing else.
    await expect(page.getByTestId('release-settings-empty')).toHaveCount(0);
    await expect(page.getByTestId('release-settings-count')).toHaveText(
      `전체 ${String(SHIPPED_KEYS.length)}개 · 미정 ${String(undecidedKeys.length)}개`,
    );
    const editButtons = page.locator('[data-testid^="release-setting-edit-"]');
    await expect(editButtons).toHaveCount(SHIPPED_KEYS.length);
    expect(
      await editButtons.evaluateAll((buttons) =>
        buttons.map((button) =>
          button.getAttribute('data-testid')?.replace('release-setting-edit-', ''),
        ),
      ),
    ).toEqual(SHIPPED_KEYS);
    for (const item of items) {
      const row = page.getByTestId(`release-setting-${item.key}`);
      await expect(row).toContainText(item.label);
      await expect(row).toContainText(item.key);
      await expect(row).toContainText(item.description);
      await expect(row.getByTestId('release-setting-status')).toHaveText(STATUS_LABEL[item.status]);
      if (item.status === 'undecided') {
        await expect(row.getByTestId('release-setting-value')).toHaveText('—');
      }
      await expect(row).toContainText(`${copy.adminReleaseSettingUnit}${item.unit ?? '—'}`);
    }
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

    // A change dialog takes a value as one line of JSON (a whole number), once a status with a
    // value is picked — the start grant's and a retention period's alike, the period in 일;
    // cancelled, nothing is written.
    for (const [key, label, unit] of [
      [START_COIN_KEY, '시작 지급액', 'Coin'],
      [RETENTION_ITEMS[0][0], RETENTION_ITEMS[0][1], '일'],
    ] as const) {
      await page.getByTestId(`release-setting-edit-${key}`).click();
      const dialog = page.getByTestId('release-setting-dialog');
      await expect(dialog).toContainText(label);
      await dialog.getByTestId('release-setting-status-test').click();
      const valueInput = dialog.getByTestId('release-setting-value-input');
      await expect(valueInput).toBeVisible();
      expect(await valueInput.evaluate((element) => element.tagName)).toBe('INPUT');
      await expect(dialog).toContainText(`${copy.adminReleaseSettingValue}(${unit})`);
      await expect(dialog).toContainText(copy.adminReleaseSettingValueJsonHint);
      await dialog.getByTestId('release-setting-cancel').click();
      await expect(dialog).toHaveCount(0);
    }
    expect(await dataOf<ReleaseSetting[]>(await admin.get(LIST))).toEqual(items);

    // 미정만 보기 keeps the items that are 미정 and hides the rest, or says none is 미정.
    const toggle = page.getByTestId('release-settings-undecided-only');
    await toggle.getByText(copy.adminReleaseSettingsUndecidedOnly).click();
    await expect(toggle.locator('input')).toBeChecked();
    if (undecidedKeys.length === 0) {
      await expect(page.getByTestId('release-settings-empty')).toHaveText(
        copy.adminReleaseSettingsNoUndecided,
      );
    }
    for (const item of items) {
      await expect(page.getByTestId(`release-setting-${item.key}`)).toHaveCount(
        item.status === 'undecided' ? 1 : 0,
      );
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
    // Least of all the amount every waiting account would be paid (#70), or a period after which
    // the worker deletes records (#184).
    await expectForbidden(
      await page.request.patch(`${LIST}/${START_COIN_KEY}`, {
        data: { status: 'test', value: 1, reason: 'e2e' },
      }),
    );
    await expectForbidden(
      await page.request.patch(`${LIST}/${RETENTION_ITEMS[0][0]}`, {
        data: { status: 'approved', value: 1, reason: 'e2e' },
      }),
    );
  });
});
