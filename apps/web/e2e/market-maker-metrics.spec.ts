import type { APIRequestContext, APIResponse } from '@playwright/test';
import type {
  AdminMarketMakerMetrics,
  AdminMarketMakerMetricsOverview,
  Market,
  ReleaseSetting,
} from '@buddha/shared';
import { copy } from '../src/copy';
import { correctionFixtureUrls } from './reconciliation-correction-worker.mjs';
import {
  accountIdOf,
  adminAccount,
  createOpenMarket,
  expect,
  freshEmail,
  signIn,
  signUp,
  test,
} from './helpers';

const N_KEY = 'market_maker.concentration_top_n';
const SETTINGS = '/api/v1/admin/release-settings';
const LIST = '/api/v1/admin/market-makers';

async function dataOf<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `Expected success at ${new URL(response.url()).pathname}`).toBe(true);
  return ((await response.json()) as { data: T }).data;
}

async function setN(
  admin: APIRequestContext,
  expectedAccountId: string,
  state: 'test' | 'undecided',
) {
  await dataOf(
    await admin.patch(`${SETTINGS}/${N_KEY}`, {
      data: {
        status: state,
        ...(state === 'test' ? { value: 2 } : {}),
        reason: 'e2e: 전용 MM 지표 시험의 빈 보유 확인 및 미정 복원 (출시값 아님)',
        expectedAccountId,
      },
    }),
  );
}

/**
 * Required quotes-profile coverage, excluded by the default regression grep. The existing
 * global setup uses the real two-admin mint and explicit test stages; createOpenMarket uses
 * real review/allocation. No direct balances, orders, fills or production defaults are written.
 * The only extra fixture write is N=2, on this owned test DB, restored to undecided in finally.
 */
