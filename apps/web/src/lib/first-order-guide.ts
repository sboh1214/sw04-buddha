import { CONTRACT_TERMS, formatCoin } from '@buddha/shared';
import { copy } from '@/copy';
import { unbroken } from './order-confirm';

/**
 * 첫 주문 안내 (#59, ADR-0154): what the guide on 확인 says, by the order the screen confirms. Only
 * the chosen way's topics (owner answer 2026-11-21 #59-3): 즉시 거래 — 계약 지급액, 부분 체결, 가격
 * 보호; 지정가 — 계약 지급액, 지정가 대기, 부분 체결. The payouts come from `CONTRACT_TERMS`, the
 * figures the confirm rows use, so the guide never says a number the rows do not; each keeps its
 * unit on its line (`unbroken`, ADR-0140 결정 2-24).
 */

export type FirstOrderTopicId = 'payout' | 'resting' | 'partial' | 'protection';

export interface FirstOrderTopic {
  id: FirstOrderTopicId;
  title: string;
  body: string;
}

/**
 * '정답인 계약은 계약마다 100 Coin, 오답인 계약은 0 Coin을 받습니다. 시장이 무효로 끝나면 YES·NO 모두
 * 계약마다 50 Coin을 받습니다.' The VOID payout is one figure for both sides (ADR-0118); the unit
 * test pins that, so the sentence cannot outlive it.
 */
export function payoutText(): string {
  const win = `${copy.firstOrderGuidePayoutWinHead} ${unbroken(formatCoin(CONTRACT_TERMS.payoutCoin))}${copy.firstOrderGuidePayoutLoseHead} ${unbroken(formatCoin(0))}${copy.firstOrderGuidePayoutTail}`;
  const voided = `${copy.firstOrderGuideVoidHead} ${unbroken(formatCoin(CONTRACT_TERMS.voidPayoutYesCoin))}${copy.firstOrderGuidePayoutTail}`;
  return `${win} ${voided}`;
}

/** The topics for an order of this way and direction, in the order the guide lists them. */
export function firstOrderTopics(
  timeInForce: 'ioc' | 'gtc',
  side: 'buy' | 'sell',
): FirstOrderTopic[] {
  const payout: FirstOrderTopic = {
    id: 'payout',
    title: copy.firstOrderGuidePayout,
    body: payoutText(),
  };
  if (timeInForce === 'gtc') {
    return [
      payout,
      { id: 'resting', title: copy.firstOrderGuideResting, body: copy.firstOrderGuideRestingBody },
      {
        id: 'partial',
        title: copy.firstOrderGuidePartial,
        body:
          side === 'buy' ? copy.firstOrderGuidePartialGtcBuy : copy.firstOrderGuidePartialGtcSell,
      },
    ];
  }
  const protection =
    side === 'buy'
      ? `${copy.firstOrderGuideProtectionHead} ${copy.orderMaxBuyPrice}${copy.firstOrderGuideProtectionBuy}`
      : `${copy.firstOrderGuideProtectionHead} ${copy.orderMinSellPrice}${copy.firstOrderGuideProtectionSell}`;
  return [
    payout,
    { id: 'partial', title: copy.firstOrderGuidePartial, body: copy.firstOrderGuidePartialIoc },
    { id: 'protection', title: copy.firstOrderGuideProtection, body: protection },
  ];
}
