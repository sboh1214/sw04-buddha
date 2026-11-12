import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { toaster } from '@/components/ui/toaster';
import { CONTROL_KEY, controlDetailKey } from '@/hooks/use-market-maker-controls';
import { adminMarketMakerKey } from '@/hooks/use-admin-market-maker';
import { ApiError, isForAnotherAccount, type MarketMakerControlWrite } from '@/lib/api';
import { marketMaker } from '@/test/market-maker';
import { makerControlRequest } from '@/test/market-maker-control';
import { controlWriteOptions } from './market-maker-controls';

vi.mock('@/components/ui/toaster', () => ({ toaster: { create: vi.fn() } }));
const failures = [
  [
    'account mismatch',
    () =>
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'Different account',
        details: [{ path: ['expectedAccountId'], message: 'Different account' }],
      }),
  ],
  ['forbidden', () => new ApiError(403, { code: 'FORBIDDEN', message: 'No role' })],
  [
    'unauthenticated',
    () => new ApiError(401, { code: 'UNAUTHENTICATED', message: 'Session ended' }),
  ],
  ['network', () => new Error('Offline')],
] as const;
const fresh: MarketMakerControlWrite = {
  marketMaker,
  request: makerControlRequest,
};
const balanceKey = adminMarketMakerKey(marketMaker.marketId);
const requestKey = controlDetailKey('admin-a', marketMaker.marketId, makerControlRequest.id);

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const by = 'admin-a';
  client.setQueryData(['me'], { id: by });
  let done!: (value: MarketMakerControlWrite) => void, fail!: (error: unknown) => void;
  const send = vi.fn(
    (_by: string) =>
      new Promise<MarketMakerControlWrite>((resolve, reject) => {
        done = resolve;
        fail = reject;
      }),
  );
  let dialog: { operator: string; reason: string } | null = {
    operator: by,
    reason: 'Original draft',
  };
  const close = vi.fn(() => {
    dialog = null;
  });
  const sessionChanged = vi.fn(isForAnotherAccount),
    setRefusal = vi.fn();
  const cancel = vi.spyOn(client, 'cancelQueries'),
    invalidate = vi.spyOn(client, 'invalidateQueries');
  vi.mocked(toaster.create).mockClear();
  const observer = new MutationObserver(
    client,
    controlWriteOptions(client, send, close, sessionChanged, setRefusal),
  );
  const switchTo = (operator: string | undefined) => {
    if (operator) client.setQueryData(['me'], { id: operator });
    else client.removeQueries({ queryKey: ['me'], exact: true });
    dialog = operator ? { operator, reason: '새 계정에서 작성 중인 사유' } : null;
    client.setQueryData(balanceKey, marketMaker);
  };
  return {
    client,
    by,
    send,
    close,
    sessionChanged,
    setRefusal,
    cancel,
    invalidate,
    observer,
    start: async () => {
      // Do not await settlement while arranging the delayed response.
      const settled = observer.mutate(by).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]?.[0]).toBe(by);
      setRefusal.mockClear();
      return { settled };
    },
    switchTo,
    dialog: () => dialog,
    done: (value = fresh) => done(value),
    fail: (error: unknown) => fail(error),
  };
}

function expectNoForeignEffects(
  h: ReturnType<typeof setup>,
  expectedDialog: ReturnType<ReturnType<typeof setup>['dialog']>,
) {
  expect(h.dialog()).toEqual(expectedDialog);
  expect(h.close).not.toHaveBeenCalled();
  expect(h.sessionChanged).not.toHaveBeenCalled();
  expect(h.setRefusal).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
  expect(toaster.create).not.toHaveBeenCalled();
  expect(h.client.getQueryData(balanceKey)).toEqual(marketMaker);
  expect(h.client.getQueryData(requestKey)).toBeUndefined();
}

