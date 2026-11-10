import {
  DEFAULT_JUDGEMENT_TIME_ZONE,
  type ExcludedTextHit,
  LEAD_CLOSE_GAP_UNDECIDED,
  MARKET_SLUG_PATTERN,
  MARKET_TAGS_MAX,
  MARKET_TAGS_MIN,
  SUBCATEGORY_SLUGS,
  createMarketBodySchema,
  findExcludedText,
  marketTagsSchema,
  minuteOf,
  missingOpenItems,
  tagKey,
  timeRuleViolations,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import {
  SEED_MARKETS,
  SEED_RULE_NO_DELAY_NO,
  type SeedMarket,
  seedScheduledOpenAt,
} from './seed-markets.js';

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

/**
 * A VOID market's contracts are paid by the one 50/50 rule (#173 item 9), never handed back as a
 * refund of what they cost (N03 §6, #23's last AC).
 */
const REFUND_WORDING = /환불|원금|돌려(드리|받|줍)/;

/**
 * The seed's text a market's screen shows: the card and the detail with its 배경 and rule items
 * (#23, ADR-0097), each source by its name and its address. Its tags are on the detail too
 * (#17), checked one by one below.
 */
const SCREEN_FIELDS = [
  'title',
  'description',
  'yesCondition',
  'noCondition',
  'primarySource',
  'fallbackSources',
  'fallbackCondition',
  'delayHandling',
] as const;
type ScreenField = (typeof SCREEN_FIELDS)[number];
/** The fields that are one text: the sources are a name and an address each. */
type TextField = Exclude<ScreenField, 'primarySource' | 'fallbackSources'>;

type ScreenCopy = Pick<SeedMarket, 'slug' | ScreenField>;

/** What a field shows: its text, or each of its sources' name and address. */
function screenTexts(market: ScreenCopy, field: ScreenField): string[] {
  if (field === 'primarySource') return [market.primarySource.name, market.primarySource.url];
  if (field === 'fallbackSources') {
    return market.fallbackSources.flatMap((source) => [source.name, source.url]);
  }
  return [market[field]];
}

/** Every text a market's screen shows, with the field it is in. */
function allScreenTexts(market: ScreenCopy): { field: ScreenField; text: string }[] {
  return SCREEN_FIELDS.flatMap((field) =>
    screenTexts(market, field).map((text) => ({ field, text })),
  );
}

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
      expect(Number.isNaN(Date.parse(market.eventDeadline)), market.slug).toBe(false);
    }
  });

  it('never answers NO only because the source published late (N03 §4)', () => {
    for (const market of SEED_MARKETS) {
      // The delay clause lives in 지연·취소·무효 처리 (#23), and no field says the opposite.
      expect(market.delayHandling, market.slug).toContain(SEED_RULE_NO_DELAY_NO);
      for (const { field, text } of allScreenTexts(market)) {
        for (const pattern of PUBLICATION_MISSING_NO) {
          expect(text, `${market.slug} ${field}`).not.toMatch(pattern);
        }
      }
    }
  });

  it('states the NO side of every market, against its event deadline (N03 §2, #172 item 8)', () => {
    for (const { slug, noCondition } of SEED_MARKETS) {
      expect(noCondition, slug).toMatch(/NO(입니다|로 판정합니다)/);
      expect(noCondition, slug).toContain('사건 기한');
    }
  });

  it('gives every market its VOID criteria and promises no refund (N03 §4·§6, #23)', () => {
    for (const market of SEED_MARKETS) {
      expect(market.delayHandling, market.slug).toContain('무효(VOID)');
      for (const { field, text } of allScreenTexts(market)) {
        expect(text, `${market.slug} ${field}`).not.toMatch(REFUND_WORDING);
      }
    }
    // The check reads the wording: a refund promise fails.
    expect('무효로 판정되면 원금을 돌려드립니다.').toMatch(REFUND_WORDING);
  });
});

/**
 * Clocks a seed may run at: before every close, on 2026-10-31 (the day #22 was written, mid-minute
 * and between stale closes), and after every close.
 */
const RUN_CLOCKS = [
  new Date('2026-09-01T00:00:00.000Z'),
  new Date('2026-10-31T13:00:30.500Z'),
  new Date('2027-07-01T00:00:00.000Z'),
];

/** The proposed 선행 마감 gap (ADR-0093 result 3: 1시간), in minutes. */
const PROPOSED_GAP_MINUTES = 60;

