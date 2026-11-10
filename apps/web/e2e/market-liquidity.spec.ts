import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import type { AdminMarket, Market, MarketLiquiditySettings } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  REVIEW_CHECKLIST,
  TEST_MARKET_LIQUIDITY,
  accountIdOf,
  adminAccount,
  createDraftMarket,
  expect,
  secondAdminAccount,
  setMarketLiquidity,
  signIn,
  submitRefusedItems,
  test,
} from './helpers';

async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${response.status()} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}
const pathOf = (id: string) => `/api/v1/admin/markets/${id}`;
const read = (admin: APIRequestContext, id: string) =>
  admin.get(pathOf(id)).then(dataOf<AdminMarket>);

async function fillSettings(page: Page, settings: MarketLiquiditySettings, reason: string) {
  for (const [field, value] of Object.entries(settings)) {
    await page.getByTestId(`market-liquidity-input-${field}`).fill(String(value));
  }
  await page.getByTestId('market-liquidity-reason').fill(reason);
}
function saveResponse(page: Page, id: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${pathOf(id)}/liquidity-settings`,
  );
}

test.describe('시장별 운영 유동성 설정 (#72)', () => {
  test('명시적 두 버전과 검수 잠금, 승인 뒤 개장 버전을 보존하고 공개 API·SSR에는 싣지 않는다', async ({
    page,
    admin,
    browser,
    baseURL,
    request,
  }) => {
    const market = await createDraftMarket(admin, { liquidity: false });
    expect(await submitRefusedItems(admin, market.id)).toEqual(['liquidity']);
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/markets/${market.id}`);
    await expect(page.getByTestId('market-review-submit')).toBeDisabled();
    await expect(page.getByTestId('market-open-items')).toContainText(copy.openItemLiquidity);
    await page.getByTestId('market-liquidity-edit').click();
    await expect(page.getByTestId('market-liquidity-dialog')).toBeVisible();
    const reason1 = `비공개유동성첫근거${market.tag}`;
    await fillSettings(page, { ...TEST_MARKET_LIQUIDITY, maxLossCoin: '10001' }, reason1);
    await expect(page.getByTestId('market-liquidity-dialog-confirm')).toBeDisabled();
    await expect(page.getByTestId('market-liquidity-error-maxLossCoin')).toHaveText(
      copy.errMarketLiquidityMaxLoss,
    );
    await page
      .getByTestId('market-liquidity-input-maxLossCoin')
      .fill(TEST_MARKET_LIQUIDITY.maxLossCoin);
    const firstSave = saveResponse(page, market.id);
    await page.getByTestId('market-liquidity-dialog-confirm').click();
    const first = await firstSave;
    expect(first.status()).toBe(200);
    expect(first.request().postDataJSON()).toEqual({
      settings: TEST_MARKET_LIQUIDITY,
      baseVersion: null,
      reason: reason1,
      expectedAccountId: await accountIdOf(admin),
    });
    await expect(page.getByTestId('market-liquidity-current-version')).toContainText('1');
    await expect(page.getByTestId('market-review-submit')).toBeEnabled();

    await page.getByTestId('market-liquidity-edit').click();
    const secondSettings = { ...TEST_MARKET_LIQUIDITY, maxLossCoin: '4000' };
    const reason2 = `비공개유동성다음근거${market.tag}`;
    await fillSettings(page, secondSettings, reason2);
    const isDetail = (url: URL) => url.pathname === pathOf(market.id);
    let failedReads = 0;
    await page.route(isDetail, (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      failedReads += 1;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
      });
    });
    const secondSave = saveResponse(page, market.id);
    await page.getByTestId('market-liquidity-dialog-confirm').click();
    expect((await secondSave).status()).toBe(200);
    await expect(page.getByTestId('market-liquidity-current-version')).toContainText('2');
    await expect(page.getByTestId('market-liquidity-version-1')).toContainText(reason1);
    await expect(page.getByTestId('market-liquidity-version-2')).toContainText(reason2);
    await expect.poll(() => failedReads).toBeGreaterThan(0);
    await expect(page.getByTestId('liquidity-current-maxLossCoin')).toContainText('4,000');
    await page.unroute(isDetail);
    await page.reload();
    await page.getByTestId('market-review-submit').click();
    await expect(page.getByTestId('market-detail-status')).toHaveText(copy.marketStatusReview);
    await expect(page.getByTestId('market-liquidity-edit')).toHaveCount(0);
    await expect(page.getByTestId('market-liquidity-locked')).toHaveText(
      copy.marketLiquidityLocked,
    );
    await expect(page.getByTestId('market-review-approve')).toBeDisabled();

    const reviewer = await browser.newContext({ baseURL, viewport: page.viewportSize() });
    try {
      const reviewPage = await reviewer.newPage();
      await signIn(reviewPage, secondAdminAccount.email, secondAdminAccount.password);
      await reviewPage.goto(`/admin/markets/${market.id}`);
      await reviewPage.getByTestId('market-review-approve').click();
      const approval = reviewPage.getByTestId('market-review-approve-dialog');
      for (const item of REVIEW_CHECKLIST)
        await approval.getByTestId(`market-review-check-${item}`).click();
      await approval
        .getByTestId('market-review-approve-reason')
        .fill(`유동성과 규칙을 확인했습니다 ${market.tag}`);
      await approval.getByTestId('market-review-approve-dialog-confirm').click();
      await expect(reviewPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusOpen,
      );
      await expect(reviewPage.getByTestId('market-liquidity-edit')).toHaveCount(0);
      await expect(reviewPage.getByTestId('market-liquidity-opened-version')).toContainText('2');
      expect(
        await reviewPage.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    } finally {
      await reviewer.close();
    }

    const current = await read(admin, market.id);
    expect(current.liquidity.openedVersion).toBe(2);
    expect(current.liquidity.history.map((row) => row.version).sort()).toEqual([1, 2]);
    const refused = await admin.post(`${pathOf(market.id)}/liquidity-settings`, {
      data: {
        settings: TEST_MARKET_LIQUIDITY,
        baseVersion: 2,
        reason: '열린 시장 수정 거절',
        expectedAccountId: await accountIdOf(admin),
      },
    });
    expect(refused.status()).toBe(400);
    expect((await read(admin, market.id)).liquidity).toEqual(current.liquidity);
    const publicMarket = await dataOf<Market>(await request.get(`/api/v1/markets/${market.id}`));
    const html = await (await request.get(`/markets/${market.slug}`)).text();
    for (const secret of [
      'liquidity',
      'budgetCoin',
      'maxLossCoin',
      'safetyTicks',
      reason1,
      reason2,
    ]) {
      expect(JSON.stringify(publicMarket)).not.toContain(secret);
      expect(html).not.toContain(secret);
    }
  });

  test('다른 관리자의 최신 버전을 덮지 않고 계정이 바뀐 탭의 저장을 거절한다', async ({
    page,
    admin,
    secondAdmin,
  }) => {
    const market = await createDraftMarket(admin);
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/markets/${market.id}`);
    await page.getByTestId('market-liquidity-edit').click();
    const settings = { ...TEST_MARKET_LIQUIDITY, maxLossCoin: '3000' };
    await fillSettings(page, settings, `먼저 열어 둔 창 ${market.tag}`);
    const changed = await setMarketLiquidity(secondAdmin, market.id, {
      ...TEST_MARKET_LIQUIDITY,
      quantity: 12,
    });
    expect(changed.liquidity.current?.version).toBe(2);
    const stale = saveResponse(page, market.id);
    await page.getByTestId('market-liquidity-dialog-confirm').click();
    expect((await stale).status()).toBe(400);
    await expect(page.getByTestId('market-liquidity-dialog-refusal')).toHaveText(
      copy.marketLiquidityStale,
    );
    await expect(page.getByTestId('market-liquidity-input-maxLossCoin')).toHaveValue('3000');
    expect((await read(admin, market.id)).liquidity).toEqual(changed.liquidity);
    await page.getByTestId('market-liquidity-dialog-cancel').click();
    await page.reload();
    await page.getByTestId('market-liquidity-edit').click();
    await fillSettings(page, settings, `다른 계정에 넘기지 않을 사유 ${market.tag}`);
    // Change only the cookie: the still-visible form belongs to the first admin.
    await page.context().addCookies((await secondAdmin.storageState()).cookies);
    const mismatched = saveResponse(page, market.id);
    await page.getByTestId('market-liquidity-dialog-confirm').click();
    const answer = await mismatched;
    expect(answer.status()).toBe(403);
    const sent = answer.request().postDataJSON() as { expectedAccountId: string };
    expect(sent.expectedAccountId).toBe(await accountIdOf(admin));
    await expect(page.getByText(copy.sessionChanged).first()).toBeVisible();
    expect((await read(admin, market.id)).liquidity).toEqual(changed.liquidity);
  });
});
