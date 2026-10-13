import {
  ADMIN_GRANT_REFUSALS,
  ADMIN_REVOKE_REFUSALS,
  ADMIN_ROLE_CHANGE_TYPES,
  ADMIN_ROLE_REASON_MAX_LENGTH,
  MIN_ADMINS,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_ROLE_CHANGE_PALETTE,
  ADMIN_ROLE_REFUSAL_MESSAGE,
  adminCountLabel,
  adminRoleChangeLabel,
  adminRoleChangeRefusal,
  adminRoleChangeTarget,
  adminRoleReasonFormSchema,
  formatAdminGrant,
  isAdminRoleChangeRefusal,
} from './admin-accounts';
import { ApiError } from './api';
import { formatKst } from './datetime';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

const refused = (reason: string) =>
  apiError(409, 'ROLE_CHANGE_NOT_ALLOWED', [{ path: ['userId'], message: reason }]);

describe('the copy and the shared rules', () => {
  it('names the two-admin floor the server enforces', () => {
    const floor = `${String(MIN_ADMINS)}명`;
    expect(copy.adminAccountsRevokeRule).toContain(floor);
    expect(copy.adminAccountsRevokeNotice).toContain(floor);
    expect(copy.errAdminRevokeMinAdmins).toContain(floor);
  });

  it('names the reason length the server takes', () => {
    expect(copy.errAdminRoleReason).toContain(`1~${String(ADMIN_ROLE_REASON_MAX_LENGTH)}자`);
  });

  it('states the grant conditions and what a revoke does (owner decision 2026-10-13)', () => {
    for (const text of [copy.adminAccountsGrantRule, copy.adminAccountsGrantNotice]) {
      expect(text).toContain('이메일 인증');
      expect(text).toContain('실명·휴대전화');
    }
    expect(copy.adminAccountsRevokeEffect).toContain('로그아웃');
    expect(copy.adminAccountsRevokeNotice).toContain('로그아웃');
    expect(copy.adminAccountsRevokeRule).toContain('내 계정');
  });
});

describe('refusals', () => {
  it('has a message for every reason the server gives', () => {
    for (const reason of [...ADMIN_GRANT_REFUSALS, ...ADMIN_REVOKE_REFUSALS]) {
      expect(isAdminRoleChangeRefusal(reason)).toBe(true);
      expect(ADMIN_ROLE_REFUSAL_MESSAGE[reason].trim()).not.toBe('');
    }
    expect(new Set(Object.values(ADMIN_ROLE_REFUSAL_MESSAGE)).size).toBe(
      ADMIN_GRANT_REFUSALS.length + ADMIN_REVOKE_REFUSALS.length,
    );
    expect(isAdminRoleChangeRefusal('requester')).toBe(false);
    expect(isAdminRoleChangeRefusal(undefined)).toBe(false);
  });

  it('explains a refusal by the rules inside the dialog', () => {
    expect(adminRoleChangeRefusal(refused('contact_required'))).toEqual({
      alert: copy.errAdminGrantContactRequired,
    });
    expect(adminRoleChangeRefusal(refused('email_not_verified'))).toEqual({
      alert: copy.errAdminGrantEmailNotVerified,
    });
    expect(adminRoleChangeRefusal(refused('already_admin'))).toEqual({
      alert: copy.errAdminGrantAlreadyAdmin,
    });
    expect(adminRoleChangeRefusal(refused('not_admin'))).toEqual({
      alert: copy.errAdminRevokeNotAdmin,
    });
    expect(adminRoleChangeRefusal(refused('min_admins'))).toEqual({
      alert: copy.errAdminRevokeMinAdmins,
    });
    // A reason this screen does not know yet still says something, in the same place.
    expect(adminRoleChangeRefusal(refused('later_rule'))).toEqual({ alert: copy.errUnknown });
    expect(adminRoleChangeRefusal(apiError(409, 'ROLE_CHANGE_NOT_ALLOWED'))).toEqual({
      alert: copy.errUnknown,
    });
  });

  it('puts a refused reason under the field', () => {
    expect(
      adminRoleChangeRefusal(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'x' }]),
      ),
    ).toEqual({ field: 'reason', message: copy.errAdminRoleReason });
  });

  it('closes on any other answer, and stays when nothing came back', () => {
    expect(adminRoleChangeRefusal(apiError(404, 'NOT_FOUND'))).toEqual({
      toast: copy.errAdminAccountNotFound,
      keepDialog: false,
    });
    expect(adminRoleChangeRefusal(apiError(401, 'UNAUTHENTICATED'))).toEqual({
      toast: copy.errUnauthenticated,
      keepDialog: false,
    });
    // A member, or an admin revoked by another since the screen loaded.
    expect(adminRoleChangeRefusal(apiError(403, 'FORBIDDEN'))).toEqual({
      toast: copy.adminOnly,
      keepDialog: false,
    });
    expect(
      adminRoleChangeRefusal(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['userId'], message: 'x' }]),
      ),
    ).toEqual({ toast: copy.errUnknown, keepDialog: false });
    expect(adminRoleChangeRefusal(apiError(500, 'INTERNAL'))).toEqual({
      toast: copy.errUnknown,
      keepDialog: false,
    });
    expect(adminRoleChangeRefusal(new TypeError('Failed to fetch'))).toEqual({
      toast: copy.errUnknown,
      keepDialog: true,
    });
  });
});

