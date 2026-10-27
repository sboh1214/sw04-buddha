/**
 * PLAN 7.5's table, in one place (M6). Its `/trades` row went with the direct AMM trade (#125);
 * the CLOB brings its own order limit (#119).
 *
 * A limit is part of the contract, so it lives in `shared` beside the error codes rather than
 * in the API's environment: PLAN 7.5 states the numbers and `docs/API.md` renders this table
 * for a client author to read. The web does not read it at runtime — a 429 carries its own
 * `details.retryAfterSeconds` and `Retry-After` — but a client that wanted to pace itself has
 * one place to look. A deployment that needs different numbers overrides the API's
 * `RATE_LIMITS` provider.
 */

/** Every limit below is per this many seconds. PLAN 7.5 states them per minute. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * What a bucket counts.
 *
 * - `ip`    — the client address, whatever the route, counted ahead of parsing and the handler
 *             (so a body that cannot be parsed or a path with no route still counts; only what
 *             Fastify's router refuses before any hook does not). Each request lands in exactly
 *             ONE address bucket: an image read (`GET /media/:mediaId`) in `mediaRead`, every
 *             other request in `default`. PLAN 7.5's default ("100req/분/IP") is stated per
 *             address, not per route: a limit that reset on every path would let a caller spend
 *             it once per handler. A peer that cannot name a client — loopback, or a proxy the
 *             API's RATE_LIMIT_UNCOUNTED_PEERS names — is not counted at all.
 * - `user`  — the signed-in account, per route. The rows PLAN 7.5 states per user.
 * - `email` — the address in the request body, per route: for routes that put mail in
 *             somebody's inbox, what has to be bounded is the recipient, not the sender
 *             (A-M2-10). `/change-email` counts signed-in requests only (a 401 mails nobody),
 *             and charges the ACCOUNT asking first — a second bucket of this size, because for
 *             a verified account the mail goes to the address it already has, not to the one
 *             in the body — then `newEmail`; and `GET /verify-email`, whose only input is a
 *             token, is charged to the address a mail-sending token is about to mail (auth.ts).
 */
export type RateLimitScope = 'ip' | 'user' | 'email';

export interface RateLimitBucketSpec {
  scope: RateLimitScope;
  /** Requests allowed per RATE_LIMIT_WINDOW_SECONDS. */
  limit: number;
}

/**
 * `default` counts the client address on every route but the image reads, which `mediaRead`
 * counts instead (both in the API's address hook, address-limit.ts). The `user` and `email`
 * buckets are attached with `@RateLimit('<bucket>')` in apps/api and ADD to the address bucket
 * rather than replace it: a route that names one is bounded twice, and whichever bound it reaches
 * first refuses.
 *
 * Replacing was the first shape of this, and it took the address bound off precisely the routes
 * that most needed one — `POST /auth/register` counts the RECIPIENT's inbox, so a caller who
 * varied the address had no bound at all.
 */
export const RATE_LIMIT_BUCKETS = {
  /** PLAN 7.5 default. Every request but an image read (`mediaRead`). */
  default: { scope: 'ip', limit: 100 },
  /**
   * `GET /media/:mediaId` (#46): a post's image, read by address in a bucket of its own INSTEAD of
   * `default` — 304s included (owner decision 2026-10-19, ADR-0073). Not in PLAN 7.5. The API
   * checks every image on every use (no-cache + ETag, so hiding or deleting a post stops its
   * images at once), so drawing one is a request each time: a list of twenty cards with
   * thumbnails or a post of ten images spent the reader's 100 a minute alongside everything else,
   * and a shared address (a carrier's, an office's) reached it and drew broken images. The owner
   * chose a generous number of its own; the reads stay bounded per address all the same.
   */
  mediaRead: { scope: 'ip', limit: 600 },
  /** PLAN 7.5 `/payments/charge`. */
  charge: { scope: 'user', limit: 10 },
  /** `/coupons/redeem`: a coupon code is a short secret and this is the only route that tests one. */
  coupon: { scope: 'user', limit: 10 },
  /**
   * `POST /me/search-history` (#15, ADR-0066): recording a submitted search, per account. Not in
   * PLAN 7.5. Each record is a row that stays (no retention limit, the owner), so with the address
   * bucket alone one account could grow its history as fast as it had addresses to send from. A
   * person submitting searches by hand stays far below it, and a refused record never fails the
   * search: the web drops it (use-search-history.ts).
   */
  searchHistory: { scope: 'user', limit: 30 },
  /**
   * `POST /me/phone-verification/code` (#183, ADR-0070): asking for an SMS code, per account. Not
   * in PLAN 7.5, and not what bounds the texts: the owner's fixed limits do that from the
   * database (one send a minute, ten a day per account and per number, PHONE_VERIFICATION_LIMITS),
   * and they hold across restarts and instances. This one keeps a scripted client from spending
   * a database transaction per refused request at the address bucket's pace; a person who waits
   * out each minute stays far below it.
   */
  phoneVerification: { scope: 'user', limit: 5 },
  /**
   * `POST /me/consents` (#58, ADR-0072): the consent step's answers and MY 설정's marketing
   * switch, per account. Not in PLAN 7.5. Every changed answer is a `consent_records` row that
   * stays — the app may not rewrite one, and they are kept for the retention period (#57-18) — and
   * the optional marketing answer can be flipped at will, so with the address bucket alone one
   * account could grow its history as fast as it had addresses to send from. A member answers the
   * step once (again after a revision that asks for it) and sends one request per flip of the
   * switch (ADR-0072 7-37), far below this. The number is this PR's choice (ADR-0072 7-26).
   */
  consent: { scope: 'user', limit: 5 },
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

/**
 * The buckets the API's address hook counts (`ip` scope): every request lands in one of them, by
 * its route. A handler cannot name one with `@RateLimit` — that decorator adds a `user` or `email`
 * bucket on top.
 */
export type AddressRateLimitBucket = {
  [Bucket in RateLimitBucket]: (typeof RATE_LIMIT_BUCKETS)[Bucket]['scope'] extends 'ip'
    ? Bucket
    : never;
}[RateLimitBucket];

/** The default limit of every bucket, as the API's `RATE_LIMITS` provider serves it. */
export type RateLimits = Record<RateLimitBucket, number>;

export const DEFAULT_RATE_LIMITS: RateLimits = Object.fromEntries(
  Object.entries(RATE_LIMIT_BUCKETS).map(([bucket, spec]) => [bucket, spec.limit]),
) as RateLimits;
