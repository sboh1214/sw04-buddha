import { readFileSync } from 'node:fs';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toaster } from '@/components/ui/toaster';
import { forgetAccountInTab } from '@/hooks/use-sign-out';
import {
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
