import * as z from 'zod';
import { coinAmountSchema } from './api/coin-amount.js';

/**
 * 시작 지급 (#70, ADR-0069 decision 1 #57-1·#57-2·#57-18 and decision 4 #70, ADR-0071): the same
 * start Coin, once per verified mobile number (N01 §2 "인증된 참여자에게 동일한 시작 코인을 1회
 * 지급한다"). Creating an account grants nothing; the server grants after the onboarding (#58)
 * confirms consent, verification and nickname, and never again to that number — not to a new
 * account that verifies it after the first one withdrew (#57-17). The amount is the release setting
 * `grant.start_coin` (START_COIN_SETTING); while it has no value the grant waits (`pending`) and is
 * paid when an admin enters one. A grant still waiting when its account withdraws is cancelled
 * instead, and its number may get the start Coin with the next account (owner decision
 * 2026-10-18: nothing was paid, so the number's once is unused).
 *
 * Owner-only, like the balance it lands in (PRIVATE_DATA `balance`): only the account itself reads
 * it, on `GET /me`.
 */

/**
 * The highest start grant the release setting takes: the same ceiling as a coupon
 * (COUPON_MAX_COIN) and an admin adjustment (ADJUST_MAX_ABS_COIN). A bound against a typo in the
 * admin screen, not a decided amount (#133 decides the amount).
 */
export const START_GRANT_MAX_COIN = 1_000_000;

/**
 * - `pending`: the account is eligible and its number recorded, but the amount is undecided; it is
 *   paid when the release setting gets a value (ADR-0069 decision 4 #70).
 * - `granted`: paid, once, with the amount read when it was paid.
 */
export const START_GRANT_STATUSES = ['pending', 'granted'] as const;
export type StartGrantStatus = (typeof START_GRANT_STATUSES)[number];
export const startGrantStatusSchema = z.enum(START_GRANT_STATUSES);

/**
 * How a number came to be recorded as one that received the start Coin (`start_grant_numbers`,
 * ADR-0071 — never on the wire):
 * - `grant`: the number the account had when its grant was recorded — one per grant;
 * - `operator`: a number an operator gave the account by hand later (#57-3), recorded beside the
 *   first so that it, too, never gets the start Coin again (owner decision 2026-10-18, the
 *   procedure in docs/OPERATIONS.md).
 */
export const START_GRANT_NUMBER_SOURCES = ['grant', 'operator'] as const;
export type StartGrantNumberSource = (typeof START_GRANT_NUMBER_SOURCES)[number];

/**
 * `Me.startGrant`: this account's start grant. `amountCoin` and `grantedAt` are null exactly while
 * it is `pending`. An account with no grant record (not yet eligible, or verified with a number
 * that already received one) has `startGrant: null`, and so has one whose waiting grant was
 * cancelled when it withdrew (owner decision 2026-10-18) — a withdrawn account reads nothing.
 */
export const startGrantSchema = z
  .object({
    status: startGrantStatusSchema,
    /** The Coin paid (the START_GRANT ledger entry's amount); null while pending. */
    amountCoin: coinAmountSchema.nullable(),
    /** When it was paid (the ledger entry's time); null while pending. */
    grantedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'StartGrant' });
export type StartGrant = z.infer<typeof startGrantSchema>;
