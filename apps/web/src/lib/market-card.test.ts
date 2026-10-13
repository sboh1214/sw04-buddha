import { PRICE_MAX, PRICE_MIN } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { formatNoPrice, formatYesPrice } from './market-admin';
import { type OutcomeReading, noPrice, outcomeRows, payoutMultiple } from './market-card';

/** The two readings of a market that HAS a fill; a missing one here is a failure, not a value. */
function readings(lastPrice: number): [OutcomeReading, OutcomeReading] {
  const [yes, no] = outcomeRows(lastPrice);
  if (yes.reading === null || no.reading === null)
    throw new Error(`no reading at ${String(lastPrice)}`);
  return [yes.reading, no.reading];
}

describe('payoutMultiple', () => {
  it('is 100 over the price with two decimals and an x', () => {
    // Kalshi's figure: what 1P on this side comes back as if it wins.
    expect(payoutMultiple(50)).toBe('2.00x');
    expect(payoutMultiple(63)).toBe('1.59x');
    expect(payoutMultiple(37)).toBe('2.70x');
    expect(payoutMultiple(3)).toBe('33.33x');
  });

  it('answers the two ends of the range the API allows', () => {
    // 1P for a 100P contract is the largest figure the card can ever print; 99P the smallest.
    expect(payoutMultiple(PRICE_MIN)).toBe('100.00x');
    expect(payoutMultiple(PRICE_MAX)).toBe('1.01x');
  });

  it('clamps an out-of-range price to the bounds instead of throwing', () => {
    // The API never sends one (priceSchema); if something did, the card prints what the API
    // would have, rather than `Infinityx` or an error that takes the whole grid down.
    expect(payoutMultiple(0)).toBe(payoutMultiple(PRICE_MIN));
    expect(payoutMultiple(-5)).toBe(payoutMultiple(PRICE_MIN));
    expect(payoutMultiple(100)).toBe(payoutMultiple(PRICE_MAX));
    expect(payoutMultiple(250)).toBe(payoutMultiple(PRICE_MAX));
  });
});

describe('noPrice', () => {
  it('is the complement of lastPrice', () => {
    expect(noPrice(63)).toBe(37);
    expect(noPrice(50)).toBe(50);
    expect(noPrice(PRICE_MIN)).toBe(PRICE_MAX);
    expect(noPrice(PRICE_MAX)).toBe(PRICE_MIN);
  });
});

describe('outcomeRows', () => {
  it('orders 예 before 아니오 and colours them first/second', () => {
    const [yes, no] = outcomeRows(63);
    expect(yes.key).toBe('yes');
    expect(no.key).toBe('no');
    expect(yes.label).toBe(copy.yes);
    expect(no.label).toBe(copy.no);
    expect(yes.accent).toBe('row.first');
    expect(no.accent).toBe('row.second');
  });

  it('shows lastPrice on the 예 row and its complement on the 아니오 row', () => {
    const [yes, no] = readings(63);
    expect(yes.percent).toBe(63);
    expect(no.percent).toBe(37);
    expect(yes.multiple).toBe('1.59x');
    expect(no.multiple).toBe('2.70x');
  });

  it('names each row by the words the badge used to show', () => {
    // "예 63%" / "아니오 37%": the reading in words, never the colour alone (PLAN 11.2).
    const [yes, no] = readings(63);
    expect(yes.accessibleName).toBe(formatYesPrice(63));
    expect(no.accessibleName).toBe(formatNoPrice(63));
    expect(yes.accessibleName).toBe(`${copy.yes} 63%`);
    expect(no.accessibleName).toBe(`${copy.no} 37%`);
  });

  it('sums the two percents to 100 across the whole range', () => {
    for (let price = PRICE_MIN; price <= PRICE_MAX; price += 1) {
      const [yes, no] = readings(price);
      expect(yes.percent + no.percent).toBe(100);
      // Both sides stay inside the range the API allows, so neither multiple ever clamps.
      expect(yes.percent).toBeGreaterThanOrEqual(PRICE_MIN);
      expect(no.percent).toBeGreaterThanOrEqual(PRICE_MIN);
      expect(yes.percent).toBeLessThanOrEqual(PRICE_MAX);
      expect(no.percent).toBeLessThanOrEqual(PRICE_MAX);
    }
  });

  it('handles the two ends: a 1% market and a 99% market', () => {
    const [yesLow, noLow] = readings(PRICE_MIN);
    expect(yesLow.percent).toBe(1);
    expect(noLow.percent).toBe(99);
    expect(yesLow.multiple).toBe('100.00x');
    expect(noLow.multiple).toBe('1.01x');

    const [yesHigh, noHigh] = readings(PRICE_MAX);
    expect(yesHigh.percent).toBe(99);
    expect(noHigh.percent).toBe(1);
    expect(yesHigh.multiple).toBe('1.01x');
    expect(noHigh.multiple).toBe('100.00x');
  });

  it('keeps both rows before the first fill, with no reading at all (N02 §5)', () => {
    // Owner decision #125 (ADR-0048): the 예 and 아니오 rows stay, labelled and coloured as ever,
    // and nothing stands in for the price — no percent, no multiple, no 50% opening setting.
    const [yes, no] = outcomeRows(null);
    expect([yes.key, no.key]).toEqual(['yes', 'no']);
    expect([yes.label, no.label]).toEqual([copy.yes, copy.no]);
    expect([yes.accent, no.accent]).toEqual(['row.first', 'row.second']);
    expect(yes.reading).toBeNull();
    expect(no.reading).toBeNull();
  });
});
