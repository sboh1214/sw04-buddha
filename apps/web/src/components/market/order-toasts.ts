import { toaster } from '@/components/ui/toaster';

/**
 * The order panel's toasts that stay until they are closed (#66, ADR-0140 결정 2-7): an order's
 * result, a refusal that wrote no row, a request not found — each one account's, told where no
 * panel shows it. The global toaster outlives the account, so each toast is kept under the account
 * it was raised for and dismissed when that account leaves the screen (결정 2-25): another account
 * on the order panel's provider (`accountChanged`), a sign-out or another sign-in SessionCacheGuard
 * hears, and the tab's own sign-out or 탈퇴 (`forgetAccountInTab`). The next user never reads the
 * last one's order or restriction.
 *
 * In memory, this tab's, as the toaster is.
 */
const kept = new Map<string, Set<string>>();

type ToastOptions = Parameters<typeof toaster.create>[0];

/** Raises `options` as `accountId`'s toast, kept until it is closed or the account leaves. */
export function createAccountToast(accountId: string, options: ToastOptions): string {
  const id = toaster.create({
    ...options,
    onStatusChange: (details) => {
      options.onStatusChange?.(details);
      // Closed by its reader (or dismissed below): nothing left to dismiss.
      if (details.status === 'unmounted') kept.get(accountId)?.delete(id);
    },
  });
  const ids = kept.get(accountId) ?? new Set<string>();
  ids.add(id);
  kept.set(accountId, ids);
  return id;
}

/**
 * Dismisses the toasts of every account `keep` is not (null: of every account). A microtask
 * later: the toaster stores its list with React's `flushSync`, which cannot run while React
 * renders or runs effects (`toastAfterCommit`, ADR-0092 8-37), and the callers are effects.
 */
export function dismissAccountToastsExcept(keep: string | null): void {
  const going = [...kept.keys()].filter((accountId) => accountId !== keep);
  if (going.length === 0) return;
  const ids = going.flatMap((accountId) => {
    const own = [...(kept.get(accountId) ?? [])];
    kept.delete(accountId);
    return own;
  });
  queueMicrotask(() => {
    for (const id of ids) toaster.dismiss(id);
  });
}

/** Dismisses `accountId`'s toasts (the account left the order panel's screen). */
export function dismissAccountToasts(accountId: string): void {
  const own = kept.get(accountId);
  if (own === undefined) return;
  kept.delete(accountId);
  const ids = [...own];
  queueMicrotask(() => {
    for (const id of ids) toaster.dismiss(id);
  });
}

/** The ids kept for `accountId` now — for tests. */
export function accountToastIds(accountId: string): string[] {
  return [...(kept.get(accountId) ?? [])];
}
