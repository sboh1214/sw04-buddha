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

  it('names the eight report reasons in the owner’s order (#45-10), the reason a hiding carries too', () => {
    // 스팸·괴롭힘·개인정보 노출·사칭·공모·조작 유도·시장과 무관·권리 침해·기타 (ADR-0069 decision 2
    // #45-10; owner decision 2026-10-22 for a hiding's reason, ADR-0080).
    expect(enums.REPORT_REASONS).toEqual([
      'spam',
      'harassment',
      'personal_info',
      'impersonation',
      'collusion_manipulation',
      'off_topic',
      'rights_infringement',
      'other',
    ]);
    expect(enums.reportReasonSchema.options).toEqual([...enums.REPORT_REASONS]);
    expect(enums.reportReasonSchema.safeParse('wrong_forecast').success).toBe(false);
  });

  it('seeds five top-level categories (the operators add any others, sports and politics too — D10)', () => {
    expect(enums.CATEGORY_SLUGS).toHaveLength(5);
    expect(enums.ADMIN_ACTION_TYPES).toEqual(
      expect.arrayContaining([
        'category_create',
        'category_rename',
        'category_reorder',
        'category_hide',
        'category_show',
      ]),
    );
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

  it("orders MARKET_STATUSES along the plan's lifecycle, the rank fallback (#174)", () => {
    // A client ranks two market:status events by this order only when a row carries no
    // transition key (statusSupersedes); it is N03 §3's forward order, PAUSED beside OPEN and
    // CANCELLED last.
    const rank = (status: enums.MarketStatus) => enums.MARKET_STATUSES.indexOf(status);
    for (const [earlier, later] of [
      ['draft', 'review'],
      ['review', 'scheduled'],
      ['scheduled', 'open'],
      ['open', 'paused'],
      ['paused', 'closed'],
      ['closed', 'provisional'],
      ['provisional', 'resolved'],
      ['resolved', 'settling'],
      ['settling', 'settled'],
      ['settled', 'cancelled'],
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
    expect(enums.LEDGER_ENTRY_TYPES.slice(-4)).toEqual([
      'PAYMENT_CANCEL',
      'PAYMENT_CANCEL_REVERSAL',
      'START_GRANT',
      'CLOSURE_FORFEIT',
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

  it('names the eleven market statuses of the plan, VOID a result and not a status (#174)', () => {
    expect(enums.MARKET_STATUSES).toEqual([
      'draft',
      'review',
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
      'resolved',
      'settling',
      'settled',
      'cancelled',
    ]);
    expect(enums.marketStatusSchema.safeParse('voided').success).toBe(false);
    // The result type is its own tuple; a contract side is never VOID.
    expect(enums.MARKET_RESULTS).toEqual(['YES', 'NO', 'VOID']);
    expect(enums.marketResultSchema.parse('VOID')).toBe('VOID');
    expect(enums.marketResultSchema.safeParse('MAYBE').success).toBe(false);
    expect(enums.OUTCOMES).toEqual(['YES', 'NO']);
    expect(enums.outcomeSchema.safeParse('VOID').success).toBe(false);
    expect(enums.marketEventTypeSchema.parse('resolved')).toBe('resolved');
    expect(enums.marketEventTypeSchema.parse('settling')).toBe('settling');
    // The M5 dispute events and the voiding are gone: the database was emptied (#174), so no
    // old row carries them.
    for (const gone of ['resolve_proposed', 'result_changed', 'voided']) {
      expect(enums.marketEventTypeSchema.safeParse(gone).success).toBe(false);
    }
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

  it('gives the forfeiture of a closure a ledger type of its own (#140)', () => {
    // ADR-0069 decision 1 #57-16: the Coin left is forfeited under its own type '탈퇴 소멸',
    // referring to the closed account itself.
    expect(enums.ledgerEntryTypeSchema.parse('CLOSURE_FORFEIT')).toBe('CLOSURE_FORFEIT');
    expect(enums.ledgerRefTypeSchema.parse('account_closure')).toBe('account_closure');
  });
});
