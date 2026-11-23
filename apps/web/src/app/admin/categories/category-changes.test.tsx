import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ADMIN_CATEGORY_CHANGES_KEY } from '@/hooks/use-admin-categories';
import { type AdminCategoryChange } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { CategoryChanges } from './category-changes';

const pages = (items: AdminCategoryChange[], nextCursor: string | null = null) => ({
  pages: [{ items, nextCursor }],
  pageParams: [undefined],
});

const RENAME = 'a1b2c3d4-0000-4000-8000-000000000002';
const REORDER = 'a1b2c3d4-0000-4000-8000-000000000001';
const CHANGES: AdminCategoryChange[] = [
  {
    id: RENAME,
    type: 'category_rename',
    at: '2026-11-21T03:00:00.000Z',
    actor: { id: 'admin-1', nickname: '운영자1' },
    category: { id: 5, nameKo: '물가 지표' },
    details: { before: '물가', after: '물가 지표' },
  },
  {
    id: REORDER,
    type: 'category_reorder',
    at: '2026-11-20T03:00:00.000Z',
    actor: { id: 'admin-2', nickname: null },
    category: null,
    details: {
      parent: null,
      before: [
        { id: 1, nameKo: '경제' },
        { id: 2, nameKo: '정치' },
      ],
      after: [
        { id: 2, nameKo: '정치' },
        { id: 1, nameKo: '경제' },
      ],
    },
  },
];

/** 변경 기록 as drawn under the category tree (#145 part 2, ADR-0164; 145-10). */
describe('CategoryChanges', () => {
  it('draws each record newest first with its time, name, category, admin and values', () => {
    const html = renderWithQueries(<CategoryChanges />, [
      [ADMIN_CATEGORY_CHANGES_KEY, pages(CHANGES, 'next')],
    ]);
    const section = byTestId(html, 'category-changes');
    expect(section?.text).toContain('변경 기록');
    expect(byTestId(html, 'category-changes-intro')?.text).toBe(copy.adminCategoryChangesHint);
    const header = byTestId(html, 'category-changes-list')?.text ?? '';
    for (const column of ['시각', '작업', '카테고리', '담당자', '전후 값']) {
      expect(header).toContain(column);
    }
    expect(
      testIdsStartingWith(html, 'category-change-').filter((id) => /-[0-9a-f-]{36}$/.test(id)),
    ).toEqual([`category-change-${RENAME}`, `category-change-${REORDER}`]);
    const part = (id: string, name: string) => byTestId(html, `category-change-${id}-${name}`);
    expect(byTestId(html, `category-change-${RENAME}`)?.attributes['data-type']).toBe(
      'category_rename',
    );
    expect(part(RENAME, 'at')?.text).toBe(formatKst('2026-11-21T03:00:00.000Z'));
    expect(part(RENAME, 'type')?.text).toBe('이름 바꾸기');
    expect(part(RENAME, 'category')?.text).toBe('물가 지표');
    expect(part(RENAME, 'actor')?.text).toBe('운영자1');
    expect(part(RENAME, 'values')?.text).toBe('물가 → 물가 지표');
    expect(part(REORDER, 'type')?.text).toBe('순서 바꾸기');
    expect(part(REORDER, 'category')?.text).toBe(copy.adminCategoryChangeTopLevel);
    expect(part(REORDER, 'actor')?.text).toBe(copy.postAuthorFormer);
    expect(part(REORDER, 'values')?.text).toBe('경제 · 정치 → 정치 · 경제');
    expect(byTestId(html, 'category-changes-more')?.text).toBe(copy.loadMore);
  });

  it('says so when there is no record', () => {
    const html = renderWithQueries(<CategoryChanges />, [[ADMIN_CATEGORY_CHANGES_KEY, pages([])]]);
    expect(byTestId(html, 'category-changes-empty')?.text).toBe(copy.adminCategoryChangesEmpty);
  });
});
