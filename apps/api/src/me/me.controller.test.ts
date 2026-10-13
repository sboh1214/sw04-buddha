import { clockTimestamp, schema } from '@buddha/db';
import {
  SIGNUP_BONUS_COIN,
  contactSchema,
  errorEnvelopeSchema,
  meSchema,
  type ValidationIssue,
} from '@buddha/shared';
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
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t);
  });

  it('GET /me returns user, profile, the bonus balance and the credential account (AC 1)', async () => {
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
    expect(me.emailVerified).toBe(true); // signUpTestUser follows the verification link
    expect(me.profile.role).toBe('user');
    expect(me.profile.nickname).toMatch(/^예측가_[A-Z2-9]{4}$/);
    expect(me.balance).toEqual({ availableCoin: SIGNUP_BONUS_COIN.toString(), lockedCoin: '0' });
    expect(me.linkedAccounts).toHaveLength(1);
    const [credential] = me.linkedAccounts;
    expect(credential).toMatchObject({ providerId: 'credential', accountId: user.id });
    expect(credential?.id).toBeTypeOf('string');
    expect(credential?.createdAt).toBeTypeOf('string');
  });

  it('GET /me reports contact as null until a user_contacts row exists, then its values (ADR-0043)', async () => {
    const before = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
    });
    expect(meSchema.parse(before.json<{ data: unknown }>().data).contact).toBeNull();

    await t.db
      .insert(schema.userContacts)
      .values({ userId: user.id, realName: '홍길동', phone: '01012345678' });
    const after = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
    });
    expect(after.statusCode).toBe(200);
    expect(meSchema.parse(after.json<{ data: unknown }>().data).contact).toEqual({
      realName: '홍길동',
      phone: '01012345678',
    });
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
    const other = await signUpTestUser(t);
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
    // The point here is that it is NOT the PLAN 7 envelope; the body's own shape is pinned by
    // health.controller.test.ts, which is where a field added to it has to be decided.
    expect(health.json()).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' });
  });

  // --- PUT /me/contact (ADR-0043) ------------------------------------------------------
  describe('PUT /me/contact', () => {
    const TRUSTED_ORIGIN = 'http://localhost:3000';
    const putContact = (payload: unknown, headers: Record<string, string> = {}) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/v1/me/contact',
        headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(payload),
      });
    const contactRows = () => t.db.select().from(schema.userContacts);
    const getMe = async (cookie: string) => {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      return meSchema.parse(res.json<{ data: unknown }>().data);
    };

    it('creates the row and returns the Contact; GET /me reflects it', async () => {
      const res = await putContact(
        { realName: '홍길동', phone: '01012345678', expectedAccountId: user.id },
        { cookie: user.cookie },
      );
      expect(res.statusCode).toBe(200);
      expect(contactSchema.parse(res.json<{ data: unknown }>().data)).toEqual({
        realName: '홍길동',
        phone: '01012345678',
      });
      const rows = await contactRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: user.id, realName: '홍길동', phone: '01012345678' });
      expect(rows[0]!.updatedAt.getTime()).toBe(rows[0]!.createdAt.getTime());
      expect((await getMe(user.cookie)).contact).toEqual({
        realName: '홍길동',
        phone: '01012345678',
      });
    });

    it('replaces an existing row in place: same created_at, updated_at from the database clock', async () => {
      await putContact(
        { realName: '홍길동', phone: '01012345678', expectedAccountId: user.id },
        { cookie: user.cookie },
      );
      // Backdated so "refreshed" is visible whatever the clock resolution.
      const past = new Date('2020-01-01T00:00:00.000Z');
      await t.db
        .update(schema.userContacts)
        .set({ createdAt: past, updatedAt: past })
        .where(eq(schema.userContacts.userId, user.id));

      const res = await putContact(
        { realName: 'Jane Doe', phone: '01198765432', expectedAccountId: user.id },
        { cookie: user.cookie },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: unknown }>().data).toEqual({
        realName: 'Jane Doe',
        phone: '01198765432',
      });
      const rows = await contactRows();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({ userId: user.id, realName: 'Jane Doe', phone: '01198765432' });
      expect(row!.createdAt.toISOString()).toBe(past.toISOString());
      expect(row!.updatedAt.getTime()).toBeGreaterThan(past.getTime());
      expect(row!.updatedAt.getTime()).toBeLessThanOrEqual((await clockTimestamp(t.db)).getTime());
      expect((await getMe(user.cookie)).contact).toEqual({
        realName: 'Jane Doe',
        phone: '01198765432',
      });
    });

    it('normalises the input: phone to digits, name trimmed', async () => {
      for (const [phone, realName] of [
        ['010-1234-5678', '  홍길동 '],
        [' 010 1234 5678 ', '홍길동'],
        ['016-123-4567', '남궁 민수'],
      ] as const) {
        const res = await putContact(
          { realName, phone, expectedAccountId: user.id },
          { cookie: user.cookie },
        );
        expect({ phone, status: res.statusCode }).toEqual({ phone, status: 200 });
        const expected = { realName: realName.trim(), phone: phone.replace(/[ -]/g, '') };
        expect(res.json<{ data: unknown }>().data).toEqual(expected);
        expect(await contactRows()).toMatchObject([{ userId: user.id, ...expected }]);
      }
    });

    it('refuses an invalid name or phone with 400 VALIDATION_ERROR naming the field, and writes nothing', async () => {
      const valid = { realName: '홍길동', phone: '01012345678', expectedAccountId: user.id };
      const cases: [Record<string, unknown>, string][] = [
        [{ ...valid, realName: '홍' }, 'realName'],
        [{ ...valid, realName: '홍길동1' }, 'realName'],
        [{ ...valid, realName: '홍길동!' }, 'realName'],
        [{ ...valid, realName: '가'.repeat(31) }, 'realName'],
        [{ ...valid, realName: '   ' }, 'realName'],
        [{ ...valid, phone: '02-123-4567' }, 'phone'],
        [{ ...valid, phone: '010-1234-567a' }, 'phone'],
        [{ ...valid, phone: '0101234567890' }, 'phone'],
        [{ ...valid, phone: '+821012345678' }, 'phone'],
        [{ ...valid, phone: 1012345678 }, 'phone'],
        [{ realName: '홍길동', expectedAccountId: user.id }, 'phone'],
        [{ phone: '01012345678', expectedAccountId: user.id }, 'realName'],
        [{ realName: '홍길동', phone: '01012345678' }, 'expectedAccountId'],
        [{ ...valid, expectedAccountId: '' }, 'expectedAccountId'],
      ];
      for (const [payload, field] of cases) {
        const res = await putContact(payload, { cookie: user.cookie });
        expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
        const { error } = errorEnvelopeSchema.parse(res.json());
        expect(error.code).toBe('VALIDATION_ERROR');
        // One issue or several (a one-letter name is both too short and off-pattern), all
        // about the field that was wrong.
        const paths = (error.details as ValidationIssue[]).map((issue) => issue.path);
        expect(paths.length).toBeGreaterThan(0);
        expect({ payload, paths: [...new Set(paths.flat())] }).toEqual({ payload, paths: [field] });
      }
      expect(await contactRows()).toHaveLength(0);
      expect((await getMe(user.cookie)).contact).toBeNull();
    });

    it('answers 401 without a session and 403 for a foreign Origin, writing nothing', async () => {
      const body = { realName: '홍길동', phone: '01012345678', expectedAccountId: user.id };
      const anonymous = await putContact(body);
      expect(anonymous.statusCode).toBe(401);
      expect(errorEnvelopeSchema.parse(anonymous.json()).error.code).toBe('UNAUTHENTICATED');

      for (const origin of ['https://evil.example', 'null']) {
        const res = await putContact(body, { cookie: user.cookie, origin });
        expect({ origin, status: res.statusCode }).toEqual({ origin, status: 403 });
        expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('FORBIDDEN');
      }
      expect(await contactRows()).toHaveLength(0);
    });

    it('keeps each account to its own row: another member sees neither the values nor the row', async () => {
      const other = await signUpTestUser(t);
      await putContact(
        { realName: '홍길동', phone: '01012345678', expectedAccountId: user.id },
        { cookie: user.cookie },
      );
      expect((await getMe(other.cookie)).contact).toBeNull();

      const res = await putContact(
        { realName: '김철수', phone: '01087654321', expectedAccountId: other.id },
        { cookie: other.cookie },
      );
      expect(res.statusCode).toBe(200);
      expect((await getMe(user.cookie)).contact).toEqual({
        realName: '홍길동',
        phone: '01012345678',
      });
      expect((await getMe(other.cookie)).contact).toEqual({
        realName: '김철수',
        phone: '01087654321',
      });
      const rows = await t.db
        .select({ userId: schema.userContacts.userId, realName: schema.userContacts.realName })
        .from(schema.userContacts);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          { userId: user.id, realName: '홍길동' },
          { userId: other.id, realName: '김철수' },
        ]),
      );
    });

    it('refuses a body naming another account than the cookie (403 naming expectedAccountId), writing nothing', async () => {
      // A tab still showing `user` after another tab signed in as `other`: the cookie is the
      // other's, the body names the account on screen. Its values must not replace the other's.
      const other = await signUpTestUser(t);
      await putContact(
        { realName: '김철수', phone: '01087654321', expectedAccountId: other.id },
        { cookie: other.cookie },
      );
      const [before] = await t.db
        .select()
        .from(schema.userContacts)
        .where(eq(schema.userContacts.userId, other.id));

      const res = await putContact(
        { realName: '홍길동', phone: '01012345678', expectedAccountId: user.id },
        { cookie: other.cookie },
      );
      expect(res.statusCode).toBe(403);
      const { error } = errorEnvelopeSchema.parse(res.json());
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
      // Neither account's row moved: the other's is as it was, and the shown one has none.
      expect(await contactRows()).toEqual([before]);
      expect((await getMe(user.cookie)).contact).toBeNull();
      expect((await getMe(other.cookie)).contact).toEqual({
        realName: '김철수',
        phone: '01087654321',
      });
    });
  });
});
