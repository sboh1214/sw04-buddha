import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { ThemeSummary } from '@/lib/api';
import { marketThemesKey, themeLinkLabel, themePath } from '@/lib/themes';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketThemes } from './market-themes';

const MARKET_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/**
 * A market detail's links to the themes it is in, as drawn (owner decision 2026-10-19, second
 * round, ADR-0088): every published theme the API names — an ended one too — each saying its
 * status after its name, `노벨상 주간 · 종료`. The API's own test sees the ended theme come back
 * (themes.controller.test.ts) and `themeLinkLabel` is unit-tested (lib/themes.test.ts); these see
 * the detail draw them. The e2e sees the ongoing link of its own theme.
 */
describe('MarketThemes', () => {
  const theme = (id: string, status: ThemeSummary['status']): ThemeSummary => ({
    id,
    slug: `theme-${id}`,
    name: `테마 ${id}`,
    startDate: '2026-10-20',
    endDate: '2026-11-03',
    status,
  });

  /** The links drawn for the market's themes, as the server seeds them. */
  const links = (rows: ThemeSummary[]) =>
    renderWithQueries(<MarketThemes marketId={MARKET_ID} />, [[marketThemesKey(MARKET_ID), rows]]);

  it("links every theme the market is in, the ended one too, each named '이름 · 상태' with the status drawn after the name", () => {
    const rows = [theme('a', 'ongoing'), theme('b', 'upcoming'), theme('c', 'ended')];
    const html = links(rows);
    expect(byTestId(html, 'market-themes')?.text.startsWith(copy.marketThemes)).toBe(true);
    // In the API's order, one link each: the ended theme is not left out.
    expect(
      testIdsStartingWith(html, 'market-theme-').filter((id) => /^market-theme-[a-z]$/.test(id)),
    ).toEqual(['market-theme-a', 'market-theme-b', 'market-theme-c']);
    const statusOf = {
      a: copy.themeStatusOngoing,
      b: copy.themeStatusUpcoming,
      c: copy.themeStatusEnded,
    };
    for (const row of rows) {
      const link = byTestId(html, `market-theme-${row.id}`);
      expect(link?.attributes.href, row.id).toBe(themePath(row.slug));
      expect(link?.attributes['aria-label'], row.id).toBe(themeLinkLabel(row));
      expect(link?.attributes['aria-label'], row.id).toBe(
        `${row.name} · ${statusOf[row.id as keyof typeof statusOf]}`,
      );
      expect(byTestId(html, `market-theme-name-${row.id}`)?.text, row.id).toBe(row.name);
      expect(byTestId(html, `market-theme-status-${row.id}`)?.text, row.id).toBe(
        `· ${statusOf[row.id as keyof typeof statusOf]}`,
      );
    }
  });

  it('draws nothing when the market is in no published theme, nor while its themes are unknown', () => {
    expect(links([])).toBe('');
    expect(renderWithQueries(<MarketThemes marketId={MARKET_ID} />)).toBe('');
  });
});
