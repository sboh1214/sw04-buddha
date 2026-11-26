import type { APIResponse, BrowserContext, Page } from '@playwright/test';
import type { ReleaseSetting, ReleaseSettingChangeResult } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  accountIdOf,
  adminAccount,
  changeReleaseSettingAs,
  expect,
  releaseSettingItem,
  secondAdminAccount,
  signIn,
  test,
} from './helpers';

/**
 * 출시 설정 변경의 묶음별 승인 (#331, ADR-0175; owner answers 331-1…331-7), on `/admin/settings`:
 *
 * - two admins: the first seed admin enters a value into a 미정 item that has no effect on any
 *   spec (`market_maker.default_quantity`, a suggestion for a new market's first liquidity form,
 *   which the global setup never enters); the dialog says it waits for another admin and its button
 *   reads 승인 요청; the item shows 승인 대기 and keeps 미정; its requester may only retract it (the
 *   API refuses their approval, `requester`); the second seed admin rejects it, the value stays;
 *   asked again, the second admin approves it and the value is in — the change log names who asked
 *   and who approved (2인 승인); back to 미정 is one admin's at once (1인 즉시, 331-5);
 * - one admin: lowering the re-grant's total cap (331-1) is applied at once and logged 1인 즉시;
 *   the global setup's value is put back by request and approval (a raise).
 *
 * A shard runs its tests one after another (`workers: 1`), so no other spec reads these two items
 * while they move, and each is put back whatever happens (`finally`).
 */

const QUANTITY_KEY = 'market_maker.default_quantity';
const CAP_KEY = 'grant.regrant_total_cap_coin';

async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/admin/settings');
  await expect(page.getByTestId('release-settings-legend')).toBeVisible();
}

/** Opens `key`'s change dialog and fills it. */
async function fillChange(
  page: Page,
  key: string,
  change: { status: ReleaseSetting['status']; value?: string; reason: string },
) {
  await page.getByTestId(`release-setting-edit-${key}`).click();
  const dialog = page.getByTestId('release-setting-dialog');
  await dialog.getByTestId(`release-setting-status-${change.status}`).click();
  if (change.value !== undefined) {
    await dialog.getByTestId('release-setting-value-input').fill(change.value);
  }
  await dialog.getByTestId('release-setting-reason').fill(change.reason);
  return dialog;
}

