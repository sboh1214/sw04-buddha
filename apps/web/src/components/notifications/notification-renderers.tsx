import {
  COMMENT_REPLIED_NOTIFICATION,
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
  MODERATION_ACTION_CANCELLED_NOTIFICATION,
  MODERATION_ACTION_TAKEN_NOTIFICATION,
  MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION,
  NOTIFICATION_DEFINITIONS,
  type NotificationDefinition,
  type NotificationParamValues,
  type NotificationType,
  ORDERS_CANCELLED_NOTIFICATION,
  ORDERS_EXPIRED_NOTIFICATION,
  ORDER_FILLED_NOTIFICATION,
  POST_REPLIED_NOTIFICATION,
  PROPOSAL_DECIDED_NOTIFICATION,
} from '@buddha/shared';
import type { ReactNode } from 'react';
import { JudgementZoneLine, useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import type { InboxNotification, PostAuthor } from '@/lib/api';
import {
  commentRepliedTitle,
  moderationCancelledTitle,
  moderationTakenHasTerm,
  moderationTakenTitle,
  postRepliedTitle,
  proposalDecidedTitle,
  restrictionEndChangedTitle,
} from '@/lib/community-notifications';
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
 * a line under it when it differs (`TimedTitle`), an amount as Coin, a reply's author as the post
 * page shows them), with `copy` holding every text it draws. A notification stores no sentence,
 * so the wording can change here without a data migration.
 */
export interface NotificationRenderer {
  /**
   * Every text the renderer draws, placeholders as written: equal to the type's `text` in the
   * excluded-feature guard's registry (NOTIFICATION_TYPE_REGISTRY), which
   * lib/notifications.test.ts holds the two to — the words the guard reads are the words shown.
   */
  readonly copy: readonly string[];
  /**
   * The title, from params the type's definition has parsed, the row's `eventCount` — how many
   * events a merged notification holds (52-6 횟수, ADR-0157; ADR-0158 for #134's fills) — and its
   * `replyAuthor`: the latest reply's author the API reads for #135's two reply types (52-15,
   * ADR-0161), null when that reply is hidden or deleted, undefined on every other type.
   */
  readonly Title: (props: {
    params: NotificationParamValues;
    eventCount: number;
    replyAuthor?: PostAuthor | null | undefined;
  }) => ReactNode;
}

/**
 * A renderer of `definition`'s type whose title reads the params as that definition's own:
 * `notificationView` hands a Title only params the type's definition parsed, so the narrowing is
 * the parse's, not a guess.
 */
