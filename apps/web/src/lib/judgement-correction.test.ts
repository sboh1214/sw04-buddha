import { findExcludedText } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  publicCompensationText,
  recapCompensationOf,
  recapCompensationText,
  recapCorrectedResultText,
  settlementCorrectedText,
} from './judgement-correction';

const entry = (amountCoin: string, kind: 'JUDGEMENT_COMPENSATION' | 'SETTLEMENT_PAYOUT') => ({
  kind,
  amountCoin,
});

/**
 * The member side of a 판정 오류 보상 (#144 part 2, ADR-0166; 144-6, 144-11, 144-15, 144-17,
 * 144-19): the public line, the recap's own amount and MY 정산 이력's mark.
 */
describe('the 판정 정정’s 보상 in public (144-6, 144-15)', () => {
  it('says the four states, the closed targets apart, and never 0 Coin without the 대상 count', () => {
    const none = { accountCount: null, paidCount: null, totalCoin: null };
    expect(publicCompensationText({ status: 'preparing', ...none })).toBe('보상 준비 중');
    expect(publicCompensationText({ status: 'none', ...none })).toBe('보상 대상 없음');
    expect(
      publicCompensationText({
        status: 'pending',
        accountCount: 1200,
        paidCount: null,
        totalCoin: null,
      }),
    ).toBe('승인 대기 · 대상 계정 1,200개');
    expect(
      publicCompensationText({ status: 'paid', accountCount: 2, paidCount: 2, totalCoin: '150' }),
    ).toBe('지급 완료 · 대상 계정 2개 · 총 150 Coin');
    expect(
      publicCompensationText({ status: 'paid', accountCount: 3, paidCount: 2, totalCoin: '150' }),
    ).toBe('지급 완료 · 대상 계정 3개 중 2개 지급 · 총 150 Coin');
    expect(
      publicCompensationText({ status: 'paid', accountCount: 1, paidCount: 0, totalCoin: '0' }),
    ).toBe('지급 완료 · 대상 계정 1개 중 0개 지급 · 총 0 Coin');
  });
});

describe('the recap’s 판정 정정 (144-11)', () => {
  it('reads the account’s own entries only once paid, and never says 보상 없음 before', () => {
    const unread = { entries: undefined, failed: false };
    expect(recapCompensationOf('preparing', unread)).toEqual({ kind: 'preparing' });
    expect(recapCompensationOf('pending', unread)).toEqual({ kind: 'pending' });
    expect(recapCompensationOf('none', unread)).toEqual({ kind: 'none' });
    expect(recapCompensationOf('paid', unread)).toEqual({ kind: 'reading' });
    expect(recapCompensationOf('paid', { entries: undefined, failed: true })).toEqual({
      kind: 'failed',
    });
    expect(
      recapCompensationOf('paid', {
        entries: [entry('100', 'JUDGEMENT_COMPENSATION')],
        failed: false,
      }),
    ).toEqual({ kind: 'amount', coin: 100n });
    // Paid, and nothing for this account (an over-paid holder, a sold-out one): 보상 없음.
    expect(recapCompensationOf('paid', { entries: [], failed: false })).toEqual({ kind: 'none' });
    // Another kind under the same market never counts.
    expect(
      recapCompensationOf('paid', {
        entries: [entry('200', 'SETTLEMENT_PAYOUT')],
        failed: false,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('words each state as 144-19 approved', () => {
    expect(recapCompensationText({ kind: 'amount', coin: 1250n })).toBe('내 보상 1,250 Coin');
    expect(recapCompensationText({ kind: 'none' })).toBe('보상 없음');
    expect(recapCompensationText({ kind: 'pending' })).toBe('보상 승인 대기');
    expect(recapCompensationText({ kind: 'preparing' })).toBe('보상 준비 중');
    expect(recapCompensationText({ kind: 'reading' })).toBe('—');
    expect(recapCorrectedResultText('NO')).toBe('정정된 결과 NO');
    expect(recapCorrectedResultText('VOID')).toBe('정정된 결과 무효');
    expect([copy.recapCorrection, copy.recapJudgingRecord]).toEqual([
      '판정 정정',
      '판정 기록 보기',
    ]);
  });
});

describe('MY 정산 이력’s mark (144-17)', () => {
  it('names the corrected result alone, no amount', () => {
    expect(settlementCorrectedText('NO')).toBe('판정 정정 · 결과 NO');
    expect(settlementCorrectedText('VOID')).toBe('판정 정정 · 결과 무효');
  });
});

describe('the member words', () => {
  it('hold no refund, P&L, 정답 or excluded feature', () => {
    const texts = Object.entries(copy)
      .filter(
        ([key]) =>
          key.startsWith('judgingCompensation') ||
          key.startsWith('recapC') ||
          key === 'recapJudgingRecord' ||
          key === 'historySettlementCorrected' ||
          key === 'ledgerTypeJudgementCompensation' ||
          key === 'notificationJudgementCompensated',
      )
      .map(([, text]) => text);
    expect(texts.length).toBe(16);
    for (const text of texts) {
      expect(findExcludedText(text), text).toEqual([]);
      expect(text, text).not.toMatch(
        /환불|원금|송금|이체|리워드|적립|정산 오류|손익|정답|맞힌|\d+ Coin씩|수익률|순위/,
      );
    }
  });
});
