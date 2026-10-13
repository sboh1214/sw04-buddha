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
  type AdminAccount,
  type AdminRoleChange,
  validationField,
  validationMessage,
} from './api';
import { formatKst } from './datetime';

/**
 * Pure helpers behind 관리자 계정 (`/admin/admins`, #171, ADR-0056): how a grant reads in the
 * list and in the record, the reason form, and what the screen says when the API refuses a
 * grant or a revoke. The rules themselves are the server's (AdminAccountsService); the screen
 * explains them and shows the refusal it gets back.
 */

/** Why each grant or revoke is refused (ROLE_CHANGE_NOT_ALLOWED `details[0].message`). */
export const ADMIN_ROLE_REFUSAL_MESSAGE: Readonly<Record<AdminRoleChangeRefusal, string>> = {
  already_admin: copy.errAdminGrantAlreadyAdmin,
  email_not_verified: copy.errAdminGrantEmailNotVerified,
  contact_required: copy.errAdminGrantContactRequired,
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
  const by = account.grantedBy === null ? '' : ` · ${account.grantedBy.nickname}`;
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

/** Whose role changed: its nickname now, or 삭제된 계정 once the account is gone. */
export function adminRoleChangeTarget(change: Pick<AdminRoleChange, 'target'>): string {
  return change.target.nickname ?? copy.adminAccountsTargetGone;
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
 *   so the admin reads it — a missing contact, an unverified email, fewer than two admins left.
 * - `toast`: anything else. `keepDialog` only when the request never came back (nothing was
 *   decided, so the admin may send it again); an answer from the API closes it.
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
  if (isApiError(error, 'NOT_FOUND')) {
    return { toast: copy.errAdminAccountNotFound, keepDialog: false };
  }
  if (isApiError(error, 'UNAUTHENTICATED')) {
    return { toast: copy.errUnauthenticated, keepDialog: false };
  }
  // A member, or an admin whom another admin revoked since the screen loaded.
  if (isApiError(error, 'FORBIDDEN')) return { toast: copy.adminOnly, keepDialog: false };
  return { toast: copy.errUnknown, keepDialog: false };
}
