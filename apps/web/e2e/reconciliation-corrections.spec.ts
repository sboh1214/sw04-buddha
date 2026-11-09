import type { APIResponse, Page, Response } from '@playwright/test';
import type {
  MemberReconciliationCorrection,
  ReconciliationCorrectionDetail,
  ReconciliationCorrectionRequest,
  ReconciliationRun,
} from '@buddha/shared';
import { formatCoin, userBalanceEventSchema, type UserBalanceEvent } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  adminAccount,
  secondAdminAccount,
  freshEmail,
  signIn,
  signUp,
  meOf,
  switchSessionTo,
  test,
  expect,
} from './helpers';
import { correctionBooks } from './reconciliation-correction-fixture';

const ROOT = '/api/v1/admin/reconciliation';
function watchBalanceSocket(page: Page) {
  const observed = { ready: false, events: [] as UserBalanceEvent[] };
  page.on('websocket', (socket) => {
    if (!socket.url().includes('EIO=')) return;
    socket.on('framereceived', (frame) => {
      const payload = String(frame.payload);
      if (payload.startsWith('40/ws,')) observed.ready = true;
      if (!payload.startsWith('42/ws,')) return;
      const [event, value] = JSON.parse(payload.slice('42/ws,'.length)) as [string, unknown];
      if (event !== 'user:balance') return;
      const parsed = userBalanceEventSchema.safeParse(value);
      if (parsed.success) observed.events.push(parsed.data);
    });
  });
  return observed;
}
async function dataOf<T>(response: APIResponse | Response): Promise<T> {
  expect(response.ok(), `Expected successful ${new URL(response.url()).pathname}`).toBe(true);
  return ((await response.json()) as { data: T }).data;
}
function post(page: Page, suffix: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${ROOT}${suffix}`,
  );
}
async function clearToasts(page: Page) {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}
async function showRequest(page: Page, id: string) {
  const row = page.getByTestId(`correction-request-${id}`);
  const more = page.getByTestId('correction-requests-more');
  for (let i = 0; i < 50; i++) {
    await expect(row.or(more).first()).toBeVisible();
    if (await row.isVisible()) return row;
    const next = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        new URL(r.url()).pathname === `${ROOT}/correction-requests`,
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="correction-requests-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(row).toBeVisible();
  return row;
}
async function requestOnScreen(page: Page, resultId: string, reason: string, userReason: string) {
  await clearToasts(page);
  const result = page.getByTestId(`correction-preview-${resultId}`);
  const more = page.getByTestId('reconciliation-results-more');
  for (let i = 0; i < 50 && !(await result.isVisible()); i++) {
    await expect(more.or(result).first()).toBeVisible();
    if (await result.isVisible()) break;
    await more.click();
    await expect(
      page.locator('[data-testid="reconciliation-results-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await result.click();
  const preview = page.getByTestId('correction-preview-dialog');
  await expect(preview).toBeVisible();
  const select = preview.locator('[data-testid^="correction-select-"]').first();
  await expect(select).toBeVisible();
  await select.click();
  const dialog = page.getByTestId('correction-request-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('correction-request-dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('correction-internal-reason').fill(reason);
  await expect(dialog.getByTestId('correction-request-dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('correction-user-reason').fill(userReason);
  const sent = post(page, `/results/${resultId}/correction-requests`);
  await dialog.getByTestId('correction-request-dialog-confirm').click();
  const response = await sent;
  const detail = await dataOf<ReconciliationCorrectionDetail>(response);
  const pending = detail.requests.find((row) => row.status === 'pending');
  expect(pending).toBeDefined();
  expect(response.request().postDataJSON()).toEqual({
    expectedAccountId: pending!.requestedBy.id,
    accountId: pending!.candidate.accountId,
    mode: pending!.candidate.mode,
    amountCoin: pending!.candidate.amountCoin,
    snapshotKey: pending!.candidate.snapshotKey,
    reason,
    userReason,
  });
  await expect(dialog).toHaveCount(0);
  await expect(await showRequest(page, pending!.id)).toContainText(userReason);
  return pending!;
}
async function decision(
  page: Page,
  request: ReconciliationCorrectionRequest,
  action: 'approve' | 'reject' | 'retract',
  reason?: string,
  beforeConfirm?: () => Promise<void>,
) {
  await clearToasts(page);
  const row = await showRequest(page, request.id);
  await row.getByTestId(`correction-${action}-${request.id}`).click();
  const dialog = page.getByTestId(`correction-${action}-dialog`);
  await expect(dialog).toBeVisible();
  if (action !== 'retract') await dialog.getByTestId('correction-decision-reason').fill(reason!);
  await beforeConfirm?.();
  const sent = post(
    page,
    `/results/${request.resultId}/correction-requests/${request.id}/${action}`,
  );
  await dialog.getByTestId(`correction-${action}-dialog-confirm`).click();
  return { response: await sent, dialog };
}

test.describe('감사 근거에 고정한 Coin 보정 (#93)', () => {
  test('두 관리자의 부족 잔고 복원은 정확히 차이만 더하고 원장을 보존하며 본인에게만 사유를 보인다', async ({
    browser,
    baseURL,
    page,
    admin,
    secondAdmin,
  }) => {
    test.slow();
    const books = await correctionBooks();
    const holderContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
    });
    const otherContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
    });
    let userId: string | undefined;
    let original: Awaited<ReturnType<typeof books.account>> | undefined;
    let pending: ReconciliationCorrectionRequest | undefined;
    const first = await meOf(admin);
    const internal = `관리자 전용 복원 근거 ${Date.now()}`;
    const visible = '누락된 Coin 잔고를 확인해 복원했습니다.';
    try {
      const holder = await holderContext.newPage();
      await signUp(holder, freshEmail());
      userId = (await meOf(holder.request)).id;
      original = await books.account(userId);
      expect(BigInt(original.available)).toBeGreaterThanOrEqual(10n);
      const ledgerBefore = await books.ledger(userId);
      await books.damage(original.id, -10n);
      let run = await dataOf<ReconciliationRun>(
        await admin.post(`${ROOT}/run`, {
          data: { expectedAccountId: first.id, target: { scope: 'account', userId } },
        }),
      );
      expect(run.result.passed).toBe(false);
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto('/admin/audit-failures');
      const other = await otherContext.newPage();
      await other.clock.install();
      await signIn(other, secondAdminAccount.email, secondAdminAccount.password);
      await other.goto('/admin/audit-failures');
      pending = await requestOnScreen(page, run.result.id, internal, visible);
      const own = await showRequest(page, pending.id);
      await expect(own.getByTestId(`correction-approve-${pending.id}`)).toBeDisabled();
      const self = await admin.post(
        `${ROOT}/results/${run.result.id}/correction-requests/${pending.id}/approve`,
        { data: { expectedAccountId: first.id, reason: '본인 승인 금지' } },
      );
      expect(self.status()).toBe(409);
      await dataOf((await decision(page, pending, 'retract')).response);
      pending = await requestOnScreen(page, run.result.id, internal, visible);
      await other.reload();
      await dataOf((await decision(other, pending, 'reject', '다시 확인해 주세요.')).response);
      expect((await books.account(userId)).available).toBe(
        String(BigInt(original.available) - 10n),
      );
      expect(
        await dataOf<MemberReconciliationCorrection[]>(
          await holder.request.get('/api/v1/me/reconciliation-corrections'),
        ),
      ).toEqual([]);
      await page.reload();
      pending = await requestOnScreen(page, run.result.id, internal, visible);
      // A second incident makes the fixed request stale, even though the operator list is open.
      await books.damage(original.id, -1n);
      run = await dataOf<ReconciliationRun>(
        await admin.post(`${ROOT}/run`, {
          data: { expectedAccountId: first.id, target: { scope: 'account', userId } },
        }),
      );
      await other.reload();
      await (
        await showRequest(other, pending.id)
      )
        .getByTestId(`correction-approve-${pending.id}`)
        .click();
      const stale = other.getByTestId('correction-approve-dialog');
      await expect(stale.getByTestId('correction-approve-dialog-refusal')).toContainText(
        copy.reconciliationCorrectionStale,
      );
      await expect(stale.getByTestId('correction-approve-dialog-confirm')).toBeDisabled();
      const refusedStale = await secondAdmin.post(
        `${ROOT}/results/${pending.resultId}/correction-requests/${pending.id}/approve`,
        {
          data: {
            expectedAccountId: (await meOf(secondAdmin)).id,
            reason: '변경 전 요청 거절 확인',
          },
        },
      );
      expect(refusedStale.status()).toBe(400);
      await stale.getByTestId('correction-approve-dialog-cancel').click();
      await dataOf((await decision(page, pending, 'retract')).response);
      await books.damage(original.id, 1n);
      run = await dataOf<ReconciliationRun>(
        await admin.post(`${ROOT}/run`, {
          data: { expectedAccountId: first.id, target: { scope: 'account', userId } },
        }),
      );
      await page.reload();
      pending = await requestOnScreen(page, run.result.id, internal, visible);
      // Typed decision state belongs to the displayed operator and is discarded on a real session switch.
      await other.reload();
      await (
        await showRequest(other, pending.id)
      )
        .getByTestId(`correction-approve-${pending.id}`)
        .click();
      const abandoned = other.getByTestId('correction-approve-dialog');
      await abandoned
        .getByTestId('correction-decision-reason')
        .fill('계정 전환 때 폐기할 내부 초안');
      const secondCookies = await otherContext.cookies();
      await switchSessionTo(other, { id: first.id, cookies: await page.context().cookies() });
      await expect(abandoned).toHaveCount(0);
      await switchSessionTo(other, { id: (await meOf(secondAdmin)).id, cookies: secondCookies });
      const balanceSocket = watchBalanceSocket(holder);
      await holder.goto('/my/wallet');
      await expect.poll(() => balanceSocket.ready).toBe(true);
      await expect(holder.getByTestId('wallet-available')).toHaveText(
        formatCoin(BigInt(original.available) - 10n),
      );
      await expect(holder.getByTestId('member-correction-history')).toContainText(
        copy.reconciliationCorrectionHistoryEmpty,
      );
      // Keep the recipient's existing document open for the committed balance event.
      await holder.evaluate(() => {
        (window as unknown as { correctionDocument: boolean }).correctionDocument = true;
      });
      await other.reload();
      const decided = await decision(
        other,
        pending,
        'approve',
        '다른 관리자가 원장과 부족액을 재확인했습니다.',
        async () => {
          // The committed POST must remove the pending row even if all following correction GETs fail.
          await other.route(
            (url) =>
              url.pathname === `${ROOT}/correction-requests` ||
              (url.pathname.endsWith('/corrections') &&
                url.pathname.startsWith(`${ROOT}/results/`)),
            (route) =>
              route.request().method() === 'GET'
                ? route.fulfill({
                    status: 503,
                    json: {
                      error: { code: 'INTERNAL_ERROR', message: 'E2E follow-up read unavailable' },
                    },
                  })
                : route.continue(),
          );
        },
      );
      const detail = await dataOf<ReconciliationCorrectionDetail>(decided.response);
      expect(detail.requests.find((row) => row.id === pending!.id)?.status).toBe('approved');
      await expect(decided.dialog).toHaveCount(0);
      await expect(other.getByTestId(`correction-request-${pending.id}`)).toHaveCount(0);
      await expect(other.getByTestId('admin-reconciliation-corrections')).toContainText(
        copy.adminMarketRefreshFailed,
      );
      await expect(holder.getByTestId('member-correction-history')).toContainText(visible);
      await expect(holder.getByTestId('wallet-available')).toHaveText(
        formatCoin(BigInt(original.available)),
      );
      expect(
        await holder.evaluate(
          () => (window as unknown as { correctionDocument: boolean }).correctionDocument,
        ),
      ).toBe(true);
      expect(await books.ledger(userId)).toEqual(ledgerBefore);
      expect((await books.account(userId)).available).toBe(original.available);
      const history = await dataOf<MemberReconciliationCorrection[]>(
        await holder.request.get('/api/v1/me/reconciliation-corrections'),
      );
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        mode: 'restore_actual',
        amountCoin: '10',
        balanceDeltaCoin: '10',
        userReason: visible,
      });
      expect(
        balanceSocket.events.some(
          (event) =>
            event.ledgerEntryId === history[0]!.eventId &&
            event.availableCoin === original!.available,
        ),
      ).toBe(true);
      expect(Object.keys(history[0]!).sort()).toEqual(
        [
          'id',
          'eventId',
          'mode',
          'amountCoin',
          'balanceDeltaCoin',
          'balanceAfterCoin',
          'userReason',
          'createdAt',
        ].sort(),
      );
      for (const secret of [internal, first.id, (await meOf(secondAdmin)).id, pending.id]) {
        expect(JSON.stringify(history)).not.toContain(secret);
        await expect(holder.getByTestId('member-correction-history')).not.toContainText(secret);
      }
      const ownOther = await dataOf<MemberReconciliationCorrection[]>(
        await secondAdmin.get('/api/v1/me/reconciliation-corrections'),
      );
      expect(ownOther.some((row) => row.id === history[0]!.id)).toBe(false);
      const anonymous = await browser.newContext({ baseURL });
      try {
        expect(
          (await anonymous.request.get('/api/v1/me/reconciliation-corrections')).status(),
        ).toBe(401);
      } finally {
        await anonymous.close();
      }
      expect(
        (
          await dataOf<{ hold: { recoveredAt: string | null } }>(
            await admin.get(`${ROOT}/holds/${run.hold!.id}`),
          )
        ).hold.recoveredAt,
      ).toBeNull();
      await holder.reload();
      await expect(holder.getByTestId('wallet-available')).toHaveText(
        formatCoin(BigInt(original.available)),
      );
      await expect(holder.getByTestId('member-correction-history')).toContainText(visible);
    } finally {
      if (pending)
        await admin
          .post(`${ROOT}/results/${pending.resultId}/correction-requests/${pending.id}/retract`, {
            data: { expectedAccountId: first.id },
          })
          .catch(() => undefined);
      if (userId && original) {
        const now = await books.account(userId);
        if (now.ledger === original.ledger && BigInt(now.available) < BigInt(original.available))
          await books.damage(original.id, BigInt(original.available) - BigInt(now.available));
      }
      await holderContext.close();
      await otherContext.close();
      await books.close();
    }
  });

  test('금고 부족은 pending을 유지하고 재원 마련 뒤 같은 요청이 원장만 보충한다', async ({
    browser,
    baseURL,
    page,
    admin,
  }) => {
    test.slow();
    const books = await correctionBooks();
    const holderContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
    });
    const otherContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
    });
    const first = await meOf(admin);
    let userId: string | undefined;
    let original: Awaited<ReturnType<typeof books.account>> | undefined;
    let gap = 0n;
    let pending: ReconciliationCorrectionRequest | undefined;
    try {
      const holder = await holderContext.newPage();
      await signUp(holder, freshEmail());
      userId = (await meOf(holder.request)).id;
      original = await books.account(userId);
      gap = (await books.treasury()) + 10n;
      await books.damage(original.id, gap);
      const run = await dataOf<ReconciliationRun>(
        await admin.post(`${ROOT}/run`, {
          data: { expectedAccountId: first.id, target: { scope: 'account', userId } },
        }),
      );
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto('/admin/audit-failures');
      const userReason = '보관된 잔고와 장부의 차이를 확인해 기록을 보충했습니다.';
      pending = await requestOnScreen(page, run.result.id, '내부 원장 보충 근거', userReason);
      const other = await otherContext.newPage();
      await signIn(other, secondAdminAccount.email, secondAdminAccount.password);
      await other.goto('/admin/audit-failures');
      const refused = await decision(other, pending, 'approve', '금고 재원을 확인해 승인합니다.');
      expect(refused.response.status()).toBe(400);
      await expect(refused.dialog.getByTestId('correction-approve-dialog-refusal')).toContainText(
        copy.reconciliationCorrectionTreasuryWait,
      );
      const still = await dataOf<ReconciliationCorrectionDetail>(
        await admin.get(`${ROOT}/results/${run.result.id}/corrections`),
      );
      expect(still.requests.find((row) => row.id === pending!.id)?.status).toBe('pending');
      expect(await books.treasury()).toBe(gap - 10n);
      await books.fund(10n);
      const accepted = post(
        other,
        `/results/${run.result.id}/correction-requests/${pending.id}/approve`,
      );
      await refused.dialog.getByTestId('correction-approve-dialog-confirm').click();
      await dataOf(await accepted);
      expect(await books.treasury()).toBe(0n);
      expect((await books.account(userId)).available).toBe(
        String(BigInt(original.available) + gap),
      );
      await holder.goto('/my/wallet');
      await expect(holder.getByTestId('member-correction-history')).toContainText(userReason);
      await expect(holder.getByTestId('member-correction-balance-delta')).toHaveText(
        copy.reconciliationCorrectionNoBalanceChange,
      );
      await expect(holder.getByTestId('ledger-list')).toContainText(
        copy.reconciliationCorrectionReplenishHint,
      );
    } finally {
      if (pending)
        await admin
          .post(`${ROOT}/results/${pending.resultId}/correction-requests/${pending.id}/retract`, {
            data: { expectedAccountId: first.id },
          })
          .catch(() => undefined);
      if (userId && original) {
        const now = await books.account(userId);
        if (
          now.ledger === original.ledger &&
          BigInt(now.available) === BigInt(original.available) + gap
        )
          await books.damage(original.id, -gap);
      }
      await holderContext.close();
      await otherContext.close();
      await books.close();
    }
  });
});
