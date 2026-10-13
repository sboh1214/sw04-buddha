import * as z from 'zod';
import { MAX_COIN_AMOUNT } from '../constants.js';

/**
 * Wire format of a Coin amount: a decimal integer string ("12500", "-300"). JSON numbers are
 * IEEE doubles and cannot carry a Postgres bigint exactly, so every Coin amount crosses the
 * API as a string in both directions. Parse with `parseCoinAmount`, format with `formatCoin`.
 */
export const coinAmountSchema = z
  .string()
  .regex(/^-?(0|[1-9]\d*)$/, 'must be a decimal integer string')
  .meta({ id: 'CoinAmount', description: 'Integer amount of Coin as a decimal string (bigint).' });
export type CoinAmount = z.infer<typeof coinAmountSchema>;

export function serializeCoinAmount(value: bigint): CoinAmount {
  return value.toString();
}

/**
 * Not for request input — that goes through `coinAmountInputSchema`, which bounds the length
 * first.
 */
export function parseCoinAmount(value: CoinAmount): bigint {
  return BigInt(value);
}

/**
 * The longest wire string a request may carry: a sign and the 16 digits of MAX_COIN_AMOUNT
 * (10^15). Checked before anything is parsed: `BigInt()` on a body-sized run of digits costs
 * real CPU on the request thread (about 70 ms per million digits in Node 24), and no valid
 * amount has more digits than the bound anyway.
 */
export const COIN_AMOUNT_INPUT_MAX_LENGTH = MAX_COIN_AMOUNT.toString().length + 1;

/** Request-side Coin amount: validates the wire string and yields a bigint (M2+ bodies). */
export const coinAmountInputSchema = coinAmountSchema
  .max(
    COIN_AMOUNT_INPUT_MAX_LENGTH,
    `must be at most ${String(COIN_AMOUNT_INPUT_MAX_LENGTH)} characters`,
  )
  .transform(parseCoinAmount);
