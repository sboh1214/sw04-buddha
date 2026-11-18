import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC } from '@/test/screen-text';

/**
 * The history's market filter (#124, ADR-0143 결정 6) is the shared `MarketFilterBar` since #69
 * (ADR-0144 결정 2-9; its rules are pinned in app/my/market-filter.test.ts). The screen needs the
 * app router, which this node-only runner does not mount, so what the move must keep is read off
 * the source: the same test ids and words, the period first on the line, and a change that writes
 * the address with the other filters kept.
 */
describe('HistoryScreen market control', () => {
  const source = readFileSync(path.join(SRC, 'app/my/history/history-screen.tsx'), 'utf8');

  it('keeps the test ids, the words and the order of #124', () => {
    expect(source).toContain('testIdPrefix="history-market"');
    expect(source).toContain('rowTestId="history-filters"');
    expect(source).toContain('prompt={copy.historyMarketPickerPrompt}');
    const bar = source.slice(source.indexOf('<MarketFilterBar'));
    expect(bar.indexOf('<PeriodSelect')).toBeLessThan(bar.indexOf('</MarketFilterBar>'));
    expect(bar).toContain('testId="history-period"');
  });

  it('writes the market picked or let go into the address, the kind and period kept', () => {
    expect(source).toContain('onChange={(market) => go({ ...filters, market })}');
    expect(source).toMatch(/router\.push\(myHistoryPath\(next\) as Route\)/);
    // No second copy of the control: the bar is the only one.
    expect(source).not.toContain('<MarketPicker');
    expect(source).not.toContain('setPicking');
  });
});
