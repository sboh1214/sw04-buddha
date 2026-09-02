import * as z from 'zod';

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

export function parsePAmount(value: PAmount): bigint {
  return BigInt(value);
}

/** Request-side P amount: validates the wire string and yields a bigint (M2+ bodies). */
export const pAmountInputSchema = pAmountSchema.transform(parsePAmount);
