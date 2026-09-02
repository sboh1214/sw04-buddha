import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MINUS_SIGN, formatP } from './format.js';

describe('formatP', () => {
  it('groups thousands and appends P', () => {
    expect(formatP(0)).toBe('0P');
    expect(formatP(999)).toBe('999P');
    expect(formatP(1000)).toBe('1,000P');
    expect(formatP(12345)).toBe('12,345P');
    expect(formatP(12345n)).toBe('12,345P');
    expect(formatP(1_000_000_000n)).toBe('1,000,000,000P');
  });

  it('renders negatives with U+2212 MINUS SIGN, never hyphen-minus', () => {
    expect(formatP(-1200)).toBe('−1,200P');
    expect(formatP(-1200n)).toBe(`${MINUS_SIGN}1,200P`);
    expect(formatP(-1)).toBe('−1P');
    expect(formatP(-1200)).not.toContain('-');
  });

  it('rejects non-integer numbers', () => {
    expect(() => formatP(1.5)).toThrow(RangeError);
    expect(() => formatP(Number.NaN)).toThrow(RangeError);
  });

  it('rejects numbers outside the safe-integer range (already rounded by the double)', () => {
    // 2 ** 53: a 9007199254740993 literal would already parse to this value.
    expect(() => formatP(2 ** 53)).toThrow(RangeError);
    expect(() => formatP(-(2 ** 53))).toThrow(RangeError);
    expect(() => formatP(1e21)).toThrow(RangeError);
    expect(() => formatP(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    // Safe boundaries stay accepted; bigint input is unbounded.
    expect(formatP(Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991P');
    expect(formatP(Number.MIN_SAFE_INTEGER)).toBe('−9,007,199,254,740,991P');
    expect(formatP(2n ** 53n)).toBe('9,007,199,254,740,992P');
  });

  it('round-trips: stripping separators and sign yields the absolute value', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (v) => {
        const out = formatP(v);
        expect(out.endsWith('P')).toBe(true);
        const body = out.slice(0, -1);
        const negative = body.startsWith(MINUS_SIGN);
        const unsigned = negative ? body.slice(1) : body;
        expect(BigInt(unsigned.replaceAll(',', ''))).toBe(v < 0n ? -v : v);
        expect(negative).toBe(v < 0n);
        // First group is 1-3 digits, every following group is exactly 3 digits.
        const groups = unsigned.split(',');
        expect(groups[0]!.length).toBeGreaterThanOrEqual(1);
        expect(groups[0]!.length).toBeLessThanOrEqual(3);
        expect(groups.slice(1).every((g) => g.length === 3)).toBe(true);
      }),
    );
  });

  it('agrees with bigint input for every safe integer', () => {
    fc.assert(
      fc.property(fc.maxSafeInteger(), (n) => {
        expect(formatP(n)).toBe(formatP(BigInt(n)));
      }),
    );
  });
});
