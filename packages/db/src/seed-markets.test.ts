import {
  type ExcludedTextHit,
  MARKET_SLUG_PATTERN,
  SUBCATEGORY_SLUGS,
  findExcludedText,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { SEED_MARKETS, SEED_RULE_NO_DELAY_NO } from './seed-markets.js';

/**
 * The phrasings the seed rules used before #125 to turn a late or missing publication into a
 * NO — "…까지 (공식) 발표가 없으면 '아니오'", "결과가 발표되지 않으면", "그마저 없으면 '아니오'",
 * "자료가 공개되지 않으면 '아니오'". N03 §4 forbids that; a NO for an event that did not happen
 * by its deadline (N03 §2) is phrased around the event and stays. The label is NO since #14, and
 * the old '아니오' is matched too.
 */
const PUBLICATION_MISSING_NO = [
  /(발표|공표|공개|고시)[가이]? 없으면[^.]*(NO|'아니오')/,
  /(발표|공표|공개|고시)되지 않으면[^.]*(NO|'아니오')/,
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
      expect(rules.replace(SEED_RULE_NO_DELAY_NO, ''), slug).toMatch(/NO(입니다|로 판정합니다)/);
    }
  });
});

/** The seed's text a market's screen shows: the card and the detail with its 규칙 and 출처. */
const SCREEN_FIELDS = ['title', 'description', 'rules', 'resolutionSource'] as const;

/**
 * A won amount a question is about (the KRW/USD close) is the market's subject, not a price for
 * Coin, which is what paid purchase's won-price word looks for (N06: no price table).
 */
const isWonAmount = (hit: ExcludedTextHit) =>
  hit.feature === 'paid-purchase' && /^\d\s*(?:[십백천만억]+\s*)?원$/.test(hit.match);

describe('seed market copy and the excluded features (#113)', () => {
  // ADR-0052 left this check to #113: the seed's text is screen text once a market opens.
  it('names nothing the plan leaves out', () => {
    const hits = SEED_MARKETS.flatMap((market) =>
      SCREEN_FIELDS.flatMap((field) =>
        findExcludedText(market[field])
          .filter((hit) => !isWonAmount(hit))
          .map((hit) => `${market.slug} ${field}: ${hit.feature} '${hit.match}'`),
      ),
    );
    expect(hits).toEqual([]);
  });

  it('lets a won amount through, and nothing else of paid purchase', () => {
    // Still needed: a seed question names a won amount.
    expect(SEED_MARKETS.some((market) => findExcludedText(market.title).some(isWonAmount))).toBe(
      true,
    );
    const hits = findExcludedText('1,000원에 충전하면 ₩100 할인').filter(
      (hit) => !isWonAmount(hit),
    );
    expect(hits.map((hit) => hit.match)).toEqual(['충전', '할인', '₩']);
    // A won amount with a unit numeral is one too.
    expect(findExcludedText('3만 원 이상').filter(isWonAmount)).toHaveLength(1);
  });
});
