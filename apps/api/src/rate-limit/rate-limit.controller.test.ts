/**
 * Rate limiting (PLAN 7.5; M6 AC 1) against the docker `test` profile. Skips when TEST_* are
 * unset (fails under CI=true, see the harness).
 *
 * Every NAMED bucket runs at PLAN's own number, so the acceptance figure
 * ("`/trades` 21번째 요청/분 → RATE_LIMITED") is measured against the value a deployment ships
 * with rather than one convenient for a test. Only the unnamed default is lowered, and only
 * because reaching 100 would cost a hundred injections; a separate test pins that the shipped
 * table still says 100.
 */
import { createMarket } from '@buddha/db/test';
import { DEFAULT_RATE_LIMITS, RATE_LIMIT_BUCKETS, RATE_LIMIT_WINDOW_SECONDS } from '@buddha/shared';
import { type Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIS } from '../infra/redis/redis.provider.js';
import {
  chargeHeaders,
  createTestApp,
  signUpTestUser,
  type TestApp,
  type TestUser,
  verificationLinkFor,
} from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { RATE_LIMIT_KEY_PREFIX } from './redis-throttler.storage.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

interface RefusalBody {
  error: { code: string; details: { retryAfterSeconds: number } };
}

/** Postgres is truncated between tests; Redis is not, so the buckets are swept by hand. */
async function clearBuckets(redis: Redis): Promise<void> {
  const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`);
  if (keys.length > 0) await redis.del(...keys);
}

describe.skipIf(!hasTestInfra)('rate limits (integration)', () => {
  let t: TestApp;
  let redis: Redis;

  beforeAll(async () => {
    // PLAN's own numbers for every named bucket — the acceptance figure has to be the shipped
    // one — but a default of 2 instead of 100. The per-address bucket is only ever reached by
    // a routable peer (see below), which nothing else in the API test suite presents, and
    // spending 100 injections to prove one refusal would be the slowest test in the file.
    // A second app cannot be the answer: `connectTestDb` holds the packages/db file lock for
    // the life of the app, so building one inside a suite that already holds it deadlocks.
    t = await createTestApp({ rateLimits: { default: 2 } });
    redis = t.app.get<Redis>(REDIS);
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    await clearBuckets(redis);
  });
  afterEach(async () => {
    await clearBuckets(redis);
  });

  it('states PLAN 7.5 verbatim', () => {
    expect(RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(DEFAULT_RATE_LIMITS.default).toBe(100);
    expect(DEFAULT_RATE_LIMITS.trade).toBe(20);
    expect(DEFAULT_RATE_LIMITS.charge).toBe(10);
    expect(RATE_LIMIT_BUCKETS.default.scope).toBe('ip');
    expect(RATE_LIMIT_BUCKETS.trade.scope).toBe('user');
    expect(RATE_LIMIT_BUCKETS.email.scope).toBe('email');
  });

  describe('POST /trades — 20 a minute per account (AC 1)', () => {
    let user: TestUser;
    let other: TestUser;
    let marketId: string;

    beforeEach(async () => {
      user = await signUpTestUser(t);
      other = await signUpTestUser(t);
      marketId = (await createMarket(t.db)).id;
    });

    /** One 1-contract buy; the sign-up bonus covers far more than 21 of them. */
    const buy = (as: TestUser) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: chargeHeaders(as.cookie),
        payload: {
          marketId,
          outcome: 'YES',
          side: 'buy',
          shares: 1,
          maxCostP: '100',
          expectedAccountId: as.id,
        },
      });

    it('refuses the 21st request of the window with RATE_LIMITED', async () => {
      for (let i = 0; i < DEFAULT_RATE_LIMITS.trade; i += 1) {
        const allowed = await buy(user);
        // The index travels with the assertion so a failure names which request broke.
        expect([i, allowed.statusCode]).toEqual([i, 200]);
      }
      const refused = await buy(user);
      expect(refused.statusCode).toBe(429);
      const body: RefusalBody = refused.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      // What the body tells the client to wait is what the header says, and it is inside the
      // window it belongs to.
      const retryAfter = Number(refused.headers['retry-after']);
      expect(retryAfter).toBe(body.error.details.retryAfterSeconds);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_SECONDS);
    });

    it('counts each account separately, and reports what is left', async () => {
      const first = await buy(user);
      expect(first.statusCode).toBe(200);
      // `-route`: the library suffixes every throttler but the address one, and the per-route
      // bucket is the second (rate-limit.module.ts).
      expect(first.headers['x-ratelimit-limit-route']).toBe(String(DEFAULT_RATE_LIMITS.trade));
      expect(first.headers['x-ratelimit-remaining-route']).toBe(
        String(DEFAULT_RATE_LIMITS.trade - 1),
      );

      for (let i = 1; i < DEFAULT_RATE_LIMITS.trade; i += 1) await buy(user);
      expect((await buy(user)).statusCode).toBe(429);
      // Same address, same route, a different account: an untouched bucket.
      const elsewhere = await buy(other);
      expect(elsewhere.statusCode).toBe(200);
      expect(elsewhere.headers['x-ratelimit-remaining-route']).toBe(
        String(DEFAULT_RATE_LIMITS.trade - 1),
      );
    });

    it('keeps no identifier in Redis: the key is namespaced and the tracker hashed', async () => {
      await buy(user);
      // Everything under the prefix: the two sign-ups of `beforeEach` left an `email` bucket
      // each, and they are just as much a bucket as the trade's.
      const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`);
      expect(keys.filter((key) => key.includes('TradesController'))).toEqual([
        expect.stringMatching(/^rl:route:TradesController\.trade:[0-9a-f]{32}$/),
      ]);
      for (const key of keys) {
        expect(key).not.toContain(user.id);
        expect(key).not.toContain('@');
      }
    });
  });

  describe('POST /auth/register — 5 a minute per ADDRESS', () => {
    const register = (email: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: jsonHeaders,
        payload: { email },
      });

    it('counts the recipient, not the caller', async () => {
      const target = `flooded-${String(Date.now())}@test.local`;
      for (let i = 0; i < DEFAULT_RATE_LIMITS.email; i += 1) {
        expect([i, (await register(target)).statusCode]).toEqual([i, 200]);
      }
      expect((await register(target)).statusCode).toBe(429);
      // Case and surrounding space are the same mailbox as far as the bucket is concerned.
      expect((await register(`  ${target.toUpperCase()} `)).statusCode).toBe(429);
      // Another address from the same caller is untouched: the bucket is the inbox.
      expect((await register(`other-${target}`)).statusCode).toBe(200);
    });

    it('counts the registration ONCE, not once per better-auth call it makes', async () => {
      // The handler calls `auth.api.signUpEmail` server-side, and an existing unverified account
      // makes it call `auth.api.sendVerificationEmail` as well. Both go through better-auth's
      // hooks, so without the `ctx.request` guard one registration would spend three buckets and
      // the shipped limit would silently be whichever of them filled first.
      const target = `once-${String(Date.now())}@test.local`;
      await register(target);
      const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`);
      expect(keys).toEqual([
        expect.stringMatching(/^rl:route:RegisterController\.register:[0-9a-f]{32}$/),
      ]);
    });
  });

  describe('/api/auth/* — the routes Nest never sees', () => {
    /**
     * better-auth is mounted as @fastify/middie middleware, which runs before Nest routing:
     * no guard, global or otherwise, ever sees these paths. The limit lives in better-auth's
     * own `hooks.before` and shares this Redis and this namespace.
     */
    const signIn = (email: string, password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: jsonHeaders,
        payload: { email, password },
      });

    it('bounds password guesses against one address', async () => {
      const user = await signUpTestUser(t);
      for (let i = 0; i < DEFAULT_RATE_LIMITS.signIn; i += 1) {
        const wrong = await signIn(user.email, 'not-the-password');
        expect([i, wrong.statusCode]).toEqual([i, 401]);
      }
      const refused = await signIn(user.email, 'not-the-password');
      expect(refused.statusCode).toBe(429);
      // better-auth answers in its OWN shape, not the PLAN 7 envelope — middie runs before the
      // exception filter, exactly as every other /api/auth/* error does (ADR-0018).
      expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
      // The right password is refused too once the bucket is spent: that is the point of a
      // lockout, and it is why a sign-in that succeeds CLEARS the bucket rather than going
      // uncounted — the count has to happen before the answer is known.
      expect((await signIn(user.email, user.password)).statusCode).toBe(429);

      // Another account is unaffected: the bucket is the address, not the caller.
      const bystander = await signUpTestUser(t);
      expect((await signIn(bystander.email, bystander.password)).statusCode).toBe(200);
    });

    it('clears the bucket on a sign-in that SUCCEEDS', async () => {
      // A shared account — this repo's seeded admin, a demo login, a team mailbox — signs in
      // many times a minute with the correct password. Counting those locked the e2e suite out
      // of its own admin the first time this shipped.
      const user = await signUpTestUser(t);
      for (let i = 0; i < DEFAULT_RATE_LIMITS.signIn * 3; i += 1) {
        const ok = await signIn(user.email, user.password);
        expect([i, ok.statusCode]).toEqual([i, 200]);
      }
      expect(await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:auth/sign-in/email:*`)).toEqual([]);
    });

    it('counts the CALLER too, in the same bucket as every /api/v1 route', async () => {
      // The address bucket is the one thing better-auth's own hook cannot give these paths: it
      // keys on the address in the BODY, so rotating that address is free. Rotating it does not
      // rotate the peer, and `/api/auth/*` shares PLAN 7.5's single per-address bucket with the
      // rest of the API — this app's `default` is 2 (beforeAll), so the third request from one
      // peer is refused whichever surface it lands on.
      const from = (remoteAddress: string) =>
        t.app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: jsonHeaders,
          remoteAddress,
          payload: {
            email: `rotating-${String(Date.now())}-${remoteAddress}@test.local`,
            password: 'x',
          },
        });
      expect((await from('203.0.113.21')).statusCode).toBe(401);
      expect((await from('203.0.113.21')).statusCode).toBe(401);
      const refused = await from('203.0.113.21');
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

      // And it IS the shared bucket: a versioned route from the same peer is refused too.
      const versioned = await t.app.inject({
        method: 'GET',
        url: '/api/v1/categories',
        remoteAddress: '203.0.113.21',
      });
      expect(versioned.statusCode).toBe(429);

      // Another peer is untouched.
      expect((await from('203.0.113.22')).statusCode).toBe(401);
    });

    it('keys those buckets by path, in the same namespace as the guard', async () => {
      const user = await signUpTestUser(t);
      await signIn(user.email, 'not-the-password');
      const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`);
      expect(keys).toContainEqual(
        expect.stringMatching(/^rl:default:auth\/sign-in\/email:[0-9a-f]{32}$/),
      );
      for (const key of keys) expect(key).not.toContain('@');
    });

    it('bounds /change-email by the account asking, which is the mailbox a verified account is mailed at', async () => {
      // For a verified account better-auth mails the confirmation to the address the account
      // already has and `newEmail` only later, once that link is clicked (auth.ts
      // `sendChangeEmailConfirmation`). A hook that counted `newEmail` alone let a caller rotate
      // it and put the same mail in their own inbox without limit; the account is counted too.
      const user = await signUpTestUser(t);
      const sent = t.mailer.messages.length; // the registration mail
      const change = (newEmail: string) =>
        t.app.inject({
          method: 'POST',
          url: '/api/auth/change-email',
          headers: { ...jsonHeaders, cookie: user.cookie },
          payload: { newEmail },
        });
      for (let i = 0; i < DEFAULT_RATE_LIMITS.email; i += 1) {
        const ok = await change(`rotating-${String(i)}-${String(Date.now())}@test.local`);
        expect([i, ok.statusCode]).toEqual([i, 200]);
      }
      const refused = await change(`rotating-last-${String(Date.now())}@test.local`);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
      const toCurrent = t.mailer.messages.slice(sent).filter((m) => m.to === user.email);
      expect(toCurrent).toHaveLength(DEFAULT_RATE_LIMITS.email);

      // Its own key, under its own path: a stranger who names this user's address as THEIR
      // `newEmail` spends `auth/change-email:<hash(address)>`, never this bucket — otherwise
      // anyone could lock a user out of changing their email with five silent 200s.
      const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email*`);
      expect(keys).toContainEqual(
        expect.stringMatching(/^rl:default:auth\/change-email\/account:[0-9a-f]{32}$/),
      );
      for (const key of keys) expect(key).not.toContain(user.id);
    });

    it('bounds replays of the confirmation link by the mailbox each click mails (Q-M6-8)', async () => {
      // better-auth's confirmation link is a stateless one-hour JWT that clicking does not
      // consume, and every click mails the NEW address again — no session needed, no body to
      // key on. One link in a caller's own inbox was an hour of mail to somebody else's: the
      // only way around the per-recipient bound above. The hook now reads the token and counts
      // the address it is about to mail.
      const user = await signUpTestUser(t);
      const victim = `victim-${String(Date.now())}@test.local`;
      const requested = await t.app.inject({
        method: 'POST',
        url: '/api/auth/change-email',
        headers: { ...jsonHeaders, cookie: user.cookie },
        payload: { newEmail: victim, callbackURL: '/settings' },
      });
      expect(requested.statusCode).toBe(200);
      const link = new URL(verificationLinkFor(t.mailer, user.email));
      const click = () => t.app.inject({ method: 'GET', url: link.pathname + link.search });

      const sent = t.mailer.messages.length;
      for (let i = 0; i < DEFAULT_RATE_LIMITS.email; i += 1) {
        const ok = await click();
        expect([i, ok.statusCode]).toEqual([i, 302]);
      }
      const refused = await click();
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
      const toVictim = t.mailer.messages.slice(sent).filter((m) => m.to === victim);
      expect(toVictim).toHaveLength(DEFAULT_RATE_LIMITS.email);

      // The bucket is the MAILBOX, not the token or the account: a second account's own
      // confirmation link toward the same address is refused on its first click. A bucket per
      // token would have let five `/change-email` requests buy twenty-five mails.
      const other = await signUpTestUser(t);
      const alsoRequested = await t.app.inject({
        method: 'POST',
        url: '/api/auth/change-email',
        headers: { ...jsonHeaders, cookie: other.cookie },
        payload: { newEmail: victim, callbackURL: '/settings' },
      });
      expect(alsoRequested.statusCode).toBe(200);
      const otherLink = new URL(verificationLinkFor(t.mailer, other.email));
      const otherClick = await t.app.inject({
        method: 'GET',
        url: otherLink.pathname + otherLink.search,
      });
      expect(otherClick.statusCode).toBe(429);
      expect(t.mailer.messages.filter((m) => m.to === victim)).toHaveLength(
        DEFAULT_RATE_LIMITS.email,
      );

      // The other half is not counted: the verification link the victim's inbox now holds
      // applies the change and mails nobody, so a stranger replaying the confirmation cannot
      // spend the click that finishes a legitimate change of address.
      const verify = new URL(verificationLinkFor(t.mailer, victim));
      const beforeApply = t.mailer.messages.length;
      const applied = await t.app.inject({
        method: 'GET',
        url: verify.pathname + verify.search,
        headers: { cookie: user.cookie },
      });
      expect(applied.statusCode).toBe(302);
      expect(t.mailer.messages).toHaveLength(beforeApply);

      // And a forged token spends nothing: the bucket is keyed on a payload only the secret can
      // sign, otherwise anybody could lock an address out of its own confirmation for free.
      // The one key is the victim's, in the same shape and namespace as every other bucket.
      const victimBucket = [expect.stringMatching(/^rl:default:auth\/verify-email:[0-9a-f]{32}$/)];
      const pattern = `${RATE_LIMIT_KEY_PREFIX}:default:auth/verify-email:*`;
      expect(await redis.keys(pattern)).toEqual(victimBucket);
      const forged = Buffer.from(
        JSON.stringify({ email: user.email, updateTo: 'stranger@test.local' }),
      ).toString('base64url');
      const rejected = await t.app.inject({
        method: 'GET',
        url: `/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.${forged}.forged`,
      });
      expect(rejected.statusCode).toBe(401);
      expect(await redis.keys(pattern)).toEqual(victimBucket);
    });
  });

  describe('the per-address default', () => {
    const anonymous = (url: string, remoteAddress?: string) =>
      t.app.inject({
        method: 'GET',
        url,
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
      });

    it('is skipped for a loopback peer, which cannot name a client', async () => {
      // Three times the limit, through the address `inject` (and the Next rewrite) presents.
      for (let i = 0; i < 6; i += 1) {
        expect([i, (await anonymous('/api/v1/categories')).statusCode]).toEqual([i, 200]);
      }
      // And nothing was counted at all — not merely allowed.
      expect(await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`)).toEqual([]);
    });

    it('applies to a routable peer, in one bucket for the whole API', async () => {
      expect((await anonymous('/api/v1/categories', '203.0.113.7')).statusCode).toBe(200);
      // A DIFFERENT route: PLAN 7.5's default is per address for the whole API, so this is the
      // second request of one bucket, not the first of another.
      expect((await anonymous('/api/v1/markets', '203.0.113.7')).statusCode).toBe(200);
      const refused = await anonymous('/api/v1/categories', '203.0.113.7');
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`)).toEqual([
        expect.stringMatching(/^rl:default:any:[0-9a-f]{32}$/),
      ]);
      // Another address is another visitor.
      expect((await anonymous('/api/v1/categories', '203.0.113.8')).statusCode).toBe(200);
    });

    it('never refuses /api/health, whatever the address has spent', async () => {
      for (let i = 0; i < 3; i += 1) await anonymous('/api/v1/categories', '203.0.113.9');
      expect((await anonymous('/api/v1/categories', '203.0.113.9')).statusCode).toBe(429);
      for (let i = 0; i < 3; i += 1) {
        const health = await anonymous('/api/health', '203.0.113.9');
        expect([i, health.statusCode]).toEqual([i, 200]);
        expect(health.json()).toMatchObject({ status: 'ok' });
      }
    });
  });
});
