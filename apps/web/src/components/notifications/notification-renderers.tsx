import {
  MARKET_CANCELLED_NOTIFICATION,
  MARKET_CLOSED_NOTIFICATION,
  MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION,
  MARKET_DISPUTE_DECIDED_NOTIFICATION,
  MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
  MARKET_JUDGEMENT_DELAYED_NOTIFICATION,
  MARKET_PAUSED_NOTIFICATION,
  MARKET_PROVISIONAL_RESULT_NOTIFICATION,
  MARKET_RESUMED_NOTIFICATION,
  MARKET_RULES_SUPPLEMENTED_NOTIFICATION,
  MARKET_SETTLED_NOTIFICATION,
  NOTIFICATION_DEFINITIONS,
  type NotificationDefinition,
  type NotificationParamValues,
  type NotificationType,
  ORDERS_CANCELLED_NOTIFICATION,
  ORDERS_EXPIRED_NOTIFICATION,
  ORDER_FILLED_NOTIFICATION,
} from '@buddha/shared';
import type { ReactNode } from 'react';
import { JudgementZoneLine, useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import type { InboxNotification } from '@/lib/api';
import {
  type FormatDateTime,
  disputeClosedByCorrectionTitle,
  disputeDecidedTitle,
  judgementCorrectedTitle,
  judgementDelayedTitle,
  marketSettledTitle,
  provisionalResultTitle,
} from '@/lib/judgement-notifications';
import {
  marketCancelledTitle,
  marketClosedTitle,
  marketPausedTitle,
  marketResumedTitle,
  marketRulesSupplementedTitle,
} from '@/lib/market-notifications';
import { notificationFallbackTitle } from '@/lib/notifications';
import {
  orderFilledTitle,
  ordersCancelledTitle,
  ordersExpiredTitle,
} from '@/lib/trade-notifications';

/**
 * How the web words each notification type (#53, ADR-0157): the type's title from its params, in
 * the member's words and zone (52-15 — a time in the member's zone, the market's 판정 기준 시간대 on
 * a line under it when it differs (`TimedTitle`), an amount as Coin), with
 * `copy` holding every text it draws. A notification stores no sentence, so the wording can change
 * here without a data migration.
 */
export interface NotificationRenderer {
  /**
   * Every text the renderer draws, placeholders as written: equal to the type's `text` in the
   * excluded-feature guard's registry (NOTIFICATION_TYPE_REGISTRY), which
   * lib/notifications.test.ts holds the two to — the words the guard reads are the words shown.
   */
  readonly copy: readonly string[];
  /**
   * The title, from params the type's definition has parsed and the row's `eventCount` — how many
   * events a merged notification holds (52-6 횟수, ADR-0157; ADR-0158 for #134's fills).
   */
  readonly Title: (props: { params: NotificationParamValues; eventCount: number }) => ReactNode;
}

/**
 * A renderer of `definition`'s type whose title reads the params as that definition's own:
 * `notificationView` hands a Title only params the type's definition parsed, so the narrowing is
 * the parse's, not a guess.
 */
function rendererOf<Params extends NotificationParamValues>(
  _definition: NotificationDefinition<string, Params>,
  texts: readonly string[],
  title: (params: Params, eventCount: number) => ReactNode,
): NotificationRenderer {
  return {
    copy: texts,
    Title: ({ params, eventCount }) => title(params as Params, eventCount),
  };
}

/**
 * A timed 판정·정산 title (#188, ADR-0160; 52-15, ADR-0093 #22): `text`'s sentence with its time in
 * the member's zone (`useFormatDateTime`), then — once that zone is settled and the market's 판정
 * 기준 시간대 is another — '판정 기준 시간대 <time>' on a line of its own under it, the detail's rule
 * (`JudgementZoneLine`; null, unknown or the same zone draw none). A component, so the hook is
 * called in one and never in a renderer's `title`. The row draws it inside its title element, so
 * that element's text holds both lines; the second is `notification-row-judgement-zone`.
 */
function TimedTitle({
  text,
  iso,
  judgementTimeZone,
}: {
  text: (format: FormatDateTime) => string;
  iso: string;
  judgementTimeZone: string | null;
}) {
  const format = useFormatDateTime();
  return (
    <>
      {text(format)}
      <JudgementZoneLine
        iso={iso}
        judgementTimeZone={judgementTimeZone}
        testId="notification-row"
      />
    </>
  );
}

/**
 * One renderer per type of the product's list (NOTIFICATION_DEFINITIONS), keyed by it exactly as
 * the guard's registry is: a type defined without its renderer, or a renderer left behind for a
 * removed type, fails to compile. #53 shipped none (52-20); #134 words the 거래 three
 * (lib/trade-notifications.ts, ADR-0158), #54 the 시장 상태 five (lib/market-notifications.ts,
 * ADR-0159 — the wording of 54-1), #188 the 판정·정산 six (lib/judgement-notifications.ts,
 * ADR-0160 — the wording of 188-1; the four that carry a time through `TimedTitle`), and each
 * later producer adds its own (#135 커뮤니티, #144 정정·보상).
 */
export const NOTIFICATION_RENDERERS = {
  order_filled: rendererOf(
    ORDER_FILLED_NOTIFICATION,
    [
      copy.notificationOrderFilled,
      copy.notificationOrderFilledMerged,
      copy.notificationOrderFilledSince,
      copy.notificationOrderFilledMergedSince,
      copy.orderStatusPartiallyFilled,
      copy.orderStatusFilled,
      // contractSideLabel's words, which fill {contract}.
      copy.yes,
      copy.no,
      copy.buy,
      copy.sell,
    ],
    orderFilledTitle,
  ),
  orders_cancelled: rendererOf(
    ORDERS_CANCELLED_NOTIFICATION,
    [
      copy.notificationOrdersCancelledMarket,
      copy.notificationOrdersCancelledAccount,
      copy.orderCancelNameAdminRole,
      copy.orderCancelNameRestricted,
    ],
    ordersCancelledTitle,
  ),
  orders_expired: rendererOf(
    ORDERS_EXPIRED_NOTIFICATION,
    [copy.notificationOrdersExpiredClosed, copy.notificationOrdersExpiredCancelled],
    ordersExpiredTitle,
  ),
  market_closed: rendererOf(
    MARKET_CLOSED_NOTIFICATION,
    [copy.notificationMarketClosed, copy.notificationMarketClosedEarly],
    marketClosedTitle,
  ),
  market_paused: rendererOf(
    MARKET_PAUSED_NOTIFICATION,
    [
      copy.notificationMarketPaused,
      // PAUSE_REASON_LABEL's words, which fill {reason} (the 공개 판정 기록's, 52-9).
      copy.pauseReasonEarlyResult,
      copy.pauseReasonLedgerFailure,
      copy.pauseReasonBasisChange,
    ],
    marketPausedTitle,
  ),
  market_resumed: rendererOf(
    MARKET_RESUMED_NOTIFICATION,
    [
      copy.notificationMarketResumed,
      copy.pauseReasonEarlyResult,
      copy.pauseReasonLedgerFailure,
      copy.pauseReasonBasisChange,
    ],
    marketResumedTitle,
  ),
  market_cancelled: rendererOf(
    MARKET_CANCELLED_NOTIFICATION,
    [copy.notificationMarketCancelled],
    marketCancelledTitle,
  ),
  market_rules_supplemented: rendererOf(
    MARKET_RULES_SUPPLEMENTED_NOTIFICATION,
    // ruleVersionName's word, which fills {version} ('v3').
    [copy.notificationMarketRulesSupplemented, copy.ruleVersionName],
    marketRulesSupplementedTitle,
  ),
  market_judgement_delayed: rendererOf(
    MARKET_JUDGEMENT_DELAYED_NOTIFICATION,
    // The second line's label (`JudgementZoneLine`), drawn when the market's zone differs.
    [copy.notificationJudgementDelayed, copy.rulesJudgementZoneLine],
    (params) => (
      <TimedTitle
        text={(format) => judgementDelayedTitle(params, format)}
        iso={params.nextReviewAt}
        judgementTimeZone={params.judgementTimeZone}
      />
    ),
  ),
  market_provisional_result: rendererOf(
    MARKET_PROVISIONAL_RESULT_NOTIFICATION,
    [
      copy.notificationProvisionalResult,
      // MARKET_RESULT_LABEL's words, which fill {result} (the detail's result row).
      copy.yes,
      copy.no,
      copy.marketResultVoid,
      copy.rulesJudgementZoneLine,
    ],
    (params) => (
      <TimedTitle
        text={(format) => provisionalResultTitle(params, format)}
        iso={params.disputeDeadline}
        judgementTimeZone={params.judgementTimeZone}
      />
    ),
  ),
  market_judgement_corrected: rendererOf(
    MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
    [
      copy.notificationJudgementCorrected,
      copy.yes,
      copy.no,
      copy.marketResultVoid,
      copy.rulesJudgementZoneLine,
    ],
    (params) => (
      <TimedTitle
        text={(format) => judgementCorrectedTitle(params, format)}
        iso={params.disputeDeadline}
        judgementTimeZone={params.judgementTimeZone}
      />
    ),
  ),
  market_dispute_decided: rendererOf(
    MARKET_DISPUTE_DECIDED_NOTIFICATION,
    // DISPUTE_STATUS_LABEL's words, which fill {decision} (MY 판정 이의's).
    [copy.notificationDisputeDecided, copy.disputeStatusDismissed, copy.disputeStatusAccepted],
    disputeDecidedTitle,
  ),
  market_dispute_closed_by_correction: rendererOf(
    MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION,
    [copy.notificationDisputeClosedByCorrection, copy.rulesJudgementZoneLine],
    (params) => (
      <TimedTitle
        text={(format) => disputeClosedByCorrectionTitle(params, format)}
        iso={params.disputeDeadline}
        judgementTimeZone={params.judgementTimeZone}
      />
    ),
  ),
  market_settled: rendererOf(
    MARKET_SETTLED_NOTIFICATION,
    [
      copy.notificationMarketSettled,
      // A watcher who held nothing at the payout (`payoutCoin` null).
      copy.notificationMarketSettledWatcher,
      copy.yes,
      copy.no,
      copy.marketResultVoid,
    ],
    marketSettledTitle,
  ),
} as const satisfies Record<NotificationType, NotificationRenderer>;

/** What a row draws as its title: the type's renderer, or the fallback's words. */
export type NotificationView =
  | {
      known: true;
      Title: NotificationRenderer['Title'];
      params: NotificationParamValues;
      eventCount: number;
    }
  | { known: false; title: string };

/**
 * A notification's title as the row draws it: its type's renderer with the params its definition
 * parsed and its `eventCount`, when this web knows the type and the params are what the type
 * holds; otherwise the fallback — the category's name and '알림' (53-11 ④) — so a type a newer
 * server sends, or params a renderer could not draw, still show a row the member can open and mark
 * read. The renderers and definitions are parameters so a test can plant its own.
 */
export function notificationView(
  item: Pick<InboxNotification, 'type' | 'category' | 'params' | 'eventCount'>,
  renderers: Readonly<Record<string, NotificationRenderer>> = NOTIFICATION_RENDERERS,
  definitions: readonly NotificationDefinition[] = NOTIFICATION_DEFINITIONS,
): NotificationView {
  const renderer = Object.hasOwn(renderers, item.type) ? renderers[item.type] : undefined;
  const definition = definitions.find((entry) => entry.type === item.type);
  if (renderer !== undefined && definition !== undefined) {
    const parsed = definition.params.safeParse(item.params);
    if (parsed.success) {
      return {
        known: true,
        Title: renderer.Title,
        params: parsed.data,
        eventCount: item.eventCount,
      };
    }
  }
  return { known: false, title: notificationFallbackTitle(item.category) };
}
