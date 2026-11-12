import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { toaster } from '@/components/ui/toaster';
import { ADMIN_TREASURY_KEY, treasuryBalanceKey, treasuryRequestKey } from '@/hooks/use-treasury';
import { ApiError, isForAnotherAccount, type TreasuryIssueWrite } from '@/lib/api';
import { treasury, treasuryApproved } from '@/test/treasury';
import { treasuryWriteOptions } from './treasury-dialogs';

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
const fresh: TreasuryIssueWrite = {
  treasury: { ...treasury, issuedCoin: '2200', availableCoin: '2000', ledgerCoin: '2000' },
  request: {
    ...treasuryApproved,
    requestedBy: { id: 'requester', nickname: '다른 요청자' },
    decidedBy: { id: 'admin-a', nickname: '승인 운영자' },
  },
};

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const by = 'admin-a';
  client.setQueryData(['me'], { id: by });
  let done!: (value: TreasuryIssueWrite) => void, fail!: (error: unknown) => void;
  const send = vi.fn(
    (_by: string) =>
      new Promise<TreasuryIssueWrite>((resolve, reject) => {
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
    treasuryWriteOptions(client, send, close, 'Saved', sessionChanged, setRefusal),
  );
  const switchTo = (operator: string | undefined) => {
    if (operator) client.setQueryData(['me'], { id: operator });
    else client.removeQueries({ queryKey: ['me'], exact: true });
    dialog = operator ? { operator, reason: '새 계정에서 작성 중인 사유' } : null;
    client.setQueryData(treasuryBalanceKey, treasury);
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
  expect(h.client.getQueryData(treasuryBalanceKey)).toEqual(treasury);
  expect(h.client.getQueryData(treasuryRequestKey(treasuryApproved.id))).toBeUndefined();
}

describe('treasury mutation completion belongs to its submitting operator', () => {
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
      let release!: () => void;
      h.cancel.mockImplementation(
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      );
      try {
        const { settled } = await h.start();
        h.done();
        await vi.waitFor(() => expect(h.cancel).toHaveBeenCalledTimes(1));
        h.switchTo(operator);
        const dialog = h.dialog();
        release();
        await settled;
        expectNoForeignEffects(h, dialog);
      } finally {
        h.client.clear();
      }
    },
  );
  it('does not close a replacement draft after committing the old operator response but before resuming its callback', async () => {
    const h = setup();
    let changed = false;
    const key = treasuryRequestKey(fresh.request.id);
    const unsubscribe = h.client.getQueryCache().subscribe((event) => {
      if (
        event.type !== 'updated' ||
        event.action.type !== 'success' ||
        JSON.stringify(event.query.queryKey) !== JSON.stringify(key)
      )
        return;
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
      expect(h.client.getQueryData(key)).toEqual(fresh.request);
      expect(h.client.getQueryData(treasuryBalanceKey)).toEqual(treasury);
      expect(h.dialog()).toEqual({ operator: 'admin-b', reason: '새 계정에서 작성 중인 사유' });
      expect(h.close).not.toHaveBeenCalled();
      expect(toaster.create).not.toHaveBeenCalled();
      expect(h.invalidate).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      h.client.clear();
    }
  });
  it('keeps a committed issuance and closes the current operator draft even if the follow-up GET fails', async () => {
    const h = setup();
    try {
      const { settled } = await h.start();
      h.client.setQueryData(treasuryBalanceKey, treasury);
      h.done();
      await settled;
      expect(h.client.getQueryData(treasuryBalanceKey)).toEqual(fresh.treasury);
      expect(h.client.getQueryData(treasuryRequestKey(fresh.request.id))).toEqual(fresh.request);
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(toaster.create).toHaveBeenCalledTimes(1);
      expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ADMIN_TREASURY_KEY });
      await expect(
        h.client.fetchQuery({
          queryKey: treasuryBalanceKey,
          retry: false,
          queryFn: () => Promise.reject(new Error('503')),
        }),
      ).rejects.toThrow('503');
      expect(h.client.getQueryData(treasuryBalanceKey)).toEqual(fresh.treasury);
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
      expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ADMIN_TREASURY_KEY });
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
