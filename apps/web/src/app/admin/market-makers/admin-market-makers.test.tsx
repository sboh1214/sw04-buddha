import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  makerMetricsKey,
  makerMetricsListKey,
  makerOverviewKey,
} from '@/hooks/use-market-maker-metrics';
import { makerMetrics, makerMetricsRow, makerOverview } from '@/test/market-maker-metrics';
import { byTestId } from '@/test/render';
import { system } from '@/theme/system';
import { AdminMarketMakersScreen } from './admin-market-makers';
import { MarketMakerMetricsPanel } from '../markets/[id]/market-maker-metrics-panel';

function render(client: QueryClient, node: ReactNode) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </ChakraProvider>,
  ).replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
}
function makeClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(['me'], { id: 'admin-b' });
  return client;
}
describe('metrics query screen states', () => {
  it('shows initial 503 with a retry and no invented empty list or healthy summary', async () => {
    const client = makeClient();
    try {
      for (const key of [
        makerOverviewKey('admin-b'),
        makerMetricsListKey('admin-b'),
        makerMetricsKey('admin-b', makerMetrics.marketId),
      ]) {
        await expect(
          client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('503')) }),
        ).rejects.toThrow('503');
      }
      const html = render(
        client,
        <>
          <AdminMarketMakersScreen />
          <MarketMakerMetricsPanel marketId={makerMetrics.marketId} />
        </>,
      );
      expect(html).toContain(copy.errUnknown);
      expect(html).toContain(copy.retry);
      expect(html).not.toContain(copy.makerMetricsEmpty);
      expect(byTestId(html, 'maker-metrics-overview')).toBeUndefined();
      expect(byTestId(html, 'market-maker-current-metrics')).toBeUndefined();
    } finally {
      client.clear();
    }
  });
  it('keeps exact snapshot and rows with a refresh warning when a later read fails', async () => {
    const client = makeClient();
    try {
      client.setQueryData(makerOverviewKey('admin-b'), makerOverview);
      client.setQueryData(makerMetricsListKey('admin-b'), {
        pages: [{ items: [makerMetricsRow], nextCursor: null }],
        pageParams: [undefined],
      });
      client.setQueryData(makerMetricsKey('admin-b', makerMetrics.marketId), makerMetrics);
      for (const key of [
        makerOverviewKey('admin-b'),
        makerMetricsListKey('admin-b'),
        makerMetricsKey('admin-b', makerMetrics.marketId),
      ]) {
        await expect(
          client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('503')) }),
        ).rejects.toThrow('503');
      }
      const html = render(
        client,
        <>
          <AdminMarketMakersScreen />
          <MarketMakerMetricsPanel marketId={makerMetrics.marketId} />
        </>,
      );
      expect(html).toContain(copy.adminMarketRefreshFailed);
      expect(byTestId(html, 'maker-overview-completeness')?.text).toBe(copy.makerMetricsPartial);
      expect(byTestId(html, `maker-metrics-market-${makerMetrics.marketId}`)?.text).toContain(
        makerMetrics.title,
      );
      expect(byTestId(html, 'market-maker-current-metrics')).toBeDefined();
    } finally {
      client.clear();
    }
  });
  it('never paints the previous account metrics while the next operator snapshot is pending', () => {
    const client = makeClient();
    try {
      client.setQueryData(makerOverviewKey('admin-a'), makerOverview);
      client.setQueryData(makerMetricsListKey('admin-a'), {
        pages: [{ items: [makerMetricsRow], nextCursor: null }],
        pageParams: [undefined],
      });
      client.setQueryData(makerMetricsKey('admin-a', makerMetrics.marketId), makerMetrics);
      const html = render(
        client,
        <>
          <AdminMarketMakersScreen />
          <MarketMakerMetricsPanel marketId={makerMetrics.marketId} />
        </>,
      );
      expect(byTestId(html, 'maker-metrics-overview')).toBeUndefined();
      expect(byTestId(html, `maker-metrics-market-${makerMetrics.marketId}`)).toBeUndefined();
      expect(byTestId(html, 'market-maker-current-metrics')).toBeUndefined();
    } finally {
      client.clear();
    }
  });
});
