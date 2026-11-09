import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ReconciliationCorrectionRequest } from '@/lib/api';
import { correctionDetail, correctionRequest } from '@/test/reconciliation-corrections';
import {
  ADMIN_CORRECTIONS_KEY,
  applyCorrectionWrite,
  correctionDetailKey,
} from './use-reconciliation-corrections';

type Pages = InfiniteData<
  { items: ReconciliationCorrectionRequest[]; nextCursor: string | null },
  string | undefined
>;
const pendingKey = [...ADMIN_CORRECTIONS_KEY, 'requests', false];
const allKey = [...ADMIN_CORRECTIONS_KEY, 'requests', true];
const page = (items: ReconciliationCorrectionRequest[]): Pages => ({
  pages: [{ items, nextCursor: null }],
  pageParams: [undefined],
});
const approved = {
  ...correctionRequest,
  status: 'approved' as const,
  decidedAt: '2026-11-09T01:01:00.000Z',
  decidedBy: { id: 'admin-b', nickname: '승인 운영자' },
};

describe('committed correction cache', () => {
  it('applies approval before revalidation and cannot restore a pending card from a late response', async () => {
    const client = new QueryClient();
    client.setQueryData(pendingKey, page([correctionRequest]));
    client.setQueryData(allKey, page([correctionRequest]));
    await applyCorrectionWrite(client, {
      ...correctionDetail,
      candidates: [],
      requests: [approved],
    });
    expect(client.getQueryData<Pages>(pendingKey)?.pages[0]?.items).toEqual([]);
    expect(client.getQueryData<Pages>(allKey)?.pages[0]?.items).toEqual([approved]);
    // No follow-up GET succeeds. A previously sent request answer arrives after the approval.
    await applyCorrectionWrite(client, correctionDetail);
    expect(client.getQueryData<Pages>(pendingKey)?.pages[0]?.items).toEqual([]);
    expect(
      client.getQueryData<{ requests: ReconciliationCorrectionRequest[] }>(
        correctionDetailKey('10'),
      )?.requests,
    ).toEqual([approved]);
    client.clear();
  });
  it('preserves terminal facts known only by a list and does not insert an unloaded old row ahead of a cursor', async () => {
    const client = new QueryClient();
    const newer = {
      ...approved,
      id: 'newer',
      resultId: '20',
      requestedAt: '2026-11-09T02:00:00.000Z',
    };
    const loaded: Pages = {
      pages: [
        { items: [newer], nextCursor: 'next' },
        { items: [approved], nextCursor: null },
      ],
      pageParams: [undefined, 'next'],
    };
    client.setQueryData(allKey, loaded);
    await applyCorrectionWrite(client, correctionDetail);
    expect(
      client.getQueryData<{ requests: ReconciliationCorrectionRequest[] }>(
        correctionDetailKey('10'),
      )?.requests,
    ).toEqual([approved]);
    expect(client.getQueryData<Pages>(allKey)).toEqual(loaded);
    const older = { ...correctionRequest, id: 'older', requestedAt: '2026-11-08T01:00:00.000Z' };
    await applyCorrectionWrite(client, { ...correctionDetail, requests: [older] });
    expect(client.getQueryData<Pages>(allKey)).toEqual(loaded);
    client.clear();
  });
});
