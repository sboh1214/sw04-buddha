import { readFileSync } from 'node:fs';
import { ORDER_QTY_MAX } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { OrderQuote, Position, SellableContract } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import type { SellableReading } from '@/lib/sellable-view';
import { positionFixture } from '@/test/positions';
import { byId, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { HoldingMarketGroup, HoldingRow, type SellAccount } from './holding-rows';

/**
 * 보유 행 (#67, ADR-0142; ADR-0135 F7·F2·D13·결정 4): what one contract's row draws on MY and the
 * detail — the two groups and their cells, '체결 없음' and '—', '보유 없음', 매도 가능 and 매도 잠금,
 * and when '매도' is off. The figures' arithmetic is use-portfolio.test.ts's and the cell's words
 * sellable-view.test.ts's; this is the drawing.
 */

const MAY: SellAccount = { account: null, accountKnown: true, describedBy: undefined };

/** An immediate sell of 2 that meets one bid at 44: '일부 수량만 가능' (the e2e's 4단계). */
const PARTIAL: OrderQuote = {
  protectedLimitPriceCoin: 40,
  filledQty: 1,
  filledAmountCoin: '44',
  remainingQty: 1,
  unspentCoin: null,
  maxSpendCoin: null,
  feeCoin: '0',
  stop: 'no_quote',
  status: 'cancelled',
  rejectReason: null,
  cancelReason: 'ioc_remainder',
};

function contract(over: Partial<SellableContract> = {}): SellableContract {
  return {
    outcome: 'YES',
    qty: 2,
    restingSellQty: 0,
    unlockedQty: 2,
    quote: PARTIAL,
    ...over,
  };
}

/** YES 2 at a cost of 67, 실현 +12, the market's last fill at 45 (the e2e's 3단계). */
const HELD: Position = positionFixture({
  qty: 2,
  costBasisCoin: '67',
  realizedPnlCoin: '12',
  marketLastPrice: 45,
  marketLastFillAt: '2026-11-16T03:04:05.000Z',
});

function row(
  position: Position,
  over: {
    sellable?: SellableReading;
    sellAccount?: SellAccount;
    layout?: 'my' | 'detail';
  } = {},
) {
  return renderWithQueries(
    <HoldingRow
      position={position}
      sellable={over.sellable ?? { state: 'ready', contract: contract() }}
      onRetrySellable={() => undefined}
      sellTarget={
        over.layout === 'detail' ? { kind: 'panel', onSell: () => undefined } : { kind: 'link' }
      }
      sellAccount={over.sellAccount ?? MAY}
      layout={over.layout ?? 'my'}
      testId="row"
    />,
  );
}

const text = (html: string, testId: string) => byTestId(html, testId)?.text;

describe('HoldingRow', () => {
  it('draws the two groups, their cells in order, and the figures of 수용 기준 4', () => {
    const html = row(HELD);
    expect(html.indexOf(copy.positionGroupHolding)).toBeLessThan(
      html.indexOf(copy.positionGroupMark),
    );
    expect(testIdsStartingWith(html, 'position-')).toEqual([
      'position-sell',
      'position-qty',
      'position-locked',
      'position-avg',
      'position-cost',
      'position-realized',
      'position-last-price',
      'position-last-fill',
      'position-value',
      'position-unrealized',
      'position-sellable',
      'position-sell-reason',
    ]);
    expect(text(html, 'position-qty')).toBe('2계약');
    expect(text(html, 'position-locked')).toBe('0계약');
    expect(text(html, 'position-avg')).toBe('33.50 Coin');
    expect(text(html, 'position-cost')).toBe('67 Coin');
    expect(text(html, 'position-realized')).toBe('12 Coin');
    // 2 × 45 = 90, minus the 67 left: 23 (F1). A gain has no sign; a loss its U+2212.
    expect(text(html, 'position-value')).toBe('90 Coin');
    expect(text(html, 'position-unrealized')).toBe('23 Coin');
    // F3: always '최근 체결 <절대 시각>', the card's and the header's words and time.
    expect(text(html, 'position-last-fill')).toBe(
      `${copy.marketLastFillAt} ${formatKst('2026-11-16T03:04:05.000Z')}`,
    );
    expect(text(html, 'position-sellable')).toContain('일부 수량만 가능 · 1계약 · 44 Coin');
    expect(text(html, 'position-sell-reason')).toBe('호가 부족');
  });

  it('values NO at the complement of the market price (결정 4)', () => {
    const html = row({ ...HELD, outcome: 'NO', costBasisCoin: '110' });
    expect(text(html, 'position-last-price')).toContain('55 Coin');
    expect(text(html, 'position-value')).toBe('110 Coin');
    expect(text(html, 'position-unrealized')).toBe('0 Coin');
  });

  it('says 체결 없음 and a dash for a holding with no fill, with no time line (결정 4)', () => {
    const html = row({ ...HELD, marketLastPrice: null, marketLastFillAt: null });
    expect(text(html, 'position-last-price')).toBe(copy.noFills);
    expect(text(html, 'position-value')).toBe('—');
    expect(text(html, 'position-unrealized')).toBe('—');
    expect(byTestId(html, 'position-last-fill')).toBeUndefined();
    // What needs no price is still there.
    expect(text(html, 'position-realized')).toBe('12 Coin');
    expect(text(html, 'position-sellable')).toContain('1계약');
  });

  it('draws the detail’s sold-out contract as 보유 없음 with its 실현 손익', () => {
    const soldOut = { ...HELD, qty: 0, costBasisCoin: '0', realizedPnlCoin: '-10' };
    const html = row(soldOut, { layout: 'detail' });
    expect(text(html, 'position-none')).toBe(copy.positionNoHolding);
    expect(text(html, 'position-realized')).toBe('−10 Coin');
    expect(byTestId(html, 'position-sell')).toBeUndefined();
    expect(byTestId(html, 'position-value')).toBeUndefined();
  });

  it('links MY’s 매도 to the detail with the contract and 매도 chosen (F6)', () => {
    const sell = byTestId(row(HELD), 'position-sell');
    expect(sell?.attributes.href).toBe('/markets/rate-cut-2026?order=sell&contract=yes');
    expect(sell?.attributes['aria-label']).toBe(`${HELD.marketTitle} YES ${copy.positionSell}`);
  });

  it('turns 매도 off for D13 — a real button, no address, pointing at the line (D13)', () => {
    for (const account of ['admin', 'restricted'] as const) {
      const html = row(HELD, {
        sellAccount: { account, accountKnown: true, describedBy: 'portfolio-account-blocked' },
      });
      const sell = byTestId(html, 'position-sell');
      expect(sell?.attributes.disabled).toBe('');
      expect(sell?.attributes.href).toBeUndefined();
      expect(sell?.attributes['aria-describedby']).toBe('portfolio-account-blocked');
      // The values stay.
      expect(text(html, 'position-value')).toBe('90 Coin');
    }
    // Before the account is judged too, so it never flashes on.
    const pending = row(HELD, {
      sellAccount: { account: null, accountKnown: false, describedBy: undefined },
    });
    expect(byTestId(pending, 'position-sell')?.attributes.disabled).toBe('');
  });

  it('keeps 매도 on for an all-locked and a no-width holding: the panel says what is possible', () => {
    const allLocked = row(HELD, {
      sellable: {
        state: 'ready',
        contract: contract({ restingSellQty: 2, unlockedQty: 0, quote: null }),
      },
    });
    expect(byTestId(allLocked, 'position-sell')?.attributes.href).toBeDefined();
    expect(text(allLocked, 'position-sellable')).toBe('매도 가능 0계약(대기 매도 잠금 2계약)');
    expect(text(allLocked, 'position-locked')).toBe('2계약');
    const noWidth = row(HELD, {
      sellable: { state: 'ready', contract: contract({ quote: null }) },
    });
    expect(byTestId(noWidth, 'position-sell')?.attributes.href).toBeDefined();
    expect(text(noWidth, 'position-sellable')).toBe(copy.orderBlockNoWidth);
  });

  /** The element a '매도' turned off points at, and that it sits in the row's 매도 가능 cell. */
  function reasonOf(html: string) {
    const id = byTestId(html, 'position-sell')?.attributes['aria-describedby'] ?? '';
    expect(id).not.toBe('');
    expect(html.indexOf(` id="${id}"`)).toBeGreaterThan(
      html.indexOf('data-testid="position-sellable"'),
    );
    return byId(html, id)?.text;
  }

  it('turns 매도 off on a market that does not trade, its 마감 the reason (F2)', () => {
    const html = row({ ...HELD, marketStatus: 'closed' });
    const sell = byTestId(html, 'position-sell');
    expect(sell?.attributes.disabled).toBe('');
    expect(sell?.attributes.href).toBeUndefined();
    expect(reasonOf(html)).toBe('마감');
    expect(text(html, 'position-sellable')).toBe('마감');
    // The last fill's value and time stay; no expected payout is drawn.
    expect(text(html, 'position-value')).toBe('90 Coin');
    expect(byTestId(html, 'position-last-fill')).toBeDefined();
  });

  it('turns 매도 off while paused — no order area (D1) — its 일시 중단 the reason', () => {
    const html = row({ ...HELD, marketStatus: 'paused' });
    const sell = byTestId(html, 'position-sell');
    expect(sell?.attributes.disabled).toBe('');
    expect(sell?.attributes.href).toBeUndefined();
    expect(reasonOf(html)).toBe('일시 중단');
    // The holding's lock is still read.
    expect(text(html, 'position-locked')).toBe('0계약');
  });

  it('gives a failed lock its own 다시 시도 where the 매도 가능 cell is 마감 (F2)', () => {
    const closed = row({ ...HELD, marketStatus: 'closed' }, { sellable: { state: 'failed' } });
    expect(text(closed, 'position-sellable')).toBe('마감');
    expect(byTestId(closed, 'position-locked')?.text).toContain('—');
    expect(byTestId(closed, 'position-locked-retry')).toBeDefined();
    // Elsewhere the 매도 가능 cell carries the one 다시 시도.
    const open = row(HELD, { sellable: { state: 'failed' } });
    expect(byTestId(open, 'position-locked-retry')).toBeUndefined();
    expect(byTestId(open, 'position-sell-retry')).toBeDefined();
  });

  it('shows the lock a ledger hold kept on a closed market beside its 마감 (M9)', () => {
    const html = row(
      { ...HELD, marketStatus: 'closed' },
      {
        sellable: {
          state: 'ready',
          contract: contract({ restingSellQty: 1, unlockedQty: 1, quote: null }),
        },
      },
    );
    expect(text(html, 'position-sellable')).toBe('마감');
    expect(text(html, 'position-locked')).toBe('1계약');
  });

  it('never fills a figure it does not know: a dash with 다시 시도, or a skeleton', () => {
    const failed = row(HELD, { sellable: { state: 'failed' } });
    expect(text(failed, 'position-sellable')).toContain('—');
    expect(byTestId(failed, 'position-sell-retry')).toBeDefined();
    expect(text(failed, 'position-locked')).toBe('—');
    const loading = row(HELD, { sellable: { state: 'loading' } });
    expect(text(loading, 'position-sellable')).toBe('');
    expect(text(loading, 'position-locked')).toBe('');
  });

  it('draws the worst figures and the 1,000,000 line in cells that may wrap (R16)', () => {
    const big = ORDER_QTY_MAX + 1;
    const html = row(
      { ...HELD, qty: big, costBasisCoin: '99000099', marketLastPrice: 99 },
      {
        sellable: {
          state: 'ready',
          contract: contract({
            qty: big,
            unlockedQty: big,
            quote: { ...PARTIAL, filledQty: 999_999, filledAmountCoin: '98999901' },
          }),
        },
      },
    );
    expect(text(html, 'position-value')).toBe('99,000,099 Coin');
    expect(text(html, 'position-sell-cap')).toBe('한 번에 1,000,000계약까지 팔 수 있습니다');
    const source = readFileSync(new URL('./holding-rows.tsx', import.meta.url), 'utf8');
    const cell = source.slice(source.indexOf('function Cell('));
    expect(cell).toContain('minW="0"');
    expect(cell).toContain('overflowWrap="anywhere"');
    expect(cell).toContain('fontVariantNumeric="tabular-nums"');
  });
});

describe('HoldingMarketGroup', () => {
  it('puts YES and NO under one market title, its status beside it when not 거래 중 (F7)', () => {
    const yes = HELD;
    const no = { ...HELD, outcome: 'NO' as const, qty: 1, costBasisCoin: '60' };
    const html = renderWithQueries(
      <HoldingMarketGroup
        group={{ marketId: HELD.marketId, rows: [yes, no], updatedAt: HELD.updatedAt }}
        display={{ judgementDelayed: false, disputeUnderReview: false }}
        sellables={(outcome) => ({
          state: 'ready',
          contract: contract({ outcome, qty: outcome === 'YES' ? 2 : 1 }),
        })}
        onRetrySellable={() => undefined}
        sellAccount={MAY}
      />,
    );
    expect(byTestId(html, `portfolio-market-${HELD.marketId}`)?.text).toContain(HELD.marketTitle);
    expect(testIdsStartingWith(html, 'portfolio-position-')).toEqual([
      `portfolio-position-${HELD.marketId}-YES`,
      `portfolio-position-${HELD.marketId}-NO`,
    ]);
    expect(byTestId(html, 'portfolio-market-status')).toBeUndefined();
    const closed = renderWithQueries(
      <HoldingMarketGroup
        group={{
          marketId: HELD.marketId,
          rows: [{ ...yes, marketStatus: 'closed' }],
          updatedAt: HELD.updatedAt,
        }}
        display={{ judgementDelayed: false, disputeUnderReview: false }}
        sellables={() => ({ state: 'loading' })}
        onRetrySellable={() => undefined}
        sellAccount={MAY}
      />,
    );
    expect(byTestId(closed, 'portfolio-market-status')?.text).toBe(copy.marketStatusClosed);
  });
});

describe('the words beside a PnL (N04 §1·§3)', () => {
  it('carry no rank, skill or score', () => {
    const words = [
      copy.positionQty,
      copy.positionLockedQty,
      copy.positionAvgPrice,
      copy.positionCostBasis,
      copy.positionCurrentPrice,
      copy.positionValue,
      copy.positionPnl,
      copy.positionRealizedPnl,
      copy.positionSellable,
      copy.positionGroupHolding,
      copy.positionGroupMark,
      copy.positionSellablePartial,
      copy.positionNoHolding,
      copy.positionSell,
      copy.portfolioValue,
      copy.portfolioUnrealizedPnl,
      copy.portfolioRealizedPnl,
      copy.portfolioPositionsEmpty,
    ].join(' ');
    for (const word of ['순위', '등수', '랭킹', '실력', '점수', '스코어', '수익률', '%']) {
      expect(words, word).not.toContain(word);
    }
  });

  it('use the plan’s names (ADR-0135 결과 4)', () => {
    expect([
      copy.positionAvgPrice,
      copy.positionCurrentPrice,
      copy.positionValue,
      copy.positionPnl,
      copy.portfolioValue,
      copy.portfolioUnrealizedPnl,
    ]).toEqual([
      '평균 매입가',
      '최근 체결가',
      '참고 평가',
      '미실현 손익',
      '총 참고 평가',
      '총 미실현 손익',
    ]);
  });
});