/** A seed market as the open-items check reads it once seeded at `now` (`seedMarkets`). */
function openItemsOf(market: SeedMarket, now: Date, leadCloseGapMinutes: number | null) {
  return {
    ...market,
    fallbackSources: [...market.fallbackSources],
    scheduledOpenAt: seedScheduledOpenAt(new Date(market.closeAt), now).toISOString(),
    // The seed files it under a leaf and gives it its tags (`seedMarkets`).
    categorySelectable: true,
    tagCount: market.tags.length,
    leadCloseGapMinutes,
    // The seed writes no width; the submission fills the default (#119), its test value here.
    priceProtectionTicks: 5,
    liquidityVersion: null, // Seed examples never infer an operator budget or loss limit.
  };
}

describe('seed market rule items (#23, ADR-0097)', () => {
  it('gives seed examples content without inventing liquidity settings', () => {
    // The times too (#22): with the scheduled open a run writes, whenever it runs, and the gap
    // the design proposes.
    for (const now of RUN_CLOCKS) {
      for (const market of SEED_MARKETS) {
        expect(
          missingOpenItems(openItemsOf(market, now, PROPOSED_GAP_MINUTES)),
          `${market.slug} at ${now.toISOString()}`,
        ).toEqual(['liquidity']);
      }
    }
  });

  it('writes each item as the admin entry would take and store it', () => {
    // The create body's own schema, the category and the account aside: the limits, the source
    // rules and the event deadline's form. Its output is the literal itself — already trimmed.
    const entry = createMarketBodySchema.omit({ categoryId: true, expectedAccountId: true });
    for (const market of SEED_MARKETS) {
      const body = {
        slug: market.slug,
        title: market.title,
        description: market.description,
        yesCondition: market.yesCondition,
        noCondition: market.noCondition,
        eventDeadline: market.eventDeadline,
        primarySource: market.primarySource,
        fallbackSources: [...market.fallbackSources],
        fallbackCondition: market.fallbackCondition,
        longDelayDays: market.longDelayDays,
        delayHandling: market.delayHandling,
        tags: [...market.tags],
        closeAt: market.closeAt,
        // The times (#22) but the scheduled open, which the seed takes from its run's clock.
        scheduledAnnouncementAt: market.scheduledAnnouncementAt,
        scheduledJudgementAt: market.scheduledJudgementAt,
        judgementTimeZone: market.judgementTimeZone,
      };
      const parsed = entry.safeParse(body);
      expect(parsed.error?.issues, market.slug).toBeUndefined();
      expect(parsed.data, market.slug).toEqual(body);
      // The service's own refusal ('no fallback source'): a switch condition needs a fallback.
      expect(market.fallbackCondition !== '', market.slug).toBe(market.fallbackSources.length > 0);
    }
  });

  it('cites every source by a name and an https address', () => {
    for (const market of SEED_MARKETS) {
      for (const source of [market.primarySource, ...market.fallbackSources]) {
        expect(source.name.trim(), market.slug).not.toBe('');
        expect(new URL(source.url).protocol, `${market.slug} ${source.url}`).toBe('https:');
      }
    }
  });

  it('gives a fallback only where the rule names one, in priority order (#172 item 9)', () => {
    const fallbacks = Object.fromEntries(
      SEED_MARKETS.filter((market) => market.fallbackSources.length > 0).map((market) => [
        market.slug,
        market.fallbackSources.map((source) => source.name),
      ]),
    );
    expect(fallbacks).toEqual({
      // The close when the market's own does not show it.
      'krw-usd-yearend-2026-above-1400': ['서울외국환중개 환율 고시'],
      // The daily totals when the monthly data is not out by 11월 15일.
      'seoul-october-2026-rain-above-50mm': ['기상자료개방포털 일자료'],
      // Three newsrooms that count alike: one primary, the other two after it in order.
      'korea-telco-6g-trial-2026': ['KT 보도자료', 'LG유플러스 뉴스룸'],
    });
    const telco = SEED_MARKETS.find((market) => market.slug === 'korea-telco-6g-trial-2026')!;
    expect(telco.primarySource.name).toBe('SK텔레콤 뉴스룸');
  });

  it('sets the long-delay deadline by how the source publishes: 14 or 30 days', () => {
    for (const { slug, longDelayDays } of SEED_MARKETS) {
      expect([14, 30], slug).toContain(longDelayDays);
    }
  });
});

/**
 * Each seed market's 발표 예정 and 예정 판정 (UTC; KST in seed-markets.ts), as verified with each
 * publisher on 2026-10-31 (ADR-0098). Null is '없음': the source has no scheduled release. Kept in
 * step with the copy by hand, as EXPECTED_CLOSE_AT is (seed.test.ts): a change is a copy change
 * for the owner to review (Q-M3-4), never a guess.
 */
