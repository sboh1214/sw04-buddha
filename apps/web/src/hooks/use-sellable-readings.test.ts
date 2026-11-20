import { readFileSync } from 'node:fs';
import { MARKET_IDS_MAX } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { sellableQueryOptions } from '@/hooks/use-orders-place';
import { RequestPacer } from '@/lib/request-pacer';
import { SELLABLE_PACE, pacedSellableQueryOptions } from './use-sellable-readings';

/**
 * MY's sellable reads go through one queue; the detail's one market does not (#67, ADR-0142 결정
 * 2-15, review P2: 50 held markets asked 50 at once beside their 50 market rows).
 */
describe('pacedSellableQueryOptions', () => {
  it('is the panel’s entry, its request run through the queue', async () => {
    const plain = sellableQueryOptions('M-1', 'user-a');
    const pacer = new RequestPacer({ maxInFlight: 1, perWindow: 1, windowMs: 60_000 });
    const paced = pacedSellableQueryOptions('M-1', 'user-a', pacer);
    expect(paced.queryKey).toEqual(plain.queryKey);
    expect(paced.enabled).toBe(true);
    expect(pacedSellableQueryOptions('M-1', undefined, pacer).enabled).toBe(false);
    // A read cancelled while it waits is never sent: the queue honours the query's signal.
    const cancel = new AbortController();
    cancel.abort(new Error('cancelled'));
    await expect(paced.queryFn({ signal: cancel.signal })).rejects.toThrow('cancelled');
    expect(pacer.running).toBe(0);
    expect(pacer.waiting).toBe(0);
  });

  it('keeps /my/positions in budget at every window (ADR-0142 결과 3)', () => {
    // The screen's fixed reads (positions 2, me 1, restriction 1, session 1), one market row per
    // held market — on a reconnect too, read once (결정 2-21; `lib/query-client.test.ts` pins the
    // N market rows of a reconnect) — and the queue's cap. Within a minute the sellable reads are
    // the N first reads plus the 결정 2-16 rotation (10 a minute), so min(N, 20) understates
    // them below N = 20; the queue's per-minute cap is the bound that holds at every N.
    const fixed = 5;
    // Measured 2026-11-17 (ADR-0142 결과 3): first entry, and the sellable reads of a reconnect
    // (a resnapshot restarts SELLABLE_KEY; 결정 2-21 does not change that).
    const measured = {
      1: { entry: 17, reconnectSellable: 12 },
      5: { entry: 25, reconnectSellable: 16 },
      10: { entry: 35, reconnectSellable: 20 },
      25: { entry: 50, reconnectSellable: 20 },
      50: { entry: 75, reconnectSellable: 20 },
    } as const;
    for (const markets of [1, 5, 10, 25, 50] as const) {
      // #67's bound, one market row per held market — what the measurement above was taken on.
      const before = fixed + markets + SELLABLE_PACE.perWindow;
      expect(before, `N = ${String(markets)}`).toBeLessThanOrEqual(markets <= 25 ? 50 : 100);
      // The bound never understates what was measured, nor the computed reconnect after 결정 2-21.
      const { entry, reconnectSellable } = measured[markets];
      expect(entry, `N = ${String(markets)}`).toBeLessThanOrEqual(before);
      expect(reconnectSellable).toBeLessThanOrEqual(SELLABLE_PACE.perWindow);
      expect(fixed + markets + reconnectSellable, `N = ${String(markets)}`).toBeLessThanOrEqual(
        before,
      );
    }
    // #300 (ADR-0147): the rows are read 50 to a request, so the market rows' share is the
    // number of chunks, not N — one tab's 50 a minute at every N up to 50, and far past it.
    for (const markets of [1, 5, 10, 25, 50, 100, 200] as const) {
      const chunks = Math.ceil(markets / MARKET_IDS_MAX);
      const bound = fixed + chunks + SELLABLE_PACE.perWindow;
      expect(bound, `N = ${String(markets)}`).toBeLessThanOrEqual(markets <= 50 ? 26 : 50);
    }
    expect(MARKET_IDS_MAX).toBe(50);
    // Measured 2026-11-20 on this code (ADR-0147 결과 2), same tool and conditions as #67: first
    // entry and reconnect within the bound at every N, and the ADR records the same numbers.
    const after = {
      1: { entry: 17, reconnect: 18 },
      5: { entry: 21, reconnect: 22 },
      10: { entry: 26, reconnect: 26 },
      25: { entry: 26, reconnect: 26 },
      50: { entry: 26, reconnect: 26 },
    } as const;
    for (const markets of [1, 5, 10, 25, 50] as const) {
      const bound = fixed + Math.ceil(markets / MARKET_IDS_MAX) + SELLABLE_PACE.perWindow;
      expect(after[markets].entry, `N = ${String(markets)}`).toBeLessThanOrEqual(bound);
      expect(after[markets].reconnect, `N = ${String(markets)}`).toBeLessThanOrEqual(bound);
    }
    // The ADR states the same bound, and still points #123's empty ADR-0141 line at this run.
    const decisions = readFileSync(
      new URL('../../../../docs/DECISIONS.md', import.meta.url),
      'utf8',
    );
    const adr = decisions.slice(decisions.indexOf('\n## ADR-0142 '));
    const adr0142 = adr.slice(0, adr.indexOf('\n## ADR-', 1));
    expect(adr0142).toContain('5 + N + 20(줄의 분당 상한');
    expect(adr0142).not.toContain('sellable min(N, 20)이 N ≤ 25');
    expect(adr0142).toContain('N = 1 17/10/약 18/15, N = 5 25/10/약 26/19');
    expect(adr0142).toContain(
      "ADR-0141 결과 3 '실시간 예산' 줄은 이 측정(`/my/orders` 한 쪽 6·두 쪽 12, 주문 상세 36",
    );
    const adr0147 = decisions.slice(decisions.indexOf('\n## ADR-0147 '));
    expect(adr0147).toMatch(/\| N = 50 +\| \*\*26\/10\/26\/25\*\* +\| 75\/10\/75\/25 +\|/);
    expect(adr0147).not.toContain('[측정 전]');
    // A focus return re-reads no open market's row (결정 2-22): the fixed reads and the queue.
    expect(fixed + SELLABLE_PACE.perWindow).toBeLessThanOrEqual(50);
    expect(SELLABLE_PACE).toEqual({ maxInFlight: 10, perWindow: 20, windowMs: 60_000 });
  });
});

