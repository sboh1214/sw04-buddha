import { MARKET_SLUG_PATTERN, SUBCATEGORY_SLUGS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { SEED_MARKETS, SEED_RULE_NO_DELAY_NO } from './seed-markets.js';

/**
 * The phrasings the seed rules used before #125 to turn a late or missing publication into a
 * NO — "…까지 (공식) 발표가 없으면 '아니오'", "결과가 발표되지 않으면", "그마저 없으면 '아니오'",
 * "자료가 공개되지 않으면 '아니오'". N03 §4 forbids that; a NO for an event that did not happen
 * by its deadline (N03 §2) is phrased around the event and stays.
 */
const PUBLICATION_MISSING_NO = [
  /(발표|공표|공개|고시)[가이]? 없으면[^.]*'아니오'/,
  /(발표|공표|공개|고시)되지 않으면[^.]*'아니오'/,
  /그마저 없으면/,
];

describe('seed market copy (#125)', () => {
  it('has 14 markets with unique, valid slugs filed under a leaf category', () => {
    expect(SEED_MARKETS).toHaveLength(14);
    const slugs = SEED_MARKETS.map((market) => market.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const leaves = new Set<string>(Object.values(SUBCATEGORY_SLUGS).flat());
    for (const market of SEED_MARKETS) {
      expect(market.slug).toMatch(MARKET_SLUG_PATTERN);
      expect(leaves.has(market.category), market.slug).toBe(true);
      expect(Number.isNaN(Date.parse(market.closeAt)), market.slug).toBe(false);
    }
  });

  it('never answers NO only because the source published late (N03 §4)', () => {
    for (const { slug, rules } of SEED_MARKETS) {
      expect(rules, slug).toContain(SEED_RULE_NO_DELAY_NO);
      for (const pattern of PUBLICATION_MISSING_NO) expect(rules, slug).not.toMatch(pattern);
    }
  });

  it('states the NO side of every rule, apart from the delay clause (N03 §2)', () => {
    for (const { slug, rules } of SEED_MARKETS) {
      expect(rules.replace(SEED_RULE_NO_DELAY_NO, ''), slug).toMatch(
        /'아니오'(입니다|로 정산합니다)/,
      );
    }
  });
});
