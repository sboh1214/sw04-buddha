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
    // removals so far recreated the type on an emptied table: MARKET_VOID_REFUND (0017), and the
    // ledger types #116 replaced (0060, ADR-0109), whose order is pinned here from then on.
    expect(enums.PAYMENT_STATUSES.slice(0, 3)).toEqual(['pending', 'succeeded', 'failed']);
    expect(enums.PAYMENT_STATUSES.slice(3)).toEqual(['cancelled', 'refunding', 'refunded']);
    expect(enums.LEDGER_ENTRY_TYPES).toEqual([
      'START_GRANT',
      'TREASURY_MINT',
      'BOT_ALLOCATION',
      'BOT_RECALL',
      'PAIR_MINT_COLLATERAL',
      'PAIR_BURN_RETURN',
      'TRADE_FILL',
      'SETTLEMENT_PAYOUT',
      'CLOSURE_FORFEIT',
      'RECONCILIATION_CORRECTION',
      'DEPOSIT',
      'BONUS',
      'PAYMENT_CANCEL',
      'PAYMENT_CANCEL_REVERSAL',
    ]);
    expect(enums.paymentStatusSchema.parse('refunding')).toBe('refunding');
    expect(enums.ledgerEntryTypeSchema.parse('PAYMENT_CANCEL_REVERSAL')).toBe(
      'PAYMENT_CANCEL_REVERSAL',
    );
  });

  it('has no admin adjustment, no fee and no side-of-trade ledger type (#116)', () => {
    // ADR-0107 결정 2 #73 7항 (관리자 잔액 조정 폐지), 15항 (수수료 0, FEE 행 없음) and 1항 (체결은
    // 체결 대금 하나): the types and the admin action went with migration 0060.
    for (const type of ['ADMIN_ADJUST', 'FEE', 'TRADE_BUY', 'TRADE_SELL']) {
      expect(enums.ledgerEntryTypeSchema.safeParse(type).success, type).toBe(false);
    }
    expect(enums.adminActionTypeSchema.safeParse('balance_adjust').success).toBe(false);
    expect(enums.ledgerRefTypeSchema.safeParse('admin_action').success).toBe(false);
    expect(enums.LEDGER_ACCOUNT_KINDS).toEqual([
      'user',
      'treasury',
      'market_collateral',
      'market_maker_funds',
    ]);
    expect(enums.ledgerRefTypeSchema.parse('approval_request')).toBe('approval_request');
    expect(enums.ledgerRefTypeSchema.parse('audit_failure')).toBe('audit_failure');
  });

  it('has no value only the direct AMM wrote (#125)', () => {
    // The void cost refund, the opening tick and the AMM counterparty are gone, and their
    // Postgres types were recreated without them on an emptied database (migration 0017).
    expect(enums.ledgerEntryTypeSchema.safeParse('MARKET_VOID_REFUND').success).toBe(false);
    expect(enums.priceTickTriggerSchema.safeParse('open').success).toBe(false);
    expect(enums).not.toHaveProperty('COUNTERPARTY_TYPES');
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

  it('records the market review in the market events and the admin log (#78)', () => {
    // Each status change of the review and the reschedule, in the lifecycle's order after the
    // draft's creation, then the open — scheduled → open since #21, draft → open before it.
    expect(enums.MARKET_EVENT_TYPES.slice(0, 7)).toEqual([
      'created',
      'submitted',
      'approved',
      'rejected',
      'reverted',
      'open_rescheduled',
      'opened',
    ]);
    expect(enums.ADMIN_ACTION_TYPES).toEqual(
      expect.arrayContaining([
        'market_submit',
        'market_approve',
        'market_reject',
        'market_revert',
        'market_reschedule',
      ]),
    );
    // Retired by #21 (nothing writes it), kept so the interim open's rows still parse.
    expect(enums.adminActionTypeSchema.parse('market_open')).toBe('market_open');
    expect(new Set(enums.MARKET_EVENT_TYPES).size).toBe(enums.MARKET_EVENT_TYPES.length);
    expect(new Set(enums.ADMIN_ACTION_TYPES).size).toBe(enums.ADMIN_ACTION_TYPES.length);
  });

  it('records a rule supplement as one market event and four admin actions (#80)', () => {
    // Appended after #78's and the lifecycle's types (#114 appended after it), and a supplement
    // changes no status.
    expect(enums.MARKET_EVENT_TYPES.indexOf('rules_supplemented')).toBe(
      enums.MARKET_EVENT_TYPES.indexOf('settling') + 1,
    );
    expect(enums.MARKET_EVENT_TYPES.filter((type) => type.startsWith('rules_'))).toEqual([
      'rules_edited',
      'rules_supplemented',
    ]);
    // Its request, 반려 and 철회 write no market event; each of the four is an admin action.
    const supplement = enums.ADMIN_ACTION_TYPES.filter((type) =>
      type.startsWith('market_supplement_'),
    );
    expect(supplement).toEqual([
      'market_supplement_request',
      'market_supplement_approve',
      'market_supplement_reject',
      'market_supplement_retract',
    ]);
    // admin_actions.type and market_events.type are varchar(40).
    for (const type of [...supplement, 'rules_supplemented']) {
      expect(type.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(enums.MARKET_EVENT_TYPES).size).toBe(enums.MARKET_EVENT_TYPES.length);
    expect(new Set(enums.ADMIN_ACTION_TYPES).size).toBe(enums.ADMIN_ACTION_TYPES.length);
  });

  it('records a pause and its next path as two market events and five admin actions (#114)', () => {
    // Appended: a pause (open → paused) and a resume (paused → open), #152's, #176's, #142's,
    // #119's and #20's after them; an early close is `closed` with its own `source`, the worker's
    // close too (or `cancelled` with no fill a person is on, #20).
    expect(enums.MARKET_EVENT_TYPES.slice(-7, -5)).toEqual(['paused', 'resumed']);
    expect(enums.MARKET_EVENT_TYPES.filter((type) => type === 'closed')).toHaveLength(1);
    // The pause is one admin's; the next path's request, approval, 반려 and 철회 are each an admin
    // action, and only the approval writes a market event.
    const pause = enums.ADMIN_ACTION_TYPES.filter((type) => type.startsWith('market_pause'));
    expect(pause).toEqual([
      'market_pause',
      'market_pause_decision_request',
      'market_pause_decision_approve',
      'market_pause_decision_reject',
      'market_pause_decision_retract',
    ]);
    // Retired by #114 (nothing writes it), kept so the one-admin close's rows still parse.
    expect(enums.adminActionTypeSchema.parse('market_close')).toBe('market_close');
    // admin_actions.type and market_events.type are varchar(40).
    for (const type of [...pause, 'paused', 'resumed']) {
      expect(type.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(enums.MARKET_EVENT_TYPES).size).toBe(enums.MARKET_EVENT_TYPES.length);
    expect(new Set(enums.ADMIN_ACTION_TYPES).size).toBe(enums.ADMIN_ACTION_TYPES.length);
  });

  it('records a judgement as one market event and four admin actions (#152)', () => {
    // Appended after #114's: the approval's closed → provisional (#176's correction after it).
    // The worker's provisional → resolved keeps the name the interim judgement wrote, so its old
    // rows still read.
    expect(enums.MARKET_EVENT_TYPES.indexOf('provisional')).toBe(
      enums.MARKET_EVENT_TYPES.indexOf('resumed') + 1,
    );
    expect(enums.MARKET_EVENT_TYPES.filter((type) => type === 'resolved')).toHaveLength(1);
    // The registration, 반려 and 철회 write no market event; each of the four is an admin action,
    // appended after #114's.
    const judgement = enums.ADMIN_ACTION_TYPES.filter((type) =>
      type.startsWith('market_judgement_'),
    );
    expect(judgement).toEqual([
      'market_judgement_request',
      'market_judgement_approve',
      'market_judgement_reject',
      'market_judgement_retract',
    ]);
    expect(enums.ADMIN_ACTION_TYPES.indexOf('market_judgement_request')).toBe(
      enums.ADMIN_ACTION_TYPES.indexOf('market_pause_decision_retract') + 1,
    );
    // Retired by #152 (nothing writes it), kept so the interim judgement's rows still parse.
    expect(enums.adminActionTypeSchema.parse('market_resolve')).toBe('market_resolve');
    // admin_actions.type and market_events.type are varchar(40).
    for (const type of [...judgement, 'provisional']) {
      expect(type.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(enums.MARKET_EVENT_TYPES).size).toBe(enums.MARKET_EVENT_TYPES.length);
    expect(new Set(enums.ADMIN_ACTION_TYPES).size).toBe(enums.ADMIN_ACTION_TYPES.length);
  });

  it('records a dispute decision as an admin action and no market event (#175)', () => {
    // Dismiss and accept, right after #152's judgement records; the submission and the
    // retraction are the member's own rows, and the confirmation stays `resolved`.
    const disputes = enums.ADMIN_ACTION_TYPES.filter((type) => type.startsWith('market_dispute_'));
    expect(disputes).toEqual(['market_dispute_dismiss', 'market_dispute_accept']);
    expect(enums.ADMIN_ACTION_TYPES.indexOf('market_dispute_dismiss')).toBe(
      enums.ADMIN_ACTION_TYPES.indexOf('market_judgement_retract') + 1,
    );
    // No market event of its own: #152's `provisional` is followed by #176's correction,
    // #142's delay record, #119's width change and #20's cancel alone.
    expect(enums.MARKET_EVENT_TYPES.slice(-5)).toEqual([
      'provisional',
      'judgement_corrected',
      'judgement_delay_recorded',
      'price_protection_changed',
      'cancelled',
    ]);
    expect(enums.MARKET_EVENT_TYPES.filter((type) => type.includes('dispute'))).toEqual([]);
    // The M5 review type stays gone; admin_actions.type is varchar(40).
    expect(enums.ADMIN_ACTION_TYPES).not.toContain('dispute_review');
    for (const type of disputes) expect(type.length).toBeLessThanOrEqual(40);
  });

  it('records a correction as one market event and the judgement’s admin actions (#176)', () => {
    // Appended after #152's (#142's, #119's and #20's after it): a correction's approval changes no
    // status (PROVISIONAL stays) and is the one market event a correction writes. Its name says
    // nothing of disputes, whose records are no market events (#175), though it closes the replaced
    // version's pending ones.
    expect(enums.MARKET_EVENT_TYPES.at(-4)).toBe('judgement_corrected');
    expect(enums.MARKET_EVENT_TYPES.indexOf('judgement_corrected')).toBe(
      enums.MARKET_EVENT_TYPES.indexOf('provisional') + 1,
    );
    expect(enums.marketEventTypeSchema.parse('judgement_corrected')).toBe('judgement_corrected');
    expect('judgement_corrected'.length).toBeLessThanOrEqual(40);
    // The registration, approval, 반려 and 철회 reuse #152's four types (one approval kind).
    expect(
      enums.ADMIN_ACTION_TYPES.filter((type) => type.startsWith('market_judgement_')),
    ).toHaveLength(4);
    // Coin reconciliation is separate; judgement corrections reuse the judgement actions.
    expect(enums.ADMIN_ACTION_TYPES.filter((type) => type.includes('correct'))).toEqual([
      'reconciliation_correction_request',
      'reconciliation_correction_approve',
      'reconciliation_correction_reject',
      'reconciliation_correction_retract',
    ]);
    expect(new Set(enums.MARKET_EVENT_TYPES).size).toBe(enums.MARKET_EVENT_TYPES.length);
  });

  it('records a delay record as one market event and one admin action (#142)', () => {
    // Appended after #176's (#119's and #20's after it): a record changes no status (CLOSED or
    // PROVISIONAL stays) and is one event and one admin action — one admin, no approval kind (#173
    // item 2).
    expect(enums.MARKET_EVENT_TYPES.at(-3)).toBe('judgement_delay_recorded');
    expect(enums.MARKET_EVENT_TYPES.indexOf('judgement_delay_recorded')).toBe(
      enums.MARKET_EVENT_TYPES.indexOf('judgement_corrected') + 1,
    );
    expect(enums.marketEventTypeSchema.parse('judgement_delay_recorded')).toBe(
      'judgement_delay_recorded',
    );
    expect(enums.ADMIN_ACTION_TYPES.indexOf('market_delay_record')).toBe(
      enums.ADMIN_ACTION_TYPES.indexOf('market_dispute_accept') + 1,
    );
    expect(enums.adminActionTypeSchema.parse('market_delay_record')).toBe('market_delay_record');
    // The one type of each that names a delay; neither joins the prefix families above (#80's
    // supplement, #114's pause, #152's judgement, #175's dispute), nor names a dispute or a
    // correction, and neither withdraws (owner answer 2026-11-03 (4): no withdrawal).
    expect(enums.MARKET_EVENT_TYPES.filter((type) => type.includes('delay'))).toEqual([
      'judgement_delay_recorded',
    ]);
    expect(enums.ADMIN_ACTION_TYPES.filter((type) => type.includes('delay'))).toEqual([
      'market_delay_record',
    ]);
    for (const prefix of [
      'market_supplement_',
      'market_pause',
      'market_judgement',
      'market_dispute',
    ]) {
      expect('market_delay_record'.startsWith(prefix), prefix).toBe(false);
    }
    for (const type of ['judgement_delay_recorded', 'market_delay_record']) {
      for (const word of ['dispute', 'correct', 'withdraw', 'retract']) {
        expect(type.includes(word), `${type} ${word}`).toBe(false);
      }
      // admin_actions.type and market_events.type are varchar(40).
      expect(type.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(enums.MARKET_EVENT_TYPES).size).toBe(enums.MARKET_EVENT_TYPES.length);
    expect(new Set(enums.ADMIN_ACTION_TYPES).size).toBe(enums.ADMIN_ACTION_TYPES.length);
  });

  it('records a market cancel as one market event and four admin actions (#20)', () => {
    // Appended last: one event type for all three paths to CANCELLED, told apart by the payload's
    // `source` (the worker's close, an approved early close, an operator's SCHEDULED cancel). The
    // close and the early close of a market with a person's fill stay `closed`.
    expect(enums.MARKET_EVENT_TYPES.at(-1)).toBe('cancelled');
    expect(enums.MARKET_EVENT_TYPES.filter((type) => type.startsWith('cancel'))).toEqual([
      'cancelled',
    ]);
    expect(enums.marketEventTypeSchema.parse('cancelled')).toBe('cancelled');
    // A SCHEDULED market's cancel request, approval, 반려 and 철회 are admin actions, appended
    // last; only the approval writes a market event.
    const cancel = enums.ADMIN_ACTION_TYPES.filter((type) => type.startsWith('market_cancel'));
    expect(cancel).toEqual([
      'market_cancel_request',
      'market_cancel_approve',
      'market_cancel_reject',
      'market_cancel_retract',
    ]);
    expect(enums.ADMIN_ACTION_TYPES.slice(-4)).toEqual(cancel);
    // admin_actions.type and market_events.type are varchar(40).
    for (const type of [...cancel, 'cancelled']) expect(type.length).toBeLessThanOrEqual(40);
    expect(new Set(enums.MARKET_EVENT_TYPES).size).toBe(enums.MARKET_EVENT_TYPES.length);
    expect(new Set(enums.ADMIN_ACTION_TYPES).size).toBe(enums.ADMIN_ACTION_TYPES.length);
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
    expect(enums.timeInForceSchema.parse('ioc')).toBe('ioc');
    expect(enums.priceTickTriggerSchema.parse('trade')).toBe('trade');
    expect(enums.adminActionTypeSchema.parse('coupon_create')).toBe('coupon_create');
    expect(enums.auditFailureKindSchema.parse('ledger_balance_mismatch')).toBe(
      'ledger_balance_mismatch',
    );
    expect(enums.ledgerRefTypeSchema.parse('fill')).toBe('fill');
    expect(enums.categorySlugSchema.parse('weather')).toBe('weather');
  });

  it('names the six order states and the reasons of ADR-0107 #177 7·8항 in its order (#119)', () => {
    // 대기·부분 체결·전량 체결·취소 완료·만료·거절.
    expect(enums.ORDER_STATUSES).toEqual([
      'open',
      'partially_filled',
      'filled',
      'cancelled',
      'expired',
      'rejected',
    ]);
    // 잔액 부족·보유량 부족·개장 전·마감·일시 중단·호가 부족·가격 한도·금액 부족·자기 체결.
    expect(enums.ORDER_REJECT_REASONS).toEqual([
      'insufficient_coin',
      'insufficient_contracts',
      'not_open_yet',
      'closed',
      'paused',
      'no_quote',
      'price_limit',
      'budget_too_small',
      'self_trade',
      'ledger_hold',
    ]);
    expect(enums.orderRejectReasonSchema.options).toEqual([...enums.ORDER_REJECT_REASONS]);
    // 본인 취소·즉시 거래 잔량·자기 체결·일시 중단·관리자 권한·계정 제한·탈퇴.
    expect(enums.ORDER_CANCEL_REASONS).toEqual([
      'by_owner',
      'ioc_remainder',
      'self_trade',
      'paused',
      'admin_role',
      'restricted',
      'account_closed',
    ]);
    expect(enums.orderCancelReasonSchema.options).toEqual([...enums.ORDER_CANCEL_REASONS]);
    expect(enums.fillKindSchema.options).toEqual(['trade', 'pair_mint']);
    // Every order carries a limit, so there is no market order type (#177 2항), and a fill names
    // both orders itself (no counterparty type).
    expect(enums).not.toHaveProperty('ORDER_TYPES');
    expect(enums).not.toHaveProperty('orderTypeSchema');
    expect(enums.MARKET_EVENT_TYPES).toContain('price_protection_changed');
    expect(enums.ADMIN_ACTION_TYPES).toContain('market_price_protection_change');
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
