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
  grantSearchRows,
  isAdminRoleChangeRefusal,
  revokedOwnRole,
  revokesSelf,
  screenAccountId,
  type GrantCandidatePage,
} from './admin-accounts';
import { ApiError, type AdminRoleChange, type AdminUser } from './api';
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

  it('states the grant conditions and what a revoke does (owner decision 2026-10-13, ADR-0070)', () => {
    // Every text that names the grant conditions names both: a verified email and a completed
    // phone verification — never the real name and number typed without one (ADR-0043).
    for (const text of [
      copy.adminAccountsGrantRule,
      copy.adminAccountsGrantNotice,
      copy.errAdminGrantEmailNotVerified,
      copy.errAdminGrantPhoneNotVerified,
    ]) {
      expect(text).toContain('이메일 인증과 휴대전화 본인확인');
      expect(text).not.toContain('입력을 마친');
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
    expect(adminRoleChangeRefusal(refused('phone_not_verified'))).toEqual({
      alert: copy.errAdminGrantPhoneNotVerified,
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
    // Another tab signed in as somebody else: the server did nothing, and says the account changed.
    expect(
      adminRoleChangeRefusal(
        apiError(403, 'FORBIDDEN', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
      ),
    ).toEqual({ toast: copy.sessionChanged, keepDialog: false });
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

describe('the grant search', () => {
  const account = (nickname: string) => ({ id: nickname, nickname }) as unknown as AdminUser;
  const page = (term: string, items: AdminUser[], nextCursor: string | null = null) =>
    ({ term, items, nextCursor }) satisfies GrantCandidatePage;
  const kim = account('kim');
  const kimchi = account('kimchi');
  const lee = account('lee');

  it("offers the submitted term's accounts, every page of them", () => {
    expect(
      grantSearchRows('kim', [page('kim', [kim], 'next'), page('kim', [kimchi])], false),
    ).toEqual({ rows: [kim, kimchi], stale: false });
    expect(grantSearchRows('kim', [page('kim', [])], false)).toEqual({ rows: [], stale: false });
  });

  it('offers nothing of the previous term while the submitted one loads', () => {
    // keepPreviousData: the query of `lee` shows the pages of `kim` as its placeholder.
    expect(grantSearchRows('lee', [page('kim', [kim])], true)).toEqual({
      rows: [kim],
      stale: true,
    });
    // A page of another term is stale even when the flag says otherwise.
    expect(grantSearchRows('lee', [page('kim', [kim])], false).stale).toBe(true);
    expect(grantSearchRows('lee', [page('lee', [lee]), page('kim', [kim])], false).stale).toBe(
      true,
    );
    // The placeholder flag alone is enough too.
    expect(grantSearchRows('lee', [page('lee', [lee])], true).stale).toBe(true);
  });

  it('has nothing to offer before any answer', () => {
    expect(grantSearchRows('kim', undefined, false)).toEqual({ rows: [], stale: false });
  });
});

describe('a revoke of my own role', () => {
  const me = { user: { id: 'me' } };

  it('is not known while the session loads, even if the admin list came first', () => {
    // During hydration `useSession` answers pending with no data; a cached answer stays pending
    // until it settles too.
    expect(revokesSelf('me', { isPending: true, data: null })).toBeUndefined();
    expect(revokesSelf('other', { isPending: true, data: null })).toBeUndefined();
    expect(revokesSelf('me', { isPending: true, data: me })).toBeUndefined();
  });

  it('is not known without a signed-in account', () => {
    expect(revokesSelf('me', { isPending: false, data: null })).toBeUndefined();
    expect(revokesSelf('me', { isPending: false, data: undefined })).toBeUndefined();
  });

  it("is mine for the signed-in account and another admin's otherwise, once the session is in", () => {
    expect(revokesSelf('me', { isPending: false, data: me })).toBe(true);
    expect(revokesSelf('other', { isPending: false, data: me })).toBe(false);
  });

  it('names the signed-in account as the one on screen, once the session is in', () => {
    expect(screenAccountId({ isPending: true, data: me })).toBeUndefined();
    expect(screenAccountId({ isPending: false, data: null })).toBeUndefined();
    expect(screenAccountId({ isPending: false, data: me })).toBe('me');
  });
});

describe('a revoke that took my own role', () => {
  const answer = (
    actor: string,
    target: string,
    type: AdminRoleChange['type'] = 'admin_revoke',
  ): Pick<AdminRoleChange, 'type' | 'actor' | 'target'> => ({
    type,
    actor: { id: actor, nickname: actor },
    target: { id: target, email: null, nickname: target },
  });

  it('is decided by the answer: its actor and target are the account the request named', () => {
    expect(revokedOwnRole(answer('me', 'me'), 'me')).toBe(true);
    // Another admin's role: no sign-out, however the screen saw it when sending.
    expect(revokedOwnRole(answer('me', 'other'), 'me')).toBe(false);
  });

  it('never signs out on an answer about another account', () => {
    // The tab believed it was `me`; the cookie was `other`'s, which revoked its own role. The
    // server refuses this (expectedAccountId), and the screen would not sign out on it either:
    // signing out would end `other`'s session from a tab showing `me`.
    expect(revokedOwnRole(answer('other', 'other'), 'me')).toBe(false);
    expect(revokedOwnRole(answer('other', 'me'), 'me')).toBe(false);
    // A grant is never a revoke of one's own role.
    expect(revokedOwnRole(answer('me', 'me', 'admin_grant'), 'me')).toBe(false);
  });
});
