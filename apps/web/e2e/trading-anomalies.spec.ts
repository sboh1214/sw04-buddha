import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { PlaceOrderResult, ReleaseSetting, TradingAnomalyReport } from '@buddha/shared';
import { isReleaseSettingUnchanged } from '@buddha/shared';
import { copy } from '../src/copy';
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

const PATH = '/api/v1/admin/trading-anomalies';
const SETTINGS = '/api/v1/admin/release-settings';
// Explicit owned-test inputs, never seed/default/operating recommendations.
const VALUES = {
  'trading_anomaly.pair_min_fills': 2,
  'trading_anomaly.pair_window_seconds': 600,
  'trading_anomaly.pair_lookback_seconds': 3600,
  'trading_anomaly.round_trip_min_pairs': 1,
  'trading_anomaly.round_trip_window_seconds': 600,
  'trading_anomaly.round_trip_lookback_seconds': 3600,
};
async function dataOf<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `Expected success at ${new URL(response.url()).pathname}`).toBe(true);
  return ((await response.json()) as { data: T }).data;
}
async function order(
  context: APIRequestContext,
  marketId: string,
  terms: {
    outcome: 'YES' | 'NO';
    side: 'buy' | 'sell';
    qty: number;
    timeInForce: 'gtc' | 'ioc';
    limitPriceCoin: number;
  },
) {
  return dataOf<PlaceOrderResult>(
    await context.post(`/api/v1/markets/${marketId}/orders`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { ...terms, expectedAccountId: await accountIdOf(context) },
    }),
  );
}

