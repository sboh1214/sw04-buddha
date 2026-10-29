/**
 * The better-auth routes MY 설정 writes through for the session's account take the account the card
 * was drawn for (`expectedAccountId`) and refuse another (ADR-0092): `hooks.before` compares it with
 * the cookie's account before the endpoint does anything. In the render between a tab's session
 * naming B and SessionCacheGuard's reset A's card still stands with B's cookie, and without the
 * check what was typed on it was done to B. Against the real Postgres/Redis of the docker `test`
 * profile; skips when TEST_* are unset (fails under CI=true, see the harness).
 */
import { schema } from '@buddha/db';
import { and, eq } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { envSchema } from '../config/env.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { RATE_LIMIT_KEY_PREFIX } from '../rate-limit/redis-throttler.storage.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { assertScreenAccount, type Auth, createAuth, CREDENTIAL_PROVIDER_ID } from './auth.js';

/** Header/body the browser would send through the Next.js rewrite (same-origin POST). */
const browserHeaders = {
  origin: 'http://localhost:3000',
  'content-type': 'application/json',
};

/** The refusal of another account's cookie: the API's own 403, unwrapped as better-auth answers. */
const OTHER_ACCOUNT = {
  code: 'FORBIDDEN',
  message: 'This session belongs to a different account than the one on screen',
  details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
};

/** better-auth's session middleware's refusal, which the hook also gives for a session it could not read. */
const UNAUTHORIZED = { code: 'UNAUTHORIZED', message: 'Unauthorized' };

/**
 * Makes the next session lookup of `auth` fail as a dropped connection or a timeout does — an error
 * `getSessionFromCtx` turns into null — and lets the ones after it read the database as before: the
 * hook's read fails, the endpoint's own read a moment later would succeed. The spy, to count reads.
 */
async function failNextSessionRead(auth: Pick<Auth, '$context'>) {
  const { internalAdapter } = await auth.$context;
  return vi
    .spyOn(internalAdapter, 'findSession')
    .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
}

describe('assertScreenAccount (ADR-0092)', () => {
  const statusOf = (body: unknown): { status: unknown; body: unknown } | undefined => {
    try {
      assertScreenAccount('account-a', body);
      return undefined;
    } catch (error) {
      const refusal = error as { status: unknown; body: unknown };
      return { status: refusal.status, body: refusal.body };
    }
  };

  it('lets the cookie’s own account through', () => {
    expect(statusOf({ expectedAccountId: 'account-a', newEmail: 'x@test.local' })).toBeUndefined();
  });

  it('refuses another account with the 403 naming the field', () => {
    expect(statusOf({ expectedAccountId: 'account-b' })).toEqual({
      status: 'FORBIDDEN',
      body: OTHER_ACCOUNT,
    });
  });

  it('refuses a body that names no account, or not as a 1–255 string, with the 400 naming it', () => {
    for (const body of [
      undefined,
      null,
      'account-a',
      {},
      { expectedAccountId: '' },
      { expectedAccountId: 'a'.repeat(256) },
      { expectedAccountId: 42 },
      { expectedAccountId: ['account-a'] },
    ]) {
      const refusal = statusOf(body);
      expect(refusal?.status, JSON.stringify(body)).toBe('BAD_REQUEST');
      expect(refusal?.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ path: ['expectedAccountId'] }],
      });
    }
  });
});

