import { describe, expect, it } from 'vitest';
import {
  OPEN_ITEMS,
  categoryUnselectableReason,
  missingOpenItems,
  openItemSchema,
} from './market-open-items.js';

describe('missingOpenItems (#17)', () => {
  const ready = { rules: '종가 기준', categorySelectable: true, tagCount: 1 };

  it('finds nothing missing on a market with rules, a selectable category and 1..5 tags', () => {
    expect(missingOpenItems(ready)).toEqual([]);
    expect(missingOpenItems({ ...ready, tagCount: 5 })).toEqual([]);
  });

  it('names every missing item in OPEN_ITEMS order', () => {
    expect(missingOpenItems({ rules: '  ', categorySelectable: false, tagCount: 0 })).toEqual([
      ...OPEN_ITEMS,
    ]);
    expect(missingOpenItems({ ...ready, tagCount: 0 })).toEqual(['tags']);
    expect(missingOpenItems({ ...ready, tagCount: 6 })).toEqual(['tags']);
    expect(missingOpenItems({ ...ready, categorySelectable: false })).toEqual(['category']);
    expect(missingOpenItems({ ...ready, rules: '' })).toEqual(['rules']);
  });

  it('keeps the item list a closed enum', () => {
    expect(openItemSchema.options).toEqual(['rules', 'category', 'tags']);
  });
});

describe('categoryUnselectableReason (#172 item 1)', () => {
  it('lets a new market go on an active leaf under an active parent, or an active childless top level', () => {
    expect(
      categoryUnselectableReason({ isActive: true, parentActive: true, activeChildCount: 0 }),
    ).toBeNull();
    expect(
      categoryUnselectableReason({ isActive: true, parentActive: null, activeChildCount: 0 }),
    ).toBeNull();
  });

  it('says why one cannot be picked, its own state first', () => {
    expect(
      categoryUnselectableReason({ isActive: false, parentActive: false, activeChildCount: 0 }),
    ).toBe('inactive');
    expect(
      categoryUnselectableReason({ isActive: true, parentActive: false, activeChildCount: 0 }),
    ).toBe('parent_inactive');
    expect(
      categoryUnselectableReason({ isActive: true, parentActive: null, activeChildCount: 2 }),
    ).toBe('subcategories');
  });
});
