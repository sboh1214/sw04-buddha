import { cancelStartGrant, schema } from '@buddha/db';
import { completeOnboarding, createPhoneVerification, createStartGrant } from '@buddha/db/test';
import { errorEnvelopeSchema, meSchema, type ValidationIssue } from '@buddha/shared';
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

  it('GET /me returns user, profile, the zero balance and the credential account (AC 1)', async () => {
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
    expect(me.profile.nickname).toMatch(/^user_[A-Z2-9]{4}$/);
    expect(me.profile.nicknameChangeAvailableAt).toBeNull();
    expect(me.profile.interestCategoryIds).toEqual([]);
    // A new account starts the onboarding at the consent step (#58).
    expect(me.onboarding).toEqual({
      consent: false,
      verification: false,
      nickname: false,
      completed: false,
      interests: false,
      nextStep: 'consent',
      consents: [],
    });
    // Signing up grants nothing (#70): the start Coin comes after the onboarding.
    expect(me.balance).toEqual({ availableCoin: '0', lockedCoin: '0' });
    expect(me.startGrant).toBeNull();
    expect(me.linkedAccounts).toHaveLength(1);
    const [credential] = me.linkedAccounts;
    expect(credential).toMatchObject({ providerId: 'credential', accountId: user.id });
    expect(credential?.id).toBeTypeOf('string');
    expect(credential?.createdAt).toBeTypeOf('string');
  });

  it('GET /me reports the verification as null until the account has one, then its values (ADR-0070)', async () => {
    const before = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
    });
    expect(meSchema.parse(before.json<{ data: unknown }>().data).verification).toBeNull();

    const verifiedAt = new Date('2026-10-18T01:02:03.004Z');
    await createPhoneVerification(t.db, {
      userId: user.id,
      realName: '홍길동',
      phone: '01012345678',
      verifiedAt,
    });
    const after = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
    });
    expect(after.statusCode).toBe(200);
    expect(meSchema.parse(after.json<{ data: unknown }>().data).verification).toEqual({
      realName: '홍길동',
      phone: '01012345678',
      verifiedAt: verifiedAt.toISOString(),
    });
  });

  it('GET /me reports the start grant: none, then pending, then granted with its amount (#70)', async () => {
    const startGrantOf = async (account: TestUser) => {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: account.cookie },
      });
      expect(res.statusCode).toBe(200);
      return meSchema.parse(res.json<{ data: unknown }>().data).startGrant;
    };
    expect(await startGrantOf(user)).toBeNull();
    // Waiting for an amount: the wallet says it will be paid.
    await createStartGrant(t.db, { userId: user.id });
    expect(await startGrantOf(user)).toEqual({
      status: 'pending',
      amountCoin: null,
      grantedAt: null,
    });
    // Paid: another account's grant, with its amount and instant; the balance holds it.
    const other = await signUpTestUser(t);
    const paid = await createStartGrant(t.db, { userId: other.id, amountCoin: 12_345n });
    expect(await startGrantOf(other)).toEqual({
      status: 'granted',
      amountCoin: '12345',
      grantedAt: paid.grantedAt!.toISOString(),
    });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: other.cookie },
    });
    expect(meSchema.parse(res.json<{ data: unknown }>().data).balance.availableCoin).toBe('12345');
    // Cancelled by a withdrawal while it waited (owner decision 2026-10-18): nothing waits any
    // more, so nothing is shown — as for an account with no grant.
    await t.db.transaction((tx) => cancelStartGrant(tx, user.id));
    expect(await startGrantOf(user)).toBeNull();
  });

  it('GET /me without a session -> 401 UNAUTHENTICATED envelope', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  const patchMe = (as: TestUser, payload: unknown) =>
    t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie: as.cookie, origin: 'http://localhost:3000' },
      payload: payload as Record<string, unknown>,
    });

  it('PATCH /me changes the nickname of an account past the onboarding’s nickname step (#58)', async () => {
    await completeOnboarding(t.db, { userId: user.id });
    const res = await patchMe(user, { nickname: '거래왕_kim1', expectedAccountId: user.id });
    expect(res.statusCode).toBe(200);
    expect(meSchema.parse(res.json<{ data: unknown }>().data).profile.nickname).toBe('거래왕_kim1');
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    expect(row?.nickname).toBe('거래왕_kim1');
  });

  it('PATCH /me with a nickname another account has, in any case -> 409 NICKNAME_NOT_ALLOWED taken (AC 4)', async () => {
    const other = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: other.id });
    await completeOnboarding(t.db, { userId: user.id });
    expect(
      (await patchMe(other, { nickname: 'Taken_Name', expectedAccountId: other.id })).statusCode,
    ).toBe(200);
    for (const nickname of ['Taken_Name', 'taken_name', 'TAKEN_NAME']) {
      const res = await patchMe(user, { nickname, expectedAccountId: user.id });
      expect(res.statusCode).toBe(409);
      const { error } = errorEnvelopeSchema.parse(res.json());
      expect(error.code).toBe('NICKNAME_NOT_ALLOWED');
      expect(error.details).toEqual({ reason: 'taken' });
    }
  });

  it('PATCH /me with an invalid nickname or no account named -> 400 VALIDATION_ERROR from the zod schema', async () => {
    const res = await patchMe(user, { nickname: 'a', expectedAccountId: user.id });
    expect(res.statusCode).toBe(400);
    const { error } = errorEnvelopeSchema.parse(res.json());
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toMatchObject([{ path: ['nickname'] }]);
    const unnamed = await patchMe(user, { nickname: '새이름' });
    expect(unnamed.statusCode).toBe(400);
    expect(
      (errorEnvelopeSchema.parse(unnamed.json()).error.details as ValidationIssue[]).map(
        (issue) => issue.path,
      ),
    ).toEqual([['expectedAccountId']]);
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

  // --- PUT /me/time-zone (ADR-0063) ---------------------------------------------------
  describe('PUT /me/time-zone', () => {
    const TRUSTED_ORIGIN = 'http://localhost:3000';
    const putTimeZone = (payload: unknown, headers: Record<string, string> = {}) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/v1/me/time-zone',
        headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(payload),
      });
    const storedZone = async (userId: string) => {
      const [row] = await t.db
        .select({ timeZone: schema.profiles.timeZone })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, userId));
      return row?.timeZone;
    };
    const zoneOf = async (cookie: string) => {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      return meSchema.parse(res.json<{ data: unknown }>().data).profile.timeZone;
    };

    it('starts at null (follow the browser), stores a zone, and clears it again with null', async () => {
      expect(await zoneOf(user.cookie)).toBeNull();

      const set = await putTimeZone(
        { timeZone: 'America/New_York', expectedAccountId: user.id },
        { cookie: user.cookie },
      );
      expect(set.statusCode).toBe(200);
      // The whole profile, like PATCH /me, so the web can replace its ['me'] entry.
      const me = meSchema.parse(set.json<{ data: unknown }>().data);
      expect(me.id).toBe(user.id);
      expect(me.profile.timeZone).toBe('America/New_York');
      expect(await storedZone(user.id)).toBe('America/New_York');
      expect(await zoneOf(user.cookie)).toBe('America/New_York');

      const cleared = await putTimeZone(
        { timeZone: null, expectedAccountId: user.id },
        { cookie: user.cookie },
      );
      expect(cleared.statusCode).toBe(200);
      expect(meSchema.parse(cleared.json<{ data: unknown }>().data).profile.timeZone).toBeNull();
      expect(await storedZone(user.id)).toBeNull();
      expect(await zoneOf(user.cookie)).toBeNull();
    });

    it('stores the name trimmed and as given, not rewritten to another spelling', async () => {
      for (const [input, stored] of [
        ['  Europe/London ', 'Europe/London'],
        ['Asia/Kolkata', 'Asia/Kolkata'],
        ['Asia/Seoul', 'Asia/Seoul'],
        // Zones Node knows but leaves out of its list, which the settings select adds.
        ['UTC', 'UTC'],
        ['Etc/GMT+5', 'Etc/GMT+5'],
      ] as const) {
        const res = await putTimeZone(
          { timeZone: input, expectedAccountId: user.id },
          { cookie: user.cookie },
        );
        expect({ input, status: res.statusCode }).toEqual({ input, status: 200 });
        expect(await storedZone(user.id)).toBe(stored);
      }
    });

    it('refuses a zone Node does not know with 400 VALIDATION_ERROR naming the field, and writes nothing', async () => {
      const account = { expectedAccountId: user.id };
      await putTimeZone({ timeZone: 'Asia/Seoul', ...account }, { cookie: user.cookie });
      for (const payload of [
        { timeZone: 'Mars/Olympus_Mons', ...account },
        { timeZone: '', ...account },
        { timeZone: '   ', ...account },
        { timeZone: '+09:00', ...account },
        // Node matches these whatever their case, but no list holds them.
        { timeZone: 'ASIA/SEOUL', ...account },
        { timeZone: 'america/new_york', ...account },
        { timeZone: `Asia/Seoul${String.fromCharCode(0)}`, ...account },
        { timeZone: 'A'.repeat(65), ...account },
        { timeZone: 9, ...account },
        account,
      ]) {
        const res = await putTimeZone(payload, { cookie: user.cookie });
        expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
        const { error } = errorEnvelopeSchema.parse(res.json());
        expect(error.code).toBe('VALIDATION_ERROR');
        const paths = (error.details as ValidationIssue[]).map((issue) => issue.path);
        expect(paths.length).toBeGreaterThan(0);
        expect({ payload, paths: [...new Set(paths.flat())] }).toEqual({
          payload,
          paths: ['timeZone'],
        });
      }
      expect(await storedZone(user.id)).toBe('Asia/Seoul');
    });

    it('answers 401 without a session and 403 for a foreign Origin, writing nothing', async () => {
      const anonymous = await putTimeZone({
        timeZone: 'America/New_York',
        expectedAccountId: user.id,
      });
      expect(anonymous.statusCode).toBe(401);
      expect(errorEnvelopeSchema.parse(anonymous.json()).error.code).toBe('UNAUTHENTICATED');

      for (const origin of ['https://evil.example', 'null']) {
        const res = await putTimeZone(
          { timeZone: 'America/New_York', expectedAccountId: user.id },
          { cookie: user.cookie, origin },
        );
        expect({ origin, status: res.statusCode }).toEqual({ origin, status: 403 });
        expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('FORBIDDEN');
      }
      expect(await storedZone(user.id)).toBeNull();
    });

    it('keeps each account to its own zone: another member neither sees nor changes it', async () => {
      const other = await signUpTestUser(t);
      await putTimeZone(
        { timeZone: 'Pacific/Chatham', expectedAccountId: user.id },
        { cookie: user.cookie },
      );
      expect(await zoneOf(other.cookie)).toBeNull();

      const res = await putTimeZone(
        { timeZone: 'Europe/Paris', expectedAccountId: other.id },
        { cookie: other.cookie },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('Pacific/Chatham');
      expect(await zoneOf(user.cookie)).toBe('Pacific/Chatham');
      expect(await zoneOf(other.cookie)).toBe('Europe/Paris');

      await putTimeZone({ timeZone: null, expectedAccountId: other.id }, { cookie: other.cookie });
      expect(await zoneOf(user.cookie)).toBe('Pacific/Chatham');
    });

    it('refuses a body naming another account than the cookie (403 naming expectedAccountId), writing nothing', async () => {
      // A window still showing `other` after this browser signed in as `user`: the cookie is
      // user's, the screen other's. Neither profile may change (ADR-0063, A-PG-24).
      const other = await signUpTestUser(t);
      await putTimeZone(
        { timeZone: 'Pacific/Chatham', expectedAccountId: user.id },
        { cookie: user.cookie },
      );

      const res = await putTimeZone(
        { timeZone: 'America/New_York', expectedAccountId: other.id },
        { cookie: user.cookie },
      );
      expect(res.statusCode).toBe(403);
      const { error } = errorEnvelopeSchema.parse(res.json());
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
      expect(await storedZone(user.id)).toBe('Pacific/Chatham');
      expect(await storedZone(other.id)).toBeNull();

      // Leaving the account out, or naming none, is a 400 on the field, not a cookie-only write.
      for (const payload of [
        { timeZone: 'America/New_York' },
        { timeZone: 'America/New_York', expectedAccountId: '' },
      ]) {
        const refused = await putTimeZone(payload, { cookie: user.cookie });
        expect({ payload, status: refused.statusCode }).toEqual({ payload, status: 400 });
        const details = errorEnvelopeSchema.parse(refused.json()).error
          .details as ValidationIssue[];
        expect(details.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
      }
      expect(await storedZone(user.id)).toBe('Pacific/Chatham');
    });
  });

  it('serves no unverified contact any more: PUT /me/contact is gone (ADR-0070)', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/contact',
      headers: { cookie: user.cookie, origin: 'http://localhost:3000' },
      payload: { realName: '홍길동', phone: '01012345678', expectedAccountId: user.id },
    });
    expect(res.statusCode).toBe(404);
    expect(await t.db.select().from(schema.phoneVerifications)).toEqual([]);
  });
});
