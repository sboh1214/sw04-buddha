import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey } from '@/hooks/use-admin-markets';
import { ADMIN_OPERATIONS_FAILURES_KEY } from '@/hooks/use-admin-operations';
import { type AdminSettlementRetryResult, ApiError, api, isForAnotherAccount } from '@/lib/api';
import {
  type SettlementRetryVariables,
  postSettlementRetry,
  settlementRetryOptions,
} from './settlement-retry-dialog';

vi.mock('@/components/ui/toaster', () => ({ toaster: { create: vi.fn() } }));

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const BY = 'admin-a';
const REASON = '대사 보류를 복구했습니다. 지급을 다시 시도합니다.';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 정산 다시 시도 as the dialog runs it (#145, ADR-0163; 145-7, 145-14): what each outcome does to the
 * dialog and to the lists behind it, driven through a real MutationObserver — the dialog's own
 * mutation options with the POST stubbed.
 */
function setup(answer: () => Promise<AdminSettlementRetryResult>) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(ADMIN_OPERATIONS_FAILURES_KEY, { pages: [], pageParams: [] });
  queryClient.setQueryData(adminMarketKey(MARKET), { id: MARKET, status: 'settling' });
  const sent: SettlementRetryVariables[] = [];
  const view = {
    close: vi.fn(),
    showFailed: vi.fn(),
    setFieldError: vi.fn(),
    setRefusal: vi.fn(),
    sessionChanged: vi.fn(isForAnotherAccount),
  };
  vi.mocked(toaster.create).mockClear();
  const observer = new MutationObserver(
    queryClient,
    settlementRetryOptions(
      queryClient,
      MARKET,
      (variables) => {
        sent.push(variables);
        return answer();
      },
      view,
    ),
  );
  const marked = () => ({
    lists: queryClient.getQueryState(ADMIN_OPERATIONS_FAILURES_KEY)?.isInvalidated,
    market: queryClient.getQueryState(adminMarketKey(MARKET))?.isInvalidated,
  });
  return { queryClient, observer, view, sent, marked };
}

const refusal = (status: number, code: ApiError['code'], details?: unknown) =>
  new ApiError(status, { code, message: code, details });

describe('정산 다시 시도 (145-7)', () => {
  it('sends the reason and the admin on screen alone', async () => {
    const post = vi.spyOn(api, 'POST').mockResolvedValue({
      data: { data: { outcome: 'settled', statusEventId: '42' } },
      response: new Response(null, { status: 200 }),
    });
    await expect(postSettlementRetry(MARKET, { reason: REASON, by: BY })).resolves.toEqual({
      outcome: 'settled',
      statusEventId: '42',
    });
    expect(post).toHaveBeenCalledWith('/api/v1/admin/markets/{id}/settlement-retries', {
      params: { path: { id: MARKET } },
      body: { reason: REASON, expectedAccountId: BY },
    });
  });

  it('closes with a toast once the attempt settled, and reads the market and the lists again', async () => {
    const { queryClient, observer, view, sent, marked } = setup(() =>
      Promise.resolve({ outcome: 'settled', statusEventId: '42' }),
    );
    try {
      await observer.mutate({ reason: REASON, by: BY });
      expect(sent).toEqual([{ reason: REASON, by: BY }]);
      expect(toaster.create).toHaveBeenCalledWith({
        type: 'success',
        title: copy.adminSettlementRetryDone,
      });
      expect(view.close).toHaveBeenCalledTimes(1);
      expect(view.showFailed).toHaveBeenLastCalledWith(null);
      expect(marked()).toEqual({ lists: true, market: true });
    } finally {
      queryClient.clear();
    }
  });

  it('stays open over the step’s error and attempts once the attempt failed, the lists read again', async () => {
    const failed = {
      outcome: 'failed',
      settlementLastError: '55000: ledger recovery approval is pending',
      settlementAttempts: 3,
    } as const;
    const { queryClient, observer, view, marked } = setup(() => Promise.resolve(failed));
    try {
      await observer.mutate({ reason: REASON, by: BY });
      expect(view.showFailed).toHaveBeenLastCalledWith(failed);
      expect(view.close).not.toHaveBeenCalled();
      expect(toaster.create).not.toHaveBeenCalled();
      expect(marked()).toEqual({ lists: true, market: true });
    } finally {
      queryClient.clear();
    }
  });

  it('closes with a fresh read when the market is no longer 지급 중 — nothing was attempted', async () => {
    const { queryClient, observer, view, marked } = setup(() =>
      Promise.reject(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['status'], message: 'not settling' }]),
      ),
    );
    try {
      await observer.mutate({ reason: REASON, by: BY }).catch(() => undefined);
      expect(toaster.create).toHaveBeenCalledWith({
        type: 'info',
        title: copy.adminSettlementRetryNotSettling,
      });
      expect(view.close).toHaveBeenCalledTimes(1);
      expect(view.setRefusal).toHaveBeenLastCalledWith(null);
      expect(marked()).toEqual({ lists: true, market: true });
    } finally {
      queryClient.clear();
    }
  });

  it('says the reason under its field and a busy market above the buttons, the dialog open', async () => {
    for (const [error, field, alert] of [
      [
        refusal(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'Too small' }]),
        copy.errMarketReviewReason,
        null,
      ],
      [refusal(409, 'TRANSACTION_BUSY'), null, copy.errTransactionBusy],
    ] as const) {
      const { queryClient, observer, view, marked } = setup(() => Promise.reject(error));
      try {
        await observer.mutate({ reason: REASON, by: BY }).catch(() => undefined);
        if (field !== null) expect(view.setFieldError).toHaveBeenLastCalledWith(field);
        if (alert !== null) expect(view.setRefusal).toHaveBeenLastCalledWith(alert);
        expect(view.close).not.toHaveBeenCalled();
        expect(toaster.create).not.toHaveBeenCalled();
        // Nothing ran, so nothing behind is read again.
        expect(marked()).toEqual({ lists: false, market: false });
      } finally {
        queryClient.clear();
      }
    }
  });

  it('closes with a toast on another account’s cookie and asks for the session again', async () => {
    const error = refusal(403, 'FORBIDDEN', [
      { path: ['expectedAccountId'], message: 'Different account' },
    ]);
    const { queryClient, observer, view, marked } = setup(() => Promise.reject(error));
    try {
      await observer.mutate({ reason: REASON, by: BY }).catch(() => undefined);
      expect(view.sessionChanged).toHaveBeenCalledWith(error);
      expect(view.sessionChanged).toHaveReturnedWith(true);
      expect(toaster.create).toHaveBeenCalledWith({ type: 'error', title: copy.sessionChanged });
      expect(view.close).toHaveBeenCalledTimes(1);
      expect(marked()).toEqual({ lists: false, market: false });
    } finally {
      queryClient.clear();
    }
  });

  it('reads the lists again when the market is gone', async () => {
    const { queryClient, observer, view, marked } = setup(() =>
      Promise.reject(refusal(404, 'NOT_FOUND')),
    );
    try {
      await observer.mutate({ reason: REASON, by: BY }).catch(() => undefined);
      expect(view.setRefusal).toHaveBeenLastCalledWith(copy.adminMarketNotFound);
      expect(view.close).not.toHaveBeenCalled();
      expect(marked()).toEqual({ lists: true, market: true });
    } finally {
      queryClient.clear();
    }
  });
});
