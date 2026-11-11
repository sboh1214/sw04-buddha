import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import type { AdminMarket, Market, MarketLiquiditySettings, ReleaseSetting } from '@buddha/shared';
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
  test('최초 표준값은 상태를 함께 제안하고 늦은 조회가 직접 입력이나 저장값을 덮지 않는다', async ({
    page,
    admin,
  }) => {
    const market = await createDraftMarket(admin, { liquidity: false });
    await signIn(page, adminAccount.email, adminAccount.password);
    const settingsPath = '/api/v1/admin/release-settings';
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const writes: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() !== 'GET' &&
        new URL(request.url()).pathname === `${pathOf(market.id)}/liquidity-settings`
      )
        writes.push(request.method());
    });
    await page.route(
      (url) => url.pathname === settingsPath,
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        reads += 1;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const body = (await response.json()) as { data: ReleaseSetting[] };
        // A response fixture only: no global setting changes or economic defaults in the DB.
        body.data = body.data.map((row) =>
          row.key === 'market_maker.default_budget_coin'
            ? { ...row, status: 'test', value: '12000' }
            : row.key === 'market_maker.default_b'
              ? { ...row, status: 'proposal', value: 1e-100 }
              : row,
        );
        await gate;
        await route.fulfill({ response, json: body });
      },
    );
    try {
      await page.goto(`/admin/markets/${market.id}`);
      await page.getByTestId('market-liquidity-edit').click();
      await expect(page.getByTestId('market-liquidity-defaults-loading')).toBeVisible();
      await page
        .getByRole('button', { name: copy.marketLiquidityDefaultsManual, exact: true })
        .click();
      await fillSettings(page, TEST_MARKET_LIQUIDITY, '직접 입력한 시험 설정');
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === settingsPath);
      release();
      await response;
      await expect(page.getByTestId('market-liquidity-input-budgetCoin')).toHaveValue(
        TEST_MARKET_LIQUIDITY.budgetCoin,
      );
      await expect(page.getByTestId('market-liquidity-input-b')).toHaveValue(
        String(TEST_MARKET_LIQUIDITY.b),
      );
      await page.getByTestId('market-liquidity-dialog-cancel').click();
      expect(writes).toEqual([]);
      expect((await read(admin, market.id)).liquidity.current).toBeNull();
      await page.getByTestId('market-liquidity-edit').click();
      await expect(page.getByTestId('market-liquidity-input-budgetCoin')).toHaveValue('12000');
      await expect(page.getByTestId('market-liquidity-input-b')).toHaveValue('1e-100');
      await expect(page.getByTestId('market-liquidity-default-budgetCoin')).toContainText('시험값');
      await expect(page.getByTestId('market-liquidity-default-b')).toContainText('설계 제안');
      await expect(page.getByTestId('market-liquidity-input-maxLossCoin')).toHaveValue('');
      await expect(page.getByTestId('market-liquidity-dialog-confirm')).toBeDisabled();
      await fillSettings(page, TEST_MARKET_LIQUIDITY, '표준값과 구분해 저장하는 시험 설정');
      const saved = saveResponse(page, market.id);
      await page.getByTestId('market-liquidity-dialog-confirm').click();
      expect((await saved).status()).toBe(200);
      await expect(page.getByTestId('market-liquidity-dialog')).toHaveCount(0);
      const readCount = reads;
      await page.getByTestId('market-liquidity-edit').click();
      await expect(page.getByTestId('market-liquidity-input-budgetCoin')).toHaveValue(
        TEST_MARKET_LIQUIDITY.budgetCoin,
      );
      await expect(page.getByTestId('market-liquidity-defaults')).toHaveCount(0);
      expect(reads).toBe(readCount);
      expect(writes).toEqual(['POST']);
    } finally {
      release();
    }
  });

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