describe('the reason form', () => {
  const message = (reason: string) => {
    const result = adminRoleReasonFormSchema.safeParse({ reason });
    return result.success ? undefined : result.error.issues[0]?.message;
  };

  it('takes 1–500 characters after trimming', () => {
    expect(message('운영 담당 교대')).toBeUndefined();
    expect(message('가'.repeat(ADMIN_ROLE_REASON_MAX_LENGTH))).toBeUndefined();
    expect(message('')).toBe(copy.errAdminRoleReason);
    expect(message('   ')).toBe(copy.errAdminRoleReason);
    expect(message('가'.repeat(ADMIN_ROLE_REASON_MAX_LENGTH + 1))).toBe(copy.errAdminRoleReason);
  });

  it('sends the trimmed reason', () => {
    expect(adminRoleReasonFormSchema.parse({ reason: '  교대  ' })).toEqual({ reason: '교대' });
  });
});

describe('how a grant reads', () => {
  const at = '2026-10-13T17:50:00.000Z';

  it('shows when and by whom, or that no record says', () => {
    expect(formatAdminGrant({ grantedAt: at, grantedBy: { id: 'a', nickname: '관리자2' } })).toBe(
      `${copy.adminAccountsGrantedAt} ${formatKst(at)} · 관리자2`,
    );
    expect(formatAdminGrant({ grantedAt: at, grantedBy: null })).toBe(
      `${copy.adminAccountsGrantedAt} ${formatKst(at)}`,
    );
    // An admin promoted before #171 (or by a test fixture) has no grant on record.
    expect(formatAdminGrant({ grantedAt: null, grantedBy: null })).toBe(
      copy.adminAccountsGrantUnknown,
    );
  });

  it('counts the admins', () => {
    expect(adminCountLabel(2)).toBe('관리자 2명');
  });
});

describe('the record', () => {
  it('labels and colours each kind apart, never brand for a revoke', () => {
    expect(adminRoleChangeLabel('admin_grant')).toBe(copy.adminAccountsChangeGrant);
    expect(adminRoleChangeLabel('admin_revoke')).toBe(copy.adminAccountsChangeRevoke);
    expect(new Set(ADMIN_ROLE_CHANGE_TYPES.map(adminRoleChangeLabel)).size).toBe(2);
    expect(ADMIN_ROLE_CHANGE_PALETTE.admin_revoke).not.toBe(ADMIN_ROLE_CHANGE_PALETTE.admin_grant);
  });

  it('names a deleted account', () => {
    expect(adminRoleChangeTarget({ target: { id: 'u', email: 'a@b.c', nickname: '회원' } })).toBe(
      '회원',
    );
    expect(adminRoleChangeTarget({ target: { id: 'u', email: null, nickname: null } })).toBe(
      copy.adminAccountsTargetGone,
    );
  });
});
