import {
  type MarketDisputeClosedByCorrectionParams,
  type MarketDisputeDecidedParams,
  type MarketJudgementCorrectedParams,
  type MarketJudgementDelayedParams,
  type MarketProvisionalResultParams,
  type MarketSettledParams,
  formatCoin,
  parseCoinAmount,
} from '@buddha/shared';
import { copy } from '@/copy';
import { DISPUTE_STATUS_LABEL } from './disputes';
import { MARKET_RESULT_LABEL } from './market-admin';
import { fillNotificationText } from './trade-notifications';

/**
 * 판정·정산 알림 (#188, ADR-0160; N05 §4; owner answers 52-1, 52-11…52-15, 188-1…188-6) as the
 * inbox's row words them: the titles of `market_judgement_delayed`, `market_provisional_result`,
 * `market_judgement_corrected`, `market_dispute_decided`, `market_dispute_closed_by_correction` and
 * `market_settled` from the params their definitions parsed (@buddha/shared notifications.ts), in
 * the sentences the owner approved (188-1). Each is copy.ts' single-brace template filled by
 * `fillNotificationText` (ADR-0158 12-10), which inserts a value as it is — a stored title or
 * reason holding `{x}` or `$&` stays as written. A result is named as the detail's result row
 * names it (MARKET_RESULT_LABEL: YES·NO·무효) and a decision as MY 판정 이의 does
 * (DISPUTE_STATUS_LABEL: 기각·수용).
 *
 * A time is the member's (52-15, ADR-0093 #22): `format` is the caller's — the renderer passes
 * `useFormatDateTime()`'s — so this module stays pure and node-safe and
 * judgement-notifications.test.ts runs it with a fixed one. The 판정 기준 시간대's second line under
 * a timed title is the renderer's (`JudgementZoneLine`), not part of the sentence. Every type leads
 * to the market's detail (`market` target, 188-4), which this module does not draw.
 */

/** An absolute time as the member reads it: `formatInTimeZone(iso, zone)` bound to the zone. */
export type FormatDateTime = (iso: string) => string;

/**
 * A `market_judgement_delayed` title (52-11, 52-15): the market, the record's 다음 검토 시각 in the
 * member's zone and its public reason as written.
 */
export function judgementDelayedTitle(
  params: MarketJudgementDelayedParams,
  format: FormatDateTime,
): string {
  return fillNotificationText(copy.notificationJudgementDelayed, {
    market: params.marketTitle,
    nextReview: format(params.nextReviewAt),
    reason: params.reason,
  });
}

/**
 * A `market_provisional_result` title (52-12, 52-15): the market, its 잠정 결과 and its 이의 기한 —
 * no expected payout (52-15 '예상 지급액 없음').
 */
export function provisionalResultTitle(
  params: MarketProvisionalResultParams,
  format: FormatDateTime,
): string {
  return fillNotificationText(copy.notificationProvisionalResult, {
    market: params.marketTitle,
    result: MARKET_RESULT_LABEL[params.result],
    deadline: format(params.disputeDeadline),
  });
}

/**
 * A `market_judgement_corrected` title (52-12, 52-14, 188-1): the corrected 잠정 결과 and its new
 * 이의 기한 — never the previous result, and the same sentence for a correction that kept the
 * result and changed its grounds alone.
 */
export function judgementCorrectedTitle(
  params: MarketJudgementCorrectedParams,
  format: FormatDateTime,
): string {
  return fillNotificationText(copy.notificationJudgementCorrected, {
    market: params.marketTitle,
    result: MARKET_RESULT_LABEL[params.result],
    deadline: format(params.disputeDeadline),
  });
}

/**
 * A `market_dispute_decided` title (52-14, 188-3): 기각 or 수용 of the member's own 판정 이의 and the
 * decision's public reason as written.
 */
export function disputeDecidedTitle(params: MarketDisputeDecidedParams): string {
  return fillNotificationText(copy.notificationDisputeDecided, {
    market: params.marketTitle,
    decision: DISPUTE_STATUS_LABEL[params.decision],
    reason: params.reason,
  });
}

/**
 * A `market_dispute_closed_by_correction` title (52-14, 188-1): the member's 판정 이의 closed by an
 * approved correction and the new 이의 기한 alone — the corrected result is the correction notice's
 * and the detail's.
 */
export function disputeClosedByCorrectionTitle(
  params: MarketDisputeClosedByCorrectionParams,
  format: FormatDateTime,
): string {
  return fillNotificationText(copy.notificationDisputeClosedByCorrection, {
    market: params.marketTitle,
    deadline: format(params.disputeDeadline),
  });
}

/**
 * A `market_settled` title (52-12 '확정 결과와 지급 완료를 나눠 적는다', 52-15): the confirmed result
 * and 지급 완료 as two items and, for a holder at the payout, the member's own payout as Coin — 0
 * included ('0 Coin'), no P&L, a 무효 payout a 지급 like any other (N03 §6). A watcher who held
 * nothing (`payoutCoin` null) reads the sentence without it. No time: the row's 발생 시각 is the
 * payout's (188-1).
 */
export function marketSettledTitle(params: MarketSettledParams): string {
  const market = params.marketTitle;
  const result = MARKET_RESULT_LABEL[params.result];
  if (params.payoutCoin === null) {
    return fillNotificationText(copy.notificationMarketSettledWatcher, { market, result });
  }
  return fillNotificationText(copy.notificationMarketSettled, {
    market,
    result,
    payout: formatCoin(parseCoinAmount(params.payoutCoin)),
  });
}
