import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { ThemeSummary } from '@/lib/api';
import { HOME_THEMES_KEY } from '@/lib/themes';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { HomeThemes } from './home-themes';

/**
 * The explore home's theme row as drawn (owner decision 2026-10-19, second round, ADR-0088): the
 * ongoing themes, else the upcoming ones, under a heading that says which, and 모든 테마 whenever a
 * theme is public — so the list page stays a click away while every theme has ended. `homeThemesRow`
 * (lib/themes.test.ts) picks the cards; these check what the row makes of its pick. The e2e sees
 * the ongoing row alone: the e2e database's other themes are not its to choose.
 */
describe('HomeThemes', () => {
  const theme = (id: string, status: ThemeSummary['status']): ThemeSummary => ({
    id,
    slug: `theme-${id}`,
    name: `테마 ${id}`,
    startDate: '2026-10-20',
    endDate: '2026-11-03',
    status,
  });

  /** The row drawn out of the home's one page, as the server seeds it. */
  const row = (page: ThemeSummary[]) =>
    renderWithQueries(<HomeThemes />, [[HOME_THEMES_KEY, page]]);

  /** The cards drawn, by their testid (each card's period carries one of its own). */
  const cards = (html: string) =>
    testIdsStartingWith(html, 'theme-card-').filter((id) => !id.startsWith('theme-card-period-'));

  /** The row's own heading (the cards' names are `h3`). */
  const heading = (html: string) => byTagName(html, 'h2').map((element) => element.text);

  const expectAllThemesLink = (html: string) => {
    const link = byTestId(html, 'home-themes-all');
    expect(link?.attributes.href).toBe('/themes');
    expect(link?.text).toBe(copy.homeThemesAll);
  };

  it('draws the ongoing themes under 진행 중인 테마, no upcoming or ended one beside them, and 모든 테마', () => {
    const html = row([
      theme('a', 'ongoing'),
      theme('b', 'ongoing'),
      theme('c', 'upcoming'),
      theme('d', 'ended'),
    ]);
    expect(heading(html)).toEqual([copy.homeThemesOngoing]);
    expect(cards(html)).toEqual(['theme-card-a', 'theme-card-b']);
    expect(byTestId(html, 'home-themes-none')).toBeUndefined();
    expectAllThemesLink(html);
  });

  it('draws the upcoming themes under 예정된 테마 when none is ongoing, and 모든 테마', () => {
    const html = row([theme('a', 'upcoming'), theme('b', 'upcoming'), theme('c', 'ended')]);
    expect(heading(html)).toEqual([copy.homeThemesUpcoming]);
    expect(cards(html)).toEqual(['theme-card-a', 'theme-card-b']);
    expect(byTestId(html, 'home-themes-none')).toBeUndefined();
    expectAllThemesLink(html);
  });

  it('keeps the row while every public theme has ended: its heading, no card, the line that none is on or coming, and 모든 테마', () => {
    const html = row([theme('a', 'ended'), theme('b', 'ended')]);
    expect(byTestId(html, 'home-themes')).toBeDefined();
    expect(heading(html)).toEqual([copy.homeThemesNone]);
    expect(cards(html)).toEqual([]);
    expect(byTestId(html, 'home-themes-none')?.text).toBe(copy.homeThemesNoneBody);
    expectAllThemesLink(html);
  });

  it('draws nothing when no theme is public, nor while the row is unknown', () => {
    expect(row([])).toBe('');
    expect(renderWithQueries(<HomeThemes />)).toBe('');
  });
});
