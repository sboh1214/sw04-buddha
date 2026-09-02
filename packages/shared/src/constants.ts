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

/** profiles.nickname: 2..20 characters (PLAN 17 Q4 default). */
export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 20;
