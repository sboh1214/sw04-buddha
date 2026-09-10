import { createHash } from 'node:crypto';
import { RATE_LIMIT_WINDOW_SECONDS, type RateLimits } from '@buddha/shared';
import { type Redis } from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

/**
 * PLAN 7.5 for the routes better-auth owns.
 *
 * `/api/auth/*` is served by @fastify/middie middleware that runs BEFORE Nest routing, so no
 * Nest guard — global or otherwise — ever sees those requests, and the throttler cannot cover
 * them the way the `TODO(M6)` in auth.ts assumed. What can is better-auth's own hooks, which
 * already exist there, already run on exactly these paths, and — unlike a Fastify hook — have
 * the PARSED BODY, which is what makes the useful key available.
 *
 * And the key is the address, not the caller. better-auth's built-in limiter counts by IP,
 * which is the one thing this deployment cannot see (rate-limit.tracker.ts): behind the Next
 * rewrite every sign-in in the country arrives from one socket. Counting the address instead
 * bounds precisely the two abuses these routes have — a password guessed against one account,
 * and a stranger's inbox filled with verification mail (A-M2-10) — and does it identically
 * whether the request came through the rewrite or straight to the API. The one route whose
 * mail does not go to the address in the body — `/change-email`, which for a verified account
 * writes to the address the account already has — is counted per account too (auth.ts).
 *
 * Same Redis, same `rl:` namespace, same fixed window and the same fail-open posture as the
 * HTTP guard: one store, one set of keys to sweep, one behaviour when Redis is down.
 */
export interface AuthRateLimiter {
  /**
   * Counts this attempt and answers how long to wait, or `null` while it is inside the limit.
   *
   * Used by EVERY path here, sign-in included, and the count happens BEFORE the handler runs.
   * On the mail paths the attempt is the harm — each one puts mail in somebody's inbox. On
   * sign-in the attempt has to be counted for a different reason: better-auth hashes the
   * submitted password even for an address that does not exist (sign-in.mjs calls
   * `password.hash` on the not-found branch, deliberately, so the answer takes the same time
   * either way), so an uncounted attempt is an unconditional scrypt anybody can ask for.
   */
  consume(path: string, tracker: string, limit: number): Promise<number | null>;
  /**
   * Clears the bucket. Called after a sign-in that SUCCEEDED.
   *
   * A sign-in with the right password is not an attack and must not leave a mark — otherwise a
   * shared account (this repo's seeded admin, a demo login, a team mailbox) locks itself out by
   * being used, which is exactly what happened the first time this limit shipped, counting
   * every attempt: the e2e lost thirteen specs to 429.
   *
   * Clearing on success rather than not counting at all is what makes the count ATOMIC. The
   * first shape of this — read the bucket in the before-hook, add to it in the after-hook —
   * left a read-then-write gap the width of a scrypt (~150 ms), so N concurrent guesses all
   * read a bucket under the limit and all got through. With INCR first, the eleventh concurrent
   * guess is refused before better-auth spends anything on it. It is also what every real
   * account lockout does: a correct password resets the failure counter.
   */
  reset(path: string, tracker: string): Promise<void>;
}

const WINDOW_MS = RATE_LIMIT_WINDOW_SECONDS * 1_000;

export function authRateLimiter(redis: Redis): AuthRateLimiter {
  const storage = new RedisThrottlerStorage(redis);
  // Hashed for the same reason the guard hashes its tracker: a limiter has no business keeping
  // addresses (or account ids) where `KEYS rl:*` can read them. The path stays legible so an
  // operator can tell a sign-in flood from a password-reset flood — and `/change-email/account`
  // from `/change-email`, which is why the account bucket has a path of its own rather than
  // sharing one with a body address a stranger can name (auth.ts).
  const keyOf = (path: string, tracker: string) =>
    `auth${path}:${createHash('sha256').update(tracker).digest('hex').slice(0, 32)}`;

  return {
    async consume(path, tracker, limit) {
      const record = await storage.increment(
        keyOf(path, tracker),
        WINDOW_MS,
        limit,
        WINDOW_MS,
        'default',
      );
      return record.isBlocked ? record.timeToBlockExpire : null;
    },
    async reset(path, tracker) {
      await storage.clear(keyOf(path, tracker), 'default');
    },
  };
}

/** The limit each better-auth path is counted against (`/change-email`'s account bucket too). */
export function authRateLimitFor(path: string, limits: RateLimits): number {
  return path === '/sign-in/email' ? limits.signIn : limits.email;
}
