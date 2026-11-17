/**
 * One ledger row as the wallet answers it (`toLedgerEntry`, #69, ADR-0144): no database. The kind
 * from the account's side, the market's slug and title only while it is public, no memo on a
 * market's row, the order only on a fill's row and the correction's effect. The integration
 * suites (wallet.controller.test.ts, reconciliation-corrections.controller.test.ts) read the same
 * through the route.
 */
import type { schema } from '@buddha/db';
import { describe, expect, it } from 'vitest';
import { toLedgerEntry } from './wallet.service.js';

type LedgerRow = typeof schema.ledgerEntries.$inferSelect;

const ME = 7;
const OTHER = 8;
const MARKET_ID = '3f1a5b6c-1111-4222-8333-444455556666';
const ORDER_ID = '3f1a5b6c-1111-4222-8333-444455556667';
const at = new Date('2026-11-17T01:02:03.004Z');

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return {
    id: 41,
    type: 'TRADE_FILL',
    amountCoin: 30n,
    fromAccountId: ME,
    toAccountId: OTHER,
    fromBalanceAfterCoin: 970n,
    toBalanceAfterCoin: 1_030n,
    marketId: MARKET_ID,
    refType: 'fill',
    refId: '17',
    idempotencyKey: '17',
    memo: null,
    createdAt: at,
    ...overrides,
  };
}

const market = { slug: 'market-1', title: '시장 하나', status: 'open' as const };

describe('toLedgerEntry (#69)', () => {
  it('names a fill by the account’s side, with the market and the account’s own order', () => {
    expect(toLedgerEntry(row({}), ME, { market, orderId: ORDER_ID })).toEqual({
      id: '41',
      kind: 'BUY_FILL',
      amountCoin: '-30',
      balanceAfterCoin: '970',
      refType: 'fill',
      refId: '17',
      memo: null,
      marketId: MARKET_ID,
      marketSlug: 'market-1',
      marketTitle: '시장 하나',
      orderId: ORDER_ID,
      correctionEffect: null,
      createdAt: at.toISOString(),
    });
    expect(toLedgerEntry(row({}), OTHER, { market, orderId: null })).toMatchObject({
      kind: 'SELL_FILL',
      amountCoin: '30',
      balanceAfterCoin: '1030',
      orderId: null,
    });
    // A pair mint's collateral is the same kind as a trade's payment (결과 4).
    expect(
      toLedgerEntry(row({ type: 'PAIR_MINT_COLLATERAL', toAccountId: 99 }), ME, { market }).kind,
    ).toBe('BUY_FILL');
  });

  it('shows the market’s slug and title only while it is public, and no memo on its row', () => {
    for (const status of ['draft', 'review'] as const) {
      expect(
        toLedgerEntry(
          row({ type: 'SETTLEMENT_PAYOUT', fromAccountId: 99, toAccountId: ME, refType: 'market' }),
          ME,
          { market: { ...market, status } },
        ),
      ).toMatchObject({ marketId: MARKET_ID, marketSlug: null, marketTitle: null });
    }
    // A settlement's memo names the title it had: never answered.
    expect(
      toLedgerEntry(
        row({
          type: 'SETTLEMENT_PAYOUT',
          fromAccountId: 99,
          toAccountId: ME,
          refType: 'market',
          refId: MARKET_ID,
          memo: '정산 지급: 옛 제목',
        }),
        ME,
        { market: { ...market, status: 'settled' } },
      ),
    ).toMatchObject({ kind: 'SETTLEMENT_PAYOUT', memo: null, orderId: null });
  });

  it('keeps the links null when none is given: the kept payment answers', () => {
    expect(
      toLedgerEntry(
        row({
          type: 'BONUS',
          fromAccountId: null,
          toAccountId: ME,
          fromBalanceAfterCoin: null,
          toBalanceAfterCoin: 500n,
          marketId: null,
          refType: 'coupon',
          refId: 'r1',
          memo: '쿠폰 WELCOME',
        }),
        ME,
      ),
    ).toMatchObject({
      kind: 'BONUS',
      memo: '쿠폰 WELCOME',
      marketId: null,
      marketSlug: null,
      marketTitle: null,
      orderId: null,
      correctionEffect: null,
    });
    // An order id is only ever a fill's.
    expect(
      toLedgerEntry(
        row({
          type: 'START_GRANT',
          fromAccountId: null,
          toAccountId: ME,
          fromBalanceAfterCoin: null,
          toBalanceAfterCoin: 500n,
          marketId: null,
          refType: 'start_grant',
          refId: MARKET_ID,
        }),
        ME,
        { orderId: ORDER_ID },
      ).orderId,
    ).toBeNull();
  });

  it('says what a correction did, with its member-facing reason only', () => {
    const corrected = row({
      type: 'RECONCILIATION_CORRECTION',
      fromAccountId: 99,
      toAccountId: ME,
      marketId: null,
      refType: 'audit_failure',
      refId: '5',
      memo: 'internal memo',
    });
    const record = { id: ORDER_ID, userReason: '사유', balanceDeltaCoin: 0n };
    expect(
      toLedgerEntry(corrected, ME, { correction: { ...record, mode: 'replenish_ledger' } }),
    ).toMatchObject({
      kind: 'RECONCILIATION_CORRECTION',
      refType: 'reconciliation_correction',
      refId: ORDER_ID,
      memo: '사유',
      correctionEffect: 'ledger_only',
    });
    expect(
      toLedgerEntry(corrected, ME, {
        correction: { ...record, mode: 'replenish_ledger', balanceDeltaCoin: 30n },
      }).correctionEffect,
    ).toBe('ledger_amount');
    expect(
      toLedgerEntry(corrected, ME, { correction: { ...record, mode: 'restore_actual' } })
        .correctionEffect,
    ).toBe('ledger_amount');
    // A legacy row has no record: the ledger moved by its amount, and no reason is made up.
    expect(toLedgerEntry(corrected, ME)).toMatchObject({
      refId: 'legacy:41',
      memo: null,
      correctionEffect: 'ledger_amount',
    });
  });

  it('throws for a pair no rule lets a person’s account take', () => {
    expect(() =>
      toLedgerEntry(
        row({
          type: 'START_GRANT',
          fromAccountId: ME,
          toAccountId: null,
          toBalanceAfterCoin: null,
        }),
        ME,
      ),
    ).toThrow();
    expect(() => toLedgerEntry(row({ type: 'BOT_ALLOCATION' }), ME)).toThrow();
  });
});