describe('market-maker control mutation completion belongs to its submitting operator', () => {
  it.each(['admin-b', undefined])(
    'ignores a late success after operator becomes %s',
    async (operator) => {
      const h = setup();
      try {
        const { settled } = await h.start();
        h.switchTo(operator);
        const dialog = h.dialog();
        h.done();
        await settled;
        expectNoForeignEffects(h, dialog);
        expect(h.cancel).not.toHaveBeenCalled();
      } finally {
        h.client.clear();
      }
    },
  );
  it.each(failures)(
    'ignores late %s after another administrator opens a new draft',
    async (_name, error) => {
      const h = setup();
      try {
        const { settled } = await h.start();
        h.switchTo('admin-b');
        const dialog = h.dialog();
        const e = error();
        h.fail(e);
        expect(await settled).toBe(e);
        expectNoForeignEffects(h, dialog);
        expect(h.cancel).not.toHaveBeenCalled();
      } finally {
        h.client.clear();
      }
    },
  );
  it.each(failures)(
    'ignores late %s after the operator is no longer known',
    async (_name, error) => {
      const h = setup();
      try {
        const { settled } = await h.start();
        h.switchTo(undefined);
        const e = error();
        h.fail(e);
        expect(await settled).toBe(e);
        expectNoForeignEffects(h, null);
        expect(h.cancel).not.toHaveBeenCalled();
      } finally {
        h.client.clear();
      }
    },
  );
  it.each(['admin-b', undefined])(
    'rechecks operator after awaiting cache cancellation (%s)',
    async (operator) => {
      const h = setup();
      const releases: Array<() => void> = [];
      h.cancel.mockImplementation(
        () =>
          new Promise<void>((done) => {
            releases.push(done);
          }),
      );
      try {
        const { settled } = await h.start();
        h.done();
        await vi.waitFor(() => expect(h.cancel).toHaveBeenCalledTimes(2));
        h.switchTo(operator);
        const dialog = h.dialog();
        for (const release of releases) release();
        await settled;
        expectNoForeignEffects(h, dialog);
      } finally {
        h.client.clear();
      }
    },
  );
  it('does not close a new operator draft between helper completion and callback resumption', async () => {
    const h = setup();
    let changed = false;
    const unsubscribe = h.client.getQueryCache().subscribe((event) => {
      if (
        event.type !== 'updated' ||
        event.action.type !== 'success' ||
        JSON.stringify(event.query.queryKey) !== JSON.stringify(requestKey)
      )
        return;
      // A session completion already queued after this synchronous cache update runs
      // before the awaiting mutation callback resumes.
      queueMicrotask(() => {
        changed = true;
        h.switchTo('admin-b');
      });
    });
    try {
      const { settled } = await h.start();
      h.done();
      await settled;
      expect(changed).toBe(true);
      expect(h.client.getQueryData(requestKey)).toEqual(fresh);
      expect(h.client.getQueryData(balanceKey)).toEqual(marketMaker);
      expect(h.dialog()).toEqual({ operator: 'admin-b', reason: '새 계정에서 작성 중인 사유' });
      expect(h.close).not.toHaveBeenCalled();
      expect(toaster.create).not.toHaveBeenCalled();
      expect(h.invalidate).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      h.client.clear();
    }
  });
  it('keeps the saved control request and closes the current operator draft even if the follow-up GET fails', async () => {
    const h = setup();
    try {
      const { settled } = await h.start();
      h.client.setQueryData(balanceKey, marketMaker);
      h.done();
      await settled;
      expect(h.client.getQueryData(balanceKey)).toEqual(fresh.marketMaker);
      expect(h.client.getQueryData(requestKey)).toEqual(fresh);
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(toaster.create).toHaveBeenCalledTimes(1);
      expect(h.invalidate).toHaveBeenCalledWith({ queryKey: CONTROL_KEY });
      await expect(
        h.client.fetchQuery({
          queryKey: balanceKey,
          retry: false,
          queryFn: () => Promise.reject(new Error('503')),
        }),
      ).rejects.toThrow('503');
      expect(h.client.getQueryData(balanceKey)).toEqual(fresh.marketMaker);
    } finally {
      h.client.clear();
    }
  });
  it.each(failures)('continues to handle %s for the current operator', async (_name, error) => {
    const h = setup();
    try {
      const { settled } = await h.start();
      const e = error();
      h.fail(e);
      expect(await settled).toBe(e);
      expect(h.sessionChanged).toHaveBeenCalledExactlyOnceWith(e);
      expect(h.invalidate).toHaveBeenCalledWith({ queryKey: CONTROL_KEY });
      if (isForAnotherAccount(e)) {
        expect(h.close).toHaveBeenCalledTimes(1);
        expect(toaster.create).toHaveBeenCalledTimes(1);
      } else {
        expect(h.close).not.toHaveBeenCalled();
        expect(h.setRefusal).toHaveBeenCalledTimes(1);
        expect(toaster.create).not.toHaveBeenCalled();
      }
    } finally {
      h.client.clear();
    }
  });
});
