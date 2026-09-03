import { schema } from '@buddha/db';
import { errorEnvelopeSchema, meSchema } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

describe.skipIf(!hasTestInfra)('/api/v1/me (integration)', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t.auth);
  });

  it('GET /me returns user, profile, zero balance and the credential account (AC 1)', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown }>();
    const me = meSchema.parse(body.data);
    expect(me.id).toBe(user.id);
    expect(me.email).toBe(user.email);
    expect(me.emailVerified).toBe(false);
    expect(me.profile.role).toBe('user');
    expect(me.profile.nickname).toMatch(/^예측가_[A-Z2-9]{4}$/);
    expect(me.balance).toEqual({ availableP: '0', lockedP: '0' });
    expect(me.linkedAccounts).toHaveLength(1);
    const [credential] = me.linkedAccounts;
    expect(credential).toMatchObject({ providerId: 'credential', accountId: user.id });
    expect(credential?.id).toBeTypeOf('string');
    expect(credential?.createdAt).toBeTypeOf('string');
  });

  it('GET /me without a session -> 401 UNAUTHENTICATED envelope', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('PATCH /me changes the nickname', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
      payload: { nickname: '예측왕_kim1' },
    });
    expect(res.statusCode).toBe(200);
    expect(meSchema.parse(res.json<{ data: unknown }>().data).profile.nickname).toBe('예측왕_kim1');
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    expect(row?.nickname).toBe('예측왕_kim1');
  });

  it('PATCH /me with a taken nickname -> 400 VALIDATION_ERROR with the field in details (AC 4)', async () => {
    const other = await signUpTestUser(t.auth);
    await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie: other.cookie },
      payload: { nickname: 'taken_name' },
    });
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
      payload: { nickname: 'taken_name' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = errorEnvelopeSchema.parse(res.json());
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([{ path: ['nickname'], message: 'already in use' }]);
  });

  it('PATCH /me with an invalid nickname -> 400 VALIDATION_ERROR from the zod schema', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
      payload: { nickname: 'a' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = errorEnvelopeSchema.parse(res.json());
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toMatchObject([{ path: ['nickname'] }]);
  });

  it('malformed JSON body -> 400 VALIDATION_ERROR envelope (Fastify parser error)', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      payload: '{"nickname":',
    });
    expect(res.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('unknown route -> 404 NOT_FOUND envelope; /api/health stays raw', async () => {
    const missing = await t.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(missing.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(missing.json()).error.code).toBe('NOT_FOUND');
    const health = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });
});
