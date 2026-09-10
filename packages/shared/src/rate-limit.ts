/**
 * PLAN 7.5's table, in one place (M6).
 *
 * A limit is part of the contract, so it lives in `shared` beside the error codes rather than
 * in the API's environment: PLAN 7.5 states the numbers, the M6 acceptance criterion counts one
 * of them, and `docs/API.md` renders this table for a client author to read. The web does not
 * read it at runtime — a 429 carries its own `details.retryAfterSeconds` and `Retry-After` —
 * but a client that wanted to pace itself has one place to look. A deployment that needs
 * different numbers overrides the API's `RATE_LIMITS` provider.
 */

/** Every limit below is per this many seconds. PLAN 7.5 states them per minute. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * What a bucket counts.
 *
 * - `ip`    — the client address, in ONE bucket for the whole API. PLAN 7.5's default
 *             ("100req/분/IP") is stated per address, not per route: a limit that reset on
 *             every path would let a caller spend it once per handler.
 * - `user`  — the signed-in account, per route. The rows PLAN 7.5 states per user.
 * - `email` — the address in the request body, per route: for routes that put mail in
 *             somebody's inbox, what has to be bounded is the recipient, not the sender
 *             (A-M2-10). `/change-email` charges a second bucket of this size to the ACCOUNT
 *             asking, because for a verified account the mail goes to the address it already
 *             has, not to the one in the body; and `GET /verify-email`, whose only input is
 *             a token, is charged to the address a mail-sending token is about to mail
 *             (auth.ts).
 */
export type RateLimitScope = 'ip' | 'user' | 'email';

export interface RateLimitBucketSpec {
  scope: RateLimitScope;
  /** Requests allowed per RATE_LIMIT_WINDOW_SECONDS. */
  limit: number;
}

/**
 * `default` counts the client address on EVERY route. The rest are attached with
 * `@RateLimit('<bucket>')` in apps/api and ADD to it rather than replace it: a route that names
 * one is bounded twice, and whichever bound it reaches first refuses.
 *
 * Replacing was the first shape of this, and it took the address bound off precisely the routes
 * that most needed one — `POST /auth/register` counts the RECIPIENT's inbox, so a caller who
 * varied the address had no bound at all.
 */
export const RATE_LIMIT_BUCKETS = {
  /** PLAN 7.5 default. */
  default: { scope: 'ip', limit: 100 },
  /** PLAN 7.5 `/trades`. The M6 acceptance criterion counts to this. */
  trade: { scope: 'user', limit: 20 },
  /** PLAN 7.5 `/payments/charge`. */
  charge: { scope: 'user', limit: 10 },
  /** `/coupons/redeem`: a coupon code is a short secret and this is the only route that tests one. */
  coupon: { scope: 'user', limit: 10 },
  /** `/markets/:id/disputes` (Q-M5-1: one per market, but not one per second). */
  dispute: { scope: 'user', limit: 10 },
  /** Routes that mail an address the caller chose, counted per address (A-M2-10). */
  email: { scope: 'email', limit: 5 },
  /**
   * Sign-in attempts against one address, per window. Only better-auth's `/sign-in/email` uses
   * it. EVERY attempt is counted, BEFORE the handler runs, and a sign-in that SUCCEEDS clears
   * the bucket (auth-rate-limit.ts).
   *
   * Both halves are load-bearing. Counting first is what makes the count atomic — reading the
   * bucket in a before-hook and adding to it after left a gap the width of a scrypt, so N
   * concurrent guesses all read a bucket under the limit and all got through. Clearing on
   * success is what keeps a shared account (a seeded admin, a demo login, a team mailbox) from
   * locking itself out by being used, which is what a "count every attempt" limit did to
   * thirteen e2e specs the first time it shipped.
   *
   * Higher than `email` because a mistyped password is ordinary and a mail flood is not, and
   * still far below what a guessing loop needs.
   */
  signIn: { scope: 'email', limit: 10 },
} as const satisfies Record<string, RateLimitBucketSpec>;

export type RateLimitBucket = keyof typeof RATE_LIMIT_BUCKETS;

/** The default limit of every bucket, as the API's `RATE_LIMITS` provider serves it. */
export type RateLimits = Record<RateLimitBucket, number>;

export const DEFAULT_RATE_LIMITS: RateLimits = Object.fromEntries(
  Object.entries(RATE_LIMIT_BUCKETS).map(([bucket, spec]) => [bucket, spec.limit]),
) as RateLimits;
