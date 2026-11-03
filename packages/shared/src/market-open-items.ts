import * as z from 'zod';
import { type MarketRuleItems, RULE_ITEMS, missingRuleItems } from './market-rules.js';
import {
  type MarketTimes,
  REQUIRED_TIME_ITEMS,
  TIME_ORDER_RULES,
  type TimeRuleViolation,
  missingTimeItems,
  timeRuleViolations,
} from './market-times.js';
import { MARKET_TAGS_MAX, MARKET_TAGS_MIN } from './tags.js';

/**
 * The open-items check's two relation items (#22, ADR-0098): not fields but how the market's
 * times stand to each other, named as #78's checklist lines '시각 순서' and '선행 마감' (ADR-0093
 * decision 2 #172 item 4).
 */
export const TIME_RELATION_ITEMS = ['timeOrder', 'leadClose'] as const;
export type TimeRelationItem = (typeof TIME_RELATION_ITEMS)[number];

/**
 * 개설 항목 검사 (#17): what a market must have before it may leave the draft — N03 §2's required
 * items, as far as the market stores them. Today the interim open (draft → open, until #78 and
 * #21) refuses a market missing any with OPEN_ITEMS_MISSING; #78's review submission takes the
 * same check unchanged.
 *
 * - `title`: not blank. The API never stores a blank one; it is listed so the check is N03 §2's
 *   list (#23 AC 2).
 * - The rule items (`RULE_ITEMS`, #23, ADR-0097), each as `missingRuleItems` counts it: 배경, the
 *   YES and NO conditions, the event deadline, a complete primary source, complete fallbacks
 *   (none is fine), the switch condition while there is a fallback, the long-delay deadline and
 *   the delay handling.
 * - The required time items (`REQUIRED_TIME_ITEMS`, #22, ADR-0098), each missing while null: the
 *   scheduled open, the close — listed, never missing, as the title — the scheduled judgement and
 *   the judgement time zone. The announcement is optional ('없음', #172 item 13).
 * - `timeOrder` 시각 순서: the order rules hold (`TIME_ORDER_RULES`: scheduled open < close ≤
 *   scheduled judgement, 사건 기한 ≤ scheduled judgement, in whole minutes). The database holds them
 *   too, so a stored market never fails it; it is listed so #78 and the admin form share the check.
 * - `leadClose` 선행 마감: with an announcement, the close leads it by the release setting
 *   `market.lead_close_gap` (`leadCloseGapMinutes`). While the setting is undecided a market with
 *   an announcement fails it, so it cannot open (ADR-0098); one with '없음' passes.
 * - `category`: one a new market may be filed under (`categorySelectable`): active, under an active
 *   parent, and a leaf — a sub-category, or a top-level category with no active sub-category
 *   (ADR-0093 decision 2 #172 item 1). `markets.category_id` is never null, so a market always has
 *   one; the check fails one whose category was hidden, or got sub-categories, after it was picked.
 * - `tags`: MARKET_TAGS_MIN..MARKET_TAGS_MAX of them (#172 item 2); entry already refuses more.
 *
 * The order is the form's, which is the order a refusal names them in; each relation item comes
 * after the time items it relates.
 */
export const OPEN_ITEMS = [
  'title',
  ...RULE_ITEMS,
  ...REQUIRED_TIME_ITEMS,
  ...TIME_RELATION_ITEMS,
  'category',
  'tags',
] as const;
export type OpenItem = (typeof OPEN_ITEMS)[number];
export const openItemSchema = z.enum(OPEN_ITEMS).meta({ id: 'OpenItem' });

export type OpenItemsInput = MarketRuleItems &
  MarketTimes & {
    title: string;
    /** 거래 마감 시각, an ISO instant. */
    closeAt: string;
    /** Whether the market's category is one a new market may be filed under (above). */
    categorySelectable: boolean;
    tagCount: number;
    /**
     * The 선행 마감 gap in minutes the check holds the market to: the one its lead close was last
     * checked against (`markets.lead_close_gap_minutes`), else the release setting's reading; null
     * while the setting is undecided and the market has none (`AdminMarket.leadCloseGapMinutes`).
     */
    leadCloseGapMinutes: number | null;
  };

/** The items `input` misses, in OPEN_ITEMS order; empty when the market may leave the draft. */
export function missingOpenItems(input: OpenItemsInput): OpenItem[] {
  const missing: OpenItem[] = [];
  if (input.title.trim() === '') missing.push('title');
  missing.push(...missingRuleItems(input));
  missing.push(...missingTimeItems(input));
  const violations = timeRuleViolations(input, input.leadCloseGapMinutes);
  for (const item of TIME_RELATION_ITEMS) {
    if (violations.some((violation) => relationOf(violation) === item)) missing.push(item);
  }
  if (!input.categorySelectable) missing.push('category');
  if (input.tagCount < MARKET_TAGS_MIN || input.tagCount > MARKET_TAGS_MAX) missing.push('tags');
  return missing;
}

/** The relation item a broken time rule fails: an order rule `timeOrder`, the lead `leadClose`. */
function relationOf(violation: TimeRuleViolation): TimeRelationItem {
  return (TIME_ORDER_RULES as readonly string[]).includes(violation.rule)
    ? 'timeOrder'
    : 'leadClose';
}

/**
 * The OPEN_ITEMS_MISSING detail message of a relation item, from the market's broken time rules
 * (`timeRuleViolations` with the gap the check used): for `timeOrder` the broken order rules,
 * joined by ', ' in TIME_RULES order (`closeByJudgement, deadlineByJudgement`); for `leadClose`
 * 'leadClose', or LEAD_CLOSE_GAP_UNDECIDED ('gap undecided') while the gap is undecided.
 */
export function timeRelationMessage(
  item: TimeRelationItem,
  violations: readonly TimeRuleViolation[],
): string {
  const broken = violations.filter((violation) => relationOf(violation) === item);
  if (item === 'timeOrder') return broken.map((violation) => violation.rule).join(', ');
  return broken[0]?.reason ?? 'leadClose';
}

/**
 * What a category needs to be picked for a new market, or why it cannot be (#172 item 1): the API
 * refuses a market create or category change naming `categoryId` with this as the message, and
 * the open-items check counts it as missing. `subcategories`: a top-level category that has an
 * active sub-category holds no new market — its markets go on the sub-category.
 */
export const CATEGORY_UNSELECTABLE_REASONS = [
  'inactive',
  'parent_inactive',
  'subcategories',
] as const;
export type CategoryUnselectableReason = (typeof CATEGORY_UNSELECTABLE_REASONS)[number];

export interface CategorySelectabilityInput {
  isActive: boolean;
  /** The parent's `is_active`; null for a top-level category. */
  parentActive: boolean | null;
  /** How many active sub-categories it has (always 0 for a sub-category). */
  activeChildCount: number;
}

export function categoryUnselectableReason(
  category: CategorySelectabilityInput,
): CategoryUnselectableReason | null {
  if (!category.isActive) return 'inactive';
  if (category.parentActive === false) return 'parent_inactive';
  if (category.activeChildCount > 0) return 'subcategories';
  return null;
}
