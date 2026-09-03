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
