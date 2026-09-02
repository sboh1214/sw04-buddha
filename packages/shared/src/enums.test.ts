import { describe, expect, it } from 'vitest';
import * as enums from './enums.js';

describe('enums', () => {
  it('exposes tuple + schema pairs that agree', () => {
    expect(enums.roleSchema.parse('admin')).toBe('admin');
    expect(enums.outcomeSchema.parse('YES')).toBe('YES');
    expect(enums.marketStatusSchema.parse('resolving')).toBe('resolving');
    expect(enums.ledgerEntryTypeSchema.options).toEqual([...enums.LEDGER_ENTRY_TYPES]);
    expect(enums.orderStatusSchema.options).toEqual([...enums.ORDER_STATUSES]);
    expect(() => enums.outcomeSchema.parse('MAYBE')).toThrow();
  });

  it('never contains sports or election categories (PLAN 0.2)', () => {
    for (const slug of enums.CATEGORY_SLUGS) {
      expect(slug).not.toMatch(/sport|election|politic/i);
    }
    expect(enums.CATEGORY_SLUGS).toHaveLength(5);
  });

  it('keeps the remaining enum schemas parseable', () => {
    expect(enums.paymentStatusSchema.parse('succeeded')).toBe('succeeded');
    expect(enums.marketMechanismSchema.parse('lmsr')).toBe('lmsr');
    expect(enums.marketVisibilitySchema.parse('public')).toBe('public');
    expect(enums.marketEventTypeSchema.parse('rules_edited')).toBe('rules_edited');
    expect(enums.orderSideSchema.parse('buy')).toBe('buy');
    expect(enums.orderTypeSchema.parse('market')).toBe('market');
    expect(enums.timeInForceSchema.parse('ioc')).toBe('ioc');
    expect(enums.counterpartyTypeSchema.parse('amm')).toBe('amm');
    expect(enums.priceTickTriggerSchema.parse('trade')).toBe('trade');
    expect(enums.disputeStatusSchema.parse('open')).toBe('open');
    expect(enums.adminActionTypeSchema.parse('balance_adjust')).toBe('balance_adjust');
    expect(enums.auditFailureKindSchema.parse('ledger_balance_mismatch')).toBe(
      'ledger_balance_mismatch',
    );
    expect(enums.ledgerRefTypeSchema.parse('fill')).toBe('fill');
    expect(enums.categorySlugSchema.parse('weather')).toBe('weather');
  });
});