function rendererOf<Params extends NotificationParamValues>(
  _definition: NotificationDefinition<string, Params>,
  texts: readonly string[],
  title: (
    params: Params,
    eventCount: number,
    replyAuthor: PostAuthor | null | undefined,
  ) => ReactNode,
): NotificationRenderer {
  return {
    copy: texts,
    Title: ({ params, eventCount, replyAuthor }) =>
      title(params as Params, eventCount, replyAuthor),
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
 * A 커뮤니티 title with a restriction's end in it (#135, ADR-0161; 135-6): `text`'s sentence with
 * the end in the member's zone (`useFormatDateTime`) — one line, no 판정 기준 시간대 (`TimedTitle`'s
 * second line is a market's, and a restriction has none). A component, so the hook is called in one
 * and never in a renderer's `title`.
 */
function TermTitle({ text }: { text: (format: FormatDateTime) => string }) {
  const format = useFormatDateTime();
  return <>{text(format)}</>;
}

/**
 * The `format` of a 커뮤니티 title that draws no time (an action that is no restriction, a 조기
 * 해제): never called — a call is a renderer that picked the wrong branch, and throws.
 */
const NO_TIME: FormatDateTime = () => {
  throw new Error('a title with no time formatted one');
};

/** The seven action words (`moderationActionLabel`, MY 조치·신고 내역's), which fill {action}. */
const MODERATION_ACTION_WORDS = [
  copy.moderationActionHide,
  copy.moderationActionWarning,
  copy.moderationActionNicknameReset,
  copy.moderationActionBioClear,
  copy.moderationActionImageRemove,
  copy.moderationActionWritingRestriction,
  copy.moderationActionAccountRestriction,
];

/**
 * One renderer per type of the product's list (NOTIFICATION_DEFINITIONS), keyed by it exactly as
 * the guard's registry is: a type defined without its renderer, or a renderer left behind for a
 * removed type, fails to compile. #53 shipped none (52-20); #134 words the 거래 three
 * (lib/trade-notifications.ts, ADR-0158), #54 the 시장 상태 five (lib/market-notifications.ts,
 * ADR-0159 — the wording of 54-1), #188 the 판정·정산 six (lib/judgement-notifications.ts,
 * ADR-0160 — the wording of 188-1; the four that carry a time through `TimedTitle`), #135 the
 * 커뮤니티 six (lib/community-notifications.ts, ADR-0161 — the wording of 135-5; a restriction's end
 * through `TermTitle`), and each later producer adds its own (#144 정정·보상).
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
  post_replied: rendererOf(
    POST_REPLIED_NOTIFICATION,
    [
      copy.notificationPostReplied,
      copy.notificationPostRepliedMerged,
      copy.notificationPostRepliedNoAuthor,
      copy.notificationPostRepliedMergedNoAuthor,
      // What fills {author} beside a nickname: an admin's tag (#45-9), a closed account's name.
      copy.notificationReplyAuthorAdmin,
      copy.postAuthorFormer,
    ],
    (_params, eventCount, replyAuthor) => postRepliedTitle(eventCount, replyAuthor),
  ),
  comment_replied: rendererOf(
    COMMENT_REPLIED_NOTIFICATION,
    [
      copy.notificationCommentReplied,
      copy.notificationCommentRepliedMerged,
      copy.notificationCommentRepliedNoAuthor,
      copy.notificationCommentRepliedMergedNoAuthor,
      copy.notificationReplyAuthorAdmin,
      copy.postAuthorFormer,
    ],
    (_params, eventCount, replyAuthor) => commentRepliedTitle(eventCount, replyAuthor),
  ),
  moderation_action_taken: rendererOf(
    MODERATION_ACTION_TAKEN_NOTIFICATION,
    [
      copy.notificationModerationTaken,
      copy.notificationModerationTakenTerm,
      ...MODERATION_ACTION_WORDS,
      // restrictionTermText's words, which fill {term} (the MY band's).
      copy.restrictionUntil,
      copy.restrictionIndefinite,
    ],
    (params) =>
      moderationTakenHasTerm(params) ? (
        <TermTitle text={(format) => moderationTakenTitle(params, format)} />
      ) : (
        moderationTakenTitle(params, NO_TIME)
      ),
  ),
  moderation_action_cancelled: rendererOf(
    MODERATION_ACTION_CANCELLED_NOTIFICATION,
    [copy.notificationModerationCancelled, ...MODERATION_ACTION_WORDS],
    moderationCancelledTitle,
  ),
  moderation_restriction_end_changed: rendererOf(
    MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION,
    [
      copy.notificationRestrictionShortened,
      copy.notificationRestrictionLifted,
      copy.moderationActionWritingRestriction,
      copy.moderationActionAccountRestriction,
      copy.restrictionUntil,
    ],
    (params) =>
      params.change === 'shorten' ? (
        <TermTitle text={(format) => restrictionEndChangedTitle(params, format)} />
      ) : (
        restrictionEndChangedTitle(params, NO_TIME)
      ),
  ),
  proposal_decided: rendererOf(
    PROPOSAL_DECIDED_NOTIFICATION,
    // PROPOSAL_STATUS_LABEL's words, which fill {decision} (MY 내 제안's).
    [copy.notificationProposalDecided, copy.proposalStatusAdopted, copy.proposalStatusRejected],
    proposalDecidedTitle,
  ),
} as const satisfies Record<NotificationType, NotificationRenderer>;

/** What a row draws as its title: the type's renderer, or the fallback's words. */
export type NotificationView =
  | {
      known: true;
      Title: NotificationRenderer['Title'];
      params: NotificationParamValues;
      eventCount: number;
      /** The row's `replyAuthor`, as the API answered it (#135's reply types; else undefined). */
      replyAuthor: PostAuthor | null | undefined;
    }
  | { known: false; title: string };

/**
 * A notification's title as the row draws it: its type's renderer with the params its definition
 * parsed, its `eventCount` and its `replyAuthor`, when this web knows the type and the params are
 * what the type holds; otherwise the fallback — the category's name and '알림' (53-11 ④) — so a
 * type a newer server sends, or params a renderer could not draw, still show a row the member can
 * open and mark read. The renderers and definitions are parameters so a test can plant its own.
 */
export function notificationView(
  item: Pick<InboxNotification, 'type' | 'category' | 'params' | 'eventCount' | 'replyAuthor'>,
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
        replyAuthor: item.replyAuthor,
      };
    }
  }
  return { known: false, title: notificationFallbackTitle(item.category) };
}
