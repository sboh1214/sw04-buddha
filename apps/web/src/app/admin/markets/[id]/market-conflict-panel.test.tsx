import { type AdminMarketConflicts } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { marketConflictsKey } from '@/hooks/use-market-conflicts';
import { byTestId, renderWithQueries } from '@/test/render';
import { MarketConflictPanel, NoConflictConfirmation } from './market-conflict-panel';

const MARKET = '00000000-0000-4000-8000-000000000001';
const clean: AdminMarketConflicts = {
  marketId: MARKET,
  operator: { userId: 'admin-a', hasFill: false, conflicted: false, declaration: null },
  declarations: [],
};
const draw = (data = clean, operator = 'admin-a') =>
  renderWithQueries(<MarketConflictPanel marketId={MARKET} />, [
    [['me'], { id: operator }],
    [marketConflictsKey(MARKET, operator), data],
  ]);
const disabled = (html: string, id: string) =>
  Object.hasOwn(byTestId(html, id)?.attributes ?? {}, 'disabled');

describe('market conflicts', () => {
  it('shows the automatic fill conflict without hiding the permanent declaration action', () => {
    const html = draw({
      ...clean,
      operator: { ...clean.operator, hasFill: true, conflicted: true },
    });
    expect(byTestId(html, 'market-conflict-status')?.text).toBe(copy.marketConflictFill);
    expect(disabled(html, 'market-conflict-declare')).toBe(false);
    expect(html).toContain(copy.marketConflictPolicy);
  });
  it('keeps the immutable reason and actor visible and prevents a second declaration', () => {
    const declaration = {
      id: '00000000-0000-4000-8000-000000000002',
      reason: '이해관계 <script>표시</script>',
      declaredAt: '2026-11-09T01:00:00.000Z',
      declaredBy: { id: 'admin-a', nickname: '운영자' },
    };
    const html = draw({
      ...clean,
      operator: { ...clean.operator, conflicted: true, declaration },
      declarations: [declaration],
    });
    expect(disabled(html, 'market-conflict-declare')).toBe(true);
    expect(html).toContain('운영자');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>표시</script>');
  });
  it('does not offer a declaration with another operator’s cached result', () => {
    expect(disabled(draw(clean, 'admin-b'), 'market-conflict-declare')).toBe(true);
  });
  it('requires a new explicit confirmation and prevents confirming a known conflict', () => {
    const html = renderWithQueries(
      <NoConflictConfirmation
        checked={false}
        onChecked={() => undefined}
        testId="conflict-confirm"
      />,
    );
    expect(html).toContain(copy.marketConflictConfirm);
    expect(byTestId(html, 'conflict-confirm')?.attributes['data-state']).toBe('unchecked');
    const blocked = renderWithQueries(
      <NoConflictConfirmation
        checked
        blocked
        onChecked={() => undefined}
        testId="conflict-confirm"
      />,
    );
    expect(blocked).toContain(copy.marketConflictRefused);
    expect(byTestId(blocked, 'conflict-confirm')?.attributes['data-state']).toBe('unchecked');
    expect(
      Object.hasOwn(byTestId(blocked, 'conflict-confirm')?.attributes ?? {}, 'data-disabled'),
    ).toBe(true);
  });
});
