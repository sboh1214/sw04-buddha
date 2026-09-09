/**
 * Numeric domain bounds (PLAN 0.2, 5.3, 6.2). The DB CHECK constraints in packages/db and
 * the zod DTOs use the same values.
 */

/** Displayed YES price in P per contract: integer 1..99 (PLAN 5.3 displayPrice). */
export const PRICE_MIN = 1;
export const PRICE_MAX = 99;

/** A winning contract pays out this many P (PLAN 5.4: payout = qty * 100). */
export const PAYOUT_PER_CONTRACT_P = 100n;

/** Basis points: probability 0..1 is stored as 0..10000 (price_ticks.p_yes_bp). */
export const BP_MAX = 10_000;

/** markets.initial_prob_bp accepts 1..9999 (never exactly 0 or 1). */
export const INITIAL_PROB_BP_MIN = 1;
export const INITIAL_PROB_BP_MAX = 9_999;

/** Default LMSR liquidity parameter (PLAN 5.3 guide). */
export const DEFAULT_LIQUIDITY_B = 1000;

/**
 * Granted to every new account by the "user" trigger, in the same transaction as the row
 * itself (PLAN 17 Q2, owner decision 2026-09-04). Changing it needs a migration, because the
 * amount lives in the trigger function as well — see packages/db/drizzle.
 */
export const SIGNUP_BONUS_P = 10_000n;

/** Coupon codes are upper-case A-Z, 0-9 and '-', so they survive being read aloud. */
export const COUPON_CODE_MIN_LENGTH = 4;
export const COUPON_CODE_MAX_LENGTH = 32;
export const COUPON_CODE_PATTERN = /^[A-Z0-9-]+$/;

/** profiles.nickname: 2..20 characters (PLAN 17 Q4 default). */
export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 20;

/**
 * Kakao/Naver may withhold the email (PLAN 10.3). better-auth needs one, so the API stores
 * `{provider}_{providerAccountId}@` + NO_EMAIL_DOMAIN: an unroutable address the mailer
 * never sends to and the UI shows as "이메일 없음" until the user registers a real one.
 */
export const NO_EMAIL_DOMAIN = 'noemail.buddha.local';

export function isNoEmailAddress(email: string): boolean {
  return email.toLowerCase().endsWith('@' + NO_EMAIL_DOMAIN);
}

// ---- markets / trading (PLAN 5.3, 5.4, 7.1; M3 design 1.5) -------------------------
/**
 * Contracts per order: 1..1,000,000. At the 100P ceiling one order moves at most 100M P,
 * which keeps every LMSR sum and every ledger amount far from the int4/int8 limits.
 */
export const TRADE_MIN_SHARES = 1;
export const ORDER_QTY_MAX = 1_000_000;

/**
 * Largest value a Postgres `integer`/`serial` column holds. A request field compared with
 * one — `positions.qty`, `categories.id` — must be bounded by it at the boundary: the driver
 * sends the value as an int4 parameter and Postgres answers SQLSTATE 22003, which the API
 * has no handler for, so an unbounded field turns malformed input into a 500 (A-M3-18).
 */
export const INT4_MAX = 2_147_483_647;

/** positions.qty is int4; `applyBuy` refuses to grow a position past it. */
export const POSITION_QTY_MAX = INT4_MAX;

/** Bound on request-side P fields (maxCostP, minProceedsP, quote spend): 10^15. */
export const MAX_P_AMOUNT = 10n ** 15n;

/** LMSR liquidity parameter accepted from the admin form (PLAN 5.3 guide: 500..3000). */
export const LIQUIDITY_B_MIN = 1;
export const LIQUIDITY_B_MAX = 1_000_000;

export const MARKET_TITLE_MAX = 120;
/** description / rules. */
export const MARKET_TEXT_MAX = 5_000;
export const MARKET_SOURCE_MAX = 500;
export const MARKET_IMAGE_URL_MAX = 500;
export const MARKET_VOID_REASON_MAX = 500;

/**
 * markets.slug: lower-case ASCII, digits, Hangul syllables and '-'; NFC-normalised before
 * matching so a decomposed (NFD) Korean title is not a second, distinct slug.
 */
export const MARKET_SLUG_MIN = 3;
export const MARKET_SLUG_MAX = 80;
export const MARKET_SLUG_PATTERN = /^[a-z0-9가-힣-]{3,80}$/;
/** `slugify()` keeps this much of the title, leaving room for the server's `-<tag>` suffix. */
export const MARKET_SLUG_STEM_MAX = 60;

/** `GET /markets/:id/fills` returns the newest this many (PLAN 7.1). */
export const FILLS_RECENT_LIMIT = 20;
/** `GET /markets/:id/ticks` downsamples to at most this many points (PLAN 7.1). */
export const TICKS_MAX_POINTS = 500;
/**
 * `GET /markets/:id/ticks` ranks at most this many ticks (the newest of the range) before
 * downsampling: the route is anonymous and a busy market writes a tick per trade, so the
 * work per request is bounded by this, not by the market's history. 20 × TICKS_MAX_POINTS:
 * at the bound one point per 20 ticks is served, the window sorts ~10 k narrow rows inside
 * the default `work_mem`, and the query stays around 10 ms on a million-tick market.
 */
export const TICKS_SCAN_MAX = 10_000;

/**
 * `GET /markets` card sparkline (PLAN 11.4): the YES probability sampled on a fixed hourly
 * grid over the last SPARKLINE_WINDOW_HOURS, each sample the newest tick at or before that
 * instant (an as-of read, so an hour without a trade carries the previous value forward
 * instead of dropping out). A market opened through the admin transition — or through the
 * seed — carries the `open` tick that transition writes, so its card draws a flat line rather
 * than an empty one; only a market that has no tick at all answers with an empty array. The
 * grid is fixed, so the work is SPARKLINE_MAX_POINTS index seeks per market whatever the
 * market's tick volume — the same kind of bound TICKS_SCAN_MAX gives the chart route (A-M3-20).
 */
export const SPARKLINE_WINDOW_HOURS = 24;
export const SPARKLINE_BUCKET_HOURS = 1;
/** Both endpoints included: 24 / 1 + 1 = 25. */
export const SPARKLINE_MAX_POINTS = SPARKLINE_WINDOW_HOURS / SPARKLINE_BUCKET_HOURS + 1;
