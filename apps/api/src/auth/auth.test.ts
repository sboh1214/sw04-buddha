/**
 * Sign-up, verification and session behaviour (PLAN 13 M1 AC, PLAN 10, ADR-0023/0024)
 * against the real Postgres/Redis of the docker `test` profile. Skips when TEST_* are unset
 * (fails under CI=true, see the harness).
 */
import { schema } from '@buddha/db';
import { AUTH_USER_NAME } from '@buddha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Redis } from 'ioredis';
import { REDIS } from '../infra/redis/redis.provider.js';
import { RATE_LIMIT_KEY_PREFIX } from '../rate-limit/redis-throttler.storage.js';
import { createTestApp, signUpTestUser, verificationLinkFor, type TestApp } from '../test/app.js';
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

/**
 * ORDERING CONTRACT — run this file whole; `-t` on a single case below the sign-up flow will
 * fail on missing state rather than on the thing it names.
 *
 * The cases from 'register creates an unverified user' down to 'POST /api/v1/me/password' are
 * one deliberate walk through ADR-0024, each asserting one step: `email` accumulates state
 * across them and `cookie` is minted by the verification case. That is why there is a single
 * `beforeAll` reset and not a `beforeEach` one.
 *
 * It stays this way on purpose. Per-case setup cannot serve it — three cases need three
 * different intermediate states (registered-but-unverified, verified-without-password,
 * fully set up) — and a lazy "establish the prerequisite if missing" helper was measured to
 * make failures WORSE, not better: when the shared mechanism itself regresses, the helper
 * fails first and collapses every downstream message into one unrelated error. Cases added
 * after that walk build their own state on a fresh address; keep doing that.
 */
