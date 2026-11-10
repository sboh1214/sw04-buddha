import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { applyTreasuryWrite, treasuryBalanceKey, treasuryRequestKey } from '@/hooks/use-treasury';
import { ApiError, type TreasuryIssueRequest } from '@/lib/api';
import { byTestId, renderWithQueries } from '@/test/render';
import { treasury, treasuryApproved, treasuryRequest } from '@/test/treasury';
import { system } from '@/theme/system';
import { AdminTreasuryScreen, TreasuryBalance, TreasuryRequestCard } from './admin-treasury';

describe('treasury facts and request controls', () => {
  it('shows a failed follow-up read while preserving the later allocation and committed decision', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      const allocated = { ...treasury, availableCoin: '700', ledgerCoin: '700' };
      await client.fetchQuery({
        queryKey: treasuryBalanceKey,
        queryFn: () => Promise.resolve(allocated),
      });
      await applyTreasuryWrite(client, { treasury, request: treasuryApproved });
      const failure = new ApiError(503, { code: 'INTERNAL', message: 'unavailable' });
      await expect(
        client.fetchQuery({
          queryKey: treasuryBalanceKey,
          queryFn: () => Promise.reject(failure),
        }),
      ).rejects.toBe(failure);
      const html = renderToStaticMarkup(
        <ChakraProvider value={system}>
          <QueryClientProvider client={client}>
            <AdminTreasuryScreen />
            <TreasuryRequestCard
              request={client.getQueryData<TreasuryIssueRequest>(
                treasuryRequestKey(treasuryRequest.id),
              )!}
              onAction={() => undefined}
            />
          </QueryClientProvider>
        </ChakraProvider>,
      );
      expect(html).toContain(copy.errUnknown);
      expect(html).toContain(copy.retry);
      expect(byTestId(html, 'treasury-availableCoin')?.text).toContain('700');
      expect(html).toContain(copy.treasuryIssueApproved);
    } finally {
      client.clear();
    }
  });
  it('does not turn missing balances into zero, and draws inconsistent observed balances with an audit link', () => {
    const empty = renderWithQueries(
      <TreasuryBalance
        treasury={{
          ...treasury,
          accountId: null,
          status: 'uninitialized',
          availableCoin: null,
          lockedCoin: null,
          ledgerCoin: null,
          issuedCoin: '0',
        }}
      />,
    );
    expect(empty).toContain(copy.treasuryUninitialized);
    expect(byTestId(empty, 'treasury-availableCoin')?.text).toContain('—');
    const broken = renderWithQueries(
      <TreasuryBalance
        treasury={{ ...treasury, status: 'inconsistent', availableCoin: '90', ledgerCoin: '100' }}
      />,
    );
    expect(broken).toContain(copy.treasuryInconsistent);
    expect(broken).toContain('/admin/audit-failures');
    expect(byTestId(broken, 'treasury-availableCoin')?.text).toContain('90');
    expect(byTestId(broken, 'treasury-ledgerCoin')?.text).toContain('100');
  });
  it('separates requester retraction, another admin decision and an unknown operator', () => {
    const draw = (id: string | undefined) =>
      renderWithQueries(
        <TreasuryRequestCard request={treasuryRequest} onAction={() => undefined} />,
        id ? [[['me'], { id }]] : [],
      );
    for (const id of [undefined, 'admin-a'])
      expect(
        byTestId(draw(id), `treasury-approve-${treasuryRequest.id}`)?.attributes,
      ).toHaveProperty('disabled');
    expect(
      byTestId(draw('admin-b'), `treasury-approve-${treasuryRequest.id}`)?.attributes,
    ).not.toHaveProperty('disabled');
    expect(byTestId(draw('admin-a'), `treasury-retract-${treasuryRequest.id}`)).toBeDefined();
    expect(byTestId(draw('admin-b'), `treasury-retract-${treasuryRequest.id}`)).toBeUndefined();
    const done = renderWithQueries(
      <TreasuryRequestCard request={treasuryApproved} onAction={() => undefined} />,
    );
    expect(done).toContain(copy.treasuryIssueApproved);
    expect(byTestId(done, `treasury-approve-${treasuryRequest.id}`)).toBeUndefined();
    expect(done).toContain(treasuryApproved.decisionReason);
  });
});
