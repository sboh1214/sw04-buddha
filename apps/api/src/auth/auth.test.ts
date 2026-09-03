/**
 * better-auth integration (PLAN 13 M1 AC, PLAN 10, ADR-0023): real Postgres/Redis from the
 * docker `test` profile. Skips when TEST_* are unset (fails under CI=true, see the harness).
 */
import { schema } from '@buddha/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, verificationLinkFor, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

/** Header/body the browser would send through the Next.js rewrite (same-origin POST). */
const browserHeaders = {
  origin: 'http://localhost:3000',
  'content-type': 'application/json',
};

/** Path + query of an absolute link, for app.inject(). */
function pathOf(link: string): string {
  const url = new URL(link);
  return url.pathname + url.search;
}

function sessionCookieOf(setCookie: string | string[] | undefined): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.find((c) => c.startsWith('buddha.session_token='));
}

describe.skipIf(!hasTestInfra)('auth (integration)', () => {
  let t: TestApp;
  const email = 'it-auth@test.local';
  /** Password of the first sign-up; rebound by the second one (pre-hijacking mitigation). */
  const firstPassword = 'password123';
  const password = 'password-rebound-9';
  let cookie = '';

  beforeAll(async () => {
    t = await createTestApp();
    await t.reset();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    t.mailer.messages.length = 0;
  });

  async function userRow(address: string) {
    const [row] = await t.db
      .select({ id: schema.user.id, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, address));
    return row;
  }

  it('rejects a password shorter than 8 characters', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email, password: 'short', name: 'IT' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
  });

  it('sign-up creates an unverified user, mails the link and starts no session (PLAN 17 Q1)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email, password: firstPassword, name: 'IT', callbackURL: '/login' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: null, user: { email, emailVerified: false } });
    expect(sessionCookieOf(res.headers['set-cookie'])).toBeUndefined();
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: email });
    expect(t.mailer.messages[0]!.text).toContain(
      'http://localhost:3000/api/auth/verify-email?token=',
    );
    expect(await userRow(email)).toMatchObject({ emailVerified: false });
  });

  it('a second sign-up rebinds the password of the unverified account and re-sends the link', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email, password, name: 'IT', callbackURL: '/login' },
    });
    // No enumeration: 200 with token null, like a fresh sign-up; still exactly one user.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: null });
    const rows = await t.db.select().from(schema.user).where(eq(schema.user.email, email));
    expect(rows).toHaveLength(1);
    // The mailbox owner gets a link (the sign-up screen promises one) ...
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: email });
    // ... and the account now carries the password of this attempt, not the first one
    // (pre-hijacking: whoever registered the address first must not keep the password).
    const [account] = await t.db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(eq(schema.account.userId, rows[0]!.id));
    expect(account?.password).toBeTypeOf('string');
    const { verifyPassword } = await import('better-auth/crypto');
    expect(await verifyPassword({ hash: account!.password!, password })).toBe(true);
    expect(await verifyPassword({ hash: account!.password!, password: firstPassword })).toBe(false);
  });

  it('created profile (예측가_XXXX) and balance 0 in the same transaction (trigger)', async () => {
    const rows = await t.db.execute<{ nickname: string; available_p: string }>(
      sql`select p.nickname, b.available_p from profiles p join balances b using (user_id)
          join "user" u on u.id = p.user_id where u.email = ${email}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.nickname).toMatch(/^예측가_[23456789A-HJ-NP-Z]{4}$/);
    expect(String(rows.rows[0]!.available_p)).toBe('0');
  });

  it('sign-in before verification -> 403 EMAIL_NOT_VERIFIED, and sends no mail itself', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: browserHeaders,
      payload: { email, password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(sessionCookieOf(res.headers['set-cookie'])).toBeUndefined();
    // The client asks for a new link explicitly, so it controls where the link lands and
    // learns about a send failure (ADR-0023).
    expect(t.mailer.messages).toHaveLength(0);
  });

  it('POST /send-verification-email mails a link that returns to the requested page', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: browserHeaders,
      payload: { email, callbackURL: '/login' },
    });
    expect(res.statusCode).toBe(200);
    expect(t.mailer.messages).toHaveLength(1);
    expect(verificationLinkFor(t.mailer, email)).toContain(
      `callbackURL=${encodeURIComponent('/login')}`,
    );
  });

  it('the verification link verifies, signs the user in and redirects to callbackURL', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: browserHeaders,
      payload: { email, callbackURL: '/login' },
    });
    const res = await t.app.inject({
      method: 'GET',
      url: pathOf(verificationLinkFor(t.mailer, email)),
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toMatch(/\/login$/);
    const raw = sessionCookieOf(res.headers['set-cookie']);
    expect(raw).toBeDefined();
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).not.toMatch(/Secure/); // http baseURL -> no __Secure- prefix, no Secure flag
    cookie = raw!.split(';')[0]!;
    expect(await userRow(email)).toMatchObject({ emailVerified: true });
  });

  it('GET /api/auth/get-session and the guarded /api/v1/me see the user; no cookie -> 401', async () => {
    const session = await t.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ user: { email, emailVerified: true } });

    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ data: { email, emailVerified: true } });

    const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required' },
    });
  });

  it('does not expose better-auth under the versioned prefix', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/get-session' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to unlink the last login method (PLAN M1 AC 3)', async () => {
    const accounts = await t.app.inject({
      method: 'GET',
      url: '/api/auth/list-accounts',
      headers: { cookie },
    });
    const [credential] = accounts.json<Array<{ id: string; providerId: string }>>();
    expect(credential?.providerId).toBe('credential');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/unlink-account',
      headers: { ...browserHeaders, cookie },
      payload: { accountId: credential!.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
  });

  it('rejects an untrusted Origin (CSRF) and signs in with the rebound password once verified', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { ...browserHeaders, origin: 'http://evil.local' },
      payload: { email, password },
    });
    expect(bad.statusCode).toBe(403);

    const stale = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: browserHeaders,
      payload: { email, password: firstPassword },
    });
    expect(stale.statusCode).toBe(401);

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: browserHeaders,
      payload: { email, password },
    });
    expect(ok.statusCode).toBe(200);
    expect(sessionCookieOf(ok.headers['set-cookie'])).toBeDefined();
  });

  it('sends the password reset mail with a link through the web origin', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: browserHeaders,
      payload: { email, redirectTo: '/reset-password' },
    });
    expect(res.statusCode).toBe(200);
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]!.text).toContain('http://localhost:3000/api/auth/reset-password/');
  });

  it('change-email (verified user): confirm at the current address, verify the new one, then it applies (PLAN 17 Q5)', async () => {
    const newEmail = 'it-auth-new@test.local';
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-email',
      headers: { ...browserHeaders, cookie },
      payload: { newEmail, callbackURL: '/settings' },
    });
    expect(res.statusCode).toBe(200);
    // Step 1: confirmation mail to the CURRENT address; nothing changed yet.
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: email });
    expect(t.mailer.messages[0]!.text).toContain(newEmail);
    expect(await userRow(newEmail)).toBeUndefined();

    const confirm = await t.app.inject({
      method: 'GET',
      url: pathOf(verificationLinkFor(t.mailer, email)),
      headers: { cookie },
    });
    expect(confirm.statusCode).toBe(302);
    // Step 2: verification mail to the NEW address; still not applied.
    expect(t.mailer.messages).toHaveLength(2);
    expect(t.mailer.messages[1]).toMatchObject({ to: newEmail });
    expect(await userRow(newEmail)).toBeUndefined();

    const verify = await t.app.inject({
      method: 'GET',
      url: pathOf(verificationLinkFor(t.mailer, newEmail)),
      headers: { cookie },
    });
    expect(verify.statusCode).toBe(302);
    expect(String(verify.headers.location)).toContain('/settings');
    expect(await userRow(newEmail)).toMatchObject({ emailVerified: true });
    expect(await userRow(email)).toBeUndefined();
  });

  it('refuses the synthetic no-email domain on every credential endpoint', async () => {
    const synthetic = 'kakao_42@noemail.buddha.local';
    const signUp = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email: synthetic, password, name: 'squatter' },
    });
    expect(signUp.statusCode).toBe(400);
    expect(signUp.json()).toMatchObject({ code: 'INVALID_EMAIL' });

    const resend = await t.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: browserHeaders,
      payload: { email: synthetic, callbackURL: '/settings' },
    });
    expect(resend.statusCode).toBe(400);

    const change = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-email',
      headers: { ...browserHeaders, cookie },
      payload: { newEmail: synthetic },
    });
    expect(change.statusCode).toBe(400);

    expect(t.mailer.messages).toHaveLength(0);
    const rows = await t.db.select().from(schema.user).where(eq(schema.user.email, synthetic));
    expect(rows).toHaveLength(0);
  });

  it('a failing mailer does not break sign-up; the explicit resend reports the failure', async () => {
    const address = 'it-auth-2@test.local';
    t.mailer.failNext(1);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email: address, password, name: 'IT2' },
    });
    expect(res.statusCode).toBe(200);
    expect(await userRow(address)).toMatchObject({ emailVerified: false });
    expect(t.mailer.messages).toHaveLength(0);

    // Unlike sign-up, /send-verification-email surfaces a mail outage (ADR-0023) ...
    t.mailer.failNext(1);
    const failed = await t.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: browserHeaders,
      payload: { email: address, callbackURL: '/login' },
    });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(t.mailer.messages).toHaveLength(0);

    // ... and works on the next attempt.
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: browserHeaders,
      payload: { email: address, callbackURL: '/login' },
    });
    expect(ok.statusCode).toBe(200);
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: address });
  });
});
