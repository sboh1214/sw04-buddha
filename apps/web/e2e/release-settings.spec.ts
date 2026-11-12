import type { APIResponse } from '@playwright/test';
import type { ReleaseSetting, ReleaseSettingStatus } from '@buddha/shared';
import { copy } from '../src/copy';
import { accountIdOf, adminAccount, expect, freshEmail, signIn, signUp, test } from './helpers';

/**
 * 출시 설정 (#170, ADR-0055) as the shipped build has it: twenty-one registered items — 시작 지급액
 * (`grant.start_coin`, #70, ADR-0071), 선행 마감 최소 간격 (`market.lead_close_gap`, #22,
 * ADR-0098), 이의 기간 (`market.dispute_window`, #152, ADR-0103), 주문 접수, 주문 속도 제한 and 가격
 * 보호 폭 표준값 (`order.*`, #119, ADR-0112 — the first a flag), three MM risk-stage items
 * (`market_maker.*`, #129, ADR-0124), and the six retention periods
 * (`retention.*` — #184's five, ADR-0087, and #77's market proposals, ADR-0089) — which the screen
 * and the API list alike, in the registry's order. Changing and recording an item are fixed by
 * the API suite with injected test items (`createTestApp({ releaseSettings })`), paying the start
 * Coin once a value is entered by the API and worker suites, deleting what a retention period has
 * kept by the worker's suite, the lead-close gap's use by the API suite
 * (admin-markets-times.controller.test.ts) and the dispute window's by the API and worker suites
 * (admin-market-judgements.controller.test.ts, market-resolve.test.ts); a browser cannot register
 * one.
 *
 * Nothing here changes an item. A value entered in a run would be paid by the worker to every
 * waiting grant — or, for an approved retention period, delete the records older than it at the
 * worker's next daily run; for the lead-close gap, decide which markets with an announcement time
 * may open — and stay for the runs after it, so the spec reads the status the database holds —
 * 미정 on a fresh one, as no migration or seed writes a value (docs/SETTINGS.md) — and checks the
 * screen against it. The suite writes eight values, by its global setup before any test
 * (global-setup.ts, 시험값 while each is 미정): the dispute window's 1분, the start Coin's 1,000,000
 * (since #116, the e2e accounts' only Coin) and the three order items — intake open, 20 orders a
 * minute and a width of 5 ticks (#119, `ensureOrderSettings`), plus the three explicit MM test
 * stage settings (#129). None of the eight is 미정 here, none changes while this spec reads the
 * list, and the 미정 count comes from the other items
 * alone. The change dialogs are opened and cancelled only.
 */

const LIST = '/api/v1/admin/release-settings';
const CHANGES = '/api/v1/admin/release-settings/changes';

/** The start grant's key (`START_COIN_SETTING`). */
const START_COIN_KEY = 'grant.start_coin';

/**
 * The lead-close gap's key (`LEAD_CLOSE_GAP_SETTING`, #22): how far a market's close must lead its
 * announcement time, in whole minutes.
 */
const LEAD_CLOSE_GAP_KEY = 'market.lead_close_gap';

/**
 * The dispute window's key (`DISPUTE_WINDOW_SETTING`, #152): how long after a 잠정 결과 is
 * published disputes are taken before the worker confirms it, in whole minutes.
 */
const DISPUTE_WINDOW_KEY = 'market.dispute_window';

/**
 * The order items (#119): 주문 접수 (`ORDER_ACCEPTING_SETTING`, true or false), 주문 속도 제한
 * (`ORDER_RATE_LIMIT_SETTING`, submissions a minute) and 가격 보호 폭 표준값
 * (`PRICE_PROTECTION_TICKS_SETTING`, ticks), with their names and units.
 */
const ORDER_ITEMS = [
  ['order.accepting', '주문 접수', null, 'boolean'],
  ['order.rate_limit', '주문 속도 제한', '회/분', 'integer'],
  ['order.price_protection_ticks', '가격 보호 폭 표준값', '틱', 'integer'],
] as const;

/** Global risk stages have explicit test values, never migration/seed defaults (#129). */
const MARKET_MAKER_ITEMS = [
  ['market_maker.reduce_at_bp', '마켓메이커 축소 시작 비율'],
  ['market_maker.halt_at_bp', '마켓메이커 중단 시작 비율'],
  ['market_maker.reduce_ratio_bp', '마켓메이커 축소 수량 비율'],
] as const;

/**
 * The retention periods (`RETENTION_PERIOD_SETTINGS`, #184 and #77) with their names, restated:
 * these specs import only types from `@buddha/shared` (helpers.ts). Whole days each.
 */
const LIQUIDITY_ITEMS = [
  ['market_maker.default_budget_coin', '시장 유동성 예산 표준값', 'Coin', 'string'],
  ['market_maker.default_max_loss_coin', '시장 최대 손실 표준값', 'Coin', 'string'],
  ['market_maker.default_b', '시장 곡선 계수 b 표준값', '계약', 'number'],
  ['market_maker.default_levels', '시장 호가 단계 수 표준값', '단계', 'integer'],
  ['market_maker.default_quantity', '시장 단계별 호가 수량 표준값', '계약', 'integer'],
  ['market_maker.default_safety_ticks', '시장 안전 간격 표준값', '틱', 'integer'],
] as const;

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

/**
 * Every key the shipped registry holds, in its order (`RELEASE_SETTINGS`): the operating values
 * first, then the retention periods.
 */