const EXPECTED_TIMES: Record<string, { announcement: string | null; judgement: string }> = {
  'bok-october-rate-cut-2026': {
    announcement: '2026-10-22T01:30:00Z',
    judgement: '2026-11-02T01:00:00Z',
  },
  'cpi-september-2026-above-2pct': {
    announcement: '2026-10-01T23:00:00Z',
    judgement: '2026-10-02T01:00:00Z',
  },
  'krw-usd-yearend-2026-above-1400': {
    announcement: '2026-12-30T06:30:00Z',
    judgement: '2026-12-31T01:00:00Z',
  },
  'seoul-apartment-price-november-2026-up': {
    announcement: '2026-12-14T15:00:00Z',
    judgement: '2026-12-16T01:00:00Z',
  },
  'unemployment-october-2026-below-3pct': {
    announcement: '2026-11-10T23:00:00Z',
    judgement: '2026-11-11T01:00:00Z',
  },
  'seoul-first-snow-before-nov-20-2026': { announcement: null, judgement: '2026-11-20T01:00:00Z' },
  'seoul-october-2026-rain-above-50mm': { announcement: null, judgement: '2026-11-02T01:00:00Z' },
  'seoul-november-2026-below-minus-5': { announcement: null, judgement: '2026-12-01T01:00:00Z' },
  'korea-telco-6g-trial-2026': { announcement: null, judgement: '2027-01-04T01:00:00Z' },
  'samsung-trifold-korea-launch-2026': { announcement: null, judgement: '2027-01-04T01:00:00Z' },
  'november-2026-korean-film-3m-in-2-weeks': {
    announcement: null,
    judgement: '2026-12-14T01:00:00Z',
  },
  'melon-last-week-2026-domestic-no1': { announcement: null, judgement: '2026-12-29T01:00:00Z' },
  'national-museum-2026-visitors-above-4m': {
    announcement: null,
    judgement: '2027-01-04T01:00:00Z',
  },
  'korea-new-books-2026-more-than-2025': {
    announcement: null,
    judgement: '2027-06-01T01:00:00Z',
  },
};

/** Korea's offset, +09:00 all year (no daylight saving). */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

