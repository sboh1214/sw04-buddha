import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAuthForAnotherAccount } from './auth-client';

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
    expect(card).toContain(
      '<AccountFields accountId={me.id} email={me.email} emailVerified={me.emailVerified} />',
    );
    const fields = declaration(card, 'AccountFields');
    expect(fields).toContain('authClient.changeEmail(');
    expect(fields).toContain('{ body: { expectedAccountId: accountId } }');
    expect(fields).toContain('sessionChanged(error) ? copy.sessionChanged');
  });

  it('the login methods card’s link names its Me and waits for it', () => {
    const card = source('../app/my/settings/linked-accounts.tsx');
    const linked = declaration(card, 'LinkedAccounts');
    expect(linked).toContain('const accountId = useMe().data?.id;');
    expect(linked).toContain('authClient.linkSocial(');
    expect(linked).toContain('{ body: { expectedAccountId: account } }');
    expect(linked).toContain('disabled={accountId === undefined}');
    expect(linked).toContain(
      'link.mutate({ provider: providerId as SocialProvider, account: accountId });',
    );
    expect(linked).toContain('sessionChanged(error)');
  });

  it('none of them reads the session for an account', () => {
    for (const file of ['password-form.tsx', 'account-section.tsx', 'linked-accounts.tsx']) {
      const card = source(`../app/my/settings/${file}`);
      expect(card, file).not.toMatch(/useSession|session\.data|user\.id/);
    }
  });
});
