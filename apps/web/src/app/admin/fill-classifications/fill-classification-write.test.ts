import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  CLASSIFICATIONS_KEY,
  classifiableFillKey,
  classificationRequestKey,
} from '@/hooks/use-fill-classifications';
import { ApiError, isForAnotherAccount, type FillClassificationWrite } from '@/lib/api';
import { classificationFill, classifiedWrite } from '@/test/fill-classifications';
import { classificationWriteOptions } from './fill-classifications';

vi.mock('@/components/ui/toaster', () => ({ toaster: { create: vi.fn() } }));

const errors = [
  ['FORBIDDEN', () => new ApiError(403, { code: 'FORBIDDEN', message: 'No current role' })],
  [
    'UNAUTHENTICATED',
    () => new ApiError(401, { code: 'UNAUTHENTICATED', message: 'Session expired' }),
  ],
  [
    'account mismatch',
    () =>
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'Session belongs to another account',
        details: [{ path: ['expectedAccountId'], message: 'Different account' }],
      }),
  ],
  ['ordinary failure', () => new Error('Network failed')],
] as const;

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const by = 'old-admin';
  client.setQueryData(['me'], { id: by });
  let reject!: (reason: unknown) => void;
  let resolve!: (value: FillClassificationWrite) => void;
  vi.mocked(toaster.create).mockClear();
  const send = vi.fn(
    () =>
      new Promise<FillClassificationWrite>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
  );
  // The screen's close callback clears whichever dialog the parent currently holds. A stale
  // mutation must not call it after the new operator has opened and typed in another dialog.
  let dialog: { operator: string; reason: string } | null = {
    operator: by,
    reason: 'Original request',
  };
  const close = vi.fn(() => {
    dialog = null;
  });
  const sessionChanged = vi.fn(isForAnotherAccount);
  const setRefusal = vi.fn();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const mutation = new MutationObserver(
    client,
    classificationWriteOptions(client, send, close, sessionChanged, setRefusal),
  );
  const start = async () => {
    // Capture rejection immediately, including before assertions that wait for the request.
    const settled = mutation.mutate(by).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(mutation.getCurrentResult().isPending).toBe(true);
    expect(setRefusal).toHaveBeenCalledExactlyOnceWith(null);
    setRefusal.mockClear();
    return { settled };
  };
  return {
    client,
    by,
    close,
    sessionChanged,
    setRefusal,
    invalidate,
    start,
    fail: (error: unknown) => reject(error),
    done: () => resolve(classifiedWrite),
    openFor: (operator: string) => {
      dialog = { operator, reason: '새 계정에서 입력 중인 사유' };
    },
    dialog: () => dialog,
  };
}

describe('classification write failures belong to the submitting operator', () => {
  it.each(errors)(
    'ignores late %s after account switching, preserving the new dialog and cache',
    async (_label, makeError) => {
      const h = setup();
      try {
        const { settled } = await h.start();
        h.client.setQueryData(['me'], { id: 'new-admin' });
        h.openFor('new-admin');
        const newDialog = h.dialog();
        const key = classifiableFillKey('new-admin', classificationFill.id);
        h.client.setQueryData(key, classificationFill);

        const error = makeError();
        h.fail(error);
        expect(await settled).toBe(error);

        expect(h.dialog()).toEqual(newDialog);
        expect(h.close).not.toHaveBeenCalled();
        expect(h.sessionChanged).not.toHaveBeenCalled();
        expect(h.setRefusal).not.toHaveBeenCalled();
        expect(h.invalidate).not.toHaveBeenCalled();
        expect(h.client.getQueryState(key)?.isInvalidated).toBe(false);
        expect(h.client.getQueryData(key)).toEqual(classificationFill);
      } finally {
        h.client.clear();
      }
    },
  );

  it.each(errors)(
    'ignores late %s after the operator is no longer known',
    async (_label, makeError) => {
      const h = setup();
      try {
        const { settled } = await h.start();
        h.client.removeQueries({ queryKey: ['me'], exact: true });
        const error = makeError();
        h.fail(error);
        expect(await settled).toBe(error);
        expect(h.close).not.toHaveBeenCalled();
        expect(h.sessionChanged).not.toHaveBeenCalled();
        expect(h.setRefusal).not.toHaveBeenCalled();
        expect(h.invalidate).not.toHaveBeenCalled();
      } finally {
        h.client.clear();
      }
    },
  );

  it.each(errors)('still handles the current operator’s %s refusal', async (label, makeError) => {
    const h = setup();
    try {
      const { settled } = await h.start();
      const key = classifiableFillKey(h.by, classificationFill.id);
      h.client.setQueryData(key, classificationFill);
      const error = makeError();
      h.fail(error);
      expect(await settled).toBe(error);
      expect(h.sessionChanged).toHaveBeenCalledExactlyOnceWith(error);

      if (label === 'ordinary failure') {
        expect(h.close).not.toHaveBeenCalled();
        expect(h.dialog()).not.toBeNull();
        expect(h.setRefusal).toHaveBeenCalledExactlyOnceWith(copy.classificationsFailure);
        expect(h.invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: CLASSIFICATIONS_KEY });
        expect(h.client.getQueryState(key)?.isInvalidated).toBe(true);
      } else {
        expect(h.close).toHaveBeenCalledTimes(1);
        expect(h.dialog()).toBeNull();
        expect(h.setRefusal).not.toHaveBeenCalled();
        expect(h.invalidate).not.toHaveBeenCalled();
      }
    } finally {
      h.client.clear();
    }
  });
});

