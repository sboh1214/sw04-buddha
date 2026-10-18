import { describe, expect, it } from 'vitest';
import * as enums from './enums.js';

describe('enums', () => {
  it('exposes tuple + schema pairs that agree', () => {
    expect(enums.roleSchema.parse('admin')).toBe('admin');
    expect(enums.outcomeSchema.parse('YES')).toBe('YES');
    expect(enums.marketStatusSchema.parse('resolved')).toBe('resolved');
    expect(enums.ledgerEntryTypeSchema.options).toEqual([...enums.LEDGER_ENTRY_TYPES]);
    expect(enums.orderStatusSchema.options).toEqual([...enums.ORDER_STATUSES]);
    expect(() => enums.outcomeSchema.parse('MAYBE')).toThrow();
  });

  it('never contains sports or election categories (PLAN 0.2)', () => {
    for (const slug of enums.ALL_CATEGORY_SLUGS) {
      expect(slug).not.toMatch(/sport|election|politic/i);
    }
    expect(enums.CATEGORY_SLUGS).toHaveLength(5);
  });

  it('keeps the category tree two levels deep with slugs unique across both', () => {
    // `?category=<slug>` names one row without saying its level, so a leaf may not reuse a
    // top-level slug, and every top-level slug has at least one leaf to file a market under.
    expect(Object.keys(enums.SUBCATEGORY_SLUGS).sort()).toEqual([...enums.CATEGORY_SLUGS].sort());
    for (const parent of enums.CATEGORY_SLUGS) {
      expect(enums.SUBCATEGORY_SLUGS[parent].length).toBeGreaterThan(0);
    }
    expect(new Set(enums.ALL_CATEGORY_SLUGS).size).toBe(enums.ALL_CATEGORY_SLUGS.length);
    // `categories.slug` is varchar(32) and the seed writes these verbatim.
    for (const slug of enums.ALL_CATEGORY_SLUGS) {
      expect(slug).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
    }
  });

  it('orders MARKET_STATUSES so a client can rank two market:status events (A-M3-19)', () => {
    // Until an event carries a strict key, a client keeps the higher rank in this order —
    // which is only a total order because the tuple is written in transition order and no
    // status repeats. Reordering it (which also reorders the Postgres enum type) or letting
    // M5 move a settled market back would break that rule silently; this fails first.
    const rank = (status: enums.MarketStatus) => enums.MARKET_STATUSES.indexOf(status);
    for (const [earlier, later] of [
      ['draft', 'open'],
      ['open', 'closed'],
      ['closed', 'resolved'],
      ['resolved', 'settled'],
      ['settled', 'voided'],
    ] as const) {
      expect(rank(earlier)).toBeLessThan(rank(later));
    }
    expect(new Set(enums.MARKET_STATUSES).size).toBe(enums.MARKET_STATUSES.length);
  });

  it('only ever appends to the Postgres-backed payment and ledger enums (ADR-0042)', () => {
    // `ALTER TYPE ... ADD VALUE` appends; reordering a tuple would reorder nothing in the
    // database and make drizzle-kit emit a BEFORE/AFTER migration nobody meant to write. The
    // one removal so far (MARKET_VOID_REFUND) recreated the type on an emptied table (0017).
    expect(enums.PAYMENT_STATUSES.slice(0, 3)).toEqual(['pending', 'succeeded', 'failed']);
    expect(enums.PAYMENT_STATUSES.slice(3)).toEqual(['cancelled', 'refunding', 'refunded']);
    expect(enums.LEDGER_ENTRY_TYPES.slice(-3)).toEqual([
      'PAYMENT_CANCEL',
      'PAYMENT_CANCEL_REVERSAL',
      'START_GRANT',
    ]);
    expect(enums.paymentStatusSchema.parse('refunding')).toBe('refunding');
    expect(enums.ledgerEntryTypeSchema.parse('PAYMENT_CANCEL_REVERSAL')).toBe(
      'PAYMENT_CANCEL_REVERSAL',
    );
  });

  it('has no value only the direct AMM wrote (#125)', () => {
    // The void cost refund, the opening tick and the AMM counterparty are gone, and their
    // Postgres types were recreated without them on an emptied database (migration 0017).
    expect(enums.ledgerEntryTypeSchema.safeParse('MARKET_VOID_REFUND').success).toBe(false);
    expect(enums.priceTickTriggerSchema.safeParse('open').success).toBe(false);
    expect(enums.counterpartyTypeSchema.safeParse('amm').success).toBe(false);
    expect(enums.adminActionTypeSchema.safeParse('market_void').success).toBe(false);
    expect(enums).not.toHaveProperty('MARKET_MECHANISMS');
  });

  it('names the payment providers, payment event types and the refund admin action', () => {
    // SmartroPay is gone (ADR-0049); `mock` is the one provider until the next PG.
    expect(enums.paymentProviderSchema.options).toEqual(['mock']);
    expect(enums.paymentProviderSchema.safeParse('smartro').success).toBe(false);
    expect(enums.paymentProviderSchema.safeParse('toss').success).toBe(false);
    // payment_events.type is varchar(32).
    for (const type of enums.PAYMENT_EVENT_TYPES) {
      expect(enums.paymentEventTypeSchema.parse(type)).toBe(type);
      expect(type.length).toBeLessThanOrEqual(32);
    }
    // admin_actions.type is varchar(40).
    expect(enums.adminActionTypeSchema.parse('payment_refund')).toBe('payment_refund');
    // The manual settle went with SmartroPay (ADR-0049).
    expect(enums.adminActionTypeSchema.safeParse('payment_settle').success).toBe(false);
    for (const type of enums.ADMIN_ACTION_TYPES) expect(type.length).toBeLessThanOrEqual(40);
  });

  it('names the market statuses after the plan, with no dispute stage (O-5, O-7, ADR-0046)', () => {
    expect(enums.MARKET_STATUSES).toEqual([
      'draft',
      'open',
      'closed',
      'resolved',
      'settled',
      'voided',
    ]);
    expect(enums.marketEventTypeSchema.parse('resolved')).toBe('resolved');
    // The M5 events stay readable: market_events is append-only and old rows carry them.
    expect(enums.marketEventTypeSchema.parse('resolve_proposed')).toBe('resolve_proposed');
    expect(enums.marketEventTypeSchema.parse('result_changed')).toBe('result_changed');
    expect(enums.ADMIN_ACTION_TYPES).not.toContain('dispute_review');
    for (const type of enums.MARKET_EVENT_TYPES) expect(type.length).toBeLessThanOrEqual(40);
  });

  it('lists the settlement steps and their statuses (O-6, ADR-0046)', () => {
    // Coin settlement is the only step: Forecast scoring left with Forecast (N02 §1, N04 §4).
    expect(enums.SETTLEMENT_STEPS).toEqual(['coin']);
    expect(enums.settlementStepSchema.parse('coin')).toBe('coin');
    expect(enums.settlementStepSchema.safeParse('score').success).toBe(false);
    expect(enums.SETTLEMENT_STEP_STATUSES).toEqual(['pending', 'done', 'failed']);
    // market_settlement_steps.step and .status are varchar(20).
    for (const value of [...enums.SETTLEMENT_STEPS, ...enums.SETTLEMENT_STEP_STATUSES]) {
      expect(value.length).toBeLessThanOrEqual(20);
    }
  });

  it('keeps the remaining enum schemas parseable', () => {
    expect(enums.paymentStatusSchema.parse('succeeded')).toBe('succeeded');
    expect(enums.marketVisibilitySchema.parse('public')).toBe('public');
    expect(enums.marketEventTypeSchema.parse('rules_edited')).toBe('rules_edited');
    expect(enums.orderSideSchema.parse('buy')).toBe('buy');
    expect(enums.orderTypeSchema.parse('market')).toBe('market');
    expect(enums.timeInForceSchema.parse('ioc')).toBe('ioc');
    expect(enums.counterpartyTypeSchema.parse('order')).toBe('order');
    expect(enums.priceTickTriggerSchema.parse('trade')).toBe('trade');
    expect(enums.adminActionTypeSchema.parse('balance_adjust')).toBe('balance_adjust');
    expect(enums.auditFailureKindSchema.parse('ledger_balance_mismatch')).toBe(
      'ledger_balance_mismatch',
    );
    expect(enums.ledgerRefTypeSchema.parse('fill')).toBe('fill');
    expect(enums.categorySlugSchema.parse('weather')).toBe('weather');
  });

  it('gives the start grant a ledger type of its own, apart from the coupon BONUS (#70)', () => {
    // ADR-0069 decision 4 #70: new issuance under its own type '시작 지급', never BONUS.
    expect(enums.ledgerEntryTypeSchema.parse('START_GRANT')).toBe('START_GRANT');
    expect(enums.ledgerRefTypeSchema.parse('start_grant')).toBe('start_grant');
    expect(enums.LEDGER_ENTRY_TYPES).toContain('BONUS');
  });
});
