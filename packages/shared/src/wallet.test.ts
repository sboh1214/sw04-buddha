import { describe, expect, it } from 'vitest';
import {
  ADJUST_MAX_ABS_P,
  CHARGE_MAX_P,
  CHARGE_MIN_P,
  CHARGE_PRESETS_P,
  adminUserQuerySchema,
  auditFailureSchema,
  balanceAdjustBodySchema,
  chargeBodySchema,
  ledgerEntrySchema,
  paymentSchema,
} from './wallet.js';

describe('chargeBodySchema', () => {
  it('accepts the bounds and yields a bigint', () => {
    expect(chargeBodySchema.parse({ amountP: CHARGE_MIN_P.toString() })).toEqual({
      amountP: CHARGE_MIN_P,
    });
    expect(chargeBodySchema.parse({ amountP: CHARGE_MAX_P.toString() })).toEqual({
      amountP: CHARGE_MAX_P,
    });
  });

  it('rejects amounts outside the bounds, zero, negatives and non-integers', () => {
    for (const amountP of [
      (CHARGE_MIN_P - 1n).toString(),
      (CHARGE_MAX_P + 1n).toString(),
      '0',
      '-10000',
      '1000.5',
      '10_000',
      '',
    ]) {
      expect(chargeBodySchema.safeParse({ amountP }).success, amountP).toBe(false);
    }
  });

  it('offers presets that are all chargeable', () => {
    for (const preset of CHARGE_PRESETS_P) {
      expect(chargeBodySchema.safeParse({ amountP: preset.toString() }).success).toBe(true);
    }
  });
});

describe('balanceAdjustBodySchema', () => {
  it('accepts a signed amount with a reason', () => {
    expect(balanceAdjustBodySchema.parse({ amountP: '-3000', memo: '중복 충전 회수' })).toEqual({
      amountP: -3000n,
      memo: '중복 충전 회수',
    });
    expect(balanceAdjustBodySchema.parse({ amountP: '2500', memo: '  보상  ' }).memo).toBe('보상');
  });

  it('requires a non-zero amount within the cap and a non-empty reason', () => {
    for (const body of [
      { amountP: '0', memo: '영원' },
      { amountP: (ADJUST_MAX_ABS_P + 1n).toString(), memo: '과다' },
      { amountP: (-ADJUST_MAX_ABS_P - 1n).toString(), memo: '과다' },
      { amountP: '1000', memo: '   ' },
      { amountP: '1000' },
    ]) {
      expect(balanceAdjustBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('response schemas', () => {
  const createdAt = '2026-09-03T04:05:06.000Z';

  it('parses a ledger entry, including a null reference and memo', () => {
    expect(
      ledgerEntrySchema.parse({
        id: '12',
        type: 'DEPOSIT',
        amountP: '10000',
        balanceAfterP: '10000',
        refType: 'payment',
        refId: 'p1',
        memo: null,
        createdAt,
      }),
    ).toMatchObject({ type: 'DEPOSIT', amountP: '10000' });

    expect(
      ledgerEntrySchema.safeParse({
        id: '12',
        type: 'UNKNOWN',
        amountP: '1',
        balanceAfterP: '1',
        refType: null,
        refId: null,
        memo: null,
        createdAt,
      }).success,
    ).toBe(false);
  });

  it('parses a payment and an audit failure', () => {
    expect(
      paymentSchema.parse({
        id: '3f1a5b6c-1111-4222-8333-444455556666',
        amountP: '5000',
        provider: 'mock',
        providerRef: 'mock_1',
        status: 'succeeded',
        createdAt,
      }).status,
    ).toBe('succeeded');

    expect(
      auditFailureSchema.parse({
        id: '1',
        kind: 'ledger_balance_mismatch',
        payload: { userId: 'u1' },
        createdAt,
      }).kind,
    ).toBe('ledger_balance_mismatch');
  });

  it('takes an optional search term on the admin user query', () => {
    expect(adminUserQuerySchema.parse({ q: ' 예측가 ' })).toMatchObject({ q: '예측가', limit: 20 });
    expect(adminUserQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });
});
