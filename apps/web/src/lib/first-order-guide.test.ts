import { CONTRACT_TERMS, formatCoin } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { firstOrderTopics, payoutText } from './first-order-guide';
import { unbroken } from './order-confirm';

describe('firstOrderTopics (#59, ADR-0154)', () => {
  it('gives an immediate order its payout, partial fill and price protection — no resting topic (#59-3)', () => {
    expect(firstOrderTopics('ioc', 'buy').map((t) => t.id)).toEqual([
      'payout',
      'partial',
      'protection',
    ]);
    expect(firstOrderTopics('ioc', 'sell').map((t) => t.id)).toEqual([
      'payout',
      'partial',
      'protection',
    ]);
  });

  it('gives a limit order its payout, resting and partial fill — no price protection (#59-3)', () => {
    for (const side of ['buy', 'sell'] as const) {
      expect(firstOrderTopics('gtc', side).map((t) => t.id)).toEqual([
        'payout',
        'resting',
        'partial',
      ]);
    }
  });

  it('names the limit the confirm rows show: 최대 매수 단가 for a buy, 최소 매도 단가 for a sell', () => {
    const buy = firstOrderTopics('ioc', 'buy').find((t) => t.id === 'protection');
    const sell = firstOrderTopics('ioc', 'sell').find((t) => t.id === 'protection');
    expect(buy?.body).toContain(copy.orderMaxBuyPrice);
    expect(buy?.body).not.toContain(copy.orderMinSellPrice);
    expect(sell?.body).toContain(copy.orderMinSellPrice);
    expect(sell?.body).not.toContain(copy.orderMaxBuyPrice);
  });

  it('says how a partial fill ends by the way of the order, and for a limit order by its direction', () => {
    for (const side of ['buy', 'sell'] as const) {
      const ioc = firstOrderTopics('ioc', side).find((t) => t.id === 'partial');
      expect(ioc?.body).toBe(copy.firstOrderGuidePartialIoc);
    }
    const gtcBuy = firstOrderTopics('gtc', 'buy').find((t) => t.id === 'partial');
    const gtcSell = firstOrderTopics('gtc', 'sell').find((t) => t.id === 'partial');
    expect(gtcBuy?.body).toBe(copy.firstOrderGuidePartialGtcBuy);
    expect(gtcSell?.body).toBe(copy.firstOrderGuidePartialGtcSell);
    // A sell's filled contracts leave its holding: it never says they become one.
    expect(gtcSell?.body).not.toContain('보유가 되');
  });

  it('takes the payouts from CONTRACT_TERMS, the figures the confirm rows use', () => {
    const text = payoutText();
    expect(text).toContain(unbroken(formatCoin(CONTRACT_TERMS.payoutCoin)));
    expect(text).toContain(unbroken(formatCoin(CONTRACT_TERMS.voidPayoutYesCoin)));
    // Each figure keeps its unit on its line: a no-break space between them (ADR-0140 결정 2-24).
    expect(text).toBe(
      '정답인 계약은 계약마다 100\u00a0Coin, 오답인 계약은 0\u00a0Coin을 받습니다. 시장이 무효로 끝나면 YES·NO 모두 계약마다 50\u00a0Coin을 받습니다.',
    );
    // One VOID figure for both sides (ADR-0118): the sentence says 'YES·NO 모두'.
    expect(CONTRACT_TERMS.voidPayoutNoCoin).toBe(CONTRACT_TERMS.voidPayoutYesCoin);
    // Trading is not guessing right (오너 결정 #14-5): the rows' 정답·오답, never 맞으면·틀리면.
    expect(text).not.toMatch(/맞으면|맞히|틀리면/);
    for (const topic of firstOrderTopics('gtc', 'buy')) expect(topic.body).not.toContain('%');
  });
});
