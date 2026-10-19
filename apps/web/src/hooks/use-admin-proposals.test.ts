import { describe, expect, it } from 'vitest';
import { type AdminProposal } from '@/lib/api';
import { isPrivateQueryKey } from '@/lib/market-keys';
import { MY_PROPOSALS_KEY, adminProposalKey, adminProposalsKey } from '@/lib/proposals';
import { getQueryClient } from '@/lib/query-client';
import { ADMIN_MARKETS_KEY, adminMarketKey } from './use-admin-markets';
import {
  adminProposalQueryOptions,
  adminProposalsInfiniteQueryOptions,
  applyProposal,
} from './use-admin-proposals';

/** The operators' 시장 제안 screens' cache (#77, ADR-0089), through the real QueryClient. */

const ID = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const id = ID.toLowerCase();

const adminProposal = (status: AdminProposal['status']): AdminProposal => ({
  id,
  question: '질문',
  deadline: '2026-12-31',
  yesCondition: 'YES 조건',
  expectedSources: '출처',
  background: null,
  category: null,
  status,
  createdAt: '2026-10-19T03:00:00.000Z',
  proposer: { id: 'user-1', nickname: '제안자' },
  reviewStartedAt: null,
  reviewStartedBy: null,
  decidedAt: null,
  decidedBy: null,
  retractedAt: null,
  rejection: null,
  adoption: null,
  internalMemo: null,
});

describe('the admin proposal queries', () => {
  it('key the detail on the canonical id and send nothing for a segment that is no id', () => {
    const options = adminProposalQueryOptions(ID);
    expect(options.queryKey).toEqual(['admin', 'proposal', id]);
    expect(options.enabled).toBe(true);
    expect(adminProposalQueryOptions('nope').enabled).toBe(false);
    expect(isPrivateQueryKey(options.queryKey)).toBe(true);
  });

  it('key each status filter under one prefix, apart from the market lists', () => {
    expect(adminProposalsInfiniteQueryOptions('').queryKey).toEqual(['admin', 'proposals', '']);
    expect(adminProposalsInfiniteQueryOptions('submitted').queryKey).toEqual(
      adminProposalsKey('submitted'),
    );
    expect(adminProposalsKey('')).not.toEqual(ADMIN_MARKETS_KEY);
    const options = adminProposalsInfiniteQueryOptions('');
    expect(options.getNextPageParam({ items: [], nextCursor: 'c2' })).toBe('c2');
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
  });
});

describe('applyProposal', () => {
  it('shows the write’s answer at once and asks every list again, the member’s own included', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(adminProposalKey(id), adminProposal('submitted'));
    queryClient.setQueryData(adminProposalsKey(''), { pages: [], pageParams: [] });
    queryClient.setQueryData(adminProposalsKey('submitted'), { pages: [], pageParams: [] });
    queryClient.setQueryData(MY_PROPOSALS_KEY, { pages: [], pageParams: [] });
    queryClient.setQueryData([...ADMIN_MARKETS_KEY, ''], { pages: [], pageParams: [] });
    queryClient.setQueryData(adminMarketKey('m1'), { id: 'm1' });
    try {
      await applyProposal(queryClient, adminProposal('reviewing'));
      expect(queryClient.getQueryData<AdminProposal>(adminProposalKey(id))?.status).toBe(
        'reviewing',
      );
      for (const key of [adminProposalsKey(''), adminProposalsKey('submitted'), MY_PROPOSALS_KEY]) {
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
      }
      // No draft was made: the market lists are left alone.
      expect(queryClient.getQueryState([...ADMIN_MARKETS_KEY, ''])?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(adminMarketKey('m1'))?.isInvalidated).toBe(false);
    } finally {
      queryClient.clear();
    }
  });

  it('asks the market lists again when a 채택 made a draft', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData([...ADMIN_MARKETS_KEY, ''], { pages: [], pageParams: [] });
    try {
      await applyProposal(queryClient, adminProposal('adopted'), { marketCreated: true });
      expect(queryClient.getQueryState([...ADMIN_MARKETS_KEY, ''])?.isInvalidated).toBe(true);
    } finally {
      queryClient.clear();
    }
  });
});
