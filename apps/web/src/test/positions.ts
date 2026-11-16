import type { Position } from '@/lib/api';

/**
 * One `GET /me/positions` row for a test, every field set (#67, ADR-0142): an open YES holding of
 * 100 contracts at 50.00 Coin in a market whose last fill was 63, with `overrides` on top. One
 * place builds it, so a field the DTO gains is added here once rather than in every test that
 * needs a row. Test support, not screen code: the screen walk skips this folder (screen-text.ts).
 */
export function positionFixture(overrides: Partial<Position> = {}): Position {
  return {
    marketId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    marketStatus: 'open',
    marketLastPrice: 63,
    marketLastFillAt: '2026-09-06T23:00:00.000Z',
    marketTradeCount: 5,
    marketStatusEventId: '10',
    resolvedResult: null,
    outcome: 'YES',
    qty: 100,
    costBasisCoin: '5000',
    realizedPnlCoin: '0',
    settled: false,
    version: 1,
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}