describe.skipIf(!hasTestInfra)('auth (integration)', () => {
  let t: TestApp;
  const email = 'it-auth@test.local';
  const password = 'password-1234';
  /** Minted by 'the verification link verifies…'; every case below it reuses that session. */
  let cookie = '';

  beforeAll(async () => {
    t = await createTestApp();
    await t.reset();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
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

  it('created profile (user_XXXX) and a zero balance in the same transaction (trigger)', async () => {
    const rows = await t.db.execute<{ nickname: string; available_coin: string; entries: string }>(
      sql`select p.nickname, b.available_coin,
            (select count(*) from ledger_entries l where l.user_id = u.id) as entries
          from profiles p join balances b using (user_id)
          join "user" u on u.id = p.user_id where u.email = ${email}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.nickname).toMatch(/^user_[23456789A-HJ-NP-Z]{4}$/);
    // Signing up grants nothing (migration 0031, #70): no Coin and no ledger entry. The start Coin
    // comes once the onboarding is done (ADR-0071).
    expect(String(rows.rows[0]!.available_coin)).toBe('0');
    expect(String(rows.rows[0]!.entries)).toBe('0');
  });

  it('grants nothing to an account a social sign-in creates either (#70)', async () => {
    // Google, Kakao and Naver create the account through better-auth's createOAuthUser — the same
    // `user` INSERT, and so the same trigger, as the email sign-up above: zero, and no ledger.
    const context = await t.auth.$context;
    const created = await context.internalAdapter.createOAuthUser(
      { email: 'it-auth-social-grant@test.local', name: 'social', emailVerified: true },
      {
        providerId: 'kakao',
        issuer: 'https://kauth.kakao.com',
        accountId: `kakao-${String(Date.now())}`,
      },
    );
    const [balance] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, created.user.id));
    expect(balance).toMatchObject({ availableCoin: 0n, lockedCoin: 0n });
    expect(
      await t.db
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.userId, created.user.id)),
    ).toEqual([]);
  });

  /** The better-auth `user` row's name and photo. */
  async function nameAndImage(userId: string) {
    const [row] = await t.db
      .select({ name: schema.user.name, image: schema.user.image })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    return row;
  }

  it('keeps no name or photo: not the email sign-up’s, not a provider’s (ADR-0072)', async () => {
    // 오너 결정 2026-10-19 (2차) 3: a social login's provider name and profile photo are not
    // stored. The email sign-up above passed better-auth a name too.
    const signedUp = await userRow(email);
    expect(await nameAndImage(signedUp!.id)).toEqual({ name: AUTH_USER_NAME, image: null });

    // A social sign-up: better-auth's createOAuthUser with what the provider handed over.
    const context = await t.auth.$context;
    const created = await context.internalAdapter.createOAuthUser(
      {
        email: 'it-auth-social-name@test.local',
        name: '홍길동',
        image: 'https://k.kakaocdn.net/photo.jpg',
        emailVerified: true,
      },
      {
        providerId: 'kakao',
        issuer: 'https://kauth.kakao.com',
        accountId: `kakao-name-${String(Date.now())}`,
      },
    );
    expect(created.user).toMatchObject({ name: AUTH_USER_NAME, image: null });
    expect(await nameAndImage(created.user.id)).toEqual({ name: AUTH_USER_NAME, image: null });

    // A later sign-in or link that copies the provider's profile over (`overrideUserInfoOnSignIn`,
    // `updateUserInfoOnLink`) goes through the same update: neither column is written, and what
    // else it carries still is.
    await context.internalAdapter.updateUser(created.user.id, {
      name: '홍길동',
      image: 'https://k.kakaocdn.net/photo.jpg',
      emailVerified: false,
    });
    expect(await nameAndImage(created.user.id)).toEqual({ name: AUTH_USER_NAME, image: null });
    expect((await userRow('it-auth-social-name@test.local'))?.emailVerified).toBe(false);
  });

  /** A provider's ID token as Google's looks: a readable JWT whose payload names the member. */
  function idTokenNaming(name: string): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return [
      part({ alg: 'RS256', typ: 'JWT' }),
      part({
        sub: `google-${name}`,
        email: 'member@gmail.com',
        email_verified: true,
        name,
        picture: 'https://lh3.googleusercontent.com/a/photo',
      }),
      'signature',
    ].join('.');
  }

  /** The tokens a login account row holds, and its scope. */
  async function accountTokens(accountRowId: string) {
    const [row] = await t.db
      .select({
        idToken: schema.account.idToken,
        accessToken: schema.account.accessToken,
        refreshToken: schema.account.refreshToken,
        accessTokenExpiresAt: schema.account.accessTokenExpiresAt,
        refreshTokenExpiresAt: schema.account.refreshTokenExpiresAt,
        scope: schema.account.scope,
      })
      .from(schema.account)
      .where(eq(schema.account.id, accountRowId));
    return row;
  }

  /** What a provider's token response hands better-auth: every token and its expiry. */
  function providerTokens(label: string) {
    return {
      accessToken: `${label}-access`,
      refreshToken: `${label}-refresh`,
      idToken: idTokenNaming('홍길동'),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    };
  }

  const NO_TOKENS = {
    idToken: null,
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };

  it('keeps no provider token: no ID, access or refresh token (ADR-0072 7-30)', async () => {
    // 오너 결정 2026-10-19 (2차) 3 for the ID token, which carries the name and photo, and (4차) 1
    // for the access and refresh tokens and their expiry. better-auth hands them to the account row
    // as they came: on a social sign-up (createOAuthUser, the callback's createAccount), on a link
    // (linkAccount), and again on every sign-in and refresh (updateAccount). Each keeps the rest of
    // what it carries.
    const context = await t.auth.$context;
    const created = await context.internalAdapter.createOAuthUser(
      { email: 'it-auth-social-token@test.local', name: '', emailVerified: true },
      {
        providerId: 'google',
        issuer: 'https://accounts.google.com',
        accountId: `google-token-${String(Date.now())}`,
        ...providerTokens('google-1'),
        scope: 'openid,email',
      },
    );
    expect(created.account).toMatchObject(NO_TOKENS);
    expect(await accountTokens(created.account.id)).toEqual({
      ...NO_TOKENS,
      scope: 'openid,email',
    });

    // The next sign-in's fresh tokens (`updateAccountOnSignIn`) or a refresh: none is written, and
    // what else the update carries still is.
    await context.internalAdapter.updateAccount(created.account.id, {
      providerId: 'google',
      ...providerTokens('google-2'),
      scope: 'openid,email,https://www.googleapis.com/auth/userinfo.email',
    });
    expect(await accountTokens(created.account.id)).toEqual({
      ...NO_TOKENS,
      scope: 'openid,email,https://www.googleapis.com/auth/userinfo.email',
    });

    // A second provider linked to the same member.
    const linked = await context.internalAdapter.linkAccount({
      userId: created.user.id,
      providerId: 'kakao',
      issuer: 'https://kauth.kakao.com',
      accountId: `kakao-token-${String(Date.now())}`,
      ...providerTokens('kakao'),
      scope: 'account_email',
    });
    expect(await accountTokens(linked.id)).toEqual({ ...NO_TOKENS, scope: 'account_email' });

    // And the plain createAccount the link callback uses.
    const account = await context.internalAdapter.createAccount({
      userId: created.user.id,
      providerId: 'naver',
      issuer: 'https://nid.naver.com',
      accountId: `naver-token-${String(Date.now())}`,
      ...providerTokens('naver'),
    });
    expect(await accountTokens(account.id)).toMatchObject(NO_TOKENS);
    // The member's three login accounts, none holding one.
    const rows = await t.db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(eq(schema.account.userId, created.user.id));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(await accountTokens(row.id)).toMatchObject(NO_TOKENS);
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
    const user = await userRow(email);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: { ...browserHeaders, cookie },
      payload: { newPassword: password, expectedAccountId: user!.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ok: true } });

    const account = await credentialAccount(user!.id);
    expect(account?.password).toBeTypeOf('string');

    // Changing a password needs the current one (/api/auth/change-password).
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: { ...browserHeaders, cookie },
      payload: { newPassword: 'another-password', expectedAccountId: user!.id },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: browserHeaders,
      payload: { newPassword: password, expectedAccountId: user!.id },
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
    const user = await userRow(email);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-email',
      headers: { ...browserHeaders, cookie },
      // The account on screen (ADR-0092, screen-account.test.ts).
      payload: { newEmail, callbackURL: '/settings', expectedAccountId: user!.id },
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

  it('carries the page the visitor came from through the link to /set-password (#58)', async () => {
    // ADR-0069 decision 1 #57-9: after the onboarding a sign-up returns to the page it left. The
    // link is the one thing that crosses the mailbox, so it carries `next` itself.
    const address = 'it-auth-register-next@test.local';
    const next = '/markets/abc?x=1';
    expect((await register({ email: address, next })).statusCode).toBe(200);
    const link = verificationLinkFor(t.mailer, address);
    expect(new URL(link).searchParams.get('callbackURL')).toBe(
      `/set-password?next=${encodeURIComponent(next)}`,
    );
    // Followed, it lands there signed in — and better-auth's own `error` on a broken copy of the
    // same link is added beside `next`, not over it.
    const res = await t.app.inject({ method: 'GET', url: pathOf(link) });
    expect(res.statusCode).toBe(302);
    const target = new URL(String(res.headers.location), 'http://localhost:3000');
    expect(target.pathname).toBe('/set-password');
    expect(target.searchParams.get('next')).toBe(next);
    expect(sessionCookieOf(res.headers['set-cookie'])).toBeDefined();
    const broken = new URL(link);
    broken.searchParams.set('token', 'not-a-token');
    const refused = await t.app.inject({ method: 'GET', url: pathOf(broken.toString()) });
    expect(refused.statusCode).toBe(302);
    const landed = new URL(String(refused.headers.location), 'http://localhost:3000');
    expect(landed.pathname).toBe('/set-password');
    expect(landed.searchParams.get('next')).toBe(next);
    expect(landed.searchParams.get('error')).toBe('INVALID_TOKEN');
  });

  it('refuses a next that is not a path on this origin, and mails nothing (#58)', async () => {
    const bad = ['https://evil.example/x', '//evil.example', '/\\evil.example'];
    for (const [index, next] of bad.entries()) {
      // An address each: the route's rate limit counts per address (`email`).
      const res = await register({ email: `it-auth-bad-next-${String(index)}@test.local`, next });
      expect(res.statusCode, next).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(t.mailer.messages).toHaveLength(0);
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

    // The account on screen is the cookie's (ADR-0092), so the refusal is the address's.
    const session = await t.auth.api.getSession({ headers: new Headers({ cookie }) });
    const change = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-email',
      headers: { ...browserHeaders, cookie },
      payload: { newEmail: synthetic, expectedAccountId: session!.user.id },
    });
    expect(change.statusCode).toBe(400);
    expect(change.json()).toMatchObject({ code: 'INVALID_EMAIL' });

    expect(t.mailer.messages).toHaveLength(0);
    const rows = await t.db.select().from(schema.user).where(eq(schema.user.email, synthetic));
    expect(rows).toHaveLength(0);
  });

  it('an account whose CURRENT address is synthetic still registers a real one through /change-email (PLAN 17 Q5)', async () => {
    // The flow a Kakao/Naver user without an email is given (auth.ts `noEmailFallback`): their
    // current address is one of ours and unverified, so the mail goes to `newEmail`. The
    // before-hook rejects synthetic addresses in the BODY and also counts the account asking;
    // that count is keyed on the account, never on its address — a variant keyed on the
    // address would refuse this user here. This case passes on the old hook too; what it pins
    // is that constraint on the new one, and that the account WAS counted for this branch.
    const own = await signUpTestUser(t, { email: 'it-auth-synthetic@test.local' });
    await t.db
      .update(schema.user)
      .set({ email: 'kakao_777@noemail.buddha.local', emailVerified: false })
      .where(eq(schema.user.id, own.id));
    t.mailer.messages.length = 0;
    const redis = t.app.get<Redis>(REDIS);
    const accountBuckets = `${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email/account:*`;
    const before = (await redis.keys(accountBuckets)).length;

    const newEmail = 'it-auth-synthetic-real@test.local';
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-email',
      headers: { ...browserHeaders, cookie: own.cookie },
      payload: { newEmail, callbackURL: '/settings', expectedAccountId: own.id },
    });
    expect(res.statusCode).toBe(200);
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: newEmail });
    expect(await redis.keys(accountBuckets)).toHaveLength(before + 1);
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

  it('better-auth’s update-user is not exposed: no name or photo through it (ADR-0072)', async () => {
    const member = await signUpTestUser(t);
    const attempt = await t.app.inject({
      method: 'POST',
      url: '/api/auth/update-user',
      headers: { ...browserHeaders, cookie: member.cookie },
      payload: { name: '홍길동', image: 'https://example.com/me.jpg' },
    });
    expect(attempt.statusCode).toBe(404);
    expect(await nameAndImage(member.id)).toEqual({ name: AUTH_USER_NAME, image: null });
  });

  it('better-auth’s account-info is not exposed: no provider profile through it (ADR-0072 7-31)', async () => {
    // Its answer is the linked provider's name and photo, read from the stored ID token or
    // fetched with the stored access token; disabledPaths answers before either is looked at.
    const member = await signUpTestUser(t);
    const attempt = await t.app.inject({
      method: 'GET',
      url: '/api/auth/account-info',
      headers: { ...browserHeaders, cookie: member.cookie },
    });
    expect(attempt.statusCode).toBe(404);
    expect(attempt.body).toBe('Not Found');
  });

  it('better-auth’s get-access-token and refresh-token are not exposed: no provider token through them (ADR-0072 7-31)', async () => {
    // 오너 결정 2026-10-19 (4차) 1: they hand the session's account its linked provider's stored
    // access token (and refresh it with the stored refresh token), which the service keeps none of;
    // disabledPaths answers before an account is looked up.
    const member = await signUpTestUser(t);
    for (const path of ['/api/auth/get-access-token', '/api/auth/refresh-token']) {
      const attempt = await t.app.inject({
        method: 'POST',
        url: path,
        headers: { ...browserHeaders, cookie: member.cookie },
        payload: { accountId: 'any-account' },
      });
      expect({ path, status: attempt.statusCode, body: attempt.body }).toEqual({
        path,
        status: 404,
        body: 'Not Found',
      });
    }
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

  it('POST /api/v1/me/password sets only the password of the account the screen shows (403 otherwise)', async () => {
    // A tab still showing A after another tab signed in as B: the cookie is B's, the body A's.
    // Both are verified and have no password yet, so nothing but the check stands in the way.
    const shown = 'it-auth-shown@test.local';
    const current = 'it-auth-current@test.local';
    const cookies = new Map<string, string>();
    for (const address of [shown, current]) {
      await register({ email: address });
      const verify = await t.app.inject({
        method: 'GET',
        url: pathOf(verificationLinkFor(t.mailer, address)),
      });
      expect(verify.statusCode).toBe(302);
      cookies.set(address, sessionCookieOf(verify.headers['set-cookie'])!.split(';')[0]!);
    }
    const a = (await userRow(shown))!;
    const b = (await userRow(current))!;
    const setPassword = (payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/me/password',
        headers: { ...browserHeaders, cookie: cookies.get(current)! },
        payload,
      });

    const refused = await setPassword({ newPassword: password, expectedAccountId: a.id });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
      },
    });
    const missing = await setPassword({ newPassword: password });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['expectedAccountId'] }] },
    });
    expect(await credentialAccount(a.id)).toBeUndefined();
    expect(await credentialAccount(b.id)).toBeUndefined();

    const own = await setPassword({ newPassword: password, expectedAccountId: b.id });
    expect(own.statusCode).toBe(200);
    expect((await credentialAccount(b.id))?.password).toBeTypeOf('string');
    expect(await credentialAccount(a.id)).toBeUndefined();
  });
});
