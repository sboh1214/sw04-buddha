/**
 * better-auth integration (PLAN 13 M1 AC, PLAN 10): real Postgres/Redis from the docker
 * `test` profile. Skips when TEST_* are unset (fails under CI=true, see packages/db harness).
 */
import { schema } from '@buddha/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

/** Header/body the browser would send through the Next.js rewrite (same-origin POST). */
const browserHeaders = {
  origin: 'http://localhost:3000',
  'content-type': 'application/json',
};

describe.skipIf(!hasTestInfra)('auth (integration)', () => {
  let t: TestApp;
  const email = 'it-auth@test.local';
  const password = 'password123';
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

  it('signs up, sets the session cookie and sends the verification mail', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email, password, name: 'IT' },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(raw).toMatch(/^buddha\.session_token=/);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).not.toMatch(/Secure/); // http baseURL -> no __Secure- prefix, no Secure flag
    cookie = raw!.split(';')[0]!;
    expect(t.mailer.messages).toHaveLength(1);
    expect(t.mailer.messages[0]).toMatchObject({ to: email });
    expect(t.mailer.messages[0]!.text).toContain('/api/auth/verify-email?token=');
  });

  it('rejects a second sign-up with the same email (code the web maps to Korean copy)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email, password, name: 'IT' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' });
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

  it('GET /api/auth/get-session and the guarded /api/v1/me see the user; no cookie -> 401', async () => {
    const session = await t.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ user: { email } });

    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ data: { email } });

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

  it('rejects an untrusted Origin (CSRF) and signs in with a valid password', async () => {
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

  it('a failing mailer does not break sign-up (verification is optional, PLAN 17 Q1)', async () => {
    t.mailer.failNext(1);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: browserHeaders,
      payload: { email: 'it-auth-2@test.local', password, name: 'IT2' },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await t.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, 'it-auth-2@test.local'));
    expect(row).toBeDefined();
  });
});
