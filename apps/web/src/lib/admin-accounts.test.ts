import {
  ADMIN_GRANT_REFUSALS,
  ADMIN_REVOKE_REFUSALS,
  ADMIN_ROLE_CHANGE_TYPES,
  ADMIN_ROLE_REASON_MAX_LENGTH,
  MIN_ADMINS,
} from '@buddha/shared';
import { readFileSync } from 'node:fs';
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
  heldForOperator,
  operatorHold,
  revokedOwnRole,
  revokesSelf,
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

  it('explains a grant to an account its member closed since the search, not as an email to verify (#140)', () => {
    expect(adminRoleChangeRefusal(apiError(409, 'ACCOUNT_CLOSED'))).toEqual({
      alert: copy.adminGrantClosed,
    });
    expect(copy.adminGrantClosed).not.toBe(copy.errAdminGrantEmailNotVerified);
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
    // A granting admin who closed the account since (#140, once the role was revoked): no
    // nickname, named as every byline names a closed account — never 'null'.
    expect(formatAdminGrant({ grantedAt: at, grantedBy: { id: 'a', nickname: null } })).toBe(
      `${copy.adminAccountsGrantedAt} ${formatKst(at)} · ${copy.postAuthorFormer}`,
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

  it('names an account its member closed apart from a deleted one (#140)', () => {
    // The closure keeps the account and replaces its address with the closed placeholder; only
    // the nickname goes.
    expect(
      adminRoleChangeTarget({
        target: { id: 'u', email: 'closed_u@noemail.buddha.local', nickname: null },
      }),
    ).toBe(copy.postAuthorFormer);
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
  it('is not known until `GET /me` has said which admin is on screen, even if the list came first', () => {
    expect(revokesSelf('me', undefined)).toBeUndefined();
    expect(revokesSelf('other', undefined)).toBeUndefined();
  });

  it("is mine for the admin on screen and another admin's otherwise", () => {
    expect(revokesSelf('me', 'me')).toBe(true);
    expect(revokesSelf('other', 'me')).toBe(false);
  });
});

describe('what an admin screen picked, held for the admin on screen (heldForOperator, ADR-0091)', () => {
  const picked = { kind: 'grant', userId: 'target' };

  it('stays while the admin it was picked by is on screen, and nothing held stays nothing', () => {
    const held = { value: picked, operatorId: 'a' };
    expect(heldForOperator(held, 'a')).toBe(held);
    expect(heldForOperator(null, 'a')).toBeNull();
    expect(heldForOperator(null, undefined)).toBeNull();
  });

  it("is dropped once another admin is drawn — `['me']` turned from A to B in place", () => {
    // The order SessionCacheGuard never sees (ADR-0090 결정 4-2): a dialog opened, and its reason
    // typed, on A's screen would otherwise be sent naming B, now the admin on screen.
    expect(heldForOperator({ value: picked, operatorId: 'a' }, 'b')).toBeNull();
  });

  it('is dropped once nobody is known to be on screen — the guard’s reset — and stays dropped', () => {
    expect(heldForOperator({ value: picked, operatorId: 'a' }, undefined)).toBeNull();
  });

  it('is never handed to the next admin known — not even one picked while nobody was', () => {
    // A pick can only be held for a known admin (`operatorHold`), so nothing waits to be adopted;
    // and a hold is the admin's it was made for alone: B after A drops it, as does A after the
    // reset left nobody known in between.
    const held = { value: picked, operatorId: 'a' };
    expect(heldForOperator(heldForOperator(held, undefined), 'a')).toBeNull();
    expect(heldForOperator(heldForOperator(held, undefined), 'b')).toBeNull();
  });
});

describe('what an admin screen may pick (operatorHold, ADR-0091)', () => {
  const picked = { kind: 'grant', userId: 'target' };

  it('is held for the admin on screen', () => {
    expect(operatorHold(picked, 'a')).toEqual({ value: picked, operatorId: 'a' });
    expect(operatorHold(null, 'a')).toBeNull();
  });

  it('is nothing while no admin is known — `GET /me` pending or failed', () => {
    // A grant picked then would be handed to whichever admin `GET /me` names first, and the cookie
    // may have turned to B meanwhile (another window signing in, SessionCacheGuard's reset): A's
    // pick and reason, sent as B. The screens offer nothing to pick until then.
    expect(operatorHold(picked, undefined)).toBeNull();
    expect(operatorHold(null, undefined)).toBeNull();
  });
});

describe('the admin the operator writes name (ADR-0091)', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const MODERATION_PAGES = [
    '../app/admin/moderation/user-moderation.tsx',
    '../app/admin/moderation/item-moderation.tsx',
    '../app/admin/moderation/actions/admin-moderation-actions.tsx',
    '../app/admin/moderation/account-restriction-requests/admin-account-requests.tsx',
  ];

  it('is the admin of the `Me` the screen is drawn from, never the session’s', () => {
    // In the render between the session naming B and SessionCacheGuard's reset the admin screens
    // are still A's, and a grant, a revoke or a moderation action naming the session's account
    // would be done as B with B's cookie — A's pick and A's reason. No component renders under
    // node (vitest's `environment: 'node'`), so the wiring is pinned in the sources: the admin on
    // screen is `GET /me`'s, and nothing on these screens reads the session's account. e2e
    // admin-accounts.spec.ts and reports.spec.ts ('탭의 계정이 …') drive them.
    const operator = source('../hooks/use-operator.ts');
    const start = operator.indexOf('export function useOperatorId()');
    expect(start).toBeGreaterThan(-1);
    expect(operator.slice(start, operator.indexOf('\n}\n', start))).toContain(
      'return useMe().data?.id;',
    );
    expect(operator).not.toMatch(/useSession|user\.id/);
    for (const file of [
      './admin-accounts.ts',
      '../app/admin/admins/admin-accounts.tsx',
      '../app/admin/moderation/moderation-parts.tsx',
      ...MODERATION_PAGES,
    ]) {
      expect(source(file), file).not.toMatch(/screenAccountId|SessionIdentity|useSession/);
    }
    // The hooks only ask for the session again on the refusal; they offer no account.
    expect(source('../hooks/use-admin-accounts.ts')).not.toMatch(
      /screenAccountId|user\.id|\baccountId\b|\bready\b/,
    );
    const accounts = source('../app/admin/admins/admin-accounts.tsx');
    expect(accounts.match(/expectedAccountId: operatorId \}/g)).toHaveLength(2);
    expect(accounts.match(/revokesSelf\([\w.]+, operatorId\)/g)).toHaveLength(2);
    const parts = source('../app/admin/moderation/moderation-parts.tsx');
    expect(parts).toContain("import { useOperatorId } from '@/hooks/use-operator';");
    expect(parts.match(/expectedAccountId: operatorId\b/g)).toHaveLength(4);
  });

  it('holds what a screen picked for the admin it was picked by', () => {
    // `['me']` can turn from A to B in place, before the session does (ADR-0090 결정 4-2 — no
    // reset then): a grant or a revoke waiting for its reason, or a moderation dialog, opened on
    // A's screen would stay with what was typed for A and name B. Each is held for the admin on
    // screen (`useHeldForOperator`, `heldForOperator`) and dropped once another is drawn. e2e
    // admin-accounts.spec.ts and reports.spec.ts ('탭의 세션이 …') hold that order.
    const accounts = source('../app/admin/admins/admin-accounts.tsx');
    expect(accounts.match(/= useHeldForOperator<PendingRoleChange>\(\);/g)).toHaveLength(2);
    expect(accounts).not.toMatch(/useState<PendingRoleChange/);
    const held = MODERATION_PAGES.flatMap(
      (file) => source(file).match(/= useHeldForOperator<DialogSpec>\(\);/g) ?? [],
    );
    // The member's page, a post's and a comment's, the action log and the requests.
    expect(held).toHaveLength(5);
    for (const file of MODERATION_PAGES) {
      expect(source(file), file).not.toMatch(/useState<DialogSpec/);
    }
    const operator = source('../hooks/use-operator.ts');
    expect(operator).toContain('const current = heldForOperator(held, operatorId);');
    expect(operator).toContain('if (current !== held) setHeld(current);');
    expect(operator).toContain('setHeld(operatorHold(value, operatorId));');
  });

  it('offers 부여 and 회수 only once `GET /me` has said which admin is on screen', () => {
    // A grant picked before that would be held for nobody — `operatorHold` holds nothing then —
    // and, held, would be handed to whichever admin `GET /me` names first (ADR-0091). 회수 waits
    // through `revokesSelf`; 부여 through the candidate's `disabled`. e2e admin-accounts.spec.ts
    // ('`GET /me`가 답하기 전에는 …') holds `GET /me` and sees both off.
    const accounts = source('../app/admin/admins/admin-accounts.tsx');
    expect(accounts).toContain('disabled={stale || operatorId === undefined}');
    expect(accounts).toContain('canRevoke={self !== undefined}');
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