describe('who paces', () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('MY’s holdings read through the queue, the detail’s 내 포지션 as its panel does', () => {
    const portfolio = src('../app/my/portfolio.tsx');
    const hook = portfolio.slice(portfolio.indexOf('export function useHoldings('));
    expect(hook.slice(0, hook.indexOf('\n}\n'))).toMatch(/useSellableReadings\(\{[^}]*paced: true/);
    const detail = src('../components/market/my-position.tsx');
    expect(detail).toContain('useSellableReadings({');
    expect(detail).not.toContain('paced');
    const readings = src('./use-sellable-readings.ts');
    expect(readings).toContain(
      'paced ? pacedSellableQueryOptions(id, accountId) : sellableQueryOptions(id, accountId)',
    );
  });

  it('MY’s holdings read the market rows 50 to a request, the detail its own row', () => {
    // #300 (ADR-0147): chunks of held ids through `GET /markets?ids=`, with ADR-0142 결정 2-22's
    // options (no settlement poll, a narrower focus re-read); never the detail's entry.
    const portfolio = src('../app/my/portfolio.tsx');
    const hook = portfolio.slice(portfolio.indexOf('export function useHoldings('));
    const body = hook.slice(0, hook.indexOf('\n}\n'));
    expect(body).toMatch(
      /holdingMarketChunks\(marketIds\)\.map\(\(ids\) =>\s*holdingMarketsQueryOptions\(ids, \(\) => seedHoldingChunk\(queryClient, ids\)\),?\s*\)/,
    );
    expect(body).not.toMatch(/(?<![A-Za-z])marketQueryOptions\(/);
    expect(body).not.toContain('holdingMarketQueryOptions(');
    const markets = src('./use-markets.ts');
    const useMarket = markets.slice(markets.indexOf('export function useMarket('));
    expect(useMarket.slice(0, useMarket.indexOf('\n}\n'))).toContain(
      'useQuery(marketQueryOptions(marketId))',
    );
  });
});
