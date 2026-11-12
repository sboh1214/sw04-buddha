import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, applyMarket } from '@/hooks/use-admin-markets';
import { ApiError, isForAnotherAccount, type AdminMarket } from '@/lib/api';
import { liquidityFailure } from '@/lib/market-liquidity';
import { liquidityWriteOptions, type LiquidityWrite } from './market-liquidity-panel';

// Callbacks treat the HTTP response as an opaque AdminMarket; DTO shape is covered separately.
const fresh = { id: 'market-a', title: '저장된 시장' } as AdminMarket;
const current = { ...fresh, title: '새 운영자의 조회 결과' };
const input: LiquidityWrite = {
  by: 'admin-a',
  baseVersion: 1,
  reason: '유동성 설정 변경 근거',
  settings: {
    budgetCoin: '10000',
    maxLossCoin: '5000',
    b: 100,
    levels: 3,
    quantity: 10,
    safetyTicks: 1,
  },
};
const errors = [
  ['forbidden', () => new ApiError(403, { code: 'FORBIDDEN', message: 'Role revoked' })],
  [
    'unauthenticated',
    () => new ApiError(401, { code: 'UNAUTHENTICATED', message: 'Session expired' }),
  ],
  [
    'account mismatch',
    () =>
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'Different account',
        details: [{ path: ['expectedAccountId'], message: 'Different account' }],
      }),
  ],
  [
    'stale version',
    () =>
      new ApiError(400, {
        code: 'VALIDATION_ERROR',
        message: 'Stale',
        details: [{ path: ['baseVersion'], message: 'stale' }],
      }),
  ],
  [
    'field validation',
    () =>
      new ApiError(400, {
        code: 'VALIDATION_ERROR',
        message: 'Invalid',
        details: [{ path: ['settings', 'maxLossCoin'], message: 'invalid' }],
      }),
  ],
  ['network failure', () => new Error('Network failed')],
] as const;