const SHIPPED_KEYS = [
  START_COIN_KEY,
  LEAD_CLOSE_GAP_KEY,
  DISPUTE_WINDOW_KEY,
  ...ORDER_ITEMS.map(([key]) => key),
  ...LIQUIDITY_ITEMS.map(([key]) => key),
  ...MARKET_MAKER_ITEMS.map(([key]) => key),
  ...RETENTION_ITEMS.map(([key]) => key),
];

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
  test('관리자 메뉴에서 열면 시작 지급액·선행 마감 최소 간격·이의 기간, 주문·MM 각 세 항목·유동성 표준값 여섯·여섯 보존기간이 보이고, 미정만 보기는 그 상태대로 거른다', async ({
    page,
    admin,
  }) => {
    // The API: every registered item, including liquidity defaults and basis-point risk stages.
    const items = await dataOf<ReleaseSetting[]>(await admin.get(LIST));
    expect(items.map((item) => item.key)).toEqual(SHIPPED_KEYS);
    const startCoin = items.find((item) => item.key === START_COIN_KEY);
    if (startCoin === undefined) throw new Error('unreachable');
    expect(startCoin).toMatchObject({ key: START_COIN_KEY, label: '시작 지급액', unit: 'Coin' });
    expect(startCoin.valueSchema.type).toBe('integer');
    // Like the dispute window below, it has a value whatever the database (global-setup.ts, #116).
    expect(startCoin.status).not.toBe('undecided');
    const leadCloseGap = items.find((item) => item.key === LEAD_CLOSE_GAP_KEY);
    expect(leadCloseGap).toMatchObject({ label: '선행 마감 최소 간격', unit: '분' });
    expect(leadCloseGap?.valueSchema.type).toBe('integer');
    // The dispute window has a value whatever the database: the global setup entered one while it
    // was 미정 (global-setup.ts), or an earlier run or a developer did.
    const disputeWindow = items.find((item) => item.key === DISPUTE_WINDOW_KEY);
    expect(disputeWindow).toMatchObject({ label: '이의 기간', unit: '분' });
    expect(disputeWindow?.valueSchema.type).toBe('integer');
    expect(disputeWindow?.status).not.toBe('undecided');
    for (const [key, label, unit, type] of [...ORDER_ITEMS, ...LIQUIDITY_ITEMS]) {
      const item = items.find((entry) => entry.key === key);
      expect(item, key).toMatchObject({ key, label, unit });
      expect(item?.valueSchema.type, key).toBe(type);
    }
    // Only the three order settings are entered by ensureOrderSettings. Liquidity defaults
    // stay unseeded: their actual state/value is checked against the screen below.
    for (const [key] of ORDER_ITEMS) {
      expect(items.find((item) => item.key === key)?.status, key).not.toBe('undecided');
    }
    for (const [key, label] of RETENTION_ITEMS) {
      const item = items.find((entry) => entry.key === key);
      expect(item, key).toMatchObject({ key, label, unit: '일' });
      expect(item?.valueSchema.type, key).toBe('integer');
      // ADR-0069 decision 7, in each item's own words: only an approved value deletes.
      expect(item?.description, key).toContain('승인됨일 때만 지우고');
    }
    for (const [key, label] of MARKET_MAKER_ITEMS) {
      const item = items.find((entry) => entry.key === key);
      expect(item, key).toMatchObject({ key, label, unit: 'bp' });
      expect(item?.valueSchema.type, key).toBe('integer');
      expect(item?.status, key).not.toBe('undecided');
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
    // value is picked — the start grant's, the lead-close gap's in 분 and a retention period's in
    // 일 alike; cancelled, nothing is written.
    for (const [key, label, unit] of [
      [START_COIN_KEY, '시작 지급액', 'Coin'],
      [LEAD_CLOSE_GAP_KEY, '선행 마감 최소 간격', '분'],
      [RETENTION_ITEMS[0][0], RETENTION_ITEMS[0][1], '일'],
      [MARKET_MAKER_ITEMS[0][0], MARKET_MAKER_ITEMS[0][1], 'bp'],
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
    // Coin defaults use exact string text, while the curve accepts JSON numbers. No values
    // are saved: merely opening the first-market suggestion registry has no write effects.
    for (const [key, label, , type] of LIQUIDITY_ITEMS) {
      await page.getByTestId(`release-setting-edit-${key}`).click();
      const dialog = page.getByTestId('release-setting-dialog');
      await expect(dialog).toContainText(label);
      await dialog.getByTestId('release-setting-status-test').click();
      await expect(dialog.getByTestId('release-setting-value-input')).toBeVisible();
      if (type === 'string')
        await expect(dialog).not.toContainText(copy.adminReleaseSettingValueJsonHint);
      else await expect(dialog).toContainText(copy.adminReleaseSettingValueJsonHint);
      await dialog.getByTestId('release-setting-cancel').click();
      await expect(dialog).toHaveCount(0);
    }
    // The first flag (#119 주문 접수): one line of JSON too ('true' or 'false'), and no unit.
    await page.getByTestId(`release-setting-edit-${ORDER_ITEMS[0][0]}`).click();
    const flagDialog = page.getByTestId('release-setting-dialog');
    await expect(flagDialog).toContainText(ORDER_ITEMS[0][1]);
    await flagDialog.getByTestId('release-setting-status-test').click();
    const flagInput = flagDialog.getByTestId('release-setting-value-input');
    await expect(flagInput).toBeVisible();
    expect(await flagInput.evaluate((element) => element.tagName)).toBe('INPUT');
    await expect(
      flagDialog.getByText(copy.adminReleaseSettingValue, { exact: true }),
    ).toBeVisible();
    await flagDialog.getByTestId('release-setting-cancel').click();
    await expect(flagDialog).toHaveCount(0);
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
