/**
 * Numeric domain bounds (PLAN 0.2, 6.2). The DB CHECK constraints in packages/db and the zod
 * DTOs use the same values.
 */

/**
 * A contract's price in Coin: integer 1..99 (PLAN 5.3 displayPrice; approved, ADR-0107 결정 1 #177
 * 1항 — `CONTRACT_TERMS`, contract.ts).
 */
export const PRICE_MIN = 1;
export const PRICE_MAX = 99;

/** The price step in Coin (approved, ADR-0107 결정 1 #177 1항 — `CONTRACT_TERMS`, contract.ts). */
export const TICK_COIN = 1;

/**
 * A winning contract pays out this many Coin (PLAN 5.4: payout = qty * 100), which is also the
 * collateral of one YES·NO pair (approved, ADR-0107 결정 1 #177 1항 — `CONTRACT_TERMS`, contract.ts).
 */
export const PAYOUT_PER_CONTRACT_COIN = 100n;

/**
 * Basis points: probability 0..1 as 0..10000 — a chart point's `PriceTick.pYesBp`, a fill's
 * `yes_price_coin × 100` since #121 (ADR-0116; the retired `price_ticks.p_yes_bp` has the range).
 */
export const BP_MAX = 10_000;

/**
 * Whether paid Coin is on sale: the charge and its catalogue, the payment provider info, coupon
 * redemption and the admin refund of a charge. Closed in the initial product (N06, owner
 * decision D9, ADR-0049): the code and the tables stay, the API answers each of those routes
 * 404 before it does anything else, and the web draws none of their entry points. Reopening
 * (#111) is this value set to `true` and a deploy. Fails closed — anything but an explicit
 * `true` keeps sales shut. Typed `boolean` so code on either side is not narrowed to
 * unreachable while it is `false`.
 */
export const PAID_COIN_SALES_ENABLED: boolean = false;

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

// ---- markets (PLAN 5.4, 7.1; M3 design 1.5) -----------------------------------------
/**
 * Largest value a Postgres `integer`/`serial` column holds. A request field compared with
 * one — `positions.qty`, `categories.id` — must be bounded by it at the boundary: the driver
 * sends the value as an int4 parameter and Postgres answers SQLSTATE 22003, which the API
 * has no handler for, so an unbounded field turns malformed input into a 500 (A-M3-18).
 */
export const INT4_MAX = 2_147_483_647;

/** positions.qty is int4; `applyBuy` refuses to grow a position past it. */
export const POSITION_QTY_MAX = INT4_MAX;

/** Bound on request-side Coin fields (`COIN_AMOUNT_INPUT_MAX_LENGTH` is its length): 10^15. */
export const MAX_COIN_AMOUNT = 10n ** 15n;

// ---- orders (#119, ADR-0112; ADR-0107 결정 1 #177 2·3·9항) --------------------------------
/**
 * The input cap of one order's quantity, 1 to this many contracts (#177 9항: no economic order or
 * holding cap, only this input cap — the old `ORDER_QTY_MAX`).
 */
export const ORDER_QTY_MAX = 1_000_000;

/**
 * The cap of a Coin-amount (budget) order's budget, 1 to this many Coin: `ORDER_QTY_MAX` × the
 * lowest price, so a budget order never fills more contracts than a quantity order may ask.
 */
export const ORDER_BUDGET_MAX_COIN = BigInt(ORDER_QTY_MAX) * BigInt(PRICE_MIN);

/**
 * The range of a 가격 보호 폭 in ticks (#177 2항): the release setting's default and a market's own
 * (`markets.price_protection_ticks`). 98 ticks reach from any price to either end of 1..99.
 */
export const PRICE_PROTECTION_TICKS_MIN = 1;
export const PRICE_PROTECTION_TICKS_MAX = PRICE_MAX - PRICE_MIN;

/** The highest value of the release setting `order.rate_limit` (submissions per minute). */
export const ORDER_RATE_LIMIT_MAX = 1_000;

export const MARKET_TITLE_MAX = 120;
/**
 * Each rule text (#23, ADR-0093 decision 3 '#23 문장 길이와 표시'): 배경 (`description`), the YES and
 * NO conditions, the switch condition and the delay handling (market-rules.ts).
 */
export const MARKET_TEXT_MAX = 5_000;
/** A rule source's name (`MarketSource.name`, #23). */
export const MARKET_SOURCE_MAX = 500;
/** A rule source's http(s) address (`MarketSource.url`, #23, ADR-0093 decision 3 '#23 출처 주소'). */
export const MARKET_SOURCE_URL_MAX = 500;
/** Fallback sources a market's rules may name, in priority order (#172 item 9: 0..3). */
export const MARKET_FALLBACK_SOURCES_MAX = 3;
/**
 * 장기 지연 기한 (`longDelayDays`, #172 item 10): whole days after the scheduled judgement instant,
 * N × 24 hours (ADR-0097). `markets.long_delay_days` has the same CHECK.
 */
export const MARKET_LONG_DELAY_DAYS_MIN = 1;
export const MARKET_LONG_DELAY_DAYS_MAX = 365;
/**
 * 다음 검토 시각 of a 판정 지연 기록 (#142, ADR-0106; owner answer 2026-11-03 (1)): a future instant
 * at most this many days — N × 24 hours, as the long delay's — after the record, on a CLOSED and
 * a PROVISIONAL market alike. A product rule, no release setting (market-judgement-delay.ts);
 * `market_judgement_delays` has the same CHECK, in hours.
 */
export const JUDGEMENT_DELAY_REVIEW_MAX_DAYS = 7;
export const MARKET_IMAGE_URL_MAX = 500;

/**
 * markets.slug: lower-case ASCII, digits, Hangul syllables and '-'; NFC-normalised before
 * matching so a decomposed (NFD) Korean title is not a second, distinct slug.
 */
export const MARKET_SLUG_MIN = 3;
export const MARKET_SLUG_MAX = 80;
export const MARKET_SLUG_PATTERN = /^[a-z0-9가-힣-]{3,80}$/;
/** `slugify()` keeps this much of the title, leaving room for the server's `-<tag>` suffix. */
export const MARKET_SLUG_STEM_MAX = 60;

/**
 * A search term, trimmed: `GET /markets?q=` and a recorded search (`market_searches.query`,
 * ADR-0066) share it, so whatever the search screen can search it can record.
 */
export const MARKET_SEARCH_TERM_MAX = 100;

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

// ---- resolution / settlement (PLAN 5.5, 7.3; ADR-0046) -------------------------------
/**
 * market_settlement_steps.last_error: the first this-many characters of the message of the
 * step's last failed attempt (the worker cuts it; the column is text).
 */
export const SETTLEMENT_STEP_ERROR_MAX = 1_000;
/**
 * Markets one scan job opens, closes, confirms or finalizes per run (PLAN 9: `market.open` (#21),
 * `market.close`, `market.resolve` (#152) and `market.finalize` without a market id scan
 * everything due). The scans repeat every minute, so a backlog wider than this is drained over
 * several runs instead of holding one job for as long as it takes.
 */
export const MARKET_SCAN_BATCH_MAX = 500;