describe.skipIf(!hasTestInfra)(
  'MY 설정’s better-auth writes name the account on screen (ADR-0092)',
  () => {
    let t: TestApp;
    let redis: Redis;
    /** A's card, B's cookie: every user has the same password (`signUpTestUser`'s default). */
    let a: TestUser;
    let b: TestUser;

    beforeAll(async () => {
      t = await createTestApp();
      redis = t.app.get<Redis>(REDIS);
    });
    afterAll(async () => {
      await t?.close(); // undefined when beforeAll timed out waiting for the file lock
    });
    beforeEach(async () => {
      await t.reset();
      a = await signUpTestUser(t);
      b = await signUpTestUser(t);
      t.mailer.messages.length = 0;
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const post = (path: string, cookie: string | undefined, payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'POST',
        url: `/api/auth${path}`,
        headers: cookie === undefined ? browserHeaders : { ...browserHeaders, cookie },
        payload,
      });

    async function passwordHash(userId: string): Promise<string | null | undefined> {
      const [row] = await t.db
        .select({ password: schema.account.password })
        .from(schema.account)
        .where(
          and(
            eq(schema.account.userId, userId),
            eq(schema.account.providerId, CREDENTIAL_PROVIDER_ID),
          ),
        );
      return row?.password;
    }

    /** A second session of `user`'s, signed in elsewhere: what `revokeOtherSessions` ends. */
    async function secondSession(user: TestUser): Promise<string> {
      const signedIn = await post('/sign-in/email', undefined, {
        email: user.email,
        password: user.password,
      });
      expect(signedIn.statusCode).toBe(200);
      const raw = [signedIn.headers['set-cookie']]
        .flat()
        .find((entry) => entry?.startsWith('buddha.session_token='));
      return raw!.split(';')[0]!;
    }

    const sessionUser = async (cookie: string) =>
      (await t.auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id;

    describe('POST /change-password', () => {
      const change = (cookie: string | undefined, expected: Record<string, unknown>) =>
        post('/change-password', cookie, {
          currentPassword: 'password-1234',
          newPassword: 'changed-password-1',
          revokeOtherSessions: true,
          ...expected,
        });

      it('refuses A’s card on B’s cookie before B’s password is read: nothing changes, no session ends', async () => {
        const elsewhere = await secondSession(b);
        const [before, beforeA] = [await passwordHash(b.id), await passwordHash(a.id)];

        // B's current password is the one typed on A's card (both have the same): without the check
        // B's password changed and B's other sessions ended, all for A's card.
        const res = await change(b.cookie, { expectedAccountId: a.id });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual(OTHER_ACCOUNT);

        expect(await passwordHash(b.id)).toBe(before);
        expect(await passwordHash(a.id)).toBe(beforeA);
        expect(await sessionUser(elsewhere)).toBe(b.id);
        expect(await sessionUser(b.cookie)).toBe(b.id);
      });

      it('refuses a body that names no account with the 400 naming the field', async () => {
        const before = await passwordHash(b.id);
        for (const expected of [{}, { expectedAccountId: '' }, { expectedAccountId: 7 }]) {
          const res = await change(b.cookie, expected);
          expect([JSON.stringify(expected), res.statusCode]).toEqual([
            JSON.stringify(expected),
            400,
          ]);
          expect(res.json()).toMatchObject({
            code: 'VALIDATION_ERROR',
            details: [{ path: ['expectedAccountId'] }],
          });
        }
        expect(await passwordHash(b.id)).toBe(before);
      });

      it('answers 401 without a session, whatever the body names', async () => {
        expect((await change(undefined, { expectedAccountId: a.id })).statusCode).toBe(401);
        expect((await change(undefined, {})).statusCode).toBe(401);
        // A forged cookie, and a signed one whose session has ended: the same 401, nothing changed.
        const ended = await secondSession(b);
        expect((await post('/sign-out', ended, {})).statusCode).toBe(200);
        const before = await passwordHash(b.id);
        for (const cookie of ['buddha.session_token=forged.not-a-signature', ended]) {
          const res = await change(cookie, { expectedAccountId: b.id });
          expect([cookie, res.statusCode]).toEqual([cookie, 401]);
          expect(res.json()).toMatchObject(UNAUTHORIZED);
        }
        expect(await passwordHash(b.id)).toBe(before);
      });

      it('fails closed when the hook cannot read the session: refused, not read again by the endpoint', async () => {
        const elsewhere = await secondSession(b);
        const before = await passwordHash(b.id);
        // The hook's read of B's cookie fails. Without the 401 the hook took it for no session and
        // skipped the check, the endpoint read the session again, and B's password changed (and B's
        // other sessions ended) for A's card.
        const findSession = await failNextSessionRead(t.auth);
        const res = await change(b.cookie, { expectedAccountId: a.id });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject(UNAUTHORIZED);
        expect(findSession).toHaveBeenCalledTimes(1);

        expect(await passwordHash(b.id)).toBe(before);
        expect(await sessionUser(elsewhere)).toBe(b.id);
        expect(await sessionUser(b.cookie)).toBe(b.id);
      });

      it('changes the password of the account it names, as before, and ends its other sessions', async () => {
        const elsewhere = await secondSession(b);
        const before = await passwordHash(b.id);
        // A wrong current password is still better-auth's own refusal, past the check.
        const wrong = await post('/change-password', b.cookie, {
          currentPassword: 'not-the-password',
          newPassword: 'changed-password-2',
          expectedAccountId: b.id,
        });
        expect(wrong.statusCode).toBe(400);
        expect(wrong.json()).toMatchObject({ code: 'INVALID_PASSWORD' });

        const res = await change(b.cookie, { expectedAccountId: b.id });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ user: { id: b.id } });
        expect(await passwordHash(b.id)).not.toBe(before);
        expect(await sessionUser(elsewhere)).toBeUndefined();
      });
    });

    describe('POST /change-email', () => {
      const changeBuckets = () => redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email*`);

      it('refuses A’s card on B’s cookie before anything is mailed or counted', async () => {
        const before = await changeBuckets();
        const res = await post('/change-email', b.cookie, {
          newEmail: 'typed-for-a@test.local',
          callbackURL: '/my/settings',
          expectedAccountId: a.id,
        });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual(OTHER_ACCOUNT);
        // Without the check B's address got the confirmation naming the address typed for A.
        expect(t.mailer.messages).toEqual([]);
        expect(await changeBuckets()).toEqual(before);
      });

      it('fails closed when the hook cannot read the session: nothing mailed or counted', async () => {
        const before = await changeBuckets();
        // Without the 401 the endpoint's own read found B and mailed B's address for A's card.
        const findSession = await failNextSessionRead(t.auth);
        const res = await post('/change-email', b.cookie, {
          newEmail: 'typed-for-a@test.local',
          callbackURL: '/my/settings',
          expectedAccountId: a.id,
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject(UNAUTHORIZED);
        expect(findSession).toHaveBeenCalledTimes(1);
        expect(t.mailer.messages).toEqual([]);
        expect(await changeBuckets()).toEqual(before);
      });

      it('refuses a body that names no account with the 400 naming the field', async () => {
        const res = await post('/change-email', b.cookie, { newEmail: 'typed@test.local' });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          code: 'VALIDATION_ERROR',
          details: [{ path: ['expectedAccountId'] }],
        });
        expect(t.mailer.messages).toEqual([]);
      });

      it('starts the change for the account it names, as before', async () => {
        const newEmail = 'b-new@test.local';
        const res = await post('/change-email', b.cookie, {
          newEmail,
          callbackURL: '/my/settings',
          expectedAccountId: b.id,
        });
        expect(res.statusCode).toBe(200);
        expect(t.mailer.messages.map((message) => message.to)).toEqual([b.email]);
        expect(t.mailer.messages[0]!.text).toContain(newEmail);
      });
    });

    describe('POST /link-social', () => {
      /**
       * The app's own instance with Google switched on: the test environment configures no provider,
       * and linking one is the write. Same factory (`createAuth`), same database, same secret — the
       * cookies `signUpTestUser` minted are its sessions too — so its `hooks.before` is the app's.
       */
      const withGoogle = () =>
        createAuth({
          env: envSchema.parse({
            ...process.env,
            GOOGLE_CLIENT_ID: 'google-client',
            GOOGLE_CLIENT_SECRET: 'google-secret',
          }),
          db: t.db,
          mailer: t.mailer,
        });

      const link = (cookie: string, expected: Record<string, unknown>, auth = withGoogle()) =>
        auth.handler(
          new Request('http://localhost:3000/api/auth/link-social', {
            method: 'POST',
            headers: { ...browserHeaders, cookie },
            body: JSON.stringify({
              provider: 'google',
              callbackURL: '/my/settings',
              errorCallbackURL: '/my/settings?error=link',
              ...expected,
            }),
          }),
        );

      /** The OAuth states better-auth keeps (`verification` rows), with the account each links. */
      async function linkStates(): Promise<Array<string | undefined>> {
        const rows = await t.db
          .select({ value: schema.verification.value })
          .from(schema.verification);
        return rows.map(
          (row) => (JSON.parse(row.value) as { link?: { userId?: string } }).link?.userId,
        );
      }

      it('refuses A’s card on B’s cookie before a state is minted: nothing to link B with', async () => {
        const res = await link(b.cookie, { expectedAccountId: a.id });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual(OTHER_ACCOUNT);
        // Without the check the answer was Google's sign-in address, its state linking B.
        expect(await linkStates()).toEqual([]);
      });

      it('fails closed when the hook cannot read the session: no state minted', async () => {
        const google = withGoogle();
        // Without the 401 the endpoint's session middleware read B again and minted B's state.
        const findSession = await failNextSessionRead(google);
        const res = await link(b.cookie, { expectedAccountId: a.id }, google);
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject(UNAUTHORIZED);
        expect(findSession).toHaveBeenCalledTimes(1);
        expect(await linkStates()).toEqual([]);
      });

      it('refuses a body that names no account with the 400 naming the field', async () => {
        const res = await link(b.cookie, {});
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          code: 'VALIDATION_ERROR',
          details: [{ path: ['expectedAccountId'] }],
        });
        expect(await linkStates()).toEqual([]);
      });

      it('sends the account it names to the provider, as before', async () => {
        const res = await link(b.cookie, { expectedAccountId: b.id });
        expect(res.status).toBe(200);
        const answer = (await res.json()) as { url: string; redirect: boolean };
        expect(new URL(answer.url).host).toBe('accounts.google.com');
        expect(await linkStates()).toEqual([b.id]);
      });
    });

    describe('the account-keyed routes left as they are', () => {
      /** A Google login row for `user`, beside the credential row `signUpTestUser` gave it. */
      async function addGoogleRow(user: TestUser): Promise<string> {
        const id = `${user.id}-google`;
        await t.db.insert(schema.account).values({
          id,
          issuer: 'local:oauth:google',
          accountId: `google-${user.id}`,
          providerId: 'google',
          userId: user.id,
          updatedAt: new Date(),
        });
        return id;
      }

      const rowsOf = async (user: TestUser) =>
        (
          await t.db
            .select({ id: schema.account.id })
            .from(schema.account)
            .where(eq(schema.account.userId, user.id))
        ).map((row) => row.id);

      it('unlink-account finds a row A’s card drew only among the cookie’s account’s rows', async () => {
        // Keyed by the row id, which better-auth looks up among the session's account's rows: on
        // B's cookie a row of A's names nothing — even when B has another to spare.
        await addGoogleRow(b);
        const [aCredential] = await rowsOf(a);
        const res = await post('/unlink-account', b.cookie, { accountId: aCredential });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
        expect(await passwordHash(a.id)).toBeTypeOf('string');
        expect(await rowsOf(b)).toHaveLength(2);
      });

      it('unlink-account on a cookie whose account has one login method refuses before the lookup', async () => {
        // A's card has two rows and an enabled 해제; B has only its credential. better-auth refuses
        // the last login method before it looks for the row: another 400, nothing unlinked.
        const aGoogle = await addGoogleRow(a);
        const res = await post('/unlink-account', b.cookie, { accountId: aGoogle });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
        expect(await rowsOf(a)).toContain(aGoogle);
        expect(await rowsOf(b)).toHaveLength(1);
        expect(await passwordHash(b.id)).toBeTypeOf('string');
      });

      it('send-verification-email on a session mails only that account’s own address', async () => {
        // MY 설정's 인증 메일 다시 보내기 names the address on its card: A's, on B's cookie, is
        // refused before anything is mailed.
        const res = await post('/send-verification-email', b.cookie, {
          email: a.email,
          callbackURL: '/my/settings',
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'EMAIL_MISMATCH' });
        expect(t.mailer.messages).toEqual([]);
      });
    });
  },
);
