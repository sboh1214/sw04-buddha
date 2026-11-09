import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page, Response } from '@playwright/test';
import type {
  AdminAccount,
  AdminMarket,
  AdminMarketConflictWrite,
  AdminRoleChange,
  MyDispute,
  Order,
  PlaceOrderResult,
  Position,
} from '@buddha/shared';
import { copy } from '../src/copy';
import { test } from './admin-role-fixture';
import {
  E2E_PASSWORD,
  adminAccount,
  closeMarket,
  createOpenMarket,
  expect,
  freshEmail,
  helperTraders,
  judgeMarket,
  leaveNoJudgement,
  meOf,
  pauseMarket,
  registerCorrection,
  registerJudgement,
  secondAdminAccount,
  sendJudgementDecision,
  sendJudgementRegistration,
  signIn,
  signUp,
} from './helpers';

const ADMINS = '/api/v1/admin/admins';
const marketPath = (id: string) => `/api/v1/admin/markets/${id}`;

async function dataOf<T>(response: APIResponse | Response): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}
function nextWrite(page: Page, path: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === path,
  );
}
async function letToastsGo(page: Page) {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}
async function marketOf(admin: APIRequestContext, id: string) {
  return dataOf<AdminMarket>(await admin.get(marketPath(id)));
}
async function revokeIfAdmin(admin: APIRequestContext, userId: string | undefined) {
  if (userId === undefined) return;
  const list = await dataOf<AdminAccount[]>(await admin.get(ADMINS));
  if (list.some((row) => row.id === userId)) {
    await dataOf(
      await admin.post(`${ADMINS}/${userId}/revoke`, {
        data: {
          expectedAccountId: (await meOf(admin)).id,
          reason: '이해관계 E2E 임시 관리자 정리',
        },
      }),
    );
  }
}
async function order(
  context: APIRequestContext,
  marketId: string,
  terms: {
    outcome?: 'YES' | 'NO';
    timeInForce?: 'gtc' | 'ioc';
    qty?: number;
    budgetCoin?: string;
    limitPriceCoin?: number;
  } = {},
  requestId = randomUUID(),
) {
  return context.post(`/api/v1/markets/${marketId}/orders`, {
    headers: { 'Idempotency-Key': requestId },
    data: {
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'gtc',
      limitPriceCoin: 50,
      ...(terms.budgetCoin === undefined ? { qty: 1 } : {}),
      ...terms,
      expectedAccountId: (await meOf(context)).id,
    },
  });
}
async function expectConflict(response: APIResponse) {
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({
    error: { code: 'FORBIDDEN', details: [{ path: ['conflict'], message: 'market_conflict' }] },
  });
}
async function approveOnScreen(page: Page, marketId: string, operatorId: string) {
  await letToastsGo(page);
  await page.getByTestId('market-judgement-approve').click();
  const dialog = page.getByTestId('market-judgement-approve-dialog');
  const confirm = dialog.getByTestId('market-judgement-approve-dialog-confirm');
  await dialog
    .getByTestId('market-judgement-approve-reason')
    .fill('출처와 정정 내용, 이해관계가 없음을 확인했습니다.');
  await dialog.getByTestId('market-judgement-approve-confirm-deadline').click();
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId('market-judgement-approve-confirm-conflict').click();
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.startsWith(`${marketPath(marketId)}/judgements/`) &&
      new URL(response.url()).pathname.endsWith('/approve'),
  );
  await confirm.click();
  const response = await sent;
  expect(response.request().postDataJSON()).toMatchObject({
    expectedAccountId: operatorId,
    noConflictConfirmed: true,
  });
  const result = await dataOf<AdminMarket>(response);
  await expect(dialog).toHaveCount(0);
  return result;
}

