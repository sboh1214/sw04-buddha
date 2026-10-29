import {
  ADMIN_GRANT_REFUSALS,
  ADMIN_REVOKE_REFUSALS,
  ADMIN_ROLE_REASON_MAX_LENGTH,
  type AdminRoleChangeRefusal,
  type AdminRoleChangeType,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  isApiError,
  isForAnotherAccount,
  type AdminAccount,
  type AdminRoleChange,
  type AdminUser,
  validationField,
  validationMessage,
} from './api';
import { nicknameShown } from './account-closure';
import { formatKst } from './datetime';

/**
 * Pure helpers behind 운영자 계정 (`/admin/admins`, #171, ADR-0056): how a grant reads in the
 * list and in the record, the reason form, and what the screen says when the API refuses a
 * grant or a revoke. The rules themselves are the server's (AdminAccountsService); the screen
 * explains them and shows the refusal it gets back.
 */

/** Why each grant or revoke is refused (ROLE_CHANGE_NOT_ALLOWED `details[0].message`). */
export const ADMIN_ROLE_REFUSAL_MESSAGE: Readonly<Record<AdminRoleChangeRefusal, string>> = {
  already_admin: copy.errAdminGrantAlreadyAdmin,
  email_not_verified: copy.errAdminGrantEmailNotVerified,
  phone_not_verified: copy.errAdminGrantPhoneNotVerified,
  not_admin: copy.errAdminRevokeNotAdmin,
  min_admins: copy.errAdminRevokeMinAdmins,
};

const REFUSALS: ReadonlySet<string> = new Set([...ADMIN_GRANT_REFUSALS, ...ADMIN_REVOKE_REFUSALS]);

export function isAdminRoleChangeRefusal(value: unknown): value is AdminRoleChangeRefusal {
  return typeof value === 'string' && REFUSALS.has(value);
}

/** The list's line under an admin: when and by whom it was granted, or that no record says. */
export function formatAdminGrant(account: Pick<AdminAccount, 'grantedAt' | 'grantedBy'>): string {
  if (account.grantedAt === null) return copy.adminAccountsGrantUnknown;
  const by = account.grantedBy === null ? '' : ` · ${nicknameShown(account.grantedBy.nickname)}`;
  return `${copy.adminAccountsGrantedAt} ${formatKst(account.grantedAt)}${by}`;
}

/** `관리자 2명`, beside the list's heading. */
export function adminCountLabel(count: number): string {
  return `${copy.adminTitle} ${String(count)}${copy.adminAccountsCountUnit}`;
}

/** The record's kind, as its badge reads it. */
export function adminRoleChangeLabel(type: AdminRoleChangeType): string {
  return type === 'admin_grant' ? copy.adminAccountsChangeGrant : copy.adminAccountsChangeRevoke;
}

/** The badge palette of each kind; the label is always inside it (PLAN 11.2). */
export const ADMIN_ROLE_CHANGE_PALETTE: Readonly<Record<AdminRoleChangeType, string>> = {
  admin_grant: 'brand',
  admin_revoke: 'red',
};

/**
 * Whose role changed: its nickname now, '탈퇴한 사용자' once its member closed it (#140 — the
 * nickname goes, the account and its placeholder address stay), or 삭제된 계정 once the account is
 * gone.
 */
export function adminRoleChangeTarget(change: Pick<AdminRoleChange, 'target'>): string {
  if (change.target.nickname !== null) return change.target.nickname;
  return change.target.email === null ? copy.adminAccountsTargetGone : nicknameShown(null);
}

/** One page of the grant search (`useAdminGrantCandidates`), with the term it answers. */
export interface GrantCandidatePage {
  term: string;
  items: AdminUser[];
  nextCursor: string | null;
}

/**
 * The grant search's accounts, and whether they are another search's (`stale`). While a newly
 * submitted term loads, react-query keeps the previous term's pages on screen
 * (`keepPreviousData`, flagged `isPlaceholderData`), and a 부여 on one of them would aim at an
 * account the submitted search did not find. So stale rows are shown dimmed, with no 부여 and no
 * 더 보기, until the submitted term's own pages arrive. Each page carries its term as well: a page
 * of another term is stale even without the flag.
 */
export function grantSearchRows(
  term: string,
  pages: readonly GrantCandidatePage[] | undefined,
  isPlaceholderData: boolean,
): { rows: AdminUser[]; stale: boolean } {
  const shown = pages ?? [];
  return {
    rows: shown.flatMap((page) => page.items),
    stale: isPlaceholderData || shown.some((page) => page.term !== term),
  };
}

/**
 * Whether revoking `accountId` would revoke the role of the admin on screen — `operatorId`, the
 * account of the `Me` the screen is drawn from (`useOperatorId`, ADR-0091) — or `undefined` while
 * that is not known. It badges 나 and puts the warning in the dialog, and 회수 stays off until it
 * is known — the admin list can arrive before `GET /me`. Whether to sign out after a revoke is NOT
 * decided by it: that is the answer's (`revokedOwnRole`).
 */
export function revokesSelf(
  accountId: string,
  operatorId: string | undefined,
): boolean | undefined {
  return operatorId === undefined ? undefined : operatorId === accountId;
}

/**
 * Something an admin screen picked or opened — a dialog with its target — and the admin on screen
 * who picked it (`useOperatorId`). Nothing is held for nobody (`operatorHold`).
 */
