import { LEDGER_ENTRY_TYPES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Me } from './api';
import { LEDGER_TYPE_LABEL, startGrantPending } from './wallet';

describe('LEDGER_TYPE_LABEL', () => {
  it('names every ledger type, each with a word of its own', () => {
    expect(Object.keys(LEDGER_TYPE_LABEL).sort()).toEqual([...LEDGER_ENTRY_TYPES].sort());
    const labels = Object.values(LEDGER_TYPE_LABEL);
    // Two types under one word would make 이용 내역 tell two sources of Coin as one (N04 §5).
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("calls the start Coin '시작 지급', never the coupon's 보너스 (ADR-0069 decision 4 #70)", () => {
    expect(LEDGER_TYPE_LABEL.START_GRANT).toBe('시작 지급');
    expect(LEDGER_TYPE_LABEL.START_GRANT).not.toBe(LEDGER_TYPE_LABEL.BONUS);
    expect(LEDGER_TYPE_LABEL.START_GRANT).not.toContain('보너스');
  });
});

describe('startGrantPending', () => {
  const pending: Pick<Me, 'startGrant'> = {
    startGrant: { status: 'pending', amountCoin: null, grantedAt: null },
  };
  const granted: Pick<Me, 'startGrant'> = {
    startGrant: { status: 'granted', amountCoin: '10000', grantedAt: '2026-10-18T00:00:00.000Z' },
  };

  it('is true only while the grant waits for its amount', () => {
    expect(startGrantPending(pending)).toBe(true);
  });

  it('says nothing once it is paid, without a grant record, or before the profile is known', () => {
    // Paid: the ledger's 시작 지급 row says so. No record: the account has not finished the
    // onboarding, or its number's start Coin went to an earlier account — nothing is waiting.
    expect(startGrantPending(granted)).toBe(false);
    expect(startGrantPending({ startGrant: null })).toBe(false);
    expect(startGrantPending(undefined)).toBe(false);
  });

  it("shows the owner's words for the wait, with no amount and no date", () => {
    expect(copy.walletStartGrantPending).toBe('시작 Coin은 준비되는 대로 지급됩니다.');
    // Nothing is decided while it waits: the notice promises neither a figure nor a time.
    expect(copy.walletStartGrantPending).not.toMatch(/\d/);
  });
});
