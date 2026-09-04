import { describe, expect, it } from 'vitest';
import { boundedInteger, integerField } from './form-schema';

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

describe('integerField', () => {
  it('trims and rejects anything outside the pattern', () => {
    const schema = integerField(/^\d+$/, 'format');
    expect(schema.safeParse(' 42 ')).toMatchObject({ success: true, data: '42' });
    expect(schema.safeParse('4.2').success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });
});
