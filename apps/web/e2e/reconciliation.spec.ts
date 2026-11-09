import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse, Locator, Page, Response } from '@playwright/test';
import type { AdminMarket, ReconciliationHoldDetail, ReconciliationRun } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  adminAccount,
  createOpenMarket,
  expect,
  meOf,
  pauseMarket,
  secondAdminAccount,
  signIn,
  test,
  workerProbeDisabled,
} from './helpers';

/**
 * #93 through real admin sessions and the worker. No owner SQL or fabricated mismatch is needed:
 * a manual ledger_failure pause closes without fills as CANCELLED, retaining its recovery hold.
 * A clean audit is evidence only; another administrator must approve the recovery. No order is
 * necessary for the hold, and no correction or Coin movement is part of these tests.
 */
const ROOT = '/api/v1/admin/reconciliation';
const CLOSE_WAIT_MS = 150_000;
const minuteIso = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString();

async function dataOf<T>(response: APIResponse | Response): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

function nextWrite(page: Page, path: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${ROOT}${path}`,
  );
}

async function letToastsGo(page: Page) {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

async function showHold(page: Page, holdId: string): Promise<Locator> {
  const row = page.getByTestId(`reconciliation-hold-${holdId}`);
  const more = page.getByTestId('reconciliation-holds-more');
  for (let count = 0; count < 50; count += 1) {
    await expect(more.or(row).first()).toBeVisible();
    if (await row.isVisible()) return row;
    const loaded = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `${ROOT}/holds`,
    );
    await more.click();
    await loaded;
    await expect(
      page.locator('[data-testid="reconciliation-holds-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(row).toBeVisible();
  return row;
}

async function runMarketOnScreen(
  page: Page,
  marketId: string,
  operatorId: string,
): Promise<ReconciliationRun> {
  await letToastsGo(page);
  await page.getByTestId('reconciliation-run').click();
  const dialog = page.getByTestId('reconciliation-run-dialog');
  await dialog.getByTestId('reconciliation-run-kind').selectOption('market');
  await dialog.getByTestId('reconciliation-run-id').fill(marketId);
  const sent = nextWrite(page, '/run');
  await dialog.getByTestId('reconciliation-run-dialog-confirm').click();
  const response = await sent;
  expect(response.request().postDataJSON()).toEqual({
    expectedAccountId: operatorId,
    target: { scope: 'market', marketId },
  });
  const result = await dataOf<ReconciliationRun>(response);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`reconciliation-result-${result.result.id}`).first()).toContainText(
    copy.reconciliationPassed,
  );
  return result;
}

async function requestRecovery(
  page: Page,
  hold: NonNullable<ReconciliationRun['hold']>,
  operatorId: string,
  reason: string,
) {
  const row = await showHold(page, hold.id);
  await letToastsGo(page);
  await row.getByTestId(`reconciliation-request-${hold.id}`).click();
  const dialog = page.getByTestId('reconciliation-request-dialog');
  await expect(dialog.getByTestId('reconciliation-request-dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('reconciliation-reason').fill(reason);
  const sent = nextWrite(page, `/holds/${hold.id}/recovery-requests`);
  await dialog.getByTestId('reconciliation-request-dialog-confirm').click();
  const response = await sent;
  expect(response.request().postDataJSON()).toEqual({
    expectedAccountId: operatorId,
    failureResultId: hold.failureResultId,
    reason,
  });
  const fresh = await dataOf<ReconciliationHoldDetail>(response);
  const pending = fresh.requests.find((request) => request.status === 'pending');
  if (!pending) throw new Error('Recovery request did not remain pending');
  await expect(dialog).toHaveCount(0);
  await expect(row.getByTestId(`reconciliation-pending-${pending.id}`)).toContainText(reason);
  return pending.id;
}

async function decideOnScreen(
  page: Page,
  holdId: string,
  requestId: string,
  action: 'approve' | 'reject' | 'retract',
  operatorId: string,
  reason?: string,
) {
  const row = await showHold(page, holdId);
  await letToastsGo(page);
  await row.getByTestId(`reconciliation-${action}-${requestId}`).click();
  const dialog = page.getByTestId(`reconciliation-${action}-dialog`);
  if (action !== 'retract') {
    await expect(dialog.getByTestId(`reconciliation-${action}-dialog-confirm`)).toBeDisabled();
    await dialog.getByTestId('reconciliation-reason').fill(reason!);
  }
  const sent = nextWrite(page, `/holds/${holdId}/recovery-requests/${requestId}/${action}`);
  await dialog.getByTestId(`reconciliation-${action}-dialog-confirm`).click();
  const response = await sent;
  expect(response.request().postDataJSON()).toEqual({
    expectedAccountId: operatorId,
    ...(action === 'retract' ? {} : { reason }),
  });
  const fresh = await dataOf<ReconciliationHoldDetail>(response);
  await expect(dialog).toHaveCount(0);
  return fresh;
}

async function marketOf(admin: APIRequestContext, marketId: string): Promise<AdminMarket> {
  return dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${marketId}`));
}

