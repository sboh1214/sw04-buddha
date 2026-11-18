import { toaster } from '@/components/ui/toaster';

/**
 * The toasts that say one account's order facts: the order panel's that stay until they are closed
 * (#66, ADR-0140 결정 2-7 — an order's result, a refusal that wrote no row, a request not found,
 * told where no panel shows it), and 대기 주문's notices (#123, ADR-0141 결정 2-6 — an order that
 * ended, a cancel that failed). The global toaster outlives the account, so each toast is kept
 * under the account it was raised for and dismissed when that account leaves the screen (결정
 * 2-25): another account on the order panel's provider (`accountChanged`) or on MY's order lists
 * and detail (`useOrderToastsOf`), a sign-out or another sign-in SessionCacheGuard hears, and the
 * tab's own sign-out or 탈퇴 (`forgetAccountInTab`). The next user never reads the last one's
 * order or restriction — a toast of the default few seconds neither: an account can turn faster.
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

/** The toasts raised for an account and not stored yet (`accountToastAfterCommit`). */
const waiting = new Map<string, Set<{ left: boolean }>>();

/**
 * `createAccountToast` for a toast raised while React runs effects — from an effect's body, or
 * from a function one calls: stored a microtask later, once the effects are over
 * (`toastAfterCommit`, ADR-0092 8-37), at the same moment for its reader.
 * Never stored if `accountId` left the screen meanwhile — an effect of the same commit that heard
 * the session turn (SessionCacheGuard) dismisses before this microtask runs, and would miss it.
 */
export function accountToastAfterCommit(accountId: string, options: ToastOptions): void {
  const one = { left: false };
  const own = waiting.get(accountId) ?? new Set<{ left: boolean }>();
  own.add(one);
  waiting.set(accountId, own);
  queueMicrotask(() => {
    if (one.left) return;
    // Not left: `own` is still the account's set (`leave` drops it only with every one marked).
    own.delete(one);
    if (own.size === 0) waiting.delete(accountId);
    createAccountToast(accountId, options);
  });
}

/**
 * Takes `accountIds` out: a toast of theirs still waiting is never stored, and the stored ones
 * are dismissed a microtask later — the toaster stores its list with React's `flushSync`, which
 * cannot run while React renders or runs effects (`toastAfterCommit`, ADR-0092 8-37), and the
 * callers are effects.
 */
function leave(accountIds: readonly string[]): void {
  const ids: string[] = [];
  for (const accountId of accountIds) {
    for (const one of waiting.get(accountId) ?? []) one.left = true;
    waiting.delete(accountId);
    ids.push(...(kept.get(accountId) ?? []));
    kept.delete(accountId);
  }
  if (ids.length === 0) return;
  queueMicrotask(() => {
    for (const id of ids) toaster.dismiss(id);
  });
}

/** Dismisses the toasts of every account `keep` is not (null: of every account). */
export function dismissAccountToastsExcept(keep: string | null): void {
  leave([...new Set([...kept.keys(), ...waiting.keys()])].filter((id) => id !== keep));
}

/** Dismisses `accountId`'s toasts (the account left the order panel's screen). */
export function dismissAccountToasts(accountId: string): void {
  leave([accountId]);
}

/** The ids kept for `accountId` now — for tests. */
export function accountToastIds(accountId: string): string[] {
  return [...(kept.get(accountId) ?? [])];
}
