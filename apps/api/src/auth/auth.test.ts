/**
 * Sign-up, verification and session behaviour (PLAN 13 M1 AC, PLAN 10, ADR-0023/0024)
 * against the real Postgres/Redis of the docker `test` profile. Skips when TEST_* are unset
 * (fails under CI=true, see the harness).
 */
import { schema } from '@buddha/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, verificationLinkFor, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { CREDENTIAL_PROVIDER_ID } from './auth.js';

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
  const password = 'password-1234';
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

  const register = (payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: browserHeaders,
      payload,
    });

  async function userRow(address: string) {
    const [row] = await t.db
      .select({ id: schema.user.id, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, address));
    return row;
  }

  async function credentialAccount(userId: string) {
    const [row] = await t.db
      .select({ id: schema.account.id, password: schema.account.password })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, CREDENTIAL_PROVIDER_ID),
        ),
      );
    return row;
  }

  it('rejects a malformed address with the PLAN 7 envelope', async () => {
    const res = await register({ email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('register creates an unverified user WITHOUT a password and mails the link (ADR-0024)', async () => {
    const res = await register({ email });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { status: 'sent' } });
    expect(sessionCookieOf(res.headers['set-cookie'])).toBeUndefined();

    const user = await userRow(email);
    expect(user).toMatchObject({ emailVerified: false });
    // Nothing to steal: the account carries no credential row until the mailbox is proven.
    expect(await credentialAccount(user!.id)).toBeUndefined();

    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: email });
    expect(t.mailer.messages[0]!.text).toContain(
      'http://localhost:3000/api/auth/verify-email?token=',
    );
    expect(verificationLinkFor(t.mailer, email)).toContain(
      `callbackURL=${encodeURIComponent('/set-password')}`,
    );
  });

  it('registering the same address again only re-sends the link (no enumeration, no second user)', async () => {
    const res = await register({ email });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { status: 'sent' } });
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: email });

    const rows = await t.db.select().from(schema.user).where(eq(schema.user.email, email));
    expect(rows).toHaveLength(1);
    expect(await credentialAccount(rows[0]!.id)).toBeUndefined();
  });

  /**
   * The credential insert is cancelled for `/sign-up/email` only. If that suppression ever
   * widened, a user could no longer obtain a password at all — this pins the other side of
   * it, while the existing 'POST /api/v1/me/password' test below pins /set-password.
   */
  it('suppressing the sign-up credential does not stop password reset creating one', async () => {
    const address = 'it-auth-reset-creates@test.local';
    await register({ email: address });
    const created = await userRow(address);
    expect(await credentialAccount(created!.id)).toBeUndefined();

    t.mailer.messages.length = 0;
    const requested = await t.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: browserHeaders,
      payload: { email: address, redirectTo: '/reset-password' },
    });
    expect(requested.statusCode).toBe(200);
    const link = /https?:\/\/\S+\/reset-password\/\S+/.exec(t.mailer.messages[0]!.text)![0];
    const token = new URL(link).pathname.split('/').pop()!;

    const done = await t.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: browserHeaders,
      payload: { newPassword: password, token },
    });
    expect(done.statusCode).toBe(200);
    expect((await credentialAccount(created!.id))?.password).toBeTypeOf('string');
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

  it('signing in before the link is clicked fails and sends nothing', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: browserHeaders,
      payload: { email, password },
    });
    // No password exists yet, so better-auth cannot tell this from a wrong one: 401.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
    expect(sessionCookieOf(res.headers['set-cookie'])).toBeUndefined();
    expect(t.mailer.messages).toHaveLength(0);
  });

  it('the verification link verifies, signs the user in and redirects to the set-password page', async () => {
    await register({ email });
    const res = await t.app.inject({
      method: 'GET',
      url: pathOf(verificationLinkFor(t.mailer, email)),
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toMatch(/\/set-password$/);
    const raw = sessionCookieOf(res.headers['set-cookie']);
    expect(raw).toBeDefined();
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).not.toMatch(/Secure/); // http baseURL -> no __Secure- prefix, no Secure flag
    cookie = raw!.split(';')[0]!;
    expect(await userRow(email)).toMatchObject({ emailVerified: true });
  });

  it('POST /api/v1/me/password sets the first password, and refuses to replace it', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: { ...browserHeaders, cookie },
      payload: { newPassword: password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ok: true } });

    const user = await userRow(email);
    const account = await credentialAccount(user!.id);
    expect(account?.password).toBeTypeOf('string');

    // Changing a password needs the current one (/api/auth/change-password).
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: { ...browserHeaders, cookie },
      payload: { newPassword: 'another-password' },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: browserHeaders,
      payload: { newPassword: password },
    });
    expect(anonymous.statusCode).toBe(401);
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

  it('rejects an untrusted Origin (CSRF) and signs in with the password that was set', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { ...browserHeaders, origin: 'http://evil.local' },
      payload: { email, password },
    });
    expect(bad.statusCode).toBe(403);

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

  it('refuses the synthetic no-email domain on register and on every credential endpoint', async () => {
    const synthetic = 'kakao_42@noemail.buddha.local';
    const registered = await register({ email: synthetic });
    expect(registered.statusCode).toBe(400);
    expect(registered.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    // /sign-up/email is unroutable now (see the test below), so the hook that rejects the
    // domain there is only reachable through the server-side call RegistrationService makes.
    await expect(
      t.auth.api.signUpEmail({
        body: { email: synthetic, password, name: 'squatter' },
      }),
    ).rejects.toMatchObject({ body: { code: 'INVALID_EMAIL' } });

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

  it('a failing mailer does not break registration; the explicit resend reports the failure', async () => {
    const address = 'it-auth-2@test.local';
    t.mailer.failNext(1);
    const res = await register({ email: address });
    expect(res.statusCode).toBe(200);
    expect(await userRow(address)).toMatchObject({ emailVerified: false });
    expect(t.mailer.messages).toHaveLength(0);

    // Unlike registration, /send-verification-email surfaces a mail outage (ADR-0023) ...
    t.mailer.failNext(1);
    const failed = await t.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: browserHeaders,
      payload: { email: address, callbackURL: '/set-password' },
    });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(t.mailer.messages).toHaveLength(0);

    // ... and works on the next attempt.
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/auth/send-verification-email',
      headers: browserHeaders,
      payload: { email: address, callbackURL: '/set-password' },
    });
    expect(ok.statusCode).toBe(200);
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: address });
  });

  /**
   * ADR-0024 only holds while /api/v1/auth/register is the ONLY sign-up surface. Through
   * better-auth's own /sign-up/email an attacker could store a password on someone else's
   * address; the victim's verification click would then activate it (and their own
   * /set-password would fail with PASSWORD_ALREADY_SET).
   */
  it('better-auth sign-up is not exposed, so nobody can plant a password on an address', async () => {
    const victim = 'it-auth-victim@test.local';
    const attempt = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email: victim, password: 'attacker-1234', name: 'squatter' },
    });
    // disabledPaths answers in the router, before any handler: plain text, not our envelope.
    expect(attempt.statusCode).toBe(404);
    expect(attempt.body).toBe('Not Found');
    expect(await userRow(victim)).toBeUndefined();
    expect(t.mailer.messages).toHaveLength(0);

    // The server-side call behind /api/v1/auth/register is unaffected by disabledPaths.
    expect((await register({ email: victim })).statusCode).toBe(200);
    const user = await userRow(victim);
    expect(user).toMatchObject({ emailVerified: false });
    expect(await credentialAccount(user!.id)).toBeUndefined();
    expect(t.mailer.messages).toHaveLength(1);
  });

  /**
   * The recovery ADR-0024 promises for a user who verified but lost the session before
   * choosing a password: re-registering stays silent (a verified address must not be
   * confirmed to a stranger), and password reset builds the missing credential account.
   */
  it('a verified user with no password recovers through password reset (ADR-0024)', async () => {
    const stranded = 'it-auth-stranded@test.local';
    await register({ email: stranded });
    const verify = await t.app.inject({
      method: 'GET',
      url: pathOf(verificationLinkFor(t.mailer, stranded)),
    });
    expect(verify.statusCode).toBe(302);
    const user = await userRow(stranded);
    expect(user).toMatchObject({ emailVerified: true });
    expect(await credentialAccount(user!.id)).toBeUndefined();

    // Registering a verified address again sends nothing (no enumeration), which is why the
    // login and check-your-mail screens point at password reset instead.
    t.mailer.messages.length = 0;
    expect((await register({ email: stranded })).statusCode).toBe(200);
    expect(t.mailer.messages).toHaveLength(0);

    const reset = await t.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: browserHeaders,
      payload: { email: stranded, redirectTo: '/reset-password' },
    });
    expect(reset.statusCode).toBe(200);
    expect(t.mailer.messages).toHaveLength(1);
    const link = /https?:\/\/\S+\/reset-password\/\S+/.exec(t.mailer.messages[0]!.text)![0];
    const token = new URL(link).pathname.split('/').pop()!;

    const done = await t.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: browserHeaders,
      payload: { newPassword: password, token },
    });
    expect(done.statusCode).toBe(200);
    expect((await credentialAccount(user!.id))?.password).toBeTypeOf('string');

    const signIn = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: browserHeaders,
      payload: { email: stranded, password },
    });
    expect(signIn.statusCode).toBe(200);
    expect(sessionCookieOf(signIn.headers['set-cookie'])).toBeDefined();
  });
});
