import {
  MARKET_STATUS_REJECT_REASONS,
  ORDER_CANCEL_REASONS,
  ORDER_REJECT_REASONS,
  ORDER_STATUSES,
  type OrderRejectReason,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  blockText,
  cancelReasonText,
  failureText,
  insufficientCoinLine,
  insufficientContractsLine,
  orderStatusLabel,
  rejectReasonText,
  restrictedLine,
  restrictedLineParts,
  sellableLine,
} from './order-reasons';
import { inputClosedShort } from './market-detail';

/**
 * 주문 패널's words for the server's answers (#66, ADR-0140; ADR-0135 결정 4, E3, D11, D12, D13).
 */
describe('the six states and their reasons', () => {
  it('names the six states as 결정 4 does, the keys MY reads too', () => {
    expect(ORDER_STATUSES.map(orderStatusLabel)).toEqual([
      '대기',
      '부분 체결',
      '전량 체결',
      '취소 완료',
      '만료',
      '거절',
    ]);
  });

  it('has a sentence for each of the eleven 거절 reasons, none the same', () => {
    const texts = ORDER_REJECT_REASONS.map(rejectReasonText);
    expect(texts).toHaveLength(11);
    expect(new Set(texts).size).toBe(11);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
  });

  it('says the acceptance’s six apart, and E3’s names', () => {
    const six: OrderRejectReason[] = [
      'insufficient_coin',
      'insufficient_contracts',
      'closed',
      'no_quote',
      'price_limit',
      'paused',
    ];
    expect(new Set(six.map(rejectReasonText)).size).toBe(6);
    expect(rejectReasonText('insufficient_coin')).toContain('잔액 부족');
    expect(rejectReasonText('insufficient_contracts')).toContain('보유량 부족');
    expect(rejectReasonText('closed')).toContain('마감');
    expect(rejectReasonText('no_quote')).toContain('호가 부족');
    expect(rejectReasonText('price_limit')).toContain('가격 한도');
    expect(rejectReasonText('paused')).toContain('일시 중단');
    expect(rejectReasonText('ledger_hold')).toContain('계정 확인 중');
    expect(rejectReasonText('admin_role_revoked')).toContain('관리자 권한');
  });

  it('says every 거절 in the past: the order was refused (계정 확인 중 too, 결정 2-23)', () => {
    for (const reason of ORDER_REJECT_REASONS) {
      expect(rejectReasonText(reason), reason).toMatch(/[았었랐였]습니다\.$/);
    }
  });

  it('names the seven 취소 reasons, and says the intake’s two', () => {
    const texts = ORDER_CANCEL_REASONS.map(cancelReasonText);
    expect(new Set(texts).size).toBe(7);
    expect(cancelReasonText('ioc_remainder')).toContain('즉시 거래 잔량');
    expect(cancelReasonText('self_trade')).toContain('자기 체결');
  });
});

describe('the figures of D11, and D13', () => {
  it('says 잔액 부족 with the available and the needed Coin', () => {
    expect(insufficientCoinLine(100n, 130n)).toBe('잔액 부족 — 가용 코인 100 Coin, 필요 130 Coin');
    expect(insufficientCoinLine(1_000n, 12_345n)).toBe(
      '잔액 부족 — 가용 코인 1,000 Coin, 필요 12,345 Coin',
    );
  });

  it('says what can be sold and what resting sells lock', () => {
    expect(sellableLine(2, 1)).toBe('매도 가능 2계약(대기 매도 잠금 1계약)');
    expect(sellableLine(0, 3)).toBe('매도 가능 0계약(대기 매도 잠금 3계약)');
    expect(insufficientContractsLine(2, 1)).toBe(
      '보유량 부족 — 매도 가능 2계약(대기 매도 잠금 1계약)',
    );
  });

  it('says a restriction’s end, or that it has none', () => {
    expect(restrictedLine('2026. 11. 20. 오후 3:00')).toBe(
      `${copy.orderRestricted}(2026. 11. 20. 오후 3:00${copy.orderRestrictedUntil})`,
    );
    expect(restrictedLine(null)).toBe(`${copy.orderRestricted}(${copy.orderRestrictedNoEnd})`);
  });

  it('keeps a restriction’s end in one piece, to be drawn unbroken (결정 2-23)', () => {
    expect(restrictedLineParts('2026. 11. 23. 오후 12:35')).toEqual([
      `${copy.orderRestricted}(`,
      `2026. 11. 23. 오후 12:35${copy.orderRestrictedUntil}`,
      ')',
    ]);
    expect(restrictedLineParts(null)[1]).toBe(copy.orderRestrictedNoEnd);
  });

  it('names the gap’s reasons short, as the 거절 sentences begin (결정 2-23)', () => {
    expect(inputClosedShort('not_open_yet')).toBe('개장 전');
    expect(inputClosedShort('paused')).toBe('일시 중단');
    expect(inputClosedShort('closed')).toBe('마감');
    for (const reason of MARKET_STATUS_REJECT_REASONS) {
      expect(rejectReasonText(reason).startsWith(`${inputClosedShort(reason)} — `)).toBe(true);
    }
  });

  it('gives each block a line', () => {
    expect(blockText('no_quote')).toBe(copy.orderBlockNoQuote);
    expect(blockText('no_width')).toBe(copy.orderBlockNoWidth);
    expect(blockText('budget_too_small')).toBe(copy.orderBlockBudget);
    // Before an order, not the 거절 row's past tense (결정 2-23).
    expect(blockText('price_limit')).toBe(copy.orderBlockPriceLimit);
    expect(blockText('price_limit')).not.toBe(rejectReasonText('price_limit'));
    expect(blockText('price_limit')).toContain('가격 한도');
    expect(blockText('price_limit')).not.toMatch(/[았었]습니다/);
    expect(blockText('admin')).toBe(copy.orderAdmin);
  });
});

describe('failureText: the refusals that write no row (orders.controller.ts)', () => {
  it('words each of the nine', () => {
    expect(failureText({ code: 'UNAUTHENTICATED' })).toBe(copy.orderSignIn);
    expect(failureText({ code: 'FORBIDDEN', anotherAccount: true })).toBe(copy.sessionChanged);
    expect(failureText({ code: 'FORBIDDEN' })).toBe(copy.orderForbidden);
    expect(failureText({ code: 'RESTRICTED', restrictedEndsAt: null })).toBe(restrictedLine(null));
    expect(failureText({ code: 'ONBOARDING_REQUIRED' })).toBe(copy.orderOnboarding);
    expect(failureText({ code: 'NOT_FOUND' })).toBe(copy.orderMarketGone);
    expect(failureText({ code: 'VALIDATION_ERROR' })).toBe(copy.orderInvalid);
    // D12, and a market with no 가격 보호 폭 (ADR-0135 결과 4).
    expect(failureText({ code: 'ORDER_INTAKE_CLOSED' })).toBe(copy.orderIntakeClosed);
    expect(failureText({ code: 'ORDER_INTAKE_CLOSED', noWidth: true })).toBe(
      copy.orderBlockNoWidth,
    );
    expect(failureText({ code: 'RATE_LIMITED', retryAfterSeconds: 12 })).toBe(
      `${copy.orderRateLimited}(12${copy.orderSeconds}).`,
    );
    expect(failureText({ code: 'RATE_LIMITED' })).toBe(`${copy.orderRateLimited}.`);
    expect(failureText({ code: 'INTERNAL' })).toBe(copy.errUnknown);
  });
});