test.describe('거래 패턴 검토 (#98)', () => {
  test('실제 사람 체결을 별도 계산하고 고정 근거를 읽으며 미정·실패·비공개 경계를 유지한다', async ({
    page,
    browser,
    admin,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    expect(testInfo.config.workers).toBe(1);
    const originals = (await dataOf<ReleaseSetting[]>(await admin.get(SETTINGS))).filter(
      (row) => row.key in VALUES,
    );
    expect(originals).toHaveLength(6);
    const expectedAccountId = await accountIdOf(admin);
    const change = async (
      key: string,
      status: ReleaseSetting['status'],
      value: ReleaseSetting['value'],
    ) => {
      const current = (await dataOf<ReleaseSetting[]>(await admin.get(SETTINGS))).find(
        (row) => row.key === key,
      );
      expect(current, `Expected registered setting ${key}`).toBeDefined();
      if (current && isReleaseSettingUnchanged(current, { status, value })) return;
      await dataOf(
        await admin.patch(`${SETTINGS}/${key}`, {
          data: {
            status,
            ...(status === 'undecided' ? {} : { value }),
            expectedAccountId,
            reason: 'e2e: 전용 DB 거래 패턴 조회 시험과 원래 설정 복원',
          },
        }),
      );
    };
    const otherContext = await browser.newContext();
    const operatorContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      const operator = await operatorContext.newPage();
      await signUp(page, freshEmail());
      await signUp(other, freshEmail());
      const a = await accountIdOf(page.request);
      const b = await accountIdOf(other.request);
      expect((await request.get(PATH)).status()).toBe(401);
      expect((await page.request.get(PATH)).status()).toBe(403);
      const market = await createOpenMarket(admin, { group: '거래 패턴' });
      await order(page.request, market.id, {
        outcome: 'NO',
        side: 'buy',
        qty: 2,
        timeInForce: 'gtc',
        limitPriceCoin: 40,
      });
      expect(
        (
          await order(other.request, market.id, {
            outcome: 'YES',
            side: 'buy',
            qty: 2,
            timeInForce: 'ioc',
            limitPriceCoin: 60,
          })
        ).order.filledQty,
      ).toBe(2);
      await order(other.request, market.id, {
        outcome: 'YES',
        side: 'sell',
        qty: 1,
        timeInForce: 'gtc',
        limitPriceCoin: 60,
      });
      expect(
        (
          await order(page.request, market.id, {
            outcome: 'YES',
            side: 'buy',
            qty: 1,
            timeInForce: 'ioc',
            limitPriceCoin: 60,
          })
        ).order.filledQty,
      ).toBe(1);
      await order(page.request, market.id, {
        outcome: 'YES',
        side: 'sell',
        qty: 1,
        timeInForce: 'gtc',
        limitPriceCoin: 60,
      });
      expect(
        (
          await order(other.request, market.id, {
            outcome: 'YES',
            side: 'buy',
            qty: 1,
            timeInForce: 'ioc',
            limitPriceCoin: 60,
          })
        ).order.filledQty,
      ).toBe(1);

      for (const key of Object.keys(VALUES)) await change(key, 'undecided', null);
      await signIn(operator, adminAccount.email, adminAccount.password);
      const writes: string[] = [];
      const reads: string[] = [];
      await operator.route('**/api/**', (route) => {
        const req = route.request();
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
          writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
          return route.abort('blockedbyclient');
        }
        if (new URL(req.url()).pathname === PATH) reads.push(req.url());
        return route.continue();
      });
      await operator.goto('/admin/markets');
      await operator
        .getByTestId('admin-nav')
        .getByRole('link', { name: copy.adminTradingAnomalies, exact: true })
        .click();
      await expect(operator).toHaveURL('/admin/trading-anomalies');
      await expect(operator.getByTestId('anomaly-empty')).toHaveText(copy.anomalyUnavailableEmpty);
      for (const [key, value] of Object.entries(VALUES)) await change(key, 'test', value);
      await operator.getByLabel(copy.anomalyMarketFilter, { exact: true }).fill(market.id);
      await operator.getByRole('button', { name: copy.anomalyApplyFilter, exact: true }).click();
      const report = await dataOf<TradingAnomalyReport>(
        await admin.get(`${PATH}?marketId=${market.id}`),
      );
      expect(report.source).toMatchObject({ scannedFills: 3, complete: true, truncated: false });
      expect(report.candidates.some((row) => row.kind === 'human_pair' && row.count === '3')).toBe(
        true,
      );
      expect(report.candidates.some((row) => row.kind === 'round_trip')).toBe(true);
      await expect(operator.getByTestId('anomaly-candidate')).toHaveCount(report.candidates.length);
      await expect(operator.getByText(copy.anomalyPurpose, { exact: true })).toBeVisible();
      const readsBeforeEvidence = reads.length;
      await operator.getByTestId('anomaly-candidate').first().locator('summary').click();
      await expect(operator.getByTestId('anomaly-candidate').first()).toContainText(
        copy.anomalyFillId,
      );
      expect(reads).toHaveLength(readsBeforeEvidence);
      expect(writes).toEqual([]);

      const match = (url: URL) => url.pathname === PATH;
      await operator.route(match, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL', message: 'unavailable' } }),
        }),
      );
      await operator.getByRole('button', { name: copy.anomalyRecalculate, exact: true }).click();
      await expect(operator.getByRole('alert')).toContainText(copy.anomalyRefreshFailed);
      await expect(operator.getByTestId('anomaly-candidate')).toHaveCount(report.candidates.length);
      await operator.unroute(match);
      await operator.getByRole('button', { name: copy.anomalyRecalculate, exact: true }).click();
      await expect(operator.getByRole('alert')).toHaveCount(0);

      for (const path of [`/api/v1/markets/${market.id}`, `/api/v1/markets/${market.id}/fills`]) {
        const response = await request.get(path);
        expect(response.ok()).toBe(true);
        const body = await response.text();
        for (const privateValue of [a, b, 'human_pair', 'round_trip', 'observedCandidates'])
          expect(body).not.toContain(privateValue);
      }
      await page.goto('/admin/trading-anomalies');
      await expect(page).toHaveURL('/');
      expect(writes).toEqual([]);
    } finally {
      try {
        for (const row of originals) await change(row.key, row.status, row.value);
      } finally {
        await Promise.all([otherContext.close(), operatorContext.close()]);
      }
    }
  });
});
