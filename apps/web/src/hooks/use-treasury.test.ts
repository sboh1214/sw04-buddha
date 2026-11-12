import { type InfiniteData, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AdminTreasury, TreasuryIssueRequest } from '@/lib/api';
import { treasury, treasuryApproved, treasuryRequest } from '@/test/treasury';
import {
  ADMIN_TREASURY_KEY,
  applyTreasuryWrite,
  treasuryBalanceKey,
  treasuryRequestKey,
} from './use-treasury';

type Pages = InfiniteData<
  { items: TreasuryIssueRequest[]; nextCursor: string | null },
  string | undefined
>;
const pendingKey = [...ADMIN_TREASURY_KEY, 'requests', false];
const allKey = [...ADMIN_TREASURY_KEY, 'requests', true];
const page = (items: TreasuryIssueRequest[]): Pages => ({
  pages: [{ items, nextCursor: null }],
  pageParams: [undefined],
});

describe('committed treasury cache', () => {
  it('keeps a committed issuance after a late pending write response and a failed follow-up read', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    client.setQueryData(['me'], { id: 'admin-a' });
    try {
      client.setQueryData(treasuryBalanceKey, {
        ...treasury,
        availableCoin: '0',
        ledgerCoin: '0',
        issuedCoin: '200',
      });
      client.setQueryData(pendingKey, page([treasuryRequest]));
      client.setQueryData(allKey, page([treasuryRequest]));
      await applyTreasuryWrite(client, 'admin-a', { treasury, request: treasuryApproved });
      await applyTreasuryWrite(client, 'admin-a', {
        treasury: { ...treasury, availableCoin: '0', ledgerCoin: '0', issuedCoin: '200' },
        request: treasuryRequest,
      });
      await expect(
        client.fetchQuery({
          queryKey: treasuryBalanceKey,
          queryFn: () => Promise.reject(new Error('offline')),
        }),
      ).rejects.toThrow('offline');
      expect(client.getQueryData<AdminTreasury>(treasuryBalanceKey)).toEqual(treasury);
      expect(client.getQueryData<Pages>(pendingKey)?.pages[0]?.items).toEqual([]);
      expect(client.getQueryData<Pages>(allKey)?.pages[0]?.items).toEqual([treasuryApproved]);
      expect(client.getQueryData(treasuryRequestKey(treasuryRequest.id))).toEqual(treasuryApproved);
    } finally {
      client.clear();
    }
  });
  it.each([
    {
      name: 'a market allocation',
      before: treasury,
      after: { ...treasury, availableCoin: '700', ledgerCoin: '700' },
    },
    {
      name: 'a market recall',
      before: { ...treasury, availableCoin: '700', ledgerCoin: '700' },
      after: treasury,
    },
    {
      name: 'an actual-balance restoration without a new ledger entry',
      before: {
        ...treasury,
        status: 'inconsistent' as const,
        availableCoin: '90',
        ledgerCoin: '100',
      },
      after: { ...treasury, availableCoin: '100', ledgerCoin: '100' },
    },
  ])(
    'keeps the completed GET after $name when an older same-issuance POST arrives',
    async ({ before, after }) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      client.setQueryData(['me'], { id: 'admin-a' });
      try {
        // The POST took its snapshot before this independent operation. Its network response
        // arrives only after the GET has already stored the later balance in this client.
        await client.fetchQuery({
          queryKey: treasuryBalanceKey,
          queryFn: () => Promise.resolve(after),
        });
        await applyTreasuryWrite(client, 'admin-a', {
          treasury: before,
          request: treasuryApproved,
        });
        expect(client.getQueryData(treasuryBalanceKey)).toEqual(after);
        expect(client.getQueryData(treasuryRequestKey(treasuryRequest.id))).toEqual(
          treasuryApproved,
        );
        await client.invalidateQueries({ queryKey: ADMIN_TREASURY_KEY, refetchType: 'none' });
        expect(client.getQueryState(treasuryBalanceKey)?.isInvalidated).toBe(true);
        await expect(
          client.fetchQuery({
            queryKey: treasuryBalanceKey,
            queryFn: () => Promise.reject(new Error('offline')),
          }),
        ).rejects.toThrow('offline');
        expect(client.getQueryData(treasuryBalanceKey)).toEqual(after);
        expect(client.getQueryState(treasuryBalanceKey)?.status).toBe('error');
      } finally {
        client.clear();
      }
    },
  );
  it('preserves terminal facts known by a loaded later page without inserting an unloaded older request ahead of the cursor', async () => {
    const client = new QueryClient();

    client.setQueryData(['me'], { id: 'admin-a' });
    try {
      const newer = { ...treasuryApproved, id: 'newer', requestedAt: '2026-11-10T02:00:00.000Z' };
      const pages: Pages = {
        pages: [
          { items: [newer], nextCursor: 'next' },
          { items: [treasuryApproved], nextCursor: null },
        ],
        pageParams: [undefined, 'next'],
      };
      client.setQueryData(allKey, pages);
      await applyTreasuryWrite(client, 'admin-a', { treasury, request: treasuryRequest });
      expect(client.getQueryData(treasuryRequestKey(treasuryRequest.id))).toEqual(treasuryApproved);
      await applyTreasuryWrite(client, 'admin-a', {
        treasury,
        request: { ...treasuryRequest, id: 'older', requestedAt: '2026-11-09T01:00:00.000Z' },
      });
      expect(client.getQueryData(allKey)).toEqual(pages);
    } finally {
      client.clear();
    }
  });
  it('cancels an in-flight stale balance response before applying the approval snapshot', async () => {
    const client = new QueryClient();

    client.setQueryData(['me'], { id: 'admin-a' });
    let resolve: ((value: AdminTreasury) => void) | undefined;
    try {
      const pending = client
        .fetchQuery({
          queryKey: treasuryBalanceKey,
          queryFn: () =>
            new Promise<AdminTreasury>((done) => {
              resolve = done;
            }),
        })
        .catch(() => undefined);
      await applyTreasuryWrite(client, 'admin-a', { treasury, request: treasuryApproved });
      resolve?.({ ...treasury, issuedCoin: '0', availableCoin: '0', ledgerCoin: '0' });
      await pending;
      expect(client.getQueryData(treasuryBalanceKey)).toEqual(treasury);
    } finally {
      client.clear();
    }
  });
});