test.describe('현재 관리자 MM 지표 @market-maker-quotes', () => {
  test('목록·전체/금고·시장 지표는 조회만 하고 미정 N과 정상 빈 보유를 구분한다', async ({
    page,
    admin,
    request,
  }, testInfo) => {
    expect(testInfo.config.metadata.marketMakerProfile).toBe('quotes');
    expect(testInfo.config.workers).toBe(1);
    const { database } = correctionFixtureUrls();
    const original = (await dataOf<ReleaseSetting[]>(await admin.get(SETTINGS))).find(
      (item) => item.key === N_KEY,
    );
    expect(original).toMatchObject({ status: 'undecided', value: null });
    const expectedAccountId = await accountIdOf(admin);
    const market = await createOpenMarket(admin, { group: 'MM 현재지표' });
    const path = `/api/v1/admin/markets/${market.id}/market-maker/metrics`;
    await expect
      .poll(
        async () =>
          (await dataOf<AdminMarketMakerMetrics>(await admin.get(path))).depth.bot.YES.bids.length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    const metrics = await dataOf<AdminMarketMakerMetrics>(await admin.get(path));
    expect(metrics.risk.kind).toBe('ready');
    expect(metrics.concentration.setting).toMatchObject({ status: 'undecided', value: null });
    for (const side of [metrics.concentration.YES, metrics.concentration.NO])
      expect(side).toEqual({ totalQty: '0', topQty: null, topShareBp: null, holders: null });
    const overview = await dataOf<AdminMarketMakerMetricsOverview>(
      await admin.get(`${LIST}/overview`),
    );
    expect(overview.scope).toBe('funded_markets');
    expect(BigInt(overview.marketCount)).toBeGreaterThan(0n);
    expect(overview.complete).toBe(true);
    expect(overview.readyCount).toBe(overview.marketCount);
    expect(overview.treasury.status).toBe('ready');

    await signIn(page, adminAccount.email, adminAccount.password);
    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.continue();
      writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
      return route.abort('blockedbyclient');
    });
    await page.goto('/admin/markets');
    await page
      .getByTestId('admin-nav')
      .getByRole('link', { name: copy.adminMarketMakers, exact: true })
      .click();
    await expect(page).toHaveURL('/admin/market-makers');
    const summary = page.getByTestId('maker-metrics-overview');
    await expect(summary.getByTestId('maker-overview-completeness')).toHaveText(
      copy.makerMetricsComplete,
    );
    await expect(summary).toContainText(copy.makerMetricsCoverage);
    await expect(summary).toContainText(copy.makerMetricsAsOf);
    await expect(summary.getByTestId('treasury-balance')).toBeVisible();
    const row = page.getByTestId(`maker-metrics-market-${market.id}`);
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: market.title, exact: true }).click();
    await expect(page).toHaveURL(`/admin/markets/${market.id}`);
    const panel = page.getByTestId('market-maker-metrics-panel');
    await expect(panel.getByTestId('maker-metrics-risk')).toBeVisible();
    await expect(panel.getByTestId('maker-metrics-scenario-pnl')).toContainText('VOID');
    await expect(panel.getByTestId('maker-metrics-concentration')).toContainText(
      copy.makerMetricsTopNUndecided,
    );
    await expect(panel.getByTestId('maker-metrics-concentration')).not.toContainText('시험값 5');
    for (const actor of ['bot', 'human'])
      for (const outcome of ['YES', 'NO'])
        await expect(panel.getByTestId(`maker-depth-${actor}-${outcome}`)).toBeVisible();
    await expect(panel.getByRole('button')).toHaveCount(1);

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
    await expect(panel.getByTestId('maker-metrics-scenario-pnl')).toContainText('VOID');
    await page.unroute(match);

    // An explicit, reversible test-only setting exercises denominator-zero presentation.
    // APIRequestContext fixture writes are outside the read-only browser path above.
    try {
      await setN(admin, expectedAccountId, 'test');
      const withN = await dataOf<AdminMarketMakerMetrics>(await admin.get(path));
      expect(withN.concentration.setting).toMatchObject({ status: 'test', value: 2 });
      for (const side of [withN.concentration.YES, withN.concentration.NO])
        expect(side).toEqual({ totalQty: '0', topQty: '0', topShareBp: null, holders: [] });
      await panel.getByRole('button', { name: copy.retry, exact: true }).click();
      await expect(panel).not.toContainText(copy.adminMarketRefreshFailed);
      for (const outcome of ['YES', 'NO']) {
        const side = panel.getByTestId(`maker-concentration-${outcome}`);
        await expect(side).toContainText(copy.makerMetricsNoHolders);
        await expect(side).toContainText('—');
        await expect(side).not.toContainText(copy.makerMetricsTopUnavailable);
        await expect(side).not.toContainText('0.00%');
      }
    } finally {
      const current = (await dataOf<ReleaseSetting[]>(await admin.get(SETTINGS))).find(
        (item) => item.key === N_KEY,
      );
      if (current?.status !== 'undecided') await setN(admin, expectedAccountId, 'undecided');
    }
    expect(writes).toEqual([]);
    await expect
      .poll(() =>
        page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeLessThanOrEqual(1);

    const publicMarket = await dataOf<Market>(await request.get(`/api/v1/markets/${market.id}`));
    for (const key of ['risk', 'assets', 'capital', 'depth', 'concentration', 'runtime'])
      expect(publicMarket).not.toHaveProperty(key);
    const html = await (await request.get(`/markets/${market.slug}`)).text();
    expect(html).not.toContain('maker-metrics-concentration');
    expect(html).not.toContain('market-maker-current-metrics');
    await testInfo.attach('metrics-fixture', {
      body: JSON.stringify({
        database,
        marketId: market.id,
        slug: market.slug,
        title: market.title,
        nRestored: true,
      }),
      contentType: 'application/json',
    });
  });

  test('익명과 일반회원은 전체·상세 지표 API와 관리자 화면을 열 수 없다', async ({
    page,
    request,
  }) => {
    const paths = [
      LIST,
      `${LIST}/overview`,
      '/api/v1/admin/markets/00000000-0000-4000-8000-000000000001/market-maker/metrics',
    ];
    for (const path of paths) expect((await request.get(path)).status()).toBe(401);
    await page.goto('/admin/market-makers');
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/market-makers');
    await signUp(page, freshEmail());
    for (const path of paths) expect((await page.request.get(path)).status()).toBe(403);
    await page.goto('/admin/market-makers');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('admin-market-makers')).toHaveCount(0);
  });
});