/** Real trades, role changes, declarations and decisions; no owner SQL or fabricated holdings. */
test.describe('시장 이해관계와 관리자 거래 배제 (#143)', () => {
  test('관리자 부여가 일반 주문만 취소하고 체결 이해관계를 표시하며 회수 뒤 이전 시장 주문을 거절한다', async ({
    admin,
    page,
    browser,
    baseURL,
  }) => {
    test.slow();
    const memberContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
      isMobile: page.viewportSize()?.width === 375,
    });
    const counterContext = await browser.newContext({ baseURL });
    let memberId: string | undefined;
    let judgedId: string | undefined;
    try {
      const member = await memberContext.newPage();
      const counter = await counterContext.newPage();
      const email = freshEmail();
      await signUp(member, email);
      await signUp(counter, freshEmail());
      memberId = (await meOf(member.request)).id;
      const filled = await createOpenMarket(admin);
      const resting = await createOpenMarket(admin);
      const held = await createOpenMarket(admin);
      judgedId = filled.id;
      await dataOf(await order(counter.request, filled.id, { outcome: 'NO', limitPriceCoin: 40 }));
      expect(
        await dataOf<PlaceOrderResult>(
          await order(member.request, filled.id, { timeInForce: 'ioc', limitPriceCoin: 99 }),
        ),
      ).toMatchObject({ order: { status: 'filled', filledQty: 1 } });
      const cancellable = (
        await dataOf<PlaceOrderResult>(await order(member.request, resting.id, { qty: 2 }))
      ).order;
      const preserved = (await dataOf<PlaceOrderResult>(await order(member.request, held.id)))
        .order;
      await pauseMarket(admin, held.id, 'ledger_failure', {
        note: '관리자 부여 중에도 원장 보류 주문을 유지합니다.',
      });
      const before = await meOf(member.request);
      const positionsBefore = await dataOf<Position[]>(
        await member.request.get('/api/v1/me/positions?status=open'),
      );

      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto('/admin/admins');
      await page.getByTestId('admin-grant-search').fill(email);
      await page.getByTestId('admin-grant-search-submit').click();
      await page
        .getByTestId('admin-grant-candidate')
        .filter({ hasText: email })
        .getByTestId('admin-grant-open')
        .click();
      const roleDialog = page.getByTestId('admin-role-dialog');
      const preview = roleDialog.getByTestId('admin-grant-preview');
      await expect(preview).toContainText(`${copy.adminGrantFilledMarkets}: 1`);
      await expect(preview).toContainText(`${copy.adminGrantLiveOrders}: 2`);
      await expect(preview).toContainText(`${copy.adminGrantHeldOrders}: 1`);
      await expect(roleDialog).toContainText(copy.adminGrantTradeNotice);
      await roleDialog
        .getByTestId('admin-role-reason')
        .fill('시장 체결 이력과 보류 주문을 확인하고 권한을 부여합니다.');
      const granted = nextWrite(page, ADMINS);
      await roleDialog.getByTestId('admin-role-submit').click();
      expect(await dataOf<AdminRoleChange>(await granted)).toMatchObject({
        tradeEffects: { filledMarketCount: 1, cancelledOrderCount: 1, heldOrderCount: 1 },
      });
      await expect(roleDialog).toBeHidden();
      expect(
        await dataOf<Order>(await member.request.get(`/api/v1/me/orders/${cancellable.id}`)),
      ).toMatchObject({ status: 'cancelled', cancelReason: 'admin_role' });
      expect(
        await dataOf<Order>(await member.request.get(`/api/v1/me/orders/${preserved.id}`)),
      ).toEqual(preserved);
      const after = await meOf(member.request);
      expect(BigInt(after.balance.availableCoin)).toBe(BigInt(before.balance.availableCoin) + 100n);
      expect(BigInt(after.balance.lockedCoin)).toBe(BigInt(before.balance.lockedCoin) - 100n);
      expect(
        await dataOf<Position[]>(await member.request.get('/api/v1/me/positions?status=open')),
      ).toEqual(positionsBefore);
      expect((await order(member.request, resting.id)).status()).toBe(403);

      await closeMarket(admin, filled.id);
      const pending = await registerJudgement(admin, filled.id);
      const requestId = pending.judgement.pending!.requestId;
      await member.goto(`/admin/markets/${filled.id}`);
      await expect(member.getByTestId('market-conflict-status')).toHaveText(
        copy.marketConflictFill,
      );
      await expectConflict(
        await sendJudgementDecision(member.request, filled.id, requestId, 'approve', {
          reason: '체결 이력이 있는 관리자의 승인 거절 확인',
          eventDeadlineConfirmed: true,
        }),
      );
      await letToastsGo(member);
      await member.getByTestId('market-judgement-approve').click();
      const blocked = member.getByTestId('market-judgement-approve-dialog');
      await expect(blocked).toContainText(copy.marketConflictRefused);
      await expect(
        blocked.getByTestId('market-judgement-approve-confirm-conflict'),
      ).toHaveAttribute('data-disabled', '');
      await expect(blocked.getByTestId('market-judgement-approve-dialog-confirm')).toBeDisabled();
      await blocked.getByTestId('market-judgement-approve-dialog-cancel').click();

      await page
        .getByTestId('admin-account-row')
        .filter({ hasText: email })
        .getByTestId('admin-account-revoke')
        .click();
      await expect(roleDialog).toContainText(copy.adminRevokeTradeNotice);
      await roleDialog
        .getByTestId('admin-role-reason')
        .fill('운영 교대를 마치고 회수 이전 시장의 거래 배제를 확인합니다.');
      const revoked = nextWrite(page, `${ADMINS}/${memberId}/revoke`);
      await roleDialog.getByTestId('admin-role-submit').click();
      await dataOf(await revoked);
      await expect(roleDialog).toBeHidden();
      await signIn(member, email, E2E_PASSWORD);
      const key = randomUUID();
      const terms = { timeInForce: 'ioc' as const, budgetCoin: '100' };
      const denied = await dataOf<PlaceOrderResult>(
        await order(member.request, resting.id, terms, key),
      );
      expect(denied).toMatchObject({
        replayed: false,
        order: {
          status: 'rejected',
          rejectReason: 'admin_role_revoked',
          filledQty: 0,
          unspentCoin: '100',
        },
      });
      expect(
        await dataOf<PlaceOrderResult>(await order(member.request, resting.id, terms, key)),
      ).toEqual({ order: denied.order, replayed: true });
      const later = await createOpenMarket(admin);
      const allowed = await dataOf<PlaceOrderResult>(await order(member.request, later.id));
      expect(allowed.order.status).toBe('open');
      await dataOf(
        await member.request.post(`/api/v1/me/orders/${allowed.order.id}/cancel`, {
          data: { expectedAccountId: memberId },
        }),
      );
    } finally {
      if (judgedId) await leaveNoJudgement(admin, judgedId);
      await revokeIfAdmin(admin, memberId);
      await memberContext.close();
      await counterContext.close();
    }
  });

  test('자진 신고가 대기 정정을 철회하고 수용 이의를 되돌리며 다른 두 관리자가 정정을 이어간다', async ({
    admin,
    secondAdmin,
    page,
    browser,
    baseURL,
  }) => {
    test.slow();
    const declaringContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
      isMobile: page.viewportSize()?.width === 375,
    });
    const decidingContext = await browser.newContext({
      baseURL,
      viewport: page.viewportSize() ?? undefined,
      isMobile: page.viewportSize()?.width === 375,
    });
    let declaringId: string | undefined;
    let marketId: string | undefined;
    let disputeId: string | undefined;
    try {
      const declaring = await declaringContext.newPage();
      const email = freshEmail();
      await signUp(declaring, email);
      declaringId = (await meOf(declaring.request)).id;
      const firstId = (await meOf(admin)).id;
      const secondId = (await meOf(secondAdmin)).id;
      await dataOf(
        await admin.post(ADMINS, {
          data: {
            userId: declaringId,
            expectedAccountId: firstId,
            reason: '이해관계 신고 흐름을 검증할 임시 관리자',
          },
        }),
      );
      const market = await createOpenMarket(admin);
      marketId = market.id;
      await closeMarket(admin, market.id);
      const [trader] = await helperTraders(admin);
      await signIn(page, adminAccount.email, adminAccount.password);
      const deciding = await decidingContext.newPage();
      await signIn(deciding, secondAdminAccount.email, secondAdminAccount.password);
      // Warm the screens before the one-minute dispute window begins.
      await declaring.goto(`/admin/markets/${market.id}`);
      await page.goto(`/admin/markets/${market.id}`);
      await deciding.goto(`/admin/markets/${market.id}`);
      await judgeMarket(admin, market.id);
      // A real eligible holder's dispute keeps this market provisional while UI decisions run.
      const dispute = await dataOf<MyDispute>(
        await trader.post(`/api/v1/markets/${market.id}/disputes`, {
          data: {
            expectedAccountId: (await meOf(trader)).id,
            judgementVersion: 1,
            links: [`https://example.com/e2e/conflicts/${market.id}`],
            reason: '출처 발표에 대한 이의를 검토해 주세요.',
          },
        }),
      );
      disputeId = dispute.id;
      await deciding.reload();
      await deciding.getByTestId(`market-judgement-dispute-${dispute.id}-accept`).click();
      const accept = deciding.getByTestId('market-dispute-accept-dialog');
      await accept
        .getByTestId('market-dispute-accept-dialog-reason')
        .fill('출처 발표가 달라 정정이 필요합니다.');
      await expect(accept.getByTestId('market-dispute-accept-dialog-confirm')).toBeDisabled();
      await accept.getByTestId('market-dispute-accept-confirm-conflict').click();
      const accepted = nextWrite(
        deciding,
        `${marketPath(market.id)}/disputes/${dispute.id}/accept`,
      );
      await accept.getByTestId('market-dispute-accept-dialog-confirm').click();
      const acceptedResponse = await accepted;
      expect(acceptedResponse.request().postDataJSON()).toMatchObject({
        noConflictConfirmed: true,
        expectedAccountId: secondId,
      });
      await dataOf(acceptedResponse);
      const pending = await registerCorrection(declaring.request, market.id);
      const requestId = pending.judgement.pending!.requestId;
      await declaring.reload();
      await expect(declaring.getByTestId('market-conflict-status')).toHaveText(
        copy.marketConflictNone,
      );
      await expect(declaring.getByTestId('market-judgement-pending')).toHaveAttribute(
        'data-correction',
        'true',
      );
      await letToastsGo(declaring);
      await declaring.getByTestId('market-conflict-declare').click();
      const dialog = declaring.getByTestId('market-conflict-declare-dialog');
      await expect(dialog).toContainText(copy.marketConflictDeclareHint);
      await expect(dialog.getByTestId('market-conflict-declare-dialog-confirm')).toBeDisabled();
      const reason = `발표 기관과 직접적인 이해관계가 있음을 신고합니다. ${market.tag}`;
      await dialog.getByTestId('market-conflict-reason').fill(reason);
      // The committed declaration must remove the old pending correction even if its follow-up
      // market GET fails. Only this tab's read is intercepted; the declaration is the real API.
      const marketRead = (url: URL) => url.pathname === marketPath(market.id);
      await declaring.route(marketRead, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await route.fulfill({
          status: 503,
          json: { error: { code: 'INTERNAL', message: 'temporary read failure' } },
        });
      });
      const sent = nextWrite(declaring, `${marketPath(market.id)}/conflicts`);
      await dialog.getByTestId('market-conflict-declare-dialog-confirm').click();
      const response = await sent;
      expect(response.request().postDataJSON()).toEqual({ expectedAccountId: declaringId, reason });
      const declared = await dataOf<AdminMarketConflictWrite>(response);
      expect(declared.conflicts.operator).toMatchObject({
        userId: declaringId,
        hasFill: false,
        conflicted: true,
        declaration: { reason },
      });
      expect(declared.market.judgement.pending).toBeNull();
      expect(
        declared.market.judgement.log.find((row) => row.requestId === requestId),
      ).toMatchObject({ status: 'retracted' });
      expect(declared.market.disputes.items.find((row) => row.id === dispute.id)?.status).toBe(
        'pending',
      );
      await expect(dialog).toHaveCount(0);
      await expect(declaring.getByTestId('market-judgement-pending')).toHaveCount(0);
      await expect(declaring.getByTestId('market-conflict-status')).toHaveText(
        copy.marketConflictDeclared,
      );
      await expect(declaring.getByTestId('market-conflict-declare')).toBeDisabled();
      await expect(declaring.getByTestId('market-conflicts')).toContainText(reason);
      await declaring.unroute(marketRead);
      for (const decision of ['accept', 'dismiss'] as const) {
        await expectConflict(
          await declaring.request.post(
            `${marketPath(market.id)}/disputes/${dispute.id}/${decision}`,
            {
              data: {
                expectedAccountId: declaringId,
                reason: '이해관계 신고 뒤 이의 결정이 거절됨을 확인합니다.',
                noConflictConfirmed: true,
              },
            },
          ),
        );
      }
      await expectConflict(
        await sendJudgementRegistration(declaring.request, market.id, {
          result: 'NO',
          correction: { baseVersion: 1, reason: '신고 뒤 등록 거절 확인' },
        }),
      );
      // A repeat cannot replace the permanent reason or create another declaration.
      const repeated = await dataOf<AdminMarketConflictWrite>(
        await declaring.request.post(`${marketPath(market.id)}/conflicts`, {
          data: { expectedAccountId: declaringId, reason: '바꾸려는 사유' },
        }),
      );
      expect(repeated.conflicts.declarations).toEqual(declared.conflicts.declarations);
      const alternate = await registerCorrection(admin, market.id);
      const alternateId = alternate.judgement.pending!.requestId;
      await expectConflict(
        await sendJudgementDecision(declaring.request, market.id, alternateId, 'approve', {
          reason: '신고 뒤 승인 거절 확인',
          eventDeadlineConfirmed: true,
        }),
      );
      await deciding.reload();
      await expect(deciding.getByTestId('market-conflict-status')).toHaveText(
        copy.marketConflictNone,
      );
      const corrected = await approveOnScreen(deciding, market.id, secondId);
      expect(corrected.judgement.current).toMatchObject({
        version: 2,
        result: 'NO',
        registeredBy: { id: firstId },
        approvedBy: { id: secondId },
      });
      const disputeHistory = await dataOf<MyDispute[]>(
        await trader.get('/api/v1/me/disputes?limit=100'),
      );
      expect(disputeHistory.find((row) => row.id === dispute.id)?.status).toBe(
        'closed_by_correction',
      );
      expect((await marketOf(admin, market.id)).judgement.pending).toBeNull();
    } finally {
      if (marketId) {
        await leaveNoJudgement(declaringContext.request, marketId);
        await leaveNoJudgement(admin, marketId);
        // If the scenario failed before correction approval, release only this test's dispute.
        if (disputeId) {
          await secondAdmin.post(`${marketPath(marketId)}/disputes/${disputeId}/dismiss`, {
            data: {
              expectedAccountId: (await meOf(secondAdmin)).id,
              reason: '실패한 이해관계 E2E의 이의 보류 정리',
              noConflictConfirmed: true,
            },
          });
        }
      }
      await revokeIfAdmin(admin, declaringId);
      await declaringContext.close();
      await decidingContext.close();
    }
  });
});