afterEach(() => vi.restoreAllMocks());
function setup() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  client.setQueryData(['me'], { id: input.by });
  client.setQueryData(adminMarketKey(fresh.id), { ...fresh, title: '저장 전' });
  let resolve!: (value: AdminMarket) => void;
  let reject!: (error: unknown) => void;
  const send = vi.fn(
    (_input: LiquidityWrite) =>
      new Promise<AdminMarket>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  let dialog: { by: string; reason: string } | null = { by: input.by, reason: input.reason };
  const close = vi.fn(() => {
    dialog = null;
  });
  const sessionChanged = vi.fn(isForAnotherAccount);
  const setFieldError = vi.fn();
  const setRefusal = vi.fn();
  const apply = vi.fn((value: AdminMarket) => applyMarket(client, fresh.id, value));
  const toast = vi.spyOn(toaster, 'create').mockImplementation(() => 'toast');
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const mutation = new MutationObserver(
    client,
    liquidityWriteOptions({
      client,
      marketId: fresh.id,
      send,
      apply,
      close,
      sessionChanged,
      setFieldError,
      setRefusal,
    }),
  );
  const start = async () => {
    const settled = mutation.mutate(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toEqual(input);
    expect(setFieldError).toHaveBeenCalledExactlyOnceWith(null);
    expect(setRefusal).toHaveBeenCalledExactlyOnceWith(null);
    setFieldError.mockClear();
    setRefusal.mockClear();
    return { settled };
  };
  const switchOperator = (known = true) => {
    if (known) client.setQueryData(['me'], { id: 'admin-b' });
    else client.removeQueries({ queryKey: ['me'], exact: true });
    dialog = { by: 'admin-b', reason: '새 운영자가 작성 중인 사유' };
    client.setQueryData(adminMarketKey(fresh.id), current);
  };
  return {
    client,
    close,
    sessionChanged,
    setFieldError,
    setRefusal,
    apply,
    toast,
    invalidate,
    start,
    succeed: () => resolve(fresh),
    fail: (error: unknown) => reject(error),
    switchOperator,
    dialog: () => dialog,
  };
}

describe('liquidity mutation callbacks remain with the submitting operator', () => {
  it.each([true, false])(
    'ignores late success when a replacement operator is known: %s',
    async (known) => {
      const h = setup();
      try {
        const { settled } = await h.start();
        h.switchOperator(known);
        const dialog = h.dialog();
        h.succeed();
        await settled;
        expect(h.apply).not.toHaveBeenCalled();
        expect(h.toast).not.toHaveBeenCalled();
        expect(h.close).not.toHaveBeenCalled();
        expect(h.dialog()).toEqual(dialog);
        expect(h.invalidate).not.toHaveBeenCalled();
        expect(h.client.getQueryData(adminMarketKey(fresh.id))).toEqual(current);
      } finally {
        h.client.clear();
      }
    },
  );
  for (const known of [true, false]) {
    it.each(errors)(
      `ignores late %s with replacement identity ${known}`,
      async (_label, makeError) => {
        const h = setup();
        try {
          const { settled } = await h.start();
          h.switchOperator(known);
          const dialog = h.dialog();
          const error = makeError();
          h.fail(error);
          expect(await settled).toBe(error);
          expect(h.sessionChanged).not.toHaveBeenCalled();
          expect(h.toast).not.toHaveBeenCalled();
          expect(h.close).not.toHaveBeenCalled();
          expect(h.setFieldError).not.toHaveBeenCalled();
          expect(h.setRefusal).not.toHaveBeenCalled();
          expect(h.invalidate).not.toHaveBeenCalled();
          expect(h.dialog()).toEqual(dialog);
          expect(h.client.getQueryData(adminMarketKey(fresh.id))).toEqual(current);
          expect(h.client.getQueryState(adminMarketKey(fresh.id))?.isInvalidated).toBe(false);
        } finally {
          h.client.clear();
        }
      },
    );
  }
  it.each(errors)('preserves the current operator’s %s handling', async (_label, makeError) => {
    const h = setup();
    try {
      const { settled } = await h.start();
      const error = makeError();
      h.fail(error);
      expect(await settled).toBe(error);
      expect(h.sessionChanged).toHaveBeenCalledExactlyOnceWith(error);
      const failure = liquidityFailure(error);
      if (failure.kind === 'toast') {
        expect(h.toast).toHaveBeenCalledExactlyOnceWith({ type: 'error', title: failure.message });
        expect(h.close).toHaveBeenCalledTimes(1);
      } else {
        expect(h.close).not.toHaveBeenCalled();
        if (failure.kind === 'field')
          expect(h.setFieldError).toHaveBeenCalledExactlyOnceWith(failure);
        else expect(h.setRefusal).toHaveBeenCalledExactlyOnceWith(failure.message);
        expect(h.invalidate).toHaveBeenCalledTimes(failure.refresh ? 1 : 0);
      }
    } finally {
      h.client.clear();
    }
  });
  it('applies the current response, announces success and closes its dialog', async () => {
    const h = setup();
    try {
      const { settled } = await h.start();
      h.succeed();
      await settled;
      expect(h.apply).toHaveBeenCalledExactlyOnceWith(fresh);
      expect(h.client.getQueryData(adminMarketKey(fresh.id))).toEqual(fresh);
      expect(h.toast).toHaveBeenCalledExactlyOnceWith({
        type: 'success',
        title: copy.marketLiquiditySaved,
      });
      expect(h.close).toHaveBeenCalledTimes(1);
    } finally {
      h.client.clear();
    }
  });
  it('does not close or toast for a new operator while the successful response awaits its refetch', async () => {
    const h = setup();
    let release!: (value: AdminMarket) => void;
    const read = vi.fn(
      () =>
        new Promise<AdminMarket>((resolve) => {
          release = resolve;
        }),
    );
    const observer = new QueryObserver(h.client, {
      queryKey: adminMarketKey(fresh.id),
      queryFn: read,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const { settled } = await h.start();
      h.succeed();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(h.client.getQueryData(adminMarketKey(fresh.id))).toEqual(fresh);
      // The session boundary cancels private GETs before the replacement identity's cache.
      h.client.setQueryData(['me'], { id: 'admin-b' });
      await h.client.cancelQueries({ queryKey: adminMarketKey(fresh.id), exact: true });
      h.switchOperator();
      const dialog = h.dialog();
      release(fresh);
      await settled;
      expect(h.toast).not.toHaveBeenCalled();
      expect(h.close).not.toHaveBeenCalled();
      expect(h.dialog()).toEqual(dialog);
      expect(h.client.getQueryData(adminMarketKey(fresh.id))).toEqual(current);
    } finally {
      unsubscribe();
      h.client.clear();
    }
  });
});
