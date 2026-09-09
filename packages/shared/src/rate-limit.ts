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
 *             (A-M2-10).
 */
export type RateLimitScope = 'ip' | 'user' | 'email';

export interface RateLimitBucketSpec {
  scope: RateLimitScope;
  /** Requests allowed per RATE_LIMIT_WINDOW_SECONDS. */
  limit: number;
}

/**
 * `default` covers every route that does not name a bucket. The rest are attached with
 * `@RateLimit('<bucket>')` in apps/api and are stricter than the default, so a route has
 * exactly one limit and a refusal has exactly one explanation.
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
   * FAILED sign-ins against one address, per window. Only better-auth's `/sign-in/email` uses
   * it, and only failures are counted (auth-rate-limit.ts): a sign-in with the right password
   * is not an attack, and counting it would let a shared account lock itself out by being
   * used. Higher than `email` because a mistyped password is ordinary and a mail flood is not,
   * and still far below what a guessing loop needs.
   */
  signIn: { scope: 'email', limit: 10 },
} as const satisfies Record<string, RateLimitBucketSpec>;

export type RateLimitBucket = keyof typeof RATE_LIMIT_BUCKETS;

/** The default limit of every bucket, as the API's `RATE_LIMITS` provider serves it. */
export type RateLimits = Record<RateLimitBucket, number>;

export const DEFAULT_RATE_LIMITS: RateLimits = Object.fromEntries(
  Object.entries(RATE_LIMIT_BUCKETS).map(([bucket, spec]) => [bucket, spec.limit]),
) as RateLimits;
