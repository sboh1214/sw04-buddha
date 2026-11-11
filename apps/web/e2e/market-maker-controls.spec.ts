import type { APIResponse, Page, Response } from '@playwright/test';
import type { AdminMarketMaker, MarketMakerControlWrite, OrderBook } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  test,
  expect,
  accountIdOf,
  adminAccount,
  secondAdminAccount,
  createDraftMarket,
  openThroughReview,
  signIn,
} from './helpers';
async function data<T>(response: APIResponse | Response): Promise<T> {
  expect(response.ok(), new URL(response.url()).pathname).toBe(true);
  return ((await response.json()) as { data: T }).data;
}
function postResponse(page: Page, path: string) {
  return page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path,
  );
}
async function clearToasts(page: Page) {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

test('봇 정지·재개는 고정 요청과 다른 관리자의 승인으로 실행되고 503 뒤에도 완료가 유지된다 @market-maker-quotes', async ({
  page,
  admin,
  secondAdmin,
  request,
  browser,
  baseURL,
}) => {
  const market = await createDraftMarket(admin);
  await openThroughReview(admin, market.id);
  const root = `/api/v1/admin/markets/${market.id}/market-maker`;
  const first = await accountIdOf(admin);
  const second = await accountIdOf(secondAdmin);
  await expect
    .poll(
      async () =>
        (await data<AdminMarketMaker>(await admin.get(root))).runtime?.lastSuccessAt ?? null,
      { timeout: 60_000 },
    )
    .not.toBeNull();
  await signIn(page, adminAccount.email, adminAccount.password);
  await page.goto(`/admin/markets/${market.id}`);
  await page.getByTestId('maker-control-open-stop').click();
  const dialog = page.getByTestId('maker-control-request-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('maker-control-request-dialog-confirm')).toBeDisabled();
  const privateReason = `PRIVATE_CONTROL_${market.tag}`;
  await dialog.getByTestId('maker-control-reason').fill(privateReason);
  const sent = postResponse(page, `${root}/control-requests`);
  await dialog.getByTestId('maker-control-request-dialog-confirm').click();
  const response = await sent;
  expect(response.request().postDataJSON()).toMatchObject({
    expectedAccountId: first,
    baseVersion: 1,
    baseControlGeneration: '1',
    change: { action: 'stop' },
  });
  const pending = await data<MarketMakerControlWrite>(response);
  expect(
    (
      await admin.post(`${root}/control-requests/${pending.request.id}/approve`, {
        data: { expectedAccountId: first, reason: 'self denied' },
      })
    ).status(),
  ).toBe(409);
  await expect(page.getByTestId(`maker-control-approve-${pending.request.id}`)).toHaveCount(0);
  const context = await browser.newContext({ baseURL, viewport: page.viewportSize() ?? undefined });
  try {
    const other = await context.newPage();
    await signIn(other, secondAdminAccount.email, secondAdminAccount.password);
    await other.goto(`/admin/markets/${market.id}`);
    await other.getByTestId(`maker-control-approve-${pending.request.id}`).click();
    const approval = other.getByTestId('maker-control-approve-dialog');
    await expect(approval).toContainText(privateReason);
    await approval.getByTestId('maker-control-decision-reason').fill('독립 검토 후 정지');
    const block = (url: URL) =>
      url.pathname.startsWith(root) &&
      url.pathname !== `${root}/control-requests/${pending.request.id}/approve`;
    await other.route(block, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'INTERNAL', message: 'unavailable' } }),
          })
        : route.continue(),
    );
    const approved = postResponse(other, `${root}/control-requests/${pending.request.id}/approve`);
    await approval.getByTestId('maker-control-approve-dialog-confirm').click();
    const result = await approved;
    expect(result.request().postDataJSON()).toMatchObject({ expectedAccountId: second });
    const saved = await data<MarketMakerControlWrite>(result);
    expect(saved.marketMaker.runtime).toMatchObject({
      desiredEnabled: false,
      controlGeneration: '2',
    });
    await expect(approval).toHaveCount(0);
    await expect(other.getByTestId('maker-controls')).toContainText(copy.makerControlsReadFailed);
    await expect(other.getByTestId('market-maker-panel')).toContainText(copy.marketMakerDisabled);
    await other.unroute(block);
    await expect
      .poll(async () => {
        const book = await data<OrderBook>(await request.get(`/api/v1/markets/${market.id}/book`));
        return book.contracts.every((c) => c.bids.length === 0 && c.asks.length === 0);
      })
      .toBe(true);
    await page.reload();
    await clearToasts(page);
    await page.getByTestId('maker-control-open-resume').click();
    await dialog.getByTestId('maker-control-reason').fill('독립 승인으로만 재개');
    const resumedRequest = postResponse(page, `${root}/control-requests`);
    await dialog.getByTestId('maker-control-request-dialog-confirm').click();
    const resume = await data<MarketMakerControlWrite>(await resumedRequest);
    await other.reload();
    await other.getByTestId(`maker-control-approve-${resume.request.id}`).click();
    await approval.getByTestId('maker-control-decision-reason').fill('재개 조건 확인');
    const resumed = postResponse(other, `${root}/control-requests/${resume.request.id}/approve`);
    await approval.getByTestId('maker-control-approve-dialog-confirm').click();
    expect((await data<MarketMakerControlWrite>(await resumed)).marketMaker.runtime).toMatchObject({
      desiredEnabled: true,
      controlGeneration: '3',
    });
    await expect
      .poll(
        async () => {
          const book = await data<OrderBook>(
            await request.get(`/api/v1/markets/${market.id}/book`),
          );
          return book.contracts.every((c) => c.bids.length > 0 && c.asks.length > 0);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const pub = await request.get(`/api/v1/markets/${market.id}`);
    const html = await (await request.get(`/markets/${market.slug}`)).text();
    for (const value of [
      privateReason,
      pending.request.id,
      'controlGeneration',
      'demandSnapshot',
    ]) {
      expect(await pub.text()).not.toContain(value);
      expect(html).not.toContain(value);
    }
  } finally {
    await context.close();
  }
});

