import { ChakraProvider } from '@chakra-ui/react';
import { MARKET_LIQUIDITY_DEFAULT_SETTINGS } from '@buddha/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type ReleaseSetting } from '@/lib/api';
import { byTestId } from '@/test/render';
import { system } from '@/theme/system';
import { LiquidityDialog, liquidityDefaultsKey } from './market-liquidity-panel';
import type * as ReviewDialogs from './market-review-dialogs';

// Portal transport alone is replaced: use the actual queries, form initialization and guards.
vi.mock('./market-review-dialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewDialogs>()),
  ReviewDialogShell: (props: ComponentProps<typeof ReviewDialogs.ReviewDialogShell>) => (
    <section>
      {props.children}
      <button data-testid="confirm" disabled={props.confirmDisabled} />
    </section>
  ),
}));
const empty = {
  id: 'market-a',
  status: 'draft' as const,
  liquidity: { current: null, openedVersion: null, history: [] },
};
const defaults: ReleaseSetting[] = Object.values(MARKET_LIQUIDITY_DEFAULT_SETTINGS).map(
  (definition) => ({
    key: definition.key,
    label: definition.label,
    unit: definition.unit,
    description: definition.description,
    valueSchema: {},
    status: definition === MARKET_LIQUIDITY_DEFAULT_SETTINGS.budgetCoin ? 'test' : 'undecided',
    value: definition === MARKET_LIQUIDITY_DEFAULT_SETTINGS.budgetCoin ? '12345' : null,
    updatedAt: null,
    updatedBy: null,
  }),
);
const draw = (
  client: QueryClient,
  market: ComponentProps<typeof LiquidityDialog>['market'] = empty,
) =>
  renderToStaticMarkup(
    <ChakraProvider value={system}>
      <QueryClientProvider client={client}>
        <LiquidityDialog market={market} onClose={() => {}} />
      </QueryClientProvider>
    </ChakraProvider>,
  );
function clientFor(operator = 'admin-a') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(['me'], { id: operator });
  return client;
}
describe('first liquidity form suggestions', () => {
  it('copies a valid explicit test suggestion, identifies its status and leaves undecided fields blank', () => {
    const client = clientFor();
    try {
      client.setQueryData(liquidityDefaultsKey('admin-a'), defaults);
      const html = draw(client);
      expect(byTestId(html, 'market-liquidity-input-budgetCoin')?.attributes.value).toBe('12345');
      expect(byTestId(html, 'market-liquidity-input-maxLossCoin')?.attributes.value).toBe('');
      expect(byTestId(html, 'market-liquidity-default-budgetCoin')?.text).toContain('시험값');
      expect(html).toContain(copy.marketLiquidityDefaultsHint);
      expect(byTestId(html, 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
  it('prefers existing market settings and never requires defaults for editing a version', () => {
    const client = clientFor();
    try {
      client.setQueryData(liquidityDefaultsKey('admin-a'), defaults);
      const current = {
        marketId: empty.id,
        version: 1,
        budgetCoin: '700',
        maxLossCoin: '100',
        b: 1e-100,
        levels: 2,
        quantity: 1,
        safetyTicks: 0,
        reason: '등록',
        createdAt: '2026-11-11T00:00:00.000Z',
        createdBy: { id: 'admin-a', nickname: '운영자' },
      };
      const html = draw(client, {
        ...empty,
        liquidity: { current, openedVersion: null, history: [current] },
      });
      expect(byTestId(html, 'market-liquidity-input-budgetCoin')?.attributes.value).toBe('700');
      expect(byTestId(html, 'market-liquidity-input-b')?.attributes.value).toBe('1e-100');
      expect(byTestId(html, 'market-liquidity-defaults')).toBeUndefined();
    } finally {
      client.clear();
    }
  });
  it('does not copy another operator’s query and offers direct input while a read is pending', () => {
    const client = clientFor('admin-b');
    try {
      client.setQueryData(liquidityDefaultsKey('admin-a'), defaults);
      const html = draw(client);
      expect(byTestId(html, 'market-liquidity-input-budgetCoin')?.attributes.value).toBe('');
      expect(html).toContain(copy.marketLiquidityDefaultsLoading);
      expect(html).toContain(copy.marketLiquidityDefaultsManual);
      expect(byTestId(html, 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
  it('reports initial GET503 as unavailable, with retry and manual entry instead of pretending every default is undecided', async () => {
    const client = clientFor();
    try {
      const error = new ApiError(503, { code: 'INTERNAL', message: 'unavailable' });
      await expect(
        client.fetchQuery({
          queryKey: liquidityDefaultsKey('admin-a'),
          queryFn: () => Promise.reject(error),
        }),
      ).rejects.toBe(error);
      const html = draw(client);
      expect(html).toContain(copy.marketLiquidityDefaultsFailed);
      expect(html).toContain(copy.retry);
      expect(html).toContain(copy.marketLiquidityDefaultsManual);
      expect(byTestId(html, 'market-liquidity-defaults')).toBeUndefined();
      expect(byTestId(html, 'confirm')?.attributes).toHaveProperty('disabled');
    } finally {
      client.clear();
    }
  });
});
