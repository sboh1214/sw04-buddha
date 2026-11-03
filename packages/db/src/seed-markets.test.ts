import {
  type ExcludedTextHit,
  MARKET_SLUG_PATTERN,
  MARKET_TAGS_MAX,
  MARKET_TAGS_MIN,
  SUBCATEGORY_SLUGS,
  findExcludedText,
  marketTagsSchema,
  tagKey,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { SEED_MARKETS, SEED_RULE_NO_DELAY_NO, type SeedMarket } from './seed-markets.js';

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

describe('seed market tags (#17, ADR-0093 decision 2 #172 item 2)', () => {
  it('gives every market 1..5 tags the API would take, none twice', () => {
    for (const { slug, tags } of SEED_MARKETS) {
      expect(tags.length, slug).toBeGreaterThanOrEqual(MARKET_TAGS_MIN);
      expect(tags.length, slug).toBeLessThanOrEqual(MARKET_TAGS_MAX);
      // The admin entry's own schema: the length, the charset and no two the same tag, case
      // ignored. Its output is the literal itself — already normalised, so the spelling written
      // here is the one stored when the seed makes the tag (seed.ts refuses anything else).
      const parsed = marketTagsSchema.safeParse(tags);
      expect(parsed.error?.issues, slug).toBeUndefined();
      expect(parsed.data, slug).toEqual(tags);
      expect(new Set(tags.map(tagKey)).size, slug).toBe(tags.length);
    }
  });

  it('spells a tag the same in every market it is on, and shares the common ones', () => {
    // One tag per key, shown with the spelling it was first made with: a second spelling in a
    // later market would never be seen, so the copy here must not disagree with itself.
    const spellings = new Map<string, Set<string>>();
    for (const { tags } of SEED_MARKETS) {
      for (const name of tags) {
        spellings.set(tagKey(name), (spellings.get(tagKey(name)) ?? new Set()).add(name));
      }
    }
    for (const [key, names] of spellings) expect([...names], key).toHaveLength(1);
    // Shared across markets where the subject is: one tag, each of its markets.
    const marketsOf = (name: string) =>
      SEED_MARKETS.filter((market) => market.tags.includes(name)).length;
    expect(marketsOf('서울')).toBeGreaterThanOrEqual(2);
    expect(marketsOf('기상청')).toBeGreaterThanOrEqual(2);
    expect(marketsOf('통계청')).toBeGreaterThanOrEqual(2);
    // And the most a market takes, so the seed exercises the CHECK's upper end.
    expect(SEED_MARKETS.some((market) => market.tags.length === MARKET_TAGS_MAX)).toBe(true);
  });
});

/**
 * The seed's text a market's screen shows: the card and the detail with its 규칙 and 출처. Its
 * tags are on the detail too (#17), checked one by one below.
 */
const SCREEN_FIELDS = ['title', 'description', 'rules', 'resolutionSource'] as const;
type ScreenField = (typeof SCREEN_FIELDS)[number];

const KRW_USD = 'krw-usd-yearend-2026-above-1400';

/**
 * The won amounts a question is about, each for the one market and field that states it: the
 * KRW/USD close is that market's subject, not a price for Coin, which is what paid purchase's
 * won-price word looks for (N06: no price table). A won amount anywhere else fails.
 */
const WON_AMOUNTS: readonly { slug: string; field: ScreenField; amount: string }[] = [
  { slug: KRW_USD, field: 'title', amount: '1,400원' },
  { slug: KRW_USD, field: 'rules', amount: '1,400.0원' },
  { slug: KRW_USD, field: 'rules', amount: '1,399.9원' },
];

type ScreenCopy = Pick<SeedMarket, 'slug' | ScreenField>;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a market's field states one of its listed won amounts, as [start, end). */
function wonAmountSpans(market: ScreenCopy, field: ScreenField): [number, number][] {
  return WON_AMOUNTS.filter((entry) => entry.slug === market.slug && entry.field === field).flatMap(
    ({ amount }) =>
      [
        ...market[field].matchAll(
          // The whole amount: not the tail of '11,400원'.
          new RegExp(`(?<![\\d.,])${escapeRegExp(amount)}`, 'g'),
        ),
      ].map((m): [number, number] => [m.index, m.index + m[0].length]),
  );
}

/** What a market's field names of the excluded features, past its listed won amounts. */
function excludedIn(market: ScreenCopy, field: ScreenField): ExcludedTextHit[] {
  const spans = wonAmountSpans(market, field);
  return findExcludedText(market[field]).filter(
    (hit) =>
      !(
        hit.feature === 'paid-purchase' &&
        spans.some(([start, end]) => start <= hit.index && hit.index + hit.match.length <= end)
      ),
  );
}

describe('seed market copy and the excluded features (#113)', () => {
  // ADR-0052 left this check to #113: the seed's text is screen text once a market opens.
  it('names nothing the plan leaves out', () => {
    const hits = SEED_MARKETS.flatMap((market) =>
      SCREEN_FIELDS.flatMap((field) =>
        excludedIn(market, field).map(
          (hit) => `${market.slug} ${field}: ${hit.feature} '${hit.match}'`,
        ),
      ),
    );
    expect(hits).toEqual([]);
  });

  it('names nothing the plan leaves out in a tag either (#17)', () => {
    // The detail shows each tag as a link of its own, so each is checked alone; no won amount
    // is listed for a tag.
    const hits = SEED_MARKETS.flatMap((market) =>
      market.tags.flatMap((name) =>
        findExcludedText(name).map(
          (hit) => `${market.slug} tag '${name}': ${hit.feature} '${hit.match}'`,
        ),
      ),
    );
    expect(hits).toEqual([]);
    // The check reads a tag: a paid-purchase word as a tag fails.
    expect(findExcludedText('충전').map((hit) => hit.feature)).toContain('paid-purchase');
  });

  it('needs every listed won amount: each still clears a hit where it is listed', () => {
    for (const entry of WON_AMOUNTS) {
      const market = SEED_MARKETS.find((m) => m.slug === entry.slug);
      expect(market, entry.slug).toBeDefined();
      const spans = wonAmountSpans(market!, entry.field).filter(
        ([start, end]) => market![entry.field].slice(start, end) === entry.amount,
      );
      expect(spans.length, `${entry.slug} ${entry.field} ${entry.amount}`).toBeGreaterThan(0);
      const cleared = findExcludedText(market![entry.field]).filter((hit) =>
        spans.some(([start, end]) => start <= hit.index && hit.index + hit.match.length <= end),
      );
      expect(cleared.map((hit) => hit.feature)).toContain('paid-purchase');
    }
  });

  it('lets the listed won amounts through, and no other won amount or paid-purchase word', () => {
    const krwUsd = SEED_MARKETS.find((market) => market.slug === KRW_USD)!;
    const other = SEED_MARKETS.find((market) => market.slug !== KRW_USD)!;
    const matches = (market: ScreenCopy, field: ScreenField) =>
      excludedIn(market, field).map((hit) => hit.match);
    // A Coin price, in another market or in the KRW/USD market's other fields.
    expect(matches({ ...other, description: 'Coin 가격은 1,000원입니다.' }, 'description')).toEqual(
      ['0원'],
    );
    expect(
      matches({ ...krwUsd, description: 'Coin 가격은 1,000원입니다.' }, 'description'),
    ).toEqual(['0원']);
    // The listed amount does not travel to another market or field.
    expect(matches({ ...other, title: krwUsd.title }, 'title')).toEqual(['0원']);
    expect(matches({ ...krwUsd, resolutionSource: krwUsd.title }, 'resolutionSource')).toEqual([
      '0원',
    ]);
    // In its own field, only the listed amount: a second amount there fails, and so do the
    // paid-purchase words and the won sign.
    expect(
      matches(
        { ...krwUsd, title: `${krwUsd.title} Coin은 1,000원에 충전합니다. ₩100 할인` },
        'title',
      ),
    ).toEqual(['충전', '할인', '0원', '₩']);
    expect(matches({ ...krwUsd, title: '환율 종가가 11,400원 이상일까?' }, 'title')).toEqual([
      '0원',
    ]);
  });
});
