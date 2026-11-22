import type {
  MarketCancelledParams,
  MarketClosedParams,
  MarketPausedParams,
  MarketResumedParams,
  MarketRulesSupplementedParams,
} from '@buddha/shared';
import { copy } from '@/copy';
import { PAUSE_REASON_LABEL } from './market-admin';
import { ruleVersionName } from './rule-versions';
import { fillNotificationText } from './trade-notifications';

/**
 * 시장 상태 알림 (#54, ADR-0159; N05 §4; owner answers 52-1, 52-5, 52-8…52-10, 54-1…54-8) as the
 * inbox's row words them: the titles of `market_closed`, `market_paused`, `market_resumed`,
 * `market_cancelled` and `market_rules_supplemented` from the params their definitions parsed
 * (@buddha/shared notifications.ts), in the sentences the owner approved (54-1). Each is copy.ts'
 * single-brace template filled by `fillNotificationText` (ADR-0158 12-10), which inserts a value as
 * it is — a stored title or reason holding `{x}` or `$&` stays as written. Pure and node-safe, so
 * market-notifications.test.ts runs them; the renderers (components/notifications) only call them.
 * Every one leads to the market's detail (`market` target, 54-4), which this module does not draw.
 */

/**
 * A `market_closed` title (52-8): '<시장> 거래 마감' at its close — on schedule, PAUSED or not —
 * and '<시장> 거래 조기 마감' for an approved early close (`early`).
 */
export function marketClosedTitle(params: MarketClosedParams): string {
  return fillNotificationText(
    params.early ? copy.notificationMarketClosedEarly : copy.notificationMarketClosed,
    { market: params.marketTitle },
  );
}

/**
 * A `market_paused` title (52-9, 54-5): the market and the pause's reason, in the label the
 * 공개 판정 기록 shows it with (PAUSE_REASON_LABEL) — never the note, which the detail shows.
 */
export function marketPausedTitle(params: MarketPausedParams): string {
  return fillNotificationText(copy.notificationMarketPaused, {
    market: params.marketTitle,
    reason: PAUSE_REASON_LABEL[params.reason],
  });
}

/**
 * A `market_resumed` title (52-9 "재개도 알리고", 54-2): the market and the ended pause's reason,
 * in the same label — which pause ended.
 */
export function marketResumedTitle(params: MarketResumedParams): string {
  return fillNotificationText(copy.notificationMarketResumed, {
    market: params.marketTitle,
    reason: PAUSE_REASON_LABEL[params.reason],
  });
}

/** A `market_cancelled` title (52-5 시장 취소 알림): '<시장> 시장 취소'. */
export function marketCancelledTitle(params: MarketCancelledParams): string {
  return fillNotificationText(copy.notificationMarketCancelled, { market: params.marketTitle });
}

/**
 * A `market_rules_supplemented` title (52-10, 54-3): the market's title after the supplement, the
 * version it made as the detail's version history names it ('v3', `ruleVersionName`) and its
 * public reason as written — in the title itself, the row unchanged (54-3).
 */
export function marketRulesSupplementedTitle(params: MarketRulesSupplementedParams): string {
  return fillNotificationText(copy.notificationMarketRulesSupplemented, {
    market: params.marketTitle,
    version: ruleVersionName(params.ruleVersion),
    reason: params.reason,
  });
}
