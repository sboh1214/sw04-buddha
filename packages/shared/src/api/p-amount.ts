import * as z from 'zod';
import { MAX_P_AMOUNT } from '../constants.js';

/**
 * Wire format of a P amount: a decimal integer string ("12500", "-300"). JSON numbers are
 * IEEE doubles and cannot carry a Postgres bigint exactly, so every P amount crosses the
 * API as a string in both directions. Parse with `parsePAmount`, format with `formatP`.
 */
export const pAmountSchema = z
  .string()
  .regex(/^-?(0|[1-9]\d*)$/, 'must be a decimal integer string')
  .meta({ id: 'PAmount', description: 'Integer amount of P as a decimal string (bigint).' });
export type PAmount = z.infer<typeof pAmountSchema>;

export function serializePAmount(value: bigint): PAmount {
  return value.toString();
}

/** Not for request input — that goes through `pAmountInputSchema`, which bounds the length first. */
export function parsePAmount(value: PAmount): bigint {
  return BigInt(value);
}

/**
 * The longest wire string a request may carry: a sign and the 16 digits of MAX_P_AMOUNT
 * (10^15). Checked before anything is parsed: `BigInt()` on a body-sized run of digits costs
 * real CPU on the request thread (about 70 ms per million digits in Node 24), and no valid
 * amount has more digits than the bound anyway.
 */
export const P_AMOUNT_INPUT_MAX_LENGTH = MAX_P_AMOUNT.toString().length + 1;

/** Request-side P amount: validates the wire string and yields a bigint (M2+ bodies). */
export const pAmountInputSchema = pAmountSchema
  .max(P_AMOUNT_INPUT_MAX_LENGTH, `must be at most ${String(P_AMOUNT_INPUT_MAX_LENGTH)} characters`)
  .transform(parsePAmount);
