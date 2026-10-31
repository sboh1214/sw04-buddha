import * as z from 'zod';
import {
  MARKET_FALLBACK_SOURCES_MAX,
  MARKET_LONG_DELAY_DAYS_MAX,
  MARKET_LONG_DELAY_DAYS_MIN,
  MARKET_SOURCE_MAX,
  MARKET_SOURCE_URL_MAX,
} from './constants.js';

/**
 * 규칙 항목 (#23, ADR-0097): what a market's rules say, one item per key (ADR-0093 decision 2 #172
 * items 7–10). A key names its item everywhere — the create and update body field, the `Market`
 * field, the open-items check (`OPEN_ITEMS`), the `rules_edited` event's item list and #80's rule
 * versions — and the list is in the admin form's order:
 *
 * - `description` 배경: the column keeps its name and stays nullable for older rows (ADR-0097).
 * - `yesCondition` YES 조건 and `noCondition` NO 조건.
 * - `eventDeadline` 사건 기한 (#172 item 8): the instant the event must happen by. None by then is
 *   NO; a source that only publishes late is a judgement delay (#173 item 11), never a NO.
 * - `primarySource` 1차 출처, `fallbackSources` 대체 출처 (0..3, in priority order; none reads
 *   '없음') and `fallbackCondition` 전환 조건, when the judgement moves from the primary to a
 *   fallback (#172 item 9). A market stores its sources as `market_sources` priorities 0..3.
 * - `longDelayDays` 장기 지연 기한 (whole days after the scheduled judgement) and `delayHandling`
 *   지연·취소·무효 처리 — what happens at that deadline, the VOID switch criteria and what an event
 *   cancelled or postponed means (#172 item 10, N03 §4). '취소' is the event's, never the market's
 *   CANCELLED status.
 *
 * VOID's 50/50 payout is no item: one rule for every market (#173 item 9, ADR-0093 result 1), shown
 * from `PROPOSED_CONTRACT_TERMS`. The title and #22's times join these items in #80's versions
 * (#172 item 7) but are not rule items.
 */
export const RULE_ITEMS = [
  'description',
  'yesCondition',
  'noCondition',
  'eventDeadline',
  'primarySource',
  'fallbackSources',
  'fallbackCondition',
  'longDelayDays',
  'delayHandling',
] as const;
export type RuleItem = (typeof RULE_ITEMS)[number];
export const ruleItemSchema = z.enum(RULE_ITEMS);

/** A source's address: http or https (ADR-0093 decision 3 '#23 출처 주소'). */
const sourceUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * One source of a market's rules (#23): a name and an http(s) address (ADR-0093 decision 3 '#23
 * 출처 주소'), each trimmed and at most 500 characters, stored as entered — the link review
 * normalises the address (`officialSourceLinks`). A draft may hold one half-filled: a blank name or
 * address is a missing item of the open-items check (`isCompleteSource`), not a refusal. Both
 * blank is refused ('empty source'), as `market_sources` refuses it: such a source says nothing.
 */
export const marketSourceSchema = z
  .object({
    name: z.string().trim().max(MARKET_SOURCE_MAX),
    /** '' while not filled in; otherwise an http(s) address. */
    url: z
      .string()
      .trim()
      .max(MARKET_SOURCE_URL_MAX)
      .refine((url) => url === '' || sourceUrlSchema.safeParse(url).success, 'Invalid URL'),
  })
  .refine((source) => source.name !== '' || source.url !== '', 'empty source')
  .meta({ id: 'MarketSource' });
export type MarketSource = z.infer<typeof marketSourceSchema>;

/**
 * The earliest instant the API stores and reads back unchanged (#23, ADR-0097) — storage's bound,
 * no product rule. `z.iso.datetime()` takes year 0000, which Postgres refuses (22008, a 500 at the
 * write), and drizzle reads a timestamptz back with `new Date(text)`, whose non-ISO parse takes a
 * year below 100 as 19xx or 20xx ('0050-01-01 00:00:00+00' comes back as 1950). There is no upper
 * bound to add: the four-digit year ends at 9999, and `new Date()` drops fractional digits past
 * the millisecond, so the latest instant is 9999-12-31T23:59:59.999Z, stored and read back as is.
 */
export const STORABLE_INSTANT_MIN = '0100-01-01T00:00:00.000Z';
/** The refusal of an instant before STORABLE_INSTANT_MIN, on the field that sent it. */
export const STORABLE_INSTANT_TOO_EARLY = `must be ${STORABLE_INSTANT_MIN} or later`;

const isIsoInstant = (value: string) => z.iso.datetime().safeParse(value).success;

/**
 * An ISO instant in UTC (`z.iso.datetime()`) from STORABLE_INSTANT_MIN on: 사건 기한 as the body
 * sends it and as `Market` carries it. The bound is checked on an ISO instant only, so a malformed
 * value is the format's one issue, never a second one (zod runs the refinement after the format
 * check failed too).
 */
export const storableInstantSchema = z.iso
  .datetime()
  .refine(
    (value) => !isIsoInstant(value) || Date.parse(value) >= Date.parse(STORABLE_INSTANT_MIN),
    STORABLE_INSTANT_TOO_EARLY,
  );

/** 장기 지연 기한 in whole days, N × 24 hours after the scheduled judgement (ADR-0097). */
export const marketLongDelayDaysSchema = z
  .number()
  .int()
  .min(MARKET_LONG_DELAY_DAYS_MIN)
  .max(MARKET_LONG_DELAY_DAYS_MAX);

