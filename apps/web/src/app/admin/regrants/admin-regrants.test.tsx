import { findExcludedText } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ADMIN_REGRANTS_KEY, type AdminRegrantPage } from '@/hooks/use-admin-regrants';
import { type AdminRegrant } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { adminUserModerationPath } from '@/lib/moderation';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminRegrants } from './admin-regrants';

const FIRST = '0b8a3c5e-2f4d-4e6a-9b1c-3d5e7f9a1b2c';
const SECOND = '1c9b4d6f-3a5e-4f7b-8c2d-4e6f8a0b2c3d';

const row = (id: string, fields: Partial<AdminRegrant> = {}): AdminRegrant => ({
  id,
  account: { userId: 'member-a', publicId: 'a1b2c3d4e5', nickname: '받은이' },
  amountCoin: '50000',
  availableBeforeCoin: '990000',
  createdAt: '2026-11-21T03:00:00.000Z',
  ...fields,
});

/** The list as the server answered it, page by page. */
const drawn = (pages: AdminRegrantPage[]) =>
  renderWithQueries(<AdminRegrants />, [
    [
      ADMIN_REGRANTS_KEY,
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 재지급 기록 as drawn (#74, ADR-0155; owner answer 2026-11-21 3: the admin screen only reads the
 * records): one row per re-grant in the order answered (newest first, regrant.controller.test.ts),
 * the account to its member page, the time in Seoul, the Coin given and the 가용 코인 before it.
 */
describe('AdminRegrants', () => {
  it('draws one row per re-grant in the order answered, the account to its member page', () => {
    const later = row(FIRST, { createdAt: '2026-11-21T05:00:00.000Z' });
    const html = drawn([{ items: [later, row(SECOND)], nextCursor: null }]);
    expect(
      testIdsStartingWith(html, 'admin-regrant-').filter((id) =>
        /^admin-regrant-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([`admin-regrant-${FIRST}`, `admin-regrant-${SECOND}`]);
    const first = byTestId(html, `admin-regrant-${FIRST}`)?.text ?? '';
    expect(first).toContain('받은이');
    expect(first).toContain('a1b2c3d4e5');
    expect(first).toContain(formatKst(later.createdAt));
    expect(first).toContain(`${copy.adminRegrantAmount} 50,000 Coin`);
    expect(first).toContain(`${copy.adminRegrantAvailableBefore} 990,000 Coin`);
    expect(byTestId(html, 'admin-regrant-account')?.attributes.href).toBe(
      adminUserModerationPath('member-a'),
    );
    // The values are the release settings': the way there, and nothing that gives or takes Coin.
    expect(byTestId(html, 'admin-regrants-settings-link')?.attributes.href).toBe('/admin/settings');
    expect(html).not.toContain('<button');
  });

  it("names a closed account '탈퇴한 사용자' and keeps its record (#140)", () => {
    const html = drawn([
      {
        items: [
          row(FIRST, { account: { userId: 'gone', publicId: 'z9y8x7w6v5', nickname: null } }),
        ],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, 'admin-regrant-account')?.text).toBe(copy.postAuthorFormer);
  });

  it('says there is none on an empty list, and offers 더 보기 while a page follows', () => {
    expect(byTestId(drawn([{ items: [], nextCursor: null }]), 'admin-regrants-empty')?.text).toBe(
      copy.adminRegrantsEmpty,
    );
    const more = drawn([{ items: [row(FIRST)], nextCursor: 'c1' }]);
    expect(byTestId(more, 'admin-regrants-more')?.text).toBe(copy.loadMore);
  });

  it('holds its own words to the gambling words, as every admin screen', () => {
    for (const text of [
      copy.adminRegrants,
      copy.adminRegrantsIntro,
      copy.adminRegrantsSettingsNotice,
      copy.adminRegrantsEmpty,
      copy.adminRegrantAmount,
      copy.adminRegrantAvailableBefore,
    ]) {
      expect(findExcludedText(text), text).toEqual([]);
    }
  });
});
