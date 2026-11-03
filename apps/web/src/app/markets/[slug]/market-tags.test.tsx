import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { tagSearchPath } from '@/lib/market-search';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketTags } from './market-tags';

/**
 * The detail's tags as drawn (#17, ADR-0093 decision 2 #172 item 2): a '#이름' chip per tag in the
 * order entered, each a link to that tag's search, and nothing for a market without tags. The
 * search a chip opens is `tagSearchPath`'s (lib/market-search.test.ts); the e2e
 * (market-tags.spec.ts) follows one to the market's card.
 */
describe('MarketTags', () => {
  it("draws '#이름' chips in entry order, each linking to its tag's search", () => {
    const tags = ['서울', 'CPI', '한국 영화'];
    const html = renderWithQueries(<MarketTags tags={tags} />);
    const list = byTestId(html, 'market-tags');
    expect(list?.attributes['aria-label']).toBe(copy.marketTags);
    expect(testIdsStartingWith(html, 'market-tag-')).toEqual([
      'market-tag-0',
      'market-tag-1',
      'market-tag-2',
    ]);
    for (const [index, name] of tags.entries()) {
      const link = byTestId(html, `market-tag-${String(index)}`);
      // The '#' is drawn, never part of the name the link searches for.
      expect(link?.text, name).toBe(`#${name}`);
      expect(link?.attributes.href, name).toBe(tagSearchPath(name));
    }
    // Links, one per tag, inside list items: nothing else is focusable.
    expect(byTagName(html, 'a')).toHaveLength(tags.length);
    expect(byTagName(html, 'li')).toHaveLength(tags.length);
  });

  it('draws nothing for a market without tags', () => {
    expect(renderWithQueries(<MarketTags tags={[]} />)).toBe('');
  });
});