test.describe('출시 설정 변경의 묶음별 승인 (#331)', () => {
  test('미정에서 값을 넣는 것은 한 관리자가 요청하고 다른 관리자가 반려·승인하며, 미정으로 돌리기는 한 명이 바로 한다', async ({
    page,
    browser,
    baseURL,
    admin,
    secondAdmin,
  }) => {
    const admins = { requester: admin, approver: secondAdmin };
    const original = await releaseSettingItem(admin, QUANTITY_KEY);
    let second: BrowserContext | undefined;
    try {
      // Start 미정, whatever an earlier run left.
      if (original.status !== 'undecided' || original.pendingRequest !== null) {
        if (original.pendingRequest !== null) {
          await dataOf(
            await secondAdmin.post(
              `/api/v1/admin/release-settings/change-requests/${original.pendingRequest.id}/reject`,
              {
                data: {
                  reason: 'e2e: 앞선 실행의 요청 정리',
                  expectedAccountId: await accountIdOf(secondAdmin),
                },
              },
            ),
          ).catch(() => undefined);
        }
        await changeReleaseSettingAs(admins, QUANTITY_KEY, {
          status: 'undecided',
          reason: 'e2e: 시작 전 미정으로',
        });
      }

      await signIn(page, adminAccount.email, adminAccount.password);
      await openSettings(page);
      const row = page.getByTestId(`release-setting-${QUANTITY_KEY}`);
      await expect(row.getByTestId('release-setting-approval')).toContainText(
        copy.adminReleaseSettingRuleNoDirection,
      );

      // --- A asks: the dialog says it waits for another admin.
      const dialog = await fillChange(page, QUANTITY_KEY, {
        status: 'test',
        value: '20',
        reason: 'e2e: 유동성 표준값 요청 ADR-0175',
      });
      const path = dialog.getByTestId('release-setting-path');
      await expect(path).toHaveAttribute('data-path', 'two_admin');
      await expect(path).toContainText(copy.adminReleaseSettingPathTwo);
      await expect(dialog.getByTestId('release-setting-submit')).toHaveText(
        copy.adminReleaseSettingRequestSubmit,
      );
      await dialog.getByTestId('release-setting-submit').click();
      await expect(page.getByText(copy.adminReleaseSettingRequested)).toBeVisible();
      await expect(row.getByTestId('release-setting-pending')).toBeVisible();
      await expect(row.getByTestId('release-setting-status')).toHaveText('미정');
      const waiting = await releaseSettingItem(admin, QUANTITY_KEY);
      expect(waiting).toMatchObject({ status: 'undecided', value: null });
      const firstId = waiting.pendingRequest!.id;
      const request = page.getByTestId(`release-setting-request-${firstId}`);
      await expect(request).toContainText(copy.adminReleaseSettingRequestOwn);
      await expect(request.getByTestId('release-setting-request-retract')).toBeVisible();
      await expect(request.getByTestId('release-setting-request-approve')).toHaveCount(0);
      // The requester never decides their own request (API refusal, ADR-0056 결정 4).
      const own = await admin.post(
        `/api/v1/admin/release-settings/change-requests/${firstId}/approve`,
        { data: { reason: '스스로 승인', expectedAccountId: await accountIdOf(admin) } },
      );
      expect(own.status()).toBe(409);
      expect(await own.text()).toContain('requester');

      // --- B rejects it on the same screen: nothing changes.
      second = await browser.newContext({ baseURL });
      const secondPage = await second.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await openSettings(secondPage);
      const theirs = secondPage.getByTestId(`release-setting-request-${firstId}`);
      await expect(theirs.getByTestId('release-setting-request-retract')).toHaveCount(0);
      await theirs.getByTestId('release-setting-request-reason').fill('e2e: 값 재검토');
      await theirs.getByTestId('release-setting-request-reject').click();
      await expect(secondPage.getByText(copy.adminReleaseSettingRejectedToast)).toBeVisible();
      expect(await releaseSettingItem(admin, QUANTITY_KEY)).toMatchObject({
        status: 'undecided',
        value: null,
        pendingRequest: null,
      });

      // --- A asks again (API), B approves on screen: the value is in.
      const again = await dataOf<ReleaseSettingChangeResult>(
        await admin.patch(`/api/v1/admin/release-settings/${QUANTITY_KEY}`, {
          data: {
            status: 'test',
            value: 20,
            reason: 'e2e: 유동성 표준값 다시 요청 ADR-0175',
            expectedAccountId: await accountIdOf(admin),
          },
        }),
      );
      expect(again.outcome).toBe('requested');
      await secondPage.reload();
      const approveRow = secondPage.getByTestId(`release-setting-request-${again.request!.id}`);
      await approveRow.getByTestId('release-setting-request-reason').fill('e2e: 확인했습니다');
      await approveRow.getByTestId('release-setting-request-approve').click();
      await expect(secondPage.getByText(copy.adminReleaseSettingApprovedToast)).toBeVisible();
      const theirRow = secondPage.getByTestId(`release-setting-${QUANTITY_KEY}`);
      await expect(theirRow.getByTestId('release-setting-value')).toHaveText('20');
      await expect(theirRow.getByTestId('release-setting-status')).toHaveText('시험값');
      const approvedEntry = secondPage
        .getByTestId('release-setting-changes')
        .locator('[data-testid^="release-setting-change-"]')
        .filter({ hasText: QUANTITY_KEY })
        .first();
      await expect(approvedEntry.getByTestId('release-setting-change-path')).toHaveText(
        copy.adminReleaseSettingPathTwoBadge,
      );
      await expect(approvedEntry.getByTestId('release-setting-change-people')).toContainText(
        copy.adminReleaseSettingChangeRequester,
      );

      // --- back to 미정: one admin, at once (331-5).
      await page.reload();
      const back = await fillChange(page, QUANTITY_KEY, {
        status: 'undecided',
        reason: 'e2e: 미정으로 되돌림',
      });
      await expect(back.getByTestId('release-setting-path')).toHaveAttribute(
        'data-path',
        'one_admin',
      );
      await expect(back.getByTestId('release-setting-submit')).toHaveText(
        copy.adminReleaseSettingSubmit,
      );
      await back.getByTestId('release-setting-submit').click();
      await expect(page.getByText(copy.adminReleaseSettingSaved)).toBeVisible();
      const backEntry = page
        .getByTestId('release-setting-changes')
        .locator('[data-testid^="release-setting-change-"]')
        .filter({ hasText: QUANTITY_KEY })
        .first();
      await expect(backEntry.getByTestId('release-setting-change-path')).toHaveText(
        copy.adminReleaseSettingPathOneBadge,
      );
      expect(await releaseSettingItem(admin, QUANTITY_KEY)).toMatchObject({
        status: 'undecided',
        value: null,
      });
    } finally {
      await second?.close();
      const now = await releaseSettingItem(admin, QUANTITY_KEY);
      if (now.pendingRequest !== null) {
        const by =
          now.pendingRequest.requestedBy.id === (await accountIdOf(admin)) ? admin : secondAdmin;
        await by
          .post(`/api/v1/admin/release-settings/change-requests/${now.pendingRequest.id}/retract`, {
            data: { expectedAccountId: await accountIdOf(by) },
          })
          .catch(() => undefined);
      }
      if (now.status !== 'undecided') {
        await changeReleaseSettingAs(admins, QUANTITY_KEY, {
          status: 'undecided',
          reason: 'e2e: 미정으로 되돌림',
        });
      }
    }
  });

  test('재지급 누적 상한을 낮추는 것은 관리자 한 명이 바로 하고, 변경 기록에 1인 즉시로 남는다', async ({
    page,
    admin,
    secondAdmin,
  }) => {
    const original = await releaseSettingItem(admin, CAP_KEY);
    test.skip(
      original.status === 'undecided' || typeof original.value !== 'number',
      `${CAP_KEY} is 미정: global-setup.ts enters it`,
    );
    const lowered = String((original.value as number) - 1);
    try {
      await signIn(page, adminAccount.email, adminAccount.password);
      await openSettings(page);
      const dialog = await fillChange(page, CAP_KEY, {
        status: original.status,
        value: lowered,
        reason: 'e2e: 누적 상한 낮추기 ADR-0175',
      });
      const path = dialog.getByTestId('release-setting-path');
      await expect(path).toHaveAttribute('data-path', 'one_admin');
      await expect(path).toContainText(copy.adminReleaseSettingPathOne);
      await dialog.getByTestId('release-setting-submit').click();
      await expect(page.getByText(copy.adminReleaseSettingSaved)).toBeVisible();
      expect(await releaseSettingItem(admin, CAP_KEY)).toMatchObject({
        status: original.status,
        value: Number(lowered),
        pendingRequest: null,
      });
      const entry = page
        .getByTestId('release-setting-changes')
        .locator('[data-testid^="release-setting-change-"]')
        .filter({ hasText: CAP_KEY })
        .first();
      await expect(entry.getByTestId('release-setting-change-path')).toHaveText(
        copy.adminReleaseSettingPathOneBadge,
      );
    } finally {
      // A raise back: one admin asks, the other approves.
      await changeReleaseSettingAs({ requester: admin, approver: secondAdmin }, CAP_KEY, {
        status: original.status,
        value: original.value,
        reason: 'e2e: 누적 상한 되돌림',
      });
    }
  });
});
