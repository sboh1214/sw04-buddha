import type { APIResponse, Page, Response } from '@playwright/test';
import {
  formatCoin,
  type TreasuryIssueRequest,
  type TreasuryIssueWrite,
  type TreasuryIssuance,
} from '@buddha/shared';
import { copy } from '../src/copy';
import {
  accountIdOf,
  adminAccount,
  expect,
  secondAdminAccount,
  signIn,
  switchMeThenSessionTo,
} from './helpers';
import { test } from './treasury-fixture';

const ROOT = '/api/v1/admin/treasury';
async function dataOf<T>(response: APIResponse | Response): Promise<T> {
  expect(response.ok(), `Expected success at ${new URL(response.url()).pathname}`).toBe(true);
  return ((await response.json()) as { data: T }).data;
}
const sent = (page: Page, suffix: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${ROOT}${suffix}`,
  );
async function clearToasts(page: Page) {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}
async function showRequest(page: Page, id: string) {
  const row = page.getByTestId(`treasury-request-${id}`);
  const more = page.getByTestId('treasury-requests-more');
  for (let i = 0; i < 100; i++) {
    await expect(row.or(more).first()).toBeVisible();
    if (await row.isVisible()) return row;
    const fetched = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' && new URL(r.url()).pathname === `${ROOT}/issue-requests`,
    );
    await more.click();
    await fetched;
    await expect(page.locator('[data-testid="treasury-requests-more"][data-loading]')).toHaveCount(
      0,
    );
  }
  await expect(row).toBeVisible();
  return row;
}
async function requestOnScreen(page: Page, by: string, amountCoin: string, reason: string) {
  await clearToasts(page);
  await page.getByTestId('treasury-request-open').click();
  const dialog = page.getByTestId('treasury-request-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('treasury-request-dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('treasury-issue-amount').fill('1.5');
  await dialog.getByTestId('treasury-issue-reason').fill(reason);
  await expect(dialog.getByTestId('treasury-request-dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('treasury-issue-amount').fill(amountCoin);
  const response = sent(page, '/issue-requests');
  await dialog.getByTestId('treasury-request-dialog-confirm').click();
  const result = await response;
  expect(result.request().postDataJSON()).toEqual({ expectedAccountId: by, amountCoin, reason });
  const write = await dataOf<TreasuryIssueWrite>(result);
  expect(write.request).toMatchObject({
    amountCoin,
    reason,
    status: 'pending',
    ledgerEntryId: null,
  });
  await expect(dialog).toHaveCount(0);
  await expect(await showRequest(page, write.request.id)).toContainText(reason);
  return write.request;
}
async function decide(
  page: Page,
  request: TreasuryIssueRequest,
  action: 'reject' | 'retract',
  by: string,
  reason = '',
) {
  await clearToasts(page);
  await (
    await showRequest(page, request.id)
  )
    .getByTestId(`treasury-${action}-${request.id}`)
    .click();
  const dialog = page.getByTestId(`treasury-${action}-dialog`);
  await expect(dialog).toBeVisible();
  if (action !== 'retract') await dialog.getByTestId('treasury-decision-reason').fill(reason);
  const response = sent(page, `/issue-requests/${request.id}/${action}`);
  await dialog.getByTestId(`treasury-${action}-dialog-confirm`).click();
  const result = await response;
  expect(result.request().postDataJSON()).toEqual({
    expectedAccountId: by,
    ...(action === 'retract' ? {} : { reason }),
  });
  const write = await dataOf<TreasuryIssueWrite>(result);
  expect(write.request.status).toBe(action === 'retract' ? 'retracted' : 'rejected');
  expect(write.request.ledgerEntryId).toBeNull();
  await expect(dialog).toHaveCount(0);
}

test.describe('금고 발행의 2인 승인 (#129)', () => {
  test('금액과 사유를 고정하고 본인 승인을 막으며, 조회 실패에도 다른 관리자의 실제 발행 완료를 보존한다', async ({
    page,
    admin,
    secondAdmin,
    browser,
    baseURL,
    request,
  }) => {
    const firstId = await accountIdOf(admin);
    const secondId = await accountIdOf(secondAdmin);
    const otherContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
    });
    let pending: TreasuryIssueRequest | undefined;
    try {
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto('/admin/treasury');
      const reason = `비공개 금고 발행 근거 ${test.info().testId}`;
      pending = await requestOnScreen(page, firstId, '1234', reason);
      await expect(page.getByTestId(`treasury-approve-${pending.id}`)).toBeDisabled();
      expect(
        (
          await admin.post(`${ROOT}/issue-requests/${pending.id}/approve`, {
            data: { expectedAccountId: firstId, reason: '본인 승인 거절 확인' },
          })
        ).status(),
      ).toBe(409);

      const other = await otherContext.newPage();
      await signIn(other, secondAdminAccount.email, secondAdminAccount.password);
      await other.goto('/admin/treasury');
      await other.getByTestId('treasury-request-filter').selectOption('all');
      const detailPath = `${ROOT}/issue-requests/${pending.id}`;
      const isDetail = (url: URL) => url.pathname === detailPath;
      await other.route(isDetail, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL', message: 'unavailable' } }),
        }),
      );
      await (
        await showRequest(other, pending.id)
      )
        .getByTestId(`treasury-approve-${pending.id}`)
        .click();
      const dialog = other.getByTestId('treasury-approve-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(copy.errUnknown);
      await expect(dialog).not.toContainText(copy.treasuryIssueNotFound);
      await expect(dialog.getByTestId('treasury-approve-dialog-confirm')).toBeDisabled();
      await other.unroute(isDetail);
      await dialog.getByRole('button', { name: copy.retry, exact: true }).click();
      await expect(dialog.getByTestId('treasury-request-facts')).toContainText(reason);
      await expect(dialog.getByTestId('treasury-issue-amount')).toHaveCount(0);
      const decisionReason = '필요 재원을 확인하고 고정된 금액을 승인합니다.';
      await dialog.getByTestId('treasury-decision-reason').fill(decisionReason);
      let failedReads = 0;
      const isTreasury = (url: URL) => url.pathname === ROOT || url.pathname.startsWith(`${ROOT}/`);
      await other.route(isTreasury, (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        failedReads += 1;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL', message: 'unavailable' } }),
        });
      });
      const response = sent(other, `/issue-requests/${pending.id}/approve`);
      await dialog.getByTestId('treasury-approve-dialog-confirm').click();
      const result = await response;
      expect(result.request().postDataJSON()).toEqual({
        expectedAccountId: secondId,
        reason: decisionReason,
      });
      const write = await dataOf<TreasuryIssueWrite>(result);
      expect(write.request).toMatchObject({
        id: pending.id,
        amountCoin: '1234',
        status: 'approved',
      });
      expect(write.request.ledgerEntryId).not.toBeNull();
      await expect(dialog).toHaveCount(0);
      await expect(other.getByTestId(`treasury-request-${pending.id}`)).toContainText(
        copy.treasuryIssueApproved,
      );
      await expect(other.getByTestId('treasury-issuedCoin')).toContainText(
        formatCoin(BigInt(write.treasury.issuedCoin)),
      );
      await expect.poll(() => failedReads).toBeGreaterThan(0);
      expect(
        (
          await secondAdmin.post(`${ROOT}/issue-requests/${pending.id}/approve`, {
            data: { expectedAccountId: secondId, reason: decisionReason },
          })
        ).status(),
      ).toBe(409);
      await other.unroute(isTreasury);
      await other.reload();
      await expect(other.getByTestId(`treasury-issuance-${pending.id}`)).toContainText(reason);
      const completed = await dataOf<TreasuryIssuance[]>(await admin.get(`${ROOT}/history`));
      expect(completed.filter((row) => row.approvalId === pending!.id)).toHaveLength(1);
      expect((await request.get(ROOT)).status()).toBe(401);
      const anonymousPage = await request.get('/admin/treasury');
      expect(await anonymousPage.text()).not.toContain(reason);
    } finally {
      if (pending)
        await admin
          .post(`${ROOT}/issue-requests/${pending.id}/retract`, {
            data: { expectedAccountId: firstId },
          })
          .catch(() => undefined);
      await otherContext.close();
    }
  });

  test('반려·철회를 발행 없이 기록하고 화면 계정이 먼저 바뀌어도 이전 관리자의 작성 내용을 폐기한다', async ({
    page,
    admin,
    secondAdmin,
  }) => {
    const firstId = await accountIdOf(admin);
    const secondId = await accountIdOf(secondAdmin);
    const pending: TreasuryIssueRequest[] = [];
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.clock.install();
    await page.goto('/admin/treasury');
    try {
      const retracted = await requestOnScreen(page, firstId, '17', '철회할 발행 사유');
      pending.push(retracted);
      await decide(page, retracted, 'retract', firstId);
      const rejected = await requestOnScreen(page, firstId, '19', '반려할 발행 사유');
      pending.push(rejected);
      await clearToasts(page);
      await page.getByTestId('treasury-request-open').click();
      await page.getByTestId('treasury-issue-amount').fill('31');
      await page.getByTestId('treasury-issue-reason').fill('계정 전환 때 폐기할 사유');
      await switchMeThenSessionTo(
        page,
        { id: secondId, cookies: (await secondAdmin.storageState()).cookies },
        async () => {
          await expect(page.getByTestId('treasury-request-dialog')).toHaveCount(0);
        },
      );
      await page.getByTestId('treasury-request-open').click();
      await expect(page.getByTestId('treasury-issue-amount')).toHaveValue('');
      await expect(page.getByTestId('treasury-issue-reason')).toHaveValue('');
      await page.getByTestId('treasury-request-dialog-cancel').click();
      await decide(
        page,
        rejected,
        'reject',
        secondId,
        '추가 발행 필요성이 확인되지 않아 반려합니다.',
      );
      for (const proposal of pending) {
        const row = await dataOf<TreasuryIssueRequest>(
          await admin.get(`${ROOT}/issue-requests/${proposal.id}`),
        );
        expect(row.ledgerEntryId).toBeNull();
      }
    } finally {
      for (const proposal of pending)
        await admin
          .post(`${ROOT}/issue-requests/${proposal.id}/retract`, {
            data: { expectedAccountId: firstId },
          })
          .catch(() => undefined);
    }
  });
});
