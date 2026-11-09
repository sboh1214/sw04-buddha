import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type ReconciliationHoldDetail, type ReconciliationResult } from '@/lib/api';
import {
  ADMIN_RECONCILIATION_KEY,
  applyReconciliationWrite,
  reconciliationHoldKey,
} from './use-reconciliation';

const AT = '2026-11-09T01:00:00.000Z';
const detail: ReconciliationHoldDetail = {
  hold: {
    id: '00000000-0000-4000-8000-000000000001',
    scope: 'account',
    targetKey: 'user:holder',
    marketId: null,
    userId: 'holder',
    failureResultId: '10',
    legacyPauseId: null,
    startedAt: AT,
    recoveredAt: null,
  },
  latestResult: {
    id: '11',
    scope: 'account',
    targetKey: 'user:holder',
    marketId: null,
    accountId: '1',
    userId: 'holder',
    source: 'manual',
    passed: true,
    checkedAt: AT,
    ledgerCursor: '3',
    findings: [],
    facts: {},
  },
  requests: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      holdId: '00000000-0000-4000-8000-000000000001',
      failureResultId: '10',
      requestedBy: { id: 'a', nickname: '요청자' },
      reason: '복구 확인',
      requestedAt: AT,
      status: 'pending',
      decidedBy: null,
      decisionReason: null,
      decidedAt: null,
      retractedAt: null,
    },
  ],
  market: null,
  user: { id: 'holder', nickname: '보유자' },
};
type Pages<T> = InfiniteData<{ items: T[]; nextCursor: string | null }, string | undefined>;
const pages = <T>(items: T[]): Pages<T> => ({
  pages: [{ items, nextCursor: null }],
  pageParams: [undefined],
});
const active = [...ADMIN_RECONCILIATION_KEY, 'holds', false];
const all = [...ADMIN_RECONCILIATION_KEY, 'holds', true];
const results = [...ADMIN_RECONCILIATION_KEY, 'results'];

describe('committed reconciliation writes stay visible when revalidation fails', () => {
  it('keeps repeated recovery evidence in its original page and excludes unloaded older results', async () => {
    const client = new QueryClient();
    const row = (id: string): ReconciliationResult => ({ ...detail.latestResult!, id });
    const loaded: Pages<ReconciliationResult> = {
      pages: [
        { items: [row('50'), row('49')], nextCursor: 'after49' },
        { items: [row('48'), row('47')], nextCursor: 'after47' },
      ],
      pageParams: [undefined, 'after49'],
    };
    client.setQueryData(results, loaded);
    await applyReconciliationWrite(client, { ...detail, latestResult: row('47') });
    await applyReconciliationWrite(client, { ...detail, latestResult: row('46') });
    expect(client.getQueryData(results)).toEqual(loaded);
    await applyReconciliationWrite(client, { result: row('51'), hold: null });
    expect(
      client
        .getQueryData<Pages<ReconciliationResult>>(results)
        ?.pages.map((page) => page.items.map((item) => item.id)),
    ).toEqual([
      ['51', '50', '49'],
      ['48', '47'],
    ]);
    expect(
      client
        .getQueryData<Pages<ReconciliationResult>>(results)
        ?.pages.map((page) => page.nextCursor),
    ).toEqual(['after49', 'after47']);
    client.clear();
  });
  it('does not insert an unloaded older hold above the first cursor', async () => {
    const client = new QueryClient();
    const newest = {
      ...detail,
      hold: {
        ...detail.hold,
        id: '00000000-0000-4000-8000-000000000050',
        startedAt: '2026-11-09T02:00:00.000Z',
      },
    };
    client.setQueryData(all, pages([newest]));
    await applyReconciliationWrite(client, detail);
    expect(client.getQueryData<Pages<ReconciliationHoldDetail>>(all)?.pages[0]?.items).toEqual([
      newest,
    ]);
    expect(client.getQueryData(reconciliationHoldKey(detail.hold.id))).toEqual(detail);
    client.clear();
  });
  it('removes a recovered hold from active pages, keeps its approved history, and does not resurrect it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(active, pages([detail]));
    client.setQueryData(all, pages([detail]));
    client.setQueryData(results, pages([detail.latestResult!]));
    const recovered: ReconciliationHoldDetail = {
      ...detail,
      hold: { ...detail.hold, recoveredAt: '2026-11-09T02:00:00.000Z' },
      latestResult: { ...detail.latestResult!, id: '12', source: 'recovery' },
      requests: [
        {
          ...detail.requests[0]!,
          status: 'approved',
          decidedAt: AT,
          decidedBy: { id: 'b', nickname: '승인자' },
          decisionReason: '확인',
        },
      ],
    };
    await applyReconciliationWrite(client, recovered);
    await expect(
      client.fetchQuery({ queryKey: active, queryFn: () => Promise.reject(new Error('offline')) }),
    ).rejects.toThrow('offline');
    expect(client.getQueryData<Pages<ReconciliationHoldDetail>>(active)?.pages[0]?.items).toEqual(
      [],
    );
    expect(
      client.getQueryData<Pages<ReconciliationHoldDetail>>(all)?.pages[0]?.items[0]?.requests[0]
        ?.status,
    ).toBe('approved');
    // A slower, earlier manual run must not undo the successful approval.
    await applyReconciliationWrite(client, { result: detail.latestResult!, hold: detail.hold });
    expect(client.getQueryData<Pages<ReconciliationHoldDetail>>(active)?.pages[0]?.items).toEqual(
      [],
    );
    expect(
      client.getQueryData<ReconciliationHoldDetail>(reconciliationHoldKey(detail.hold.id))?.hold
        .recoveredAt,
    ).toBe(recovered.hold.recoveredAt);
    client.clear();
  });
  it('applies a passing reaudit without clearing the hold or its waiting request', async () => {
    const client = new QueryClient();
    const failed = { ...detail, latestResult: { ...detail.latestResult!, passed: false } };
    client.setQueryData(active, pages([failed]));
    client.setQueryData(results, pages<ReconciliationResult>([]));
    const passed = { ...detail.latestResult!, id: '12', passed: true };
    await applyReconciliationWrite(client, { result: passed, hold: detail.hold });
    const saved = client.getQueryData<Pages<ReconciliationHoldDetail>>(active)?.pages[0]?.items[0];
    expect(saved?.latestResult).toEqual(passed);
    expect(saved?.hold.recoveredAt).toBeNull();
    expect(saved?.requests[0]?.status).toBe('pending');
    expect(client.getQueryData<Pages<ReconciliationResult>>(results)?.pages[0]?.items).toEqual([
      passed,
    ]);
    client.clear();
  });
});