describe('seed market times (#22, ADR-0098)', () => {
  it("gives each market its publisher's scheduled release or '없음', and its judgement", () => {
    expect(
      Object.fromEntries(
        SEED_MARKETS.map((market) => [
          market.slug,
          { announcement: market.scheduledAnnouncementAt, judgement: market.scheduledJudgementAt },
        ]),
      ),
    ).toEqual(EXPECTED_TIMES);
    // '없음' where the publisher has no calendar: observations, ad-hoc announcements, data with no
    // stated time (#172 item 13).
    expect(SEED_MARKETS.filter((market) => market.scheduledAnnouncementAt === null)).toHaveLength(
      9,
    );
  });

  it('breaks no time rule at the proposed gap, whenever the seed runs (#172 items 12-13, A1)', () => {
    // Scheduled open < close <= scheduled judgement, 사건 기한 <= scheduled judgement, and the close
    // at least 60 minutes before a release: what the database CHECKs (all but the lead) and the
    // open-items check hold the seed to.
    for (const now of RUN_CLOCKS) {
      for (const market of SEED_MARKETS) {
        expect(
          timeRuleViolations(openItemsOf(market, now, PROPOSED_GAP_MINUTES), PROPOSED_GAP_MINUTES),
          `${market.slug} at ${now.toISOString()}`,
        ).toEqual([]);
      }
    }
  });

  it('holds back only the markets with a release while the gap is undecided', () => {
    // Until the owner enters `market.lead_close_gap`, a market with a scheduled release cannot
    // open (its 선행 마감 cannot be judged); a '없음' market is not held (ADR-0098).
    const now = RUN_CLOCKS[1]!;
    for (const market of SEED_MARKETS) {
      const held = market.scheduledAnnouncementAt !== null;
      expect(timeRuleViolations(openItemsOf(market, now, null), null), market.slug).toEqual(
        held
          ? [
              {
                rule: 'leadClose',
                fields: ['closeAt', 'scheduledAnnouncementAt'],
                reason: LEAD_CLOSE_GAP_UNDECIDED,
              },
            ]
          : [],
      );
      expect(missingOpenItems(openItemsOf(market, now, null)), market.slug).toEqual(
        held ? ['leadClose', 'liquidity'] : ['liquidity'],
      );
    }
  });

  it("judges at 10:00 KST on a weekday after 사건 기한 and the release, in the seed's zone", () => {
    // The seed's rule (ADR-0098 구현의 선택); the public holidays it skips are in each comment.
    for (const market of SEED_MARKETS) {
      const judgement = Date.parse(market.scheduledJudgementAt);
      const kst = new Date(judgement + KST_OFFSET_MS);
      expect(
        [kst.getUTCHours(), kst.getUTCMinutes(), kst.getUTCSeconds(), kst.getUTCMilliseconds()],
        market.slug,
      ).toEqual([10, 0, 0, 0]);
      expect([1, 2, 3, 4, 5], market.slug).toContain(kst.getUTCDay());
      expect(judgement, market.slug).toBeGreaterThan(Date.parse(market.eventDeadline));
      if (market.scheduledAnnouncementAt !== null) {
        expect(judgement, market.slug).toBeGreaterThan(Date.parse(market.scheduledAnnouncementAt));
      }
      expect(market.judgementTimeZone, market.slug).toBe(DEFAULT_JUDGEMENT_TIME_ZONE);
    }
  });

  it("opens at the run's clock floored to the minute, or the minute before a close it reached", () => {
    const open = (closeAt: string, now: string) =>
      seedScheduledOpenAt(new Date(closeAt), new Date(now)).toISOString();
    // Passed already, so it opens as soon as it is approved (ADR-0093 decision 2 #172 item 6; #21).
    expect(open('2026-12-31T14:59:59Z', '2026-10-31T13:00:30.500Z')).toBe(
      '2026-10-31T13:00:00.000Z',
    );
    // A run two minutes before the close's own minute still gets its clock…
    expect(open('2026-10-31T14:59:59Z', '2026-10-31T14:57:59.999Z')).toBe(
      '2026-10-31T14:57:00.000Z',
    );
    // …and a run in that minute, or past the close (a stale seed), the minute before the close.
    expect(open('2026-10-31T14:59:59Z', '2026-10-31T14:59:00.000Z')).toBe(
      '2026-10-31T14:58:00.000Z',
    );
    expect(open('2026-09-30T14:59:59Z', '2026-10-31T13:00:30.500Z')).toBe(
      '2026-09-30T14:58:00.000Z',
    );
    expect(open('2026-11-19T15:00:00Z', '2026-12-01T00:00:00Z')).toBe('2026-11-19T14:59:00.000Z');
    // Whenever the seed runs, each one is a whole minute, has passed, and is before the close.
    for (const now of RUN_CLOCKS) {
      for (const market of SEED_MARKETS) {
        const opens = seedScheduledOpenAt(new Date(market.closeAt), now);
        const label = `${market.slug} at ${now.toISOString()}`;
        expect(opens.getTime() % 60_000, label).toBe(0);
        expect(opens.getTime(), label).toBeLessThanOrEqual(now.getTime());
        expect(minuteOf(opens.toISOString()), label).toBeLessThan(minuteOf(market.closeAt));
      }
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

const KRW_USD = 'krw-usd-yearend-2026-above-1400';

/**
 * The won amounts a question is about, each for the one market and field that states it: the
 * KRW/USD close is that market's subject, not a price for Coin, which is what paid purchase's
 * won-price word looks for (N06: no price table). A won amount anywhere else fails — in a source
 * too, which lists none.
 */
const WON_AMOUNTS: readonly { slug: string; field: TextField; amount: string }[] = [
  { slug: KRW_USD, field: 'title', amount: '1,400원' },
  { slug: KRW_USD, field: 'yesCondition', amount: '1,400.0원' },
  { slug: KRW_USD, field: 'noCondition', amount: '1,399.9원' },
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a market's field states one of its listed won amounts, as [start, end). */
function wonAmountSpans(market: ScreenCopy, field: TextField): [number, number][] {
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
  if (field === 'primarySource' || field === 'fallbackSources') {
    // Each name and address alone, as the detail shows them; no amount is listed for one.
    return screenTexts(market, field).flatMap((text) => findExcludedText(text));
  }
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
    // The listed amount does not travel to another market or field, a source included.
    expect(matches({ ...other, title: krwUsd.title }, 'title')).toEqual(['0원']);
    expect(matches({ ...krwUsd, delayHandling: krwUsd.title }, 'delayHandling')).toEqual(['0원']);
    expect(matches({ ...krwUsd, noCondition: krwUsd.yesCondition }, 'noCondition')).toEqual([
      '0원',
    ]);
    expect(
      matches({ ...krwUsd, primarySource: { name: krwUsd.title, url: '' } }, 'primarySource'),
    ).toEqual(['0원']);
    expect(
      matches(
        { ...krwUsd, fallbackSources: [{ name: '환율 고시', url: 'https://example.com/충전' }] },
        'fallbackSources',
      ),
    ).toEqual(['충전']);
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
