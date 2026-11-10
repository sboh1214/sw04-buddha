import type { APIResponse } from '@playwright/test';
import type { AdminMarketMaker, Market, OrderBook } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  TEST_MARKET_LIQUIDITY,
  adminAccount,
  createDraftMarket,
  expect,
  openThroughReview,
  setMarketLiquidity,
  signIn,
  test,
} from './helpers';

async function dataOf<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `Expected successful ${new URL(response.url()).pathname}`).toBe(true);
  return ((await response.json()) as { data: T }).data;
}

test('관리자 실행 관측은 미배정과 실제 개장을 구분하고 공개 API·SSR에는 나오지 않는다 @market-maker-quotes', async ({
  page,
  admin,
  request,
}) => {
  const market = await createDraftMarket(admin, { liquidity: false });
  const path = `/api/v1/admin/markets/${market.id}/market-maker`;
  const before = await dataOf<AdminMarketMaker>(await admin.get(path));
  expect(before.runtime).toBeNull();
  expect(before.lastOpenAttempt).toBeNull();
  expect(before.readiness.blockers).toEqual(
    expect.arrayContaining(['liquidity_missing', 'not_allocated']),
  );
  await signIn(page, adminAccount.email, adminAccount.password);
  await page.goto(`/admin/markets/${market.id}`);
  const panel = page.getByTestId('market-maker-panel');
  await expect(panel).toContainText(copy.marketMakerNoRuntime);
  await expect(panel).toContainText(copy.marketMakerNotAllocated);
  await expect(panel.getByRole('button')).toHaveCount(1);

  const privateReason = `운영설정비공개근거${market.tag}`;
  await setMarketLiquidity(admin, market.id, TEST_MARKET_LIQUIDITY, privateReason);
  await openThroughReview(admin, market.id);
  await expect
    .poll(
      async () =>
        (await dataOf<AdminMarketMaker>(await admin.get(path))).runtime?.lastSuccessAt ?? null,
      { timeout: 60_000 },
    )
    .not.toBeNull();
  const opened = await dataOf<AdminMarketMaker>(await admin.get(path));
  expect(opened.runtime).not.toBeNull();
  expect(opened.openedVersion).toBe(opened.config?.version);
  expect(opened.lastOpenAttempt?.succeededAt ?? null).not.toBeNull();
  expect(opened.readiness.blockers).not.toContain('not_allocated');
  // No person has submitted an order here. The public, anonymous book must expose actual
  // two-sided aggregated liquidity, while posting alone produces no fills or displayed price.
  await expect
    .poll(async () => {
      const book = await dataOf<OrderBook>(await request.get(`/api/v1/markets/${market.id}/book`));
      return (
        book.contracts.length === 2 &&
        book.contracts.every((contract) => contract.bids.length > 0 && contract.asks.length > 0)
      );
    })
    .toBe(true);
  await page.reload();
  await expect(panel.getByTestId('market-maker-last-open')).toContainText(
    copy.marketMakerOpenSucceeded,
  );
  await expect(panel).toContainText(copy.marketMakerLastSuccess);

  const match = (url: URL) => url.pathname === path;
  await page.route(match, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL', message: 'unavailable' } }),
    }),
  );
  await panel.getByRole('button', { name: copy.retry, exact: true }).click();
  await expect(panel).toContainText(copy.adminMarketRefreshFailed);
  await expect(panel.getByTestId('market-maker-last-open')).toContainText(
    copy.marketMakerOpenSucceeded,
  );
  await page.unroute(match);

  expect((await request.get(path)).status()).toBe(401);
  const publicMarket = await dataOf<Market>(await request.get(`/api/v1/markets/${market.id}`));
  expect(publicMarket).toMatchObject({ tradeCount: 0, volumeCoin: '0', lastPrice: null });
  for (const key of [
    'config',
    'liquidity',
    'runtime',
    'stageSettings',
    'readiness',
    'lastOpenAttempt',
  ])
    expect(publicMarket).not.toHaveProperty(key);
  expect(JSON.stringify(publicMarket)).not.toContain(privateReason);
  const html = await (await request.get(`/markets/${market.slug}`)).text();
  expect(html).not.toContain(privateReason);
  expect(html).not.toContain('market-maker-panel');
});
