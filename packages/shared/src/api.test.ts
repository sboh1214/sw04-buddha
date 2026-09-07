import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { dataEnvelope, pageEnvelope, pageMetaSchema } from './api/envelope.js';
import { ERROR_CODES, errorEnvelopeSchema, validationIssueSchema } from './api/errors.js';
import {
  P_AMOUNT_INPUT_MAX_LENGTH,
  pAmountInputSchema,
  pAmountSchema,
  parsePAmount,
  serializePAmount,
} from './api/p-amount.js';
import { MAX_P_AMOUNT } from './constants.js';

describe('PAmount wire format', () => {
  it('bounds a request amount to the digits of MAX_P_AMOUNT before parsing it', () => {
    // A sign and the 16 digits of 10^15: nothing longer can be a valid amount, and a
    // body-sized run of digits must never reach BigInt().
    expect(P_AMOUNT_INPUT_MAX_LENGTH).toBe(MAX_P_AMOUNT.toString().length + 1);
    expect(pAmountInputSchema.parse(MAX_P_AMOUNT.toString())).toBe(MAX_P_AMOUNT);
    expect(pAmountInputSchema.parse(`-${MAX_P_AMOUNT.toString()}`)).toBe(-MAX_P_AMOUNT);
    for (const long of ['1'.repeat(P_AMOUNT_INPUT_MAX_LENGTH + 1), '9'.repeat(200_000)]) {
      const result = pAmountInputSchema.safeParse(long);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.code)).toContain('too_big');
    }
    // The response schema is unbounded: it only describes what the API sends.
    expect(pAmountSchema.safeParse('1'.repeat(40)).success).toBe(true);
  });

  it('accepts decimal integer strings only', () => {
    for (const ok of ['0', '1', '12500', '-300', '9007199254740993']) {
      expect(pAmountSchema.parse(ok)).toBe(ok);
    }
    for (const bad of ['', '01', '+1', '1.5', '1e3', '12,500', ' 1', 'abc']) {
      expect(pAmountSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('round-trips bigints beyond 2^53', () => {
    const big = 2n ** 63n - 1n;
    expect(parsePAmount(serializePAmount(big))).toBe(big);
    expect(parsePAmount(serializePAmount(-42n))).toBe(-42n);
    expect(pAmountInputSchema.parse('123')).toBe(123n);
  });
});

describe('envelopes', () => {
  it('wraps data and pages', () => {
    const item = z.object({ id: z.string() });
    expect(dataEnvelope(item).parse({ data: { id: 'a' } })).toEqual({ data: { id: 'a' } });
    const page = pageEnvelope(item).parse({ data: [{ id: 'a' }], meta: { nextCursor: null } });
    expect(page.meta.nextCursor).toBeNull();
    expect(pageMetaSchema.parse({ nextCursor: 'abc' }).nextCursor).toBe('abc');
  });

  it('only admits PLAN 7.4 error codes', () => {
    expect(ERROR_CODES).toContain('INSUFFICIENT_BALANCE');
    const ok = errorEnvelopeSchema.parse({
      error: { code: 'VALIDATION_ERROR', message: 'bad', details: [{ path: ['x'], message: 'm' }] },
    });
    expect(ok.error.code).toBe('VALIDATION_ERROR');
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(
      false,
    );
    expect(validationIssueSchema.parse({ path: ['nickname', 0], message: 'taken' }).path).toEqual([
      'nickname',
      0,
    ]);
  });
});