test.describe('장부 대사와 복구 (#93)', () => {
  test('관리자가 화면에서 정상 시장을 대사하고 대상이 없는 요청은 고쳐 다시 실행한다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const operatorId = (await meOf(admin)).id;
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/audit-failures');
    await expect(page.getByTestId('admin-reconciliation')).toBeVisible();
    await page.getByTestId('reconciliation-run').click();
    const dialog = page.getByTestId('reconciliation-run-dialog');
    await expect(dialog.getByTestId('reconciliation-run-dialog-confirm')).toBeDisabled();
    await dialog.getByTestId('reconciliation-run-id').fill(randomUUID());
    const refused = nextWrite(page, '/run');
    await dialog.getByTestId('reconciliation-run-dialog-confirm').click();
    expect((await refused).status()).toBe(404);
    await expect(dialog.getByTestId('reconciliation-run-dialog-refusal')).toContainText(
      copy.reconciliationNotFound,
    );
    await dialog.getByTestId('reconciliation-run-dialog-cancel').click();
    const result = await runMarketOnScreen(page, market.id, operatorId);
    expect(result).toMatchObject({
      result: { scope: 'market', marketId: market.id, source: 'manual', passed: true },
      hold: null,
    });
    expect((await marketOf(admin, market.id)).status).toBe('open');
  });

  test('주문 없는 원장 보류 시장도 워커 취소 뒤 대사와 2인 승인을 거쳐 복구하며 철회·반려는 보류를 유지한다', async ({
    admin,
    secondAdmin,
    page,
    browser,
    baseURL,
  }) => {
    test.skip(workerProbeDisabled(), 'The worker must close the paused market on schedule');
    test.slow();
    const first = await meOf(admin);
    const second = await meOf(secondAdmin);
    const otherContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
      isMobile: page.viewportSize()?.width === 375,
    });
    let holdId: string | undefined;
    try {
      // Warm both pages before setting the near close, so a cold build does not eat that window.
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto('/admin/audit-failures');
      const other = await otherContext.newPage();
      await signIn(other, secondAdminAccount.email, secondAdminAccount.password);
      await other.goto('/admin/audit-failures');
      const market = await createOpenMarket(admin, { closeAt: minuteIso(Date.now() + 90_000) });
      await pauseMarket(admin, market.id, 'ledger_failure', {
        note: `주문 없는 시장의 원장 복구 절차 확인 ${market.tag}`,
      });
      await expect
        .poll(async () => (await marketOf(admin, market.id)).status, {
          timeout: CLOSE_WAIT_MS,
          intervals: [1_000, 2_000],
        })
        .toBe('cancelled');
      const cancelled = await marketOf(admin, market.id);
      expect(cancelled).toMatchObject({ status: 'cancelled', tradeCount: 0, resolvedResult: null });
      expect(cancelled.pause.history[0]).toMatchObject({
        reason: 'ledger_failure',
        endKind: 'closed_at_close',
      });

      const checked = await runMarketOnScreen(page, market.id, first.id);
      expect(checked.result.passed).toBe(true);
      expect(checked.hold).toMatchObject({
        marketId: market.id,
        recoveredAt: null,
        legacyPauseId: cancelled.pause.history[0]!.id,
      });
      if (!checked.hold) throw new Error('Clean audit must retain the ledger recovery hold');
      holdId = checked.hold.id;

      let requestId = await requestRecovery(
        page,
        checked.hold,
        first.id,
        `첫 복구 요청 ${market.tag}`,
      );
      const row = await showHold(page, holdId);
      await expect(row.getByTestId(`reconciliation-approve-${requestId}`)).toBeDisabled();
      await expect(row.getByTestId(`reconciliation-reject-${requestId}`)).toBeDisabled();
      await expect(row.getByTestId(`reconciliation-retract-${requestId}`)).toBeEnabled();
      await expect(row).toContainText(copy.reconciliationOwnRequest);
      const self = await admin.post(
        `${ROOT}/holds/${holdId}/recovery-requests/${requestId}/approve`,
        { data: { expectedAccountId: first.id, reason: '본인 요청 승인 금지 확인' } },
      );
      expect(self.status()).toBe(409);
      expect(await self.json()).toMatchObject({
        error: { code: 'APPROVAL_NOT_ALLOWED', details: [{ message: 'requester' }] },
      });
      const retracted = await decideOnScreen(page, holdId, requestId, 'retract', first.id);
      expect(retracted.hold.recoveredAt).toBeNull();
      expect(retracted.requests.find((request) => request.id === requestId)?.status).toBe(
        'retracted',
      );

      requestId = await requestRecovery(
        page,
        checked.hold,
        first.id,
        `다른 관리자 반려 확인 ${market.tag}`,
      );
      await other.reload();
      const rejected = await decideOnScreen(
        other,
        holdId,
        requestId,
        'reject',
        second.id,
        '재검토 후 다시 요청해 주세요.',
      );
      expect(rejected.hold.recoveredAt).toBeNull();
      expect(rejected.requests.find((request) => request.id === requestId)?.status).toBe(
        'rejected',
      );

      await page.reload();
      requestId = await requestRecovery(
        page,
        checked.hold,
        first.id,
        `최종 복구 요청 ${market.tag}`,
      );
      await other.reload();
      const recovered = await decideOnScreen(
        other,
        holdId,
        requestId,
        'approve',
        second.id,
        '최신 대사가 통과했고 보류 해제가 맞습니다.',
      );
      expect(recovered.hold.recoveredAt).not.toBeNull();
      expect(recovered.latestResult).toMatchObject({ source: 'recovery', passed: true });
      expect(recovered.requests.find((request) => request.id === requestId)).toMatchObject({
        status: 'approved',
        decidedBy: { id: second.id },
      });
      await expect(other.getByTestId(`reconciliation-hold-${holdId}`)).toHaveCount(0);
      await other.getByTestId('reconciliation-hold-filter').selectOption('all');
      await expect(await showHold(other, holdId)).toContainText(copy.reconciliationRecovered);
      expect((await marketOf(admin, market.id)).status).toBe('cancelled');
    } finally {
      // Failed runs must not leave a pending request blocking a later local run.
      if (holdId) {
        const response = await admin.get(`${ROOT}/holds/${holdId}`).catch(() => undefined);
        if (response?.ok()) {
          const detail = await dataOf<ReconciliationHoldDetail>(response);
          for (const request of detail.requests.filter(
            (entry) => entry.status === 'pending' && entry.requestedBy.id === first.id,
          )) {
            await admin
              .post(`${ROOT}/holds/${holdId}/recovery-requests/${request.id}/retract`, {
                data: { expectedAccountId: first.id },
              })
              .catch(() => undefined);
          }
        }
      }
      await otherContext.close();
    }
  });
});
