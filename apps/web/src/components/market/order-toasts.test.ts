import { readFileSync } from 'node:fs';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toaster } from '@/components/ui/toaster';
import { forgetAccountInTab } from '@/hooks/use-sign-out';
import {
  accountToastAfterCommit,
  accountToastIds,
  createAccountToast,
  dismissAccountToasts,
  dismissAccountToastsExcept,
} from './order-toasts';

/**
 * 결정 2-25 (#66, ADR-0140): the order toasts that stay until closed are one account's, and go
 * when it leaves the screen — the provider's owner turn, SessionCacheGuard's session turn, the
 * tab's own sign-out — so the next user never reads the last one's order or restriction.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  dismissAccountToastsExcept(null);
  vi.restoreAllMocks();
});

describe('order toasts kept per account', () => {
  it('dismisses the toasts of every account but the one now on screen', async () => {
    const a = createAccountToast(A, { title: 'A', duration: Number.POSITIVE_INFINITY });
    const b = createAccountToast(B, { title: 'B', duration: Number.POSITIVE_INFINITY });
    expect(accountToastIds(A)).toEqual([a]);
    const dismiss = vi.spyOn(toaster, 'dismiss');
    dismissAccountToastsExcept(B);
    // A microtask later: never inside React's render or effects (ADR-0092 8-37).
    expect(dismiss).not.toHaveBeenCalled();
    await flush();
    expect(dismiss.mock.calls).toEqual([[a]]);
    expect(accountToastIds(A)).toEqual([]);
    expect(accountToastIds(B)).toEqual([b]);
  });

  it('dismisses one account’s toasts as it leaves the order panel', async () => {
    const a = createAccountToast(A, { title: 'A' });
    const dismiss = vi.spyOn(toaster, 'dismiss');
    dismissAccountToasts(A);
    dismissAccountToasts(B);
    await flush();
    expect(dismiss.mock.calls).toEqual([[a]]);
  });

  it('dismisses them all on the tab’s own sign-out or 탈퇴', async () => {
    const a = createAccountToast(A, { title: 'A' });
    const b = createAccountToast(B, { title: 'B' });
    const dismiss = vi.spyOn(toaster, 'dismiss');
    forgetAccountInTab(new QueryClient());
    await flush();
    expect(dismiss.mock.calls.flat().toSorted()).toEqual([a, b].toSorted());
  });
});

/**
 * A toast raised while React runs effects (#123, ADR-0141 결정 2-6: the order detail's notice) is
 * stored a microtask later (ADR-0092 8-37) — as its account's all the same, and never once that
 * account left the screen in between.
 */
describe('an account toast raised while React runs effects', () => {
  it('is stored a microtask later, under its account, and goes with it', async () => {
    const create = vi.spyOn(toaster, 'create');
    accountToastAfterCommit(A, { type: 'info', title: 'A' });
    expect(create).not.toHaveBeenCalled();
    expect(accountToastIds(A)).toEqual([]);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ type: 'info', title: 'A' });
    const [id] = accountToastIds(A);
    expect(id).toBe(create.mock.results[0]?.value);
    const dismiss = vi.spyOn(toaster, 'dismiss');
    dismissAccountToastsExcept(B);
    await flush();
    expect(dismiss.mock.calls).toEqual([[id]]);
    expect(accountToastIds(A)).toEqual([]);
  });

  it('is never stored once its account left before the commit ended', async () => {
    const create = vi.spyOn(toaster, 'create');
    // The three ways out (결정 2-25), each in the same task as the raise — an effect of the same
    // commit: the session turned, the screen's account turned, the tab's own sign-out or 탈퇴.
    const leaving: readonly (() => void)[] = [
      () => dismissAccountToastsExcept(B),
      () => dismissAccountToastsExcept(null),
      () => dismissAccountToasts(A),
      () => forgetAccountInTab(new QueryClient()),
    ];
    for (const leave of leaving) {
      accountToastAfterCommit(A, { type: 'info', title: 'A' });
      leave();
      await flush();
      await flush();
      expect(create).not.toHaveBeenCalled();
      expect(accountToastIds(A)).toEqual([]);
    }
  });

  it('is stored for the account that stays, and for one raised after the leave', async () => {
    const create = vi.spyOn(toaster, 'create');
    accountToastAfterCommit(B, { type: 'info', title: 'B' });
    dismissAccountToastsExcept(B);
    dismissAccountToasts(A);
    accountToastAfterCommit(A, { type: 'info', title: 'A again' });
    await flush();
    expect(create.mock.calls.map(([options]) => options.title)).toEqual(['B', 'A again']);
    expect(accountToastIds(B)).toHaveLength(1);
    expect(accountToastIds(A)).toHaveLength(1);
  });
});

describe('where the toasts are raised and dismissed', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('raises every order toast under its account', () => {
    const recovery = read('./order-recovery.tsx');
    expect(recovery).not.toContain('toaster.create(');
    expect(recovery.match(/createAccountToast\(accountId, \{/g)).toHaveLength(3);
    const provider = read('./order-panel-provider.tsx');
    expect(provider).toContain('orderToast(order, account)');
    expect(provider).toContain(
      'failureToast(outcome.failure, endsAt == null ? null : format(endsAt), account)',
    );
  });

  it('dismisses them as the account leaves the panel and as the session turns', () => {
    const provider = read('./order-panel-provider.tsx');
    expect(provider).toContain(
      "if (typeof before === 'string' && before !== owner) dismissAccountToasts(before);",
    );
    const guard = read('../auth/session-cache-guard.tsx');
    expect(guard).toContain('dismissAccountToastsExcept(identity);');
  });
});
