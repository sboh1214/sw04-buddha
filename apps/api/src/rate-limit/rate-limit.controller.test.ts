/**
 * Rate limiting (PLAN 7.5; M6 AC 1) against the docker `test` profile. Skips when TEST_* are
 * unset (fails under CI=true, see the harness).
 *
 * Every NAMED bucket runs at PLAN's own number, so a refusal is measured against the value a
 * deployment ships with rather than one convenient for a test. The M6 acceptance figure counted
 * `/trades`, which went with the direct AMM trade (#125); the per-account bucket is measured on
 * `/payments/charge`, PLAN 7.5's other per-account row — preserved code, closed in production while
 * paid Coin is off (ADR-0049), so this app opens it. Only the unnamed default is lowered, and
 * only because reaching 100 would cost a hundred injections; a separate test pins that the
 * shipped table still says 100.
 */
import { createHash } from 'node:crypto';
import { schema } from '@buddha/db';
import { createMarket, createMedia, createPost } from '@buddha/db/test';
import {
  CONSENT_ITEMS,
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_WINDOW_SECONDS,
  currentConsentVersion,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIS } from '../infra/redis/redis.provider.js';
import {
  chargeBody,
  chargeHeaders,
  createTestApp,
  createTestPackage,
  signUpTestUser,
  type TestApp,
  type TestPackage,
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
    // `uncountedPeers` names two networks a split deployment's web host could live on; the
    // cases below present a peer from each and one from outside them.
    // The image reads' own address bucket is lowered for the same reason, to 3 — distinct from
    // the default's 2, so a refusal says which bucket it came from.
    t = await createTestApp({
      paidCoinSales: true,
      rateLimits: { default: 2, mediaRead: 3 },
      uncountedPeers: '10.0.0.0/8, fd00::/8',
    });
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
    expect(DEFAULT_RATE_LIMITS.charge).toBe(10);
    expect(RATE_LIMIT_BUCKETS.default.scope).toBe('ip');
    expect(RATE_LIMIT_BUCKETS.charge.scope).toBe('user');
    expect(RATE_LIMIT_BUCKETS.email.scope).toBe('email');
    // Not PLAN 7.5's: the image reads' own per-address bucket (owner decision 2026-10-19).
    expect(RATE_LIMIT_BUCKETS.mediaRead).toEqual({ scope: 'ip', limit: 600 });
    expect(DEFAULT_RATE_LIMITS.mediaRead).toBe(600);
  });

  describe('POST /payments/charge — 10 a minute per account', () => {
    let user: TestUser;
    let other: TestUser;
    let pack: TestPackage;

    beforeEach(async () => {
      user = await signUpTestUser(t);
      other = await signUpTestUser(t);
      pack = await createTestPackage(t.db);
    });

    /** One mock charge (setup-env pins PAYMENT_PROVIDER=mock): each succeeds at once. */
    const buy = (as: TestUser) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/payments/charge',
        headers: chargeHeaders(as.cookie),
        payload: chargeBody(pack, as.id),
      });

    it('refuses the 11th request of the window with RATE_LIMITED', async () => {
      for (let i = 0; i < DEFAULT_RATE_LIMITS.charge; i += 1) {
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
      // `-route`: the library suffixes every throttler name but `default`, and the only
      // throttler left in rate-limit.module.ts is `route` — the address bucket writes its
      // unsuffixed headers from the hook (address-limit.ts).
      expect(first.headers['x-ratelimit-limit-route']).toBe(String(DEFAULT_RATE_LIMITS.charge));
      expect(first.headers['x-ratelimit-remaining-route']).toBe(
        String(DEFAULT_RATE_LIMITS.charge - 1),
      );

      for (let i = 1; i < DEFAULT_RATE_LIMITS.charge; i += 1) await buy(user);
      expect((await buy(user)).statusCode).toBe(429);
      // Same address, same route, a different account: an untouched bucket.
      const elsewhere = await buy(other);
      expect(elsewhere.statusCode).toBe(200);
      expect(elsewhere.headers['x-ratelimit-remaining-route']).toBe(
        String(DEFAULT_RATE_LIMITS.charge - 1),
      );
    });

    it('keeps no identifier in Redis: the key is namespaced and the tracker hashed', async () => {
      await buy(user);
      // Everything under the prefix: the two sign-ups of `beforeEach` left an `email` bucket
      // each, and they are just as much a bucket as the charge's.
      const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`);
      expect(keys.filter((key) => key.includes('PaymentsController'))).toEqual([
        expect.stringMatching(/^rl:route:PaymentsController\.charge:[0-9a-f]{32}$/),
      ]);
      for (const key of keys) {
        expect(key).not.toContain(user.id);
        expect(key).not.toContain('@');
      }
    });
  });

  describe('POST /me/search-history — 30 a minute per account (ADR-0066)', () => {
    /**
     * Not a PLAN 7.5 row: each record is a row that stays (no retention limit, the owner), so the
     * address bucket alone would let one account grow its history at 100 a minute per address it
     * sends from. Counted per account, at the shipped number.
     */
    const record = (as: TestUser, query: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/me/search-history',
        headers: { ...jsonHeaders, cookie: as.cookie },
        payload: { query, expectedAccountId: as.id },
      });
    const rows = (as: TestUser) =>
      t.db
        .select({ id: schema.marketSearches.id })
        .from(schema.marketSearches)
        .where(eq(schema.marketSearches.userId, as.id));

    it('refuses the 31st record of the window, writing nothing, and counts each account apart', async () => {
      const user = await signUpTestUser(t);
      const other = await signUpTestUser(t);
      expect(RATE_LIMIT_BUCKETS.searchHistory).toEqual({ scope: 'user', limit: 30 });
      for (let i = 0; i < DEFAULT_RATE_LIMITS.searchHistory; i += 1) {
        const allowed = await record(user, `검색어 ${String(i)}`);
        expect([i, allowed.statusCode]).toEqual([i, 200]);
      }
      const refused = await record(user, '하나 더');
      expect(refused.statusCode).toBe(429);
      const body: RefusalBody = refused.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(await rows(user)).toHaveLength(DEFAULT_RATE_LIMITS.searchHistory);
      // The list is not counted by it, and another account has a bucket of its own.
      const read = await t.app.inject({
        method: 'GET',
        url: '/api/v1/me/search-history',
        headers: { cookie: user.cookie },
      });
      expect(read.statusCode).toBe(200);
      expect((await record(other, '하나 더')).statusCode).toBe(200);
    });
  });

  describe('POST /me/consents — 5 a minute per account (ADR-0072)', () => {
    /**
     * Not a PLAN 7.5 row: every changed answer is a consent record that stays (the app cannot
     * rewrite one; they are kept for the retention period), and the optional marketing answer can
     * be flipped at will. Counted per account, at the shipped number.
     */
    const answer = (as: TestUser, marketing: boolean) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/me/consents',
        headers: { ...jsonHeaders, cookie: as.cookie },
        payload: {
          consents: Object.fromEntries(
            CONSENT_ITEMS.map((item) => [
              item,
              {
                version: currentConsentVersion(item),
                agreed: item === 'marketing' ? marketing : true,
              },
            ]),
          ),
          expectedAccountId: as.id,
        },
      });
    const rows = (as: TestUser) =>
      t.db
        .select({ id: schema.consentRecords.id })
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.userId, as.id));

    it('refuses the 6th answer of the window, recording nothing, and counts each account apart', async () => {
      const user = await signUpTestUser(t);
      const other = await signUpTestUser(t);
      expect(RATE_LIMIT_BUCKETS.consent).toEqual({ scope: 'user', limit: 5 });
      for (let i = 0; i < DEFAULT_RATE_LIMITS.consent; i += 1) {
        // The marketing answer flipped each time: every request after the first writes a row.
        const allowed = await answer(user, i % 2 === 1);
        expect([i, allowed.statusCode]).toEqual([i, 200]);
      }
      const recorded = (await rows(user)).length;
      expect(recorded).toBe(CONSENT_ITEMS.length + DEFAULT_RATE_LIMITS.consent - 1);
      const refused = await answer(user, DEFAULT_RATE_LIMITS.consent % 2 === 1);
      expect(refused.statusCode).toBe(429);
      const body: RefusalBody = refused.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(await rows(user)).toHaveLength(recorded);
      expect((await answer(other, false)).statusCode).toBe(200);
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
     * no guard, global or otherwise, ever sees these paths. The named limits live in
     * better-auth's own `hooks.before` and share this Redis and this namespace; the address
     * bucket is the same Fastify hook that counts the rest of the API (address-limit.ts).
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
      // rotate the peer, and `/api/auth/*` is counted by the same Fastify hook as the rest of
      // the API, into PLAN 7.5's single per-address bucket — this app's `default` is 2
      // (beforeAll), so the third request from one peer is refused whichever surface it lands on.
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
      const recipientKeys = () =>
        redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email:*`);
      const spent = (await recipientKeys()).length;
      expect(spent).toBe(DEFAULT_RATE_LIMITS.email);
      const refused = await change(`rotating-last-${String(Date.now())}@test.local`);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
      const toCurrent = t.mailer.messages.slice(sent).filter((m) => m.to === user.email);
      expect(toCurrent).toHaveLength(DEFAULT_RATE_LIMITS.email);
      // The account is charged FIRST: a caller whose five are spent never touches the
      // recipient key of the sixth address they name, so one account can lock at most five
      // addresses a minute rather than every address it can type.
      expect(await recipientKeys()).toHaveLength(spent);

      // Its own key, under its own path: a stranger who names this user's address as THEIR
      // `newEmail` spends `auth/change-email:<hash(address)>` (signed in, and out of their own
      // account's five), never this bucket — otherwise anyone could lock a user out of changing
      // their email with five silent 200s.
      const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email*`);
      expect(keys).toContainEqual(
        expect.stringMatching(/^rl:default:auth\/change-email\/account:[0-9a-f]{32}$/),
      );
      for (const key of keys) expect(key).not.toContain(user.id);
    });

    it('reads one field per path: an `email` smuggled into /change-email spends nothing', async () => {
      // The hook runs on the raw body, before better-auth's schema strips keys it does not
      // know. Reading `email` AND `newEmail` let a signed-in caller name two addresses per
      // request — ten a minute, not the five the account bucket promises.
      const user = await signUpTestUser(t);
      const smuggled = `smuggled-${String(Date.now())}@test.local`;
      const named = `named-${String(Date.now())}@test.local`;
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/change-email',
        headers: { ...jsonHeaders, cookie: user.cookie },
        payload: { newEmail: named, email: smuggled },
      });
      expect(res.statusCode).toBe(200);
      // One recipient key, and it is the named address's (the key is the tracker's sha256
      // prefix, auth-rate-limit.ts); the smuggled one never got a key at all.
      const digest = (address: string) =>
        createHash('sha256').update(address).digest('hex').slice(0, 32);
      expect(await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email:*`)).toEqual([
        `${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email:${digest(named)}`,
      ]);
      expect(
        await redis.exists(
          `${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email:${digest(smuggled)}`,
        ),
      ).toBe(0);
    });

    it('spends nothing on /change-email without a session: a 401 mails nobody', async () => {
      // The one better-auth path that requires a session. Counting `newEmail` before the
      // session was checked let anyone — no account, no cookie — name X five times and refuse
      // every genuine change to X for a minute, at no cost and with no mail: the same free
      // lockout Q-M6-8 closed for forged tokens (PR #8 review).
      const victim = `victim-${String(Date.now())}@test.local`;
      for (let i = 0; i <= DEFAULT_RATE_LIMITS.email; i += 1) {
        const anonymous = await t.app.inject({
          method: 'POST',
          url: '/api/auth/change-email',
          headers: jsonHeaders,
          payload: { newEmail: victim },
        });
        expect([i, anonymous.statusCode]).toEqual([i, 401]);
      }
      expect(await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email*`)).toEqual([]);

      // The genuine change to that address goes through, and is what spends the first count.
      const user = await signUpTestUser(t);
      const sent = t.mailer.messages.length;
      const genuine = await t.app.inject({
        method: 'POST',
        url: '/api/auth/change-email',
        headers: { ...jsonHeaders, cookie: user.cookie },
        payload: { newEmail: victim },
      });
      expect(genuine.statusCode).toBe(200);
      expect(t.mailer.messages.slice(sent).map((m) => m.to)).toEqual([user.email]);
      const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:auth/change-email*`);
      expect(keys).toHaveLength(2);
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
      // The exemption is by the route Fastify matched, so neither a query string nor the
      // caller's choice of encoding — `/api/he%61lth` is served by the same handler — puts a
      // probe back into the bucket.
      for (const url of ['/api/health', '/api/health?x=1', '/api/he%61lth', '/api/health/live']) {
        const health = await anonymous(url, '203.0.113.9');
        expect([url, health.statusCode]).toEqual([url, 200]);
      }
      expect((await anonymous('/api/health', '203.0.113.9')).json()).toMatchObject({
        status: 'ok',
      });
    });

    it('counts what never reaches a handler: a body Fastify cannot parse, and a path with no route', async () => {
      // The bucket used to be a guard, and a guard runs inside the route handler — the last
      // stage of Fastify's lifecycle. Malformed JSON (400), a body over `bodyLimit` (413) and a
      // 404 are answered before it, so a peer could send those without limit while the contract
      // said "every route" (PR #8 review). The hook runs after routing and ahead of parsing.
      const malformed = () =>
        t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          headers: { 'content-type': 'application/json' },
          payload: '{',
          remoteAddress: '203.0.113.10',
        });
      expect((await malformed()).statusCode).toBe(400);
      expect((await anonymous('/api/v1/no-such-route', '203.0.113.10')).statusCode).toBe(404);
      // Two counted; the third — whatever it is — is refused BEFORE its body is parsed: an
      // exhausted peer's malformed body no longer buys a 400, it buys the 429.
      const refused = await malformed();
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`)).toEqual([
        expect.stringMatching(/^rl:default:any:[0-9a-f]{32}$/),
      ]);
    });

    it('writes the address headers on a counted response — on both halves of the API', async () => {
      // docs/API.md: a counted response carries the unsuffixed X-RateLimit-* three; a refusal
      // carries Retry-After. Written on the raw response, because better-auth answers on the
      // raw response and never flushes Fastify's reply headers — so the /api/auth/* half gets
      // them too, which the first shape of the hook never managed.
      const first = await anonymous('/api/v1/categories', '203.0.113.11');
      expect(first.statusCode).toBe(200);
      expect(first.headers['x-ratelimit-limit']).toBe('2');
      expect(first.headers['x-ratelimit-remaining']).toBe('1');
      expect(Number(first.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
      const second = await t.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: jsonHeaders,
        remoteAddress: '203.0.113.11',
        payload: { email: 'nobody@test.local', password: 'x' },
      });
      expect(second.statusCode).toBe(401);
      expect(second.headers['x-ratelimit-limit']).toBe('2');
      expect(second.headers['x-ratelimit-remaining']).toBe('0');
      const refused = await anonymous('/api/v1/categories', '203.0.113.11');
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(refused.headers['x-ratelimit-limit']).toBeUndefined();
      // Sent from the hook, so the API's security headers must still be on it (the helmet
      // plugin is registered first, main.ts / test/app.ts).
      expect(refused.headers['x-content-type-options']).toBe('nosniff');
      expect(refused.headers['x-robots-tag']).toBe('noindex');
      // A loopback peer is not counted, and says so by carrying none of them.
      const uncounted = await anonymous('/api/v1/categories');
      expect(uncounted.statusCode).toBe(200);
      expect(uncounted.headers['x-ratelimit-limit']).toBeUndefined();
    });

    it('counts an image read in its own bucket, never in the default — 304s too (owner decision 2026-10-19)', async () => {
      // The API checks an image on every use (no-cache + ETag), so a page of thumbnails is a page
      // of requests: they are counted per address in `mediaRead` (600 a minute shipped, 3 here),
      // and the default's hundred (2 here) is left to everything else.
      const author = await signUpTestUser(t);
      const market = await createMarket(t.db);
      const image = await createMedia(t.db, { ownerId: author.id });
      await createPost(t.db, { marketId: market.id, authorId: author.id, imageIds: [image.id] });
      const peer = '203.0.113.31';
      const revalidate = () =>
        t.app.inject({
          method: 'GET',
          url: `/api/v1/media/${image.id}`,
          headers: { 'if-none-match': `"${image.id}"` },
          remoteAddress: peer,
        });

      const first = await revalidate();
      expect(first.statusCode).toBe(304);
      expect(first.headers['x-ratelimit-limit']).toBe('3');
      expect(first.headers['x-ratelimit-remaining']).toBe('2');
      // An image no post shows is the same route, and the same bucket.
      expect(
        (await anonymous('/api/v1/media/0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60', peer)).statusCode,
      ).toBe(404);
      // The default is untouched: two requests of its own, then refused.
      const other = await anonymous('/api/v1/categories', peer);
      expect(other.statusCode).toBe(200);
      expect(other.headers['x-ratelimit-limit']).toBe('2');
      expect(other.headers['x-ratelimit-remaining']).toBe('1');
      expect((await anonymous('/api/v1/categories', peer)).statusCode).toBe(200);
      expect((await anonymous('/api/v1/categories', peer)).statusCode).toBe(429);
      // A spent default does not stop the images, which run out at their own limit.
      expect((await revalidate()).statusCode).toBe(304);
      const refused = await revalidate();
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // Two counters for the one address, under one digest (the sign-up's own `email` bucket
      // aside).
      const keys = (await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*:any:*`)).sort();
      expect(keys).toEqual([
        expect.stringMatching(/^rl:default:any:[0-9a-f]{32}$/),
        expect.stringMatching(/^rl:mediaRead:any:[0-9a-f]{32}$/),
      ]);
      expect(keys[0]?.split(':').at(-1)).toBe(keys[1]?.split(':').at(-1));
      // Another address is another reader.
      expect(
        (
          await t.app.inject({
            method: 'GET',
            url: `/api/v1/media/${image.id}`,
            headers: { 'if-none-match': `"${image.id}"` },
            remoteAddress: '203.0.113.32',
          })
        ).statusCode,
      ).toBe(304);
    });

    it('skips a peer RATE_LIMIT_UNCOUNTED_PEERS names, on both halves — a web host elsewhere', async () => {
      // The loopback rule generalised: a split deployment's web server presents a routable
      // address that still cannot name a visitor. Counting it put the whole site in one 100/min
      // window (PR #8 review). Listed peers are skipped, not refused — and IPv6 ones too, which
      // `BlockList` silently answers `false` for unless the family is passed.
      for (const peer of ['10.1.2.3', 'fd00::5']) {
        for (let i = 0; i < 6; i += 1) {
          expect([peer, i, (await anonymous('/api/v1/categories', peer)).statusCode]).toEqual([
            peer,
            i,
            200,
          ]);
        }
        for (let i = 0; i < 3; i += 1) {
          const auth = await t.app.inject({
            method: 'POST',
            url: '/api/auth/sign-in/email',
            headers: jsonHeaders,
            remoteAddress: peer,
            payload: { email: 'nobody@test.local', password: 'x' },
          });
          expect([peer, i, auth.statusCode]).toEqual([peer, i, 401]);
        }
      }
      // Nothing counted at all — not merely allowed.
      expect(await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:default:any:*`)).toEqual([]);
      // A neighbour outside the listed networks is a client, and is counted as before.
      expect((await anonymous('/api/v1/categories', '11.1.2.3')).statusCode).toBe(200);
      expect((await anonymous('/api/v1/categories', '11.1.2.3')).statusCode).toBe(200);
      expect((await anonymous('/api/v1/categories', '11.1.2.3')).statusCode).toBe(429);
    });
  });
});
