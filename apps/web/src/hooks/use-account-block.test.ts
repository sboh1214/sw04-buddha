import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * D13's account reading (`useAccountBlock`, #67 ADR-0142 — out of the order panel, ADR-0140 결정
 * 2-11·2-26), pinned in its source as the panel's wiring was: no hook runs its effects under node.
 * MY's holdings and the order panel read one decision.
 */
describe('useAccountBlock', () => {
  const source = readFileSync(new URL('./use-account-block.ts', import.meta.url), 'utf8');
  const panel = readFileSync(
    new URL('../components/market/order-panel-provider.tsx', import.meta.url),
    'utf8',
  );
  const portfolio = readFileSync(new URL('../app/my/portfolio.tsx', import.meta.url), 'utf8');

  it('reads the restriction of the account on screen, under its id, never the last one’s', () => {
    expect(source).toContain('const restrictionOwner = me?.id ?? null;');
    expect(source).toContain('const restriction = useMyRestriction(restrictionOwner);');
    // A visitor, or `me` not answered yet: no restriction held.
    expect(source).toContain(
      'const heldRestriction = me === undefined ? null : (restriction.data?.accountRestriction ?? null);',
    );
  });

  it('lets a term account restriction end at its endsAt, and reads it again then (결정 2-11)', () => {
    expect(source).toMatch(
      /useInstantReached\(\s*heldRestriction\?\.endsAt \?\? null,\s*now,\s*refreshRestriction,?\s*\)/,
    );
    expect(source).toContain(
      'const restrictedDetails = restrictionEnded ? null : heldRestriction;',
    );
    expect(source).toMatch(
      /void queryClient\.invalidateQueries\(\{\s*queryKey: myRestrictionKey\(restrictionOwner\),\s*exact: true,\s*\}\);/,
    );
  });

  it('names an admin before a restriction, as the panel always did', () => {
    expect(source).toContain(
      "const account: AccountBlock = admin ? 'admin' : restrictedDetails !== null ? 'restricted' : null;",
    );
  });

  it('is the one reading of the panel and of MY’s holdings', () => {
    expect(panel).toContain('useAccountBlock(me, now)');
    expect(portfolio).toContain('useAccountBlock(');
    expect(panel).not.toContain('useMyRestriction(');
  });
});
