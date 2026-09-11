import { describe, expect, it } from 'vitest';
import { type Category } from './api';
import { CATEGORY_TRAIL_SEPARATOR, categoryBreadcrumb } from './category-label';

const category = (id: number, slug: string, nameKo: string, parentId: number | null): Category => ({
  id,
  slug,
  nameKo,
  sortOrder: id * 10,
  parentId,
});

/** The API's own order: parents first, then leaves grouped by parent (category-tree.test.ts). */
const FLAT: Category[] = [
  category(1, 'economy', '경제', null),
  category(2, 'culture', '문화', null),
  category(11, 'housing', '주택', 1),
  category(12, 'jobs', '일자리', 1),
];

describe('categoryBreadcrumb', () => {
  it('writes a leaf as its parent then itself', () => {
    expect(categoryBreadcrumb(FLAT, 'housing', '주택')).toEqual(['경제', '주택']);
    expect(categoryBreadcrumb(FLAT, 'jobs', '일자리')).toEqual(['경제', '일자리']);
  });

  it('writes a top-level slug as one part, even for a parent that has leaves', () => {
    // A parent with no active leaves may hold markets (ADR-0041), and one WITH leaves may
    // still hold one filed before its leaves existed: either way the trail is the parent alone.
    expect(categoryBreadcrumb(FLAT, 'culture', '문화')).toEqual(['문화']);
    expect(categoryBreadcrumb(FLAT, 'economy', '경제')).toEqual(['경제']);
  });

  it('falls back to the name the row carries while the list has not resolved', () => {
    expect(categoryBreadcrumb(undefined, 'housing', '주택')).toEqual(['주택']);
  });

  it('falls back to the name the row carries when the slug is not in the active list', () => {
    // A category retired since the market was made, or an empty list from an API with no rows.
    expect(categoryBreadcrumb(FLAT, 'retired', '은퇴한 분류')).toEqual(['은퇴한 분류']);
    expect(categoryBreadcrumb([], 'housing', '주택')).toEqual(['주택']);
  });

  it('takes the names from the list, not from the fallback, once the slug resolves', () => {
    // The fallback is the row's own copy of the leaf name; a renamed category shows its new
    // name as soon as the list arrives, so the two must not be confused.
    expect(categoryBreadcrumb(FLAT, 'housing', '옛 이름')).toEqual(['경제', '주택']);
  });

  it('does not lean on parents preceding their leaves in the list', () => {
    expect(categoryBreadcrumb([FLAT[2]!, FLAT[0]!], 'housing', '주택')).toEqual(['경제', '주택']);
  });
});

describe('CATEGORY_TRAIL_SEPARATOR', () => {
  it('is a spaced U+203A, so the joined trail reads as Kalshi writes it', () => {
    expect(CATEGORY_TRAIL_SEPARATOR).toBe(' › ');
    expect(categoryBreadcrumb(FLAT, 'housing', '주택').join(CATEGORY_TRAIL_SEPARATOR)).toBe(
      '경제 › 주택',
    );
  });
});