export interface OperatorHeld<T> {
  value: T;
  operatorId: string;
}

/**
 * What picking `value` holds while `operatorId` is the admin on screen (`useHeldForOperator`,
 * ADR-0091): nothing while that admin is not known — `GET /me` pending, or failed without ever
 * answering. A pick made then would belong to whichever admin `GET /me` names first, and the
 * cookie may have changed meanwhile (another window signing in as B, a SessionCacheGuard reset
 * that leaves `['me']` unknown): A's pick and reason, sent as B. So the screens offer nothing to
 * pick until then (부여 and 회수 wait, as every moderation action's button does).
 */
export function operatorHold<T>(
  value: T | null,
  operatorId: string | undefined,
): OperatorHeld<T> | null {
  return value === null || operatorId === undefined ? null : { value, operatorId };
}

/**
 * What `held` is once the admin on screen is `operatorId` (`useHeldForOperator`, ADR-0091): kept
 * while it is the admin it was picked by, and dropped once another admin, or nobody known
 * (SessionCacheGuard's reset, a `GET /me` that failed), is on screen — never handed on to the
 * next admin known. A grant, a revoke or a moderation action picked — and its reason typed — on
 * A's screen is not B's to send: `['me']` can turn from A to B in place, before the session does
 * (ADR-0090 결정 4-2).
 */
export function heldForOperator<T>(
  held: OperatorHeld<T> | null,
  operatorId: string | undefined,
): OperatorHeld<T> | null {
  return held !== null && held.operatorId === operatorId ? held : null;
}

/**
 * Whether a revoke's answer took the role of the very account that sent it: its sessions are gone
 * and the tab signs out (`useSignOut`). Decided by the server's answer and the account the request
 * named (`expectedAccountId`), which the server refused unless the cookie was that account — so
 * the answer's actor is it, and the revoke was its own exactly when the target is it too. Never by
 * what the screen believed: another tab may have signed in as somebody else since `GET /me` was
 * read (sign-ins are not broadcast), and a tab trusting that would sign the other account out, or
 * take its own revoke for another's and stay on a stale admin screen.
 */
export function revokedOwnRole(
  change: Pick<AdminRoleChange, 'type' | 'actor' | 'target'>,
  expectedAccountId: string,
): boolean {
  return (
    change.type === 'admin_revoke' &&
    change.actor.id === expectedAccountId &&
    change.target.id === expectedAccountId
  );
}

/** The grant and revoke dialogs' one field: a reason of 1–500 characters (`AdminGrantBody`). */
export const adminRoleReasonFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, copy.errAdminRoleReason)
    .max(ADMIN_ROLE_REASON_MAX_LENGTH, copy.errAdminRoleReason),
});
export type AdminRoleReasonValues = z.infer<typeof adminRoleReasonFormSchema>;

/**
 * What a dialog does with a refused grant or revoke.
 * - `field`: the reason was refused; the message goes under it and the dialog stays.
 * - `alert`: the rules refused it (ROLE_CHANGE_NOT_ALLOWED): why, inside the dialog, which stays
 *   so the admin reads it — an unverified phone, an unverified email, fewer than two admins left;
 *   or a grant to an account its member closed since the search (ACCOUNT_CLOSED, #140).
 * - `toast`: anything else, a change of the signed-in account among it (`sessionChanged`).
 *   `keepDialog` only when the request never came back (nothing was decided, so the admin may
 *   send it again); an answer from the API closes it.
 * The lists are refreshed on every answer (use-admin-accounts), so the screen shows what the
 * server holds now — another admin may have changed the role first.
 */
export type AdminRoleChangeOutcome =
  { field: 'reason'; message: string } | { alert: string } | { toast: string; keepDialog: boolean };

export function adminRoleChangeRefusal(error: unknown): AdminRoleChangeOutcome {
  if (!isApiError(error)) return { toast: copy.errUnknown, keepDialog: true };
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'reason') {
    return { field: 'reason', message: copy.errAdminRoleReason };
  }
  if (isApiError(error, 'ROLE_CHANGE_NOT_ALLOWED')) {
    const refusal = validationMessage(error);
    return {
      alert: isAdminRoleChangeRefusal(refusal)
        ? ADMIN_ROLE_REFUSAL_MESSAGE[refusal]
        : copy.errUnknown,
    };
  }
  // Closed by its member since the search was read (#140): the grant's own sentence, in the dialog
  // like the rules' refusals — the account will never take the role.
  if (isApiError(error, 'ACCOUNT_CLOSED')) return { alert: copy.adminGrantClosed };
  if (isApiError(error, 'NOT_FOUND')) {
    return { toast: copy.errAdminAccountNotFound, keepDialog: false };
  }
  if (isApiError(error, 'UNAUTHENTICATED')) {
    return { toast: copy.errUnauthenticated, keepDialog: false };
  }
  // The cookie is another account's now (another tab signed in): nothing was done, and the hook
  // refetches the session so the screen shows the account that is really signed in.
  if (isForAnotherAccount(error)) return { toast: copy.sessionChanged, keepDialog: false };
  // A member, or an admin whom another admin revoked since the screen loaded.
  if (isApiError(error, 'FORBIDDEN')) return { toast: copy.adminOnly, keepDialog: false };
  return { toast: copy.errUnknown, keepDialog: false };
}
