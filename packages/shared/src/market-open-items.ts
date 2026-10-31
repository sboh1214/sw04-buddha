import * as z from 'zod';
import { MARKET_TAGS_MAX, MARKET_TAGS_MIN } from './tags.js';

/**
 * 개설 항목 검사 (#17): what a market must have before it may leave the draft — N03 §2's required
 * items, as far as the market stores them. Today the interim open (draft → open, until #78 and
 * #21) refuses a market missing any with OPEN_ITEMS_MISSING; #78's review submission takes the
 * same check, and #23 (rule items) and #22 (times) add theirs to this list.
 *
 * - `rules`: not blank (PLAN 0.2 — a market trades against its rules).
 * - `category`: one a new market may be filed under (`categorySelectable`): active, under an active
 *   parent, and a leaf — a sub-category, or a top-level category with no active sub-category
 *   (ADR-0093 decision 2 #172 item 1). `markets.category_id` is never null, so a market always has
 *   one; the check fails one whose category was hidden, or got sub-categories, after it was picked.
 * - `tags`: MARKET_TAGS_MIN..MARKET_TAGS_MAX of them (#172 item 2); entry already refuses more.
 *
 * The order is the form's, which is the order a refusal names them in.
 */
export const OPEN_ITEMS = ['rules', 'category', 'tags'] as const;
export type OpenItem = (typeof OPEN_ITEMS)[number];
export const openItemSchema = z.enum(OPEN_ITEMS).meta({ id: 'OpenItem' });

export interface OpenItemsInput {
  rules: string;
  /** Whether the market's category is one a new market may be filed under (above). */
  categorySelectable: boolean;
  tagCount: number;
}

/** The items `input` misses, in OPEN_ITEMS order; empty when the market may leave the draft. */
export function missingOpenItems(input: OpenItemsInput): OpenItem[] {
  const missing: OpenItem[] = [];
  if (input.rules.trim() === '') missing.push('rules');
  if (!input.categorySelectable) missing.push('category');
  if (input.tagCount < MARKET_TAGS_MIN || input.tagCount > MARKET_TAGS_MAX) missing.push('tags');
  return missing;
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
