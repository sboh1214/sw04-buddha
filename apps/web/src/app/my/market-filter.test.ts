import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC } from '@/test/screen-text';

/**
 * MY's market filter (#124's, ADR-0143 결정 6; shared since #69, ADR-0144 결정 2-9): the control
 * needs the app router's screens around it, which this node-only runner does not mount, so the
 * wiring is read off the source. What it pins — moved here from the history screen's test when
 * the control left that screen: the picker closes whichever way a market got set, and after a
 * pick or a clear made on this screen the control that replaced the removed one takes focus (it
 * would fall to the page otherwise). The screen's own push is `onChange`.
 */
describe('MarketFilterBar', () => {
  const source = readFileSync(path.join(SRC, 'app/my/market-filter.tsx'), 'utf8');

  it('closes the picker whenever a market is set, not only when it is picked here', () => {
    // During render, before anything is drawn: a row link, Back or Forward set the market too,
    // and the screen is not mounted again for a new address.
    const close = 'if (picking && market !== undefined) setPicking(false);';
    expect(source).toContain(close);
    expect(source.indexOf(close)).toBeLessThan(source.indexOf('return ('));
    // The panel is drawn only while no market is set either.
    expect(source).toContain('{picking && market === undefined && (');
  });

  it('focuses the control that replaced the removed one, only after a change made here', () => {
    expect(source).toMatch(/<Button\s+ref=\{pickRef\}/);
    expect(source).toMatch(/<CloseButton\s+ref=\{clearRef\}/);
    // The clear asks for the pick button, the pick for the clear button, each before its change.
    expect(source).toMatch(/focusAfter\.current = 'pick';\s*onChange\(undefined\);/);
    expect(source).toMatch(
      /setPicking\(false\);\s*pickRef\.current\?\.focus\(\);\s*focusAfter\.current = 'clear';\s*onChange\(picked\.id\);/,
    );
    // Run once the new address has rendered, and only for the target asked for: a plain load or a
    // link leaves `focusAfter` null and moves nothing; a stale request is dropped.
    const effect = source.slice(source.indexOf('useEffect(() => {'));
    expect(effect).toMatch(
      /const target = focusAfter\.current;\s*focusAfter\.current = null;\s*if \(target === wanted\)/,
    );
    expect(effect).toMatch(/\}, \[market\]\);/);
    expect(source.match(/focusAfter\.current = '(pick|clear)'/g)).toHaveLength(2);
  });

  it("names its controls from the screen's prefix and draws the screen's filters first", () => {
    for (const control of ['pick', 'chip', 'clear', 'picker']) {
      expect(source).toContain(`\`\${testIdPrefix}-${control}\``);
    }
    expect(source).toMatch(/data-testid=\{rowTestId\}>\s*\{children\}/);
    expect(source).toContain('prompt={prompt}');
  });
});
