import * as z from 'zod';
import { type MarketRuleItems, RULE_ITEMS, changedRuleItems } from './market-rules.js';
import { type MarketTimes, type TimeItem, sameTimeItem } from './market-times.js';

/** The time items `rules_edited` counts beside the rule items, in TIME_ITEMS order. */
const EDITED_TIME_ITEMS = [
  'scheduledAnnouncementAt',
  'judgementTimeZone',
] as const satisfies readonly TimeItem[];
type EditedTimeItem = (typeof EDITED_TIME_ITEMS)[number];

/**
 * What the `rules_edited` market event counts (#23, #22, ADR-0098): the rule items (`RULE_ITEMS`)
 * and the two time items that are 판정 항목 of ADR-0093 decision 2 #172 item 7 — the announcement
 * time and the judgement time zone — in the form's order. The scheduled open, the close and the
 * scheduled judgement are times of the market, as its title is a version item: an edit of them is
 * in `market_update`'s before and after, not here. The list spans market-rules.ts and
 * market-times.ts, and the second imports the first, so it lives in a module of its own. Since
 * #80 the event is a draft's: after the open every version item (`RULE_VERSION_ITEMS`, a superset)
 * changes by a supplement, whose `rules_supplemented` event names them.
 */
export const RULES_EDITED_ITEMS = [...RULE_ITEMS, ...EDITED_TIME_ITEMS] as const;
export type RulesEditedItem = (typeof RULES_EDITED_ITEMS)[number];
export const rulesEditedItemSchema = z.enum(RULES_EDITED_ITEMS);

/** The values `rules_edited` compares: the rule items and its two time items. */
export type RulesEditedValues = MarketRuleItems & Pick<MarketTimes, EditedTimeItem>;

/**
 * The items of RULES_EDITED_ITEMS whose value an edit changed, in that order: the rule items as
 * `changedRuleItems` compares them, the announcement by its instant and the zone by its name.
 */
export function changedRulesEditedItems(
  before: RulesEditedValues,
  after: RulesEditedValues,
): RulesEditedItem[] {
  return [
    ...changedRuleItems(before, after),
    ...EDITED_TIME_ITEMS.filter((item) => !sameTimeItem(item, before[item], after[item])),
  ];
}

/**
 * The payload of a `rules_edited` market event (#23, #22, ADR-0097, ADR-0098): the items an edit
 * changed (`changedRulesEditedItems`) and each one's value before and after it — a source as
 * `{name, url}`, the fallbacks as their ordered list, the event deadline and the announcement as an
 * ISO instant or null, the zone as its name or null. Rows written before #23 carry `{before,
 * after}` as the old rules text instead, and rows before #22 name rule items only.
 */
export interface RulesEditedPayload {
  items: RulesEditedItem[];
  before: Partial<RulesEditedValues>;
  after: Partial<RulesEditedValues>;
}

function pickItems(values: RulesEditedValues, items: readonly RulesEditedItem[]) {
  return Object.fromEntries(
    items.map((item) => [item, values[item]]),
  ) as Partial<RulesEditedValues>;
}

/** The `rules_edited` payload of an edit from `before` to `after`; null when no item changed. */
export function rulesEditedPayload(
  before: RulesEditedValues,
  after: RulesEditedValues,
): RulesEditedPayload | null {
  const items = changedRulesEditedItems(before, after);
  if (items.length === 0) return null;
  return { items, before: pickItems(before, items), after: pickItems(after, items) };
}