/**
 * The rule items as a market carries them (`Market`, `AdminMarket`), in RULE_ITEMS order. A blank
 * text, a null and an empty list are items not filled in: a draft may save any of them, and the
 * open-items check names them (`missingRuleItems`). A market opened before #23 has them all blank.
 */
export const marketRuleItemsSchema = z.object({
  /** 배경. Null on a row that never had one. */
  description: z.string().nullable(),
  yesCondition: z.string(),
  noCondition: z.string(),
  eventDeadline: storableInstantSchema.nullable(),
  /** Priority 0 of `market_sources`. */
  primarySource: marketSourceSchema.nullable(),
  /** Priorities 1..3 in order; empty is '없음'. */
  fallbackSources: z.array(marketSourceSchema).max(MARKET_FALLBACK_SOURCES_MAX),
  /** Blank, and not asked for, while there is no fallback. */
  fallbackCondition: z.string(),
  longDelayDays: marketLongDelayDaysSchema.nullable(),
  delayHandling: z.string(),
});
export type MarketRuleItems = z.infer<typeof marketRuleItemsSchema>;

/**
 * Whether a source is filled in: a name and an address, neither blank (ADR-0093 decision 3 '#23 출처
 * 주소': «비면 개설 항목을 채우지 못한 것이다»).
 */
export function isCompleteSource(source: MarketSource): boolean {
  return source.name.trim() !== '' && source.url.trim() !== '';
}

function isBlank(text: string | null): boolean {
  return text === null || text.trim() === '';
}

/** When each rule item counts as missing (#23). */
const MISSING: { readonly [K in RuleItem]: (items: MarketRuleItems) => boolean } = {
  description: (items) => isBlank(items.description),
  yesCondition: (items) => isBlank(items.yesCondition),
  noCondition: (items) => isBlank(items.noCondition),
  eventDeadline: (items) => items.eventDeadline === null,
  primarySource: (items) => items.primarySource === null || !isCompleteSource(items.primarySource),
  // No fallback is fine ('없음'); a listed one must be complete.
  fallbackSources: (items) => !items.fallbackSources.every(isCompleteSource),
  // Asked for only while there is a fallback to switch to.
  fallbackCondition: (items) =>
    items.fallbackSources.length > 0 && isBlank(items.fallbackCondition),
  longDelayDays: (items) => items.longDelayDays === null,
  delayHandling: (items) => isBlank(items.delayHandling),
};

/**
 * The rule items `items` misses, in RULE_ITEMS order — the open-items check's share (#23): a blank
 * or null text, no event deadline, no primary source or one with a blank name or address, a listed
 * fallback with either blank, no switch condition while there is a fallback, and no long-delay
 * deadline. An empty fallback list is no missing item.
 */
export function missingRuleItems(items: MarketRuleItems): RuleItem[] {
  return RULE_ITEMS.filter((item) => MISSING[item](items));
}

function sameText(a: string | null, b: string | null): boolean {
  return (a ?? '').trim() === (b ?? '').trim();
}

function sameSource(a: MarketSource | null, b: MarketSource | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.url === b.url;
}

/** When two values of each rule item say the same. */
const SAME: {
  readonly [K in RuleItem]: (a: MarketRuleItems[K], b: MarketRuleItems[K]) => boolean;
} = {
  description: sameText,
  yesCondition: sameText,
  noCondition: sameText,
  // Instants, not strings: '…00Z' and '…00.000Z' are the same moment.
  eventDeadline: (a, b) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b)),
  primarySource: sameSource,
  fallbackSources: (a, b) =>
    a.length === b.length && a.every((source, index) => sameSource(source, b[index] ?? null)),
  fallbackCondition: sameText,
  longDelayDays: (a, b) => a === b,
  delayHandling: sameText,
};

function sameItem<K extends RuleItem>(item: K, before: MarketRuleItems, after: MarketRuleItems) {
  return SAME[item](before[item], after[item]);
}

/**
 * The rule items whose value an edit changed, in RULE_ITEMS order (#23): a text by its trimmed
 * value, null and blank alike; the event deadline by its instant; the sources by name and address,
 * in order, so a reordered fallback list is a change. The `rules_edited` event lists them, and
 * #80's versions can.
 */
export function changedRuleItems(before: MarketRuleItems, after: MarketRuleItems): RuleItem[] {
  return RULE_ITEMS.filter((item) => !sameItem(item, before, after));
}

/**
 * The payload of a `rules_edited` market event (#23, ADR-0097): the items an edit changed
 * (`changedRuleItems`) and each one's value before and after it — a source as `{name, url}`, the
 * fallbacks as their ordered list, the event deadline as an ISO instant or null. Rows written
 * before #23 carry `{before, after}` as the old rules text instead.
 */
export interface RulesEditedPayload {
  items: RuleItem[];
  before: Partial<MarketRuleItems>;
  after: Partial<MarketRuleItems>;
}

function pickRuleItems(values: MarketRuleItems, items: readonly RuleItem[]) {
  return Object.fromEntries(items.map((item) => [item, values[item]])) as Partial<MarketRuleItems>;
}

/** The `rules_edited` payload of an edit from `before` to `after`; null when no item changed. */
export function rulesEditedPayload(
  before: MarketRuleItems,
  after: MarketRuleItems,
): RulesEditedPayload | null {
  const items = changedRuleItems(before, after);
  if (items.length === 0) return null;
  return { items, before: pickRuleItems(before, items), after: pickRuleItems(after, items) };
}
