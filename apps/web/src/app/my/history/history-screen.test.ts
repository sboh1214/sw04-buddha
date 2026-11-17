import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC } from '@/test/screen-text';

/**
 * The market filter's control (#124, ADR-0143 결정 6): the screen needs the app router, which this
 * node-only runner does not mount, so the wiring is read off the source. What it pins: the picker
 * closes whichever way a market got set, and after a pick or a clear made on this screen the
 * control that replaced the removed one takes focus (it would fall to the page otherwise).
 */
describe('HistoryScreen market control', () => {
  const source = readFileSync(path.join(SRC, 'app/my/history/history-screen.tsx'), 'utf8');

  it('closes the picker whenever a market is set, not only when it is picked here', () => {
    // During render, before any branch: a row link, Back or Forward set the market too, and the
    // screen is not mounted again for a new address.
    expect(source).toContain('if (picking && filters.market !== undefined) setPicking(false);');
    expect(
      source.indexOf('if (picking && filters.market !== undefined) setPicking(false);'),
    ).toBeLessThan(source.indexOf('if (ended) return <SessionEnded />;'));
  });

  it('focuses the control that replaced the removed one, only after a change made here', () => {
    expect(source).toMatch(/<Button\s+ref=\{pickRef\}/);
    expect(source).toMatch(/<CloseButton\s+ref=\{clearRef\}/);
    // The clear asks for the pick button, the pick for the clear button, each before its push.
    expect(source).toMatch(
      /focusAfter\.current = 'pick';\s*go\(\{ \.\.\.filters, market: undefined \}\);/,
    );
    expect(source).toMatch(
      /setPicking\(false\);\s*pickRef\.current\?\.focus\(\);\s*focusAfter\.current = 'clear';\s*go\(\{ \.\.\.filters, market: market\.id \}\);/,
    );
    // Run once the new address has rendered, and only for the target asked for: a plain load or a
    // link leaves `focusAfter` null and moves nothing; a stale request is dropped.
    const effect = source.slice(source.indexOf('useEffect(() => {'));
    expect(effect).toMatch(
      /const target = focusAfter\.current;\s*focusAfter\.current = null;\s*if \(target === wanted\)/,
    );
    expect(effect).toMatch(/\}, \[filters\.market\]\);/);
    expect(source.match(/focusAfter\.current = '(pick|clear)'/g)).toHaveLength(2);
  });
});