test('설정·고정 증액은 원본 근거를 남기고 낡은 요청은 반려·철회할 수 있다 @market-maker-quotes', async ({
  page,
  admin,
  secondAdmin,
}) => {
  const market = await createDraftMarket(admin);
  await openThroughReview(admin, market.id);
  const root = `/api/v1/admin/markets/${market.id}/market-maker`;
  const first = await accountIdOf(admin);
  const second = await accountIdOf(secondAdmin);
  await signIn(page, adminAccount.email, adminAccount.password);
  await page.goto(`/admin/markets/${market.id}`);
  await page.getByTestId('maker-control-open-settings').click();
  let dialog = page.getByTestId('maker-control-request-dialog');
  await dialog.getByTestId('maker-control-maxLossCoin').fill('4000');
  await dialog.getByTestId('maker-control-reason').fill('기존 곡선 보존 설정');
  let next = postResponse(page, `${root}/control-requests`);
  await dialog.getByTestId('maker-control-request-dialog-confirm').click();
  const setting = await data<MarketMakerControlWrite>(await next);
  const stale = await data<MarketMakerControlWrite>(
    await admin.post(`${root}/control-requests`, {
      data: {
        expectedAccountId: first,
        baseVersion: 1,
        baseControlGeneration: '1',
        reason: 'stale cleanup',
        change: { action: 'stop' },
      },
    }),
  );
  expect(
    (
      await secondAdmin.post(`${root}/control-requests/${setting.request.id}/approve`, {
        data: { expectedAccountId: second, reason: '독립 설정 검토' },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await secondAdmin.post(`${root}/control-requests/${stale.request.id}/approve`, {
        data: { expectedAccountId: second, reason: 'stale' },
      })
    ).status(),
  ).toBe(409);
  await page.reload();
  await page.getByTestId(`maker-control-retract-${stale.request.id}`).click();
  const retract = page.getByTestId('maker-control-retract-dialog');
  await expect(retract).toContainText(copy.makerControlsChanged);
  next = postResponse(page, `${root}/control-requests/${stale.request.id}/retract`);
  await retract.getByTestId('maker-control-retract-dialog-confirm').click();
  expect((await data<MarketMakerControlWrite>(await next)).request.status).toBe('retracted');
  await clearToasts(page);
  await page.getByTestId('maker-control-open-increase').click();
  dialog = page.getByTestId('maker-control-request-dialog');
  await dialog.getByTestId('maker-control-additionalCoin').fill('100');
  await dialog.getByTestId('maker-control-from').fill('2020-01-01T00:00');
  await dialog.getByTestId('maker-control-to').fill('2020-01-02T00:00');
  await dialog.getByTestId('maker-control-independentParticipants').fill('독립 참여');
  await dialog.getByTestId('maker-control-bidirectionalTrading').fill('양방향 확인');
  await dialog.getByTestId('maker-control-actualDemand').fill('실제 수요');
  await dialog.getByTestId('maker-control-reason').fill('고정 추가 예산');
  next = postResponse(page, `${root}/control-requests`);
  await dialog.getByTestId('maker-control-request-dialog-confirm').click();
  const increase = await data<MarketMakerControlWrite>(await next);
  expect(increase.request.payload.demandSnapshot?.fillCount).toBe('0');
  const approved = await data<MarketMakerControlWrite>(
    await secondAdmin.post(`${root}/control-requests/${increase.request.id}/approve`, {
      data: { expectedAccountId: second, reason: '정량 자동판정 아닌 독립 검토' },
    }),
  );
  expect(approved.marketMaker.config).toMatchObject({
    budgetCoin: '10100',
    maxLossCoin: '4000',
    version: 3,
    b: 100,
  });
  expect(approved.marketMaker.openedVersion).toBe(1);
  expect(approved.request.execution).toMatchObject({ additionalCoin: '100' });
});
