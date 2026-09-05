import { describe, expect, it } from 'vitest';
import { boundedInteger, integerField, optionalCouponCode } from './form-schema';

const inRange = (value: bigint) => value >= 1_000n && value <= 1_000_000n;

describe('boundedInteger', () => {
  it('reports the format error instead of throwing on a non-numeric string', () => {
    // The whole point of the `.pipe()`: zod 4 keeps checking after `.regex()` fails, so a
    // plain `.refine()` would call BigInt('abc') and throw SyntaxError out of safeParse —
    // react-hook-form would then show no error at all and the form would look dead.
    const schema = boundedInteger(/^\d+$/, 'format', inRange, 'range');
    const result = schema.safeParse('abc');
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['format']);
  });

  it('still applies the range check once the format passes', () => {
    const schema = boundedInteger(/^\d+$/, 'format', inRange, 'range');
    expect(schema.safeParse('5').error?.issues.map((issue) => issue.message)).toEqual(['range']);
    expect(schema.safeParse(' 5000 ')).toMatchObject({ success: true, data: '5000' });
  });

  it('accepts a signed pattern, as the balance adjustment needs', () => {
    const schema = boundedInteger(
      /^-?\d+$/,
      'format',
      (value) => value !== 0n && value >= -1_000n && value <= 1_000n,
      'range',
    );
    expect(schema.safeParse('-300')).toMatchObject({ success: true });
    expect(schema.safeParse('0').error?.issues.map((issue) => issue.message)).toEqual(['range']);
    expect(schema.safeParse('-').error?.issues.map((issue) => issue.message)).toEqual(['format']);
  });
});

describe('optionalCouponCode', () => {
  const schema = optionalCouponCode('bad');

  it('accepts a blank field, which asks the server to generate a code', () => {
    expect(schema.safeParse('')).toMatchObject({ success: true, data: '' });
    expect(schema.safeParse('   ')).toMatchObject({ success: true, data: '' });
  });

  it('normalises a typed code the way the API stores it', () => {
    expect(schema.safeParse(' summer-2026 ')).toMatchObject({
      success: true,
      data: 'SUMMER-2026',
    });
  });

  it('rejects what the API would reject, rather than leaving it to a generic 400', () => {
    // Each of these passed the old `.max(32)`-only field and came back as an unexplained
    // toast: an underscore and a space break the charset, and 'ABC' is under the minimum.
    for (const code of ['WELCOME_2026', 'SUMMER SALE', 'ABC', 'A'.repeat(33)]) {
      const result = schema.safeParse(code);
      expect({ code, success: result.success }).toEqual({ code, success: false });
      expect(result.error?.issues.map((issue) => issue.message)).toEqual(['bad']);
    }
  });
});

describe('integerField', () => {
  it('trims and rejects anything outside the pattern', () => {
    const schema = integerField(/^\d+$/, 'format');
    expect(schema.safeParse(' 42 ')).toMatchObject({ success: true, data: '42' });
    expect(schema.safeParse('4.2').success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });
});
