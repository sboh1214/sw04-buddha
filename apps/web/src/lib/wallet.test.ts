import { readFileSync } from 'node:fs';
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

describe('where the wait is told', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it("is one notice, drawn from startGrantPending with the owner's words", () => {
    const notice = source('../app/my/wallet/start-grant-notice.tsx');
    expect(notice).toContain('if (!startGrantPending(me)) return null;');
    expect(notice).toContain('{copy.walletStartGrantPending}');
  });

  it('is shown under the balance on the wallet and on MY 요약’s wallet preview (owner decision 2026-10-18)', () => {
    // The wallet's balance card (ADR-0069 decision 4 #70: '지갑에도') and the preview of the wallet
    // on MY's first screen, which shows the same balance; each with its own test id for the e2e.
    for (const [path, testId] of [
      ['../app/my/wallet/balance-card.tsx', 'wallet-start-grant-pending'],
      ['../app/my/summary.tsx', 'my-preview-wallet-start-grant-pending'],
    ] as const) {
      const screen = source(path);
      expect(screen, path).toMatch(/<StartGrantPendingNotice\b[^>]*\bme=\{me(\.data)?\}/s);
      expect(screen, path).toContain(`testId="${testId}"`);
      // Only through the shared notice: no second copy of the words or the rule.
      expect(screen, path).not.toContain('walletStartGrantPending');
    }
  });
});
