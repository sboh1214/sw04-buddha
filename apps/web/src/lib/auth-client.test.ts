import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { authErrorMessage, isAuthForAnotherAccount } from './auth-client';

describe('isAuthForAnotherAccount (ADR-0092)', () => {
  const refusal = {
    status: 403,
    code: 'FORBIDDEN',
    message: 'This session belongs to a different account than the one on screen',
    details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
  };

  it('is the 403 whose details name expectedAccountId, as the API’s hook answers it', () => {
    expect(isAuthForAnotherAccount(refusal)).toBe(true);
  });

  it('is no other failure', () => {
    for (const error of [
      null,
      undefined,
      {},
      // The CSRF refusal of an untrusted Origin, and a session too old to unlink with: no field.
      { status: 403, code: 'INVALID_ORIGIN', message: 'Invalid origin' },
      { status: 403, code: 'SESSION_NOT_FRESH' },
      { ...refusal, details: undefined },
      { ...refusal, details: 'expectedAccountId' },
      { ...refusal, details: [] },
      { ...refusal, details: [{ path: ['newEmail'] }] },
      { ...refusal, details: [{ path: 'expectedAccountId' }] },
      // The body that named no account is a 400, not another account.
      { ...refusal, status: 400, code: 'VALIDATION_ERROR' },
      { ...refusal, code: 'INVALID_PASSWORD' },
      { status: 503, code: 'NETWORK_ERROR' },
    ]) {
      expect(isAuthForAnotherAccount(error), JSON.stringify(error)).toBe(false);
    }
  });
});