describe('classification success callback belongs to the current operator after its helper returns', () => {
  it.each(['new-admin', undefined])(
    'preserves the new dialog when operator becomes %s between helper completion and callback resumption',
    async (operator) => {
      const h = setup();
      const requestKey = classificationRequestKey(
        h.by,
        classifiedWrite.fill.id,
        classifiedWrite.request.id,
      );
      const newFillKey = classifiableFillKey('new-admin', classifiedWrite.fill.id);
      h.client.setQueryData(newFillKey, classificationFill);
      let changed = false;
      const unsubscribe = h.client.getQueryCache().subscribe((event) => {
        if (
          event.type !== 'updated' ||
          event.action.type !== 'success' ||
          JSON.stringify(event.query.queryKey) !== JSON.stringify(requestKey)
        )
          return;
        // The helper writes the committed response for its still-current operator. A queued
        // session completion then runs before the caller resumes after awaiting the helper.
        queueMicrotask(() => {
          changed = true;
          if (operator) {
            h.client.setQueryData(['me'], { id: operator });
            h.openFor(operator);
          } else h.client.removeQueries({ queryKey: ['me'], exact: true });
        });
      });
      try {
        const { settled } = await h.start();
        h.done();
        await settled;
        expect(changed).toBe(true);
        expect(h.client.getQueryData<{ id: string }>(['me'])?.id).toBe(operator);
        expect(h.client.getQueryData(requestKey)).toEqual(classifiedWrite);
        expect(h.client.getQueryData(newFillKey)).toEqual(classificationFill);
        expect(h.dialog()).toEqual(
          operator
            ? { operator, reason: '새 계정에서 입력 중인 사유' }
            : { operator: h.by, reason: 'Original request' },
        );
        expect(h.close).not.toHaveBeenCalled();
        expect(toaster.create).not.toHaveBeenCalled();
        expect(h.invalidate).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        h.client.clear();
      }
    },
  );

  it('keeps the committed write and closes the current operator draft even when the later GET fails', async () => {
    const h = setup();
    const requestKey = classificationRequestKey(
      h.by,
      classifiedWrite.fill.id,
      classifiedWrite.request.id,
    );
    try {
      const { settled } = await h.start();
      h.done();
      await settled;
      expect(h.client.getQueryData(requestKey)).toEqual(classifiedWrite);
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(toaster.create).toHaveBeenCalledTimes(1);
      expect(h.invalidate).toHaveBeenCalledExactlyOnceWith({
        queryKey: [...CLASSIFICATIONS_KEY, h.by],
      });
      await expect(
        h.client.fetchQuery({
          queryKey: requestKey,
          retry: false,
          queryFn: () => Promise.reject(new Error('503')),
        }),
      ).rejects.toThrow('503');
      expect(h.client.getQueryData(requestKey)).toEqual(classifiedWrite);
    } finally {
      h.client.clear();
    }
  });
});