describe('MY 설정’s better-auth writes name the account on screen (ADR-0092)', () => {
  /**
   * In the render between the session naming B and SessionCacheGuard's reset a MY 설정 card is
   * still A's while the cookie is B's, and a better-auth write taken with B's cookie was B's: B's
   * password changed (and B's other sessions ended), a confirmation mailed to B's address, the
   * provider A picked linked to B. No component renders under node, so the wiring is pinned in the
   * sources: each card is handed its `Me`'s id — never the session's — and merges it into
   * better-auth's body, and the refusal is shown as `copy.sessionChanged` after asking for the
   * session again (`useAuthSessionChanged`). e2e auth.spec.ts ('탭의 계정이 …') drives all three.
   */
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  /** The text of `function <name>(` up to the end of its declaration. */
  const declaration = (text: string, name: string) => {
    const start = text.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf('\n}\n', start));
  };

  it('the password card’s change names its Me', () => {
    const card = source('../app/my/settings/password-form.tsx');
    expect(card).toContain('<ChangePasswordFields key={me.id} accountId={me.id} />');
    const change = declaration(card, 'ChangePasswordFields');
    expect(change).toContain('authClient.changePassword(');
    expect(change).toContain('{ body: { expectedAccountId: accountId } }');
    expect(change).toContain('useAuthSessionChanged()');
    expect(change).toMatch(
      /if \(sessionChanged\(error\)\) \{\s+toaster\.create\(\{ type: 'error', title: copy\.sessionChanged \}\);/,
    );
  });

  it('the address card’s change names its Me', () => {
    const card = source('../app/my/settings/account-section.tsx');
    expect(card).toMatch(
      /<AccountFields\s+key=\{me\.id\}\s+accountId=\{me\.id\}\s+email=\{me\.email\}\s+emailVerified=\{me\.emailVerified\}\s+\/>/,
    );
    const fields = declaration(card, 'AccountFields');
    expect(fields).toContain('authClient.changeEmail(');
    expect(fields).toContain('{ body: { expectedAccountId: accountId } }');
    expect(fields).toContain('sessionChanged(error) ? copy.sessionChanged');
  });

  it('the login methods card’s link names its Me', () => {
    const card = source('../app/my/settings/linked-accounts.tsx');
    const linked = declaration(card, 'LinkedAccounts');
    expect(linked).toContain('const { data: me, isPending: mePending } = useMe();');
    expect(linked).toContain('authClient.linkSocial(');
    expect(linked).toContain('{ body: { expectedAccountId: account } }');
    expect(linked).toContain(
      'link.mutate({ provider: providerId as SocialProvider, account: me.id })',
    );
    expect(linked).toContain('sessionChanged(error)');
  });

  it('the login methods card waits for its Me as the other cards do, and says when it could not be read (owner decision 2026-10-26 17:21 answer 6)', () => {
    // «다른 카드처럼 보임»: the skeleton while `GET /me` is read, then `copy.errProfileLoad` and 다시
    // 시도 (`ProfileUnavailable`, ADR-0091's password card) — no row, 연결 or 해제 for nobody.
    // Before, the rows and 해제 stood while 연결 stayed off with no reason and no retry.
    const card = source('../app/my/settings/linked-accounts.tsx');
    expect(card).toContain("import { ProfileUnavailable } from './profile-unavailable';");
    const linked = declaration(card, 'LinkedAccounts');
    expect(linked).toContain('{mePending || !me ? (\n        <ProfileUnavailable />');
    // The rows are past it: the list's own states come only once the profile is there.
    expect(linked.indexOf('<ProfileUnavailable />')).toBeLessThan(
      linked.indexOf('accounts.isPending ?'),
    );
    expect(linked).not.toContain('accountId === undefined');
    // The failure the card shows is the shared one, with its retry of `GET /me`.
    const unavailable = source('../app/my/settings/profile-unavailable.tsx');
    expect(unavailable).toContain('<Alert.Description>{copy.errProfileLoad}</Alert.Description>');
    expect(unavailable).toContain('onClick={() => void refetch()}');
  });

  it('인증 메일 다시 보내기 reads the session and the profile again on EMAIL_MISMATCH, its message the generic one (owner decision 2026-10-26 17:21 answer 5)', () => {
    // better-auth mails a signed-in request only to its own account's address: EMAIL_MISMATCH says
    // the card's address is not the signed-in account's as it now is — another account signed in
    // in another window, or the address changed elsewhere. «다시 읽고 일반 문구 유지».
    const fields = declaration(source('../app/my/settings/account-section.tsx'), 'AccountFields');
    expect(fields).toContain('const emailMismatch = useAuthEmailMismatch();');
    expect(fields).toMatch(
      /authClient\.sendVerificationEmail\(\{ email, callbackURL: CALLBACK \}\);\s+if \(error\) \{[^}]*emailMismatch\(error\);\s+throw new Error\(authErrorMessage\(error\)\);/,
    );
    const hook = declaration(source('../hooks/use-session-changed.ts'), 'useAuthEmailMismatch');
    expect(hook).toContain('if (error?.code !== AUTH_ERROR.EMAIL_MISMATCH) return false;');
    expect(hook).toContain('void refetchSession();');
    expect(hook).toContain('void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });');
    // The generic message: EMAIL_MISMATCH has no copy of its own.
    expect(authErrorMessage({ status: 400, code: 'EMAIL_MISMATCH' })).toBe(copy.errUnknown);
  });

  it('the address card is drawn again for each account (owner decision 2026-10-26 17:21 answer 1)', () => {
    // `['me']` can turn from A to B in place, before the session does (ADR-0090 결정 4-2 — no
    // reset then): unkeyed, the address typed on A's card stayed with 변경 on and the next press
    // named B — B's `Me` — with B's cookie, mailing B's address a confirmation for what A typed.
    // Keyed by the account, as the password card is (ADR-0091 결정 3), it starts again empty. e2e
    // auth.spec.ts ('탭의 세션이 아직 …') holds that order.
    const card = source('../app/my/settings/account-section.tsx');
    const section = declaration(card, 'AccountSection');
    expect(section).toMatch(/<AccountFields\s+key=\{me\.id\}/);
    // Drawn only once `GET /me` has answered: no field to type in for nobody.
    expect(section).toContain('{isPending || !me ? (\n        <ProfileUnavailable />');
  });

  it('none of them reads the session for an account', () => {
    for (const file of ['password-form.tsx', 'account-section.tsx', 'linked-accounts.tsx']) {
      const card = source(`../app/my/settings/${file}`);
      expect(card, file).not.toMatch(/useSession|session\.data|user\.id/);
    }
  });
});
