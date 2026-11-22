import * as z from 'zod';
import { serializeCoinAmount } from './api/coin-amount.js';
import { uuidSchema } from './api/uuid.js';
import {
  MARKET_RESULTS,
  MODERATION_ACTION_TYPES,
  RESTRICTION_END_CHANGE_KINDS,
  orderSideSchema,
  outcomeSchema,
  type ModerationActionType,
  type OrderCancelReason,
  type ProposalStatus,
} from './enums.js';
import type { MarketDisputeStatus } from './market-dispute.js';
import { MARKET_PAUSE_REASONS } from './market-pause.js';
import { marketSlugSchema } from './market.js';
import { postAuthorSchema } from './post.js';

/**
 * 앱 내 알림함 (#53, ADR-0157; N05 §4·§8, owner answers 53-1…53-11 and #52's 52-1…52-23): what a
 * notification is, as every producer writes it and the API answers it.
 *
 * A notification stores a type, its parameters and a typed target — never a sentence. The web
 * renders the Korean from its copy by type, so wording changes without a data migration, and no
 * text of another member is ever copied into one (135-4: a reply's body never is). The params
 * carry only the recipient's own values or public values (N04 §2): times as ISO strings (the web
 * renders them in the member's zone, 52-15), Coin amounts and quantities as decimal strings
 * (`serializeCoinAmount`), never JS numbers. Another member's identity (a nickname, an account
 * id, a public id, an address) is never stored: a type that shows one keeps the id of the object
 * that names it and the API reads the person when the list is read — 52-15's reply author through
 * `replyId` (ADR-0161), so ADR-0086's '탈퇴한 사용자' and a forced nickname change show at once.
 *
 * The product's types are NOTIFICATION_DEFINITIONS, and nothing else: the one write path
 * (@buddha/db `createNotifications`) refuses a type it does not list, and the database holds the
 * shape only (`notifications.type` is a pattern, not a list — ADR-0157). #53 shipped no type
 * (52-20); the producers add theirs, each with its guard entry (guards/notifications.ts) and its
 * web renderer: #134 the 거래 three (ADR-0158 — `order_filled`, `orders_cancelled`,
 * `orders_expired`, below), #54 the 시장 상태 five (ADR-0159 — `market_closed`, `market_paused`,
 * `market_resumed`, `market_cancelled`, `market_rules_supplemented`), #188 the 판정·정산 six
 * (ADR-0160 — `market_judgement_delayed`, `market_provisional_result`,
 * `market_judgement_corrected`, `market_dispute_decided`, `market_dispute_closed_by_correction`,
 * `market_settled`), #135 the 커뮤니티 six (ADR-0161 — `post_replied`, `comment_replied`,
 * `moderation_action_taken`, `moderation_action_cancelled`, `moderation_restriction_end_changed`,
 * `proposal_decided`), then #144 정정·보상.
 */

/**
 * The three settings units a notification belongs to (N05 §4, 52-21): every type carries exactly
 * one, and #56's 수신 설정 turns a category off. The Korean labels (거래·시장·커뮤니티) are the
 * web's copy. A fourth (N05 §4's 가격 변동, #146 — post-MVP) comes with a migration of its own:
 * the column's CHECK is generated from this list, as a retention purge kind's is.
 */
export const NOTIFICATION_CATEGORIES = ['trade', 'market', 'community'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const notificationCategorySchema = z
  .enum(NOTIFICATION_CATEGORIES)
  .meta({ id: 'NotificationCategory' });

/**
 * A type's name: lower-case words joined by `_`, 2 to 48 characters — the shape the database's
 * CHECK holds `notifications.type` and `notification_keys.type` to (migration 0078).
 */
export const NOTIFICATION_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;

/**
 * An event's id as a producer keys it (an order id, a fill id, `market:<id>:closed`, …) and a
 * merge key's (the order, the post or the comment the merged events are about): the shape the
 * database's CHECKs hold `notification_keys.event_key` and `notifications.merge_key` to.
 */
export const NOTIFICATION_EVENT_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

/**
 * The most the unread count says: the count stops at this number, which means "this many or
 * more" (the web shows '99+' past 99, 53-11 ①). Counting stops there, so the read is bounded.
 */
export const NOTIFICATION_UNREAD_COUNT_CAP = 100;

/** A parameter's name: camelCase, a letter first, up to 40 characters. */
export const NOTIFICATION_PARAM_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** The longest string a parameter holds (a market title is at most 120). */
export const NOTIFICATION_PARAM_STRING_MAX = 500;

/** What one parameter holds: a flat value the web renders, never an object or a list. */
export type NotificationParamValue = string | number | boolean | null;

/** A notification's parameters: flat, as NOTIFICATION_PARAM_KEY_PATTERN names them. */
export type NotificationParamValues = Readonly<Record<string, NotificationParamValue>>;

/** One parameter's value, as stored and answered. */
export const notificationParamValueSchema = z.union([
  z.string().max(NOTIFICATION_PARAM_STRING_MAX),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * The parameters of a notification as the API answers them: a flat record the type's renderer
 * reads. What each type holds is its definition's `params`; this is the shape every type shares.
 */
export const notificationParamsSchema = z
  .record(z.string().regex(NOTIFICATION_PARAM_KEY_PATTERN), notificationParamValueSchema)
  .meta({ id: 'NotificationParams' });
export type NotificationParams = z.infer<typeof notificationParamsSchema>;

/**
 * Where a notification leads: a typed target the web maps to its own path (no URL is stored, so
 * nothing redirects off the site and a route can move). The kinds:
 * - `market` (#53), a market by its slug — a market's slug changes only in `draft` (`PATCH
 *   /admin/markets/:id`), and a market anybody can be notified about is public (scheduled onward,
 *   CANCELLED included), so the stored slug never goes stale and the detail answers in every
 *   public status (N05 §3, #53 AC 4);
 * - `order` (#134, ADR-0158), one of the recipient's own orders by its id — its detail
 *   (`/my/orders/<id>`, ADR-0141) answers 404 to anyone else, so the id tells nobody else a thing;
 * - `order_history` (#134), the recipient's ended orders (`/my/history`, ADR-0143), of one market
 *   (`marketId`, public: the history filter puts it in the URL) or of every market (`null`: an
 *   account event's, 52-4);
 * - `post` (#135, ADR-0161), the recipient's own post (`postId`) a 댓글 was written on, and
 *   `comment`, the recipient's own 댓글 (`commentId`, with its `postId`) a 대댓글 was written under:
 *   public objects — their ids are in every public comment list — so the ids tell nobody a thing;
 * - `moderation_action` (#135), an action taken on the recipient (`actionId`), led to MY 조치·신고
 *   내역 (`/my/moderation`, 135-2), and `proposal` (#135), the recipient's own 시장 제안
 *   (`proposalId`), led to MY 내 제안 (`/my/proposals`): the recipient's own, read only on their
 *   own MY pages, so the ids tell nobody else a thing either.
 * The web leads `post` and `comment` to the post's page and the other two to their MY pages, each
 * at its top (135-7); the ids not used by a path yet stay for a later anchor without a data change
 * (a stored target never changes, ADR-0157 결정 3).
 */
export const notificationMarketTargetSchema = z
  .object({ kind: z.literal('market'), slug: marketSlugSchema })
  .meta({ id: 'NotificationMarketTarget' });
export type NotificationMarketTarget = z.infer<typeof notificationMarketTargetSchema>;

export const notificationOrderTargetSchema = z
  .object({ kind: z.literal('order'), orderId: uuidSchema })
  .meta({ id: 'NotificationOrderTarget' });
export type NotificationOrderTarget = z.infer<typeof notificationOrderTargetSchema>;

export const notificationOrderHistoryTargetSchema = z
  .object({ kind: z.literal('order_history'), marketId: uuidSchema.nullable() })
  .meta({ id: 'NotificationOrderHistoryTarget' });
export type NotificationOrderHistoryTarget = z.infer<typeof notificationOrderHistoryTargetSchema>;

export const notificationPostTargetSchema = z
  .object({ kind: z.literal('post'), postId: uuidSchema })
  .meta({ id: 'NotificationPostTarget' });
export type NotificationPostTarget = z.infer<typeof notificationPostTargetSchema>;

export const notificationCommentTargetSchema = z
  .object({ kind: z.literal('comment'), postId: uuidSchema, commentId: uuidSchema })
  .meta({ id: 'NotificationCommentTarget' });
export type NotificationCommentTarget = z.infer<typeof notificationCommentTargetSchema>;

export const notificationModerationActionTargetSchema = z
  .object({ kind: z.literal('moderation_action'), actionId: uuidSchema })
  .meta({ id: 'NotificationModerationActionTarget' });
export type NotificationModerationActionTarget = z.infer<
  typeof notificationModerationActionTargetSchema
>;

export const notificationProposalTargetSchema = z
  .object({ kind: z.literal('proposal'), proposalId: uuidSchema })
  .meta({ id: 'NotificationProposalTarget' });
export type NotificationProposalTarget = z.infer<typeof notificationProposalTargetSchema>;

export const notificationTargetSchema = z
  .discriminatedUnion('kind', [
    notificationMarketTargetSchema,
    notificationOrderTargetSchema,
    notificationOrderHistoryTargetSchema,
    notificationPostTargetSchema,
    notificationCommentTargetSchema,
    notificationModerationActionTargetSchema,
    notificationProposalTargetSchema,
  ])
  .meta({ id: 'NotificationTarget' });
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;
export type NotificationTargetKind = NotificationTarget['kind'];

/** Every target kind, in the union's order (notifications.test.ts keeps the two equal). */
export const NOTIFICATION_TARGET_KINDS = [
  'market',
  'order',
  'order_history',
  'post',
  'comment',
  'moderation_action',
  'proposal',
] as const satisfies readonly NotificationTargetKind[];

/**
 * How a mergeable type folds one more event into the unread notification it joins (52-6, 52-7):
 * the held parameters and the incoming event's, to the parameters the row then shows. Declared
 * bivariantly so a definition typed by its own params is still a `NotificationDefinition`.
 */
export type NotificationMerge<Params extends NotificationParamValues> = {
  bivarianceHack(held: Params, next: Params): Params;
}['bivarianceHack'];

/**
 * One notification type of the product:
 * - `type`: its name (NOTIFICATION_TYPE_PATTERN), unique in the list;
 * - `category`: its settings unit (52-21), exactly one;
 * - `targets`: the target kinds it may lead to;
 * - `params`: the schema of its flat parameters (string, number, boolean or null fields only) —
 *   none of which names another account or its identity (the privacy rule above);
 * - `merge`: null for a type whose every event is a notification of its own; for a mergeable one
 *   (52-6 a resting order's fills, 52-7 replies to one post or comment), how an event joins the
 *   unread notification of the same merge key. One type is one merge group: a state that changes
 *   as events merge (52-6 부분 → 전량 체결) is a parameter of the type, never a second type.
 *   An unread row may hold params an earlier version of the type stored, so a mergeable type's
 *   `params` should only gain optional fields and its `merge` should accept every shape it ever
 *   stored. When it cannot — the held params no longer parse, the merge throws or its result does
 *   not parse — the write path replaces the held params with the event's (`paramsReset`) and the
 *   producer's event still commits: a safety net, not a way to change a type.
 */
export interface NotificationDefinition<
  Type extends string = string,
  Params extends NotificationParamValues = NotificationParamValues,
> {
  readonly type: Type;
  readonly category: NotificationCategory;
  readonly targets: readonly NotificationTargetKind[];
  readonly params: z.ZodType<Params>;
  readonly merge: NotificationMerge<Params> | null;
}

/** A definition, typed by its own name and parameters (the merge's arguments included). */
export function defineNotification<
  const Type extends string,
  Params extends NotificationParamValues,
>(definition: NotificationDefinition<Type, Params>): NotificationDefinition<Type, Params> {
  return definition;
}

// ---- 거래 알림 (#134, ADR-0158) --------------------------------------------------------------

/** A whole number ≥ 1 as a decimal string: a contract quantity or a Coin amount (ADR-0157 결정 3). */
const positiveDecimalSchema = z.string().regex(/^[1-9][0-9]{0,15}$/);

/** A count of orders or of markets (not a contract quantity): a whole number ≥ 1. */
const countSchema = z.number().int().min(1);

/**
 * The market's title at the event (public, ADR-0157 결정 3). Bounded by the generic param cap, NOT
 * MARKET_TITLE_MAX: `markets.title` is varchar(120) in code points while zod counts UTF-16 units,
 * so a 120-character title with astral characters written outside `marketTitleSchema` (a fixture,
 * a raw write) would fail validation — and a NotificationInputError rolls back the close, the
 * pause or the fill it rides on (ADR-0158).
 */
const noticeTitleSchema = z.string().min(1).max(NOTIFICATION_PARAM_STRING_MAX);

/** The larger of two decimal strings, compared as whole numbers. */
const maxDecimal = (a: string, b: string): string => (BigInt(a) >= BigInt(b) ? a : b);

/**
 * `order_filled` (N05 §4 부분·전량 체결; 52-2, 52-6, 134-1·134-2·134-3): a fill of one of the
 * recipient's RESTING orders — never the incoming order's own (its fills, IOC remainder,
 * self-trade stop and rejection are the placing request's result, 52-2). Its contract and
 * direction (`outcome`, `side`) are the resting order's; `qty` and `amountCoin` sum the fills this
 * notification holds (Σ resting price × qty, so the 평균 가격 is `amountCoin / qty` — the order's
 * own price, N01 §4); `fullyFilled` says the order has nothing left; `orderQty` and
 * `orderFilledQty` are the order's quantity and its filled quantity after the latest fill held
 * (134-3: the web shows them when this notification does not hold every fill of the order).
 */
export const orderFilledParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  outcome: outcomeSchema,
  side: orderSideSchema,
  qty: positiveDecimalSchema,
  amountCoin: positiveDecimalSchema,
  fullyFilled: z.boolean(),
  orderQty: positiveDecimalSchema,
  orderFilledQty: positiveDecimalSchema,
});
export type OrderFilledParams = z.infer<typeof orderFilledParamsSchema>;

/**
 * 52-6: while unread, the same order's fills merge into one notification (횟수 is the row's
 * `event_count`); after it is read, the next fill makes a new one. Order-independent, as the write
 * path's input order is by event-key string (`fill:10` < `fill:9`): sums, OR, the max, and a
 * title, contract and direction that are equal for one order (taken from `next`).
 */
export const ORDER_FILLED_NOTIFICATION = defineNotification({
  type: 'order_filled',
  category: 'trade',
  targets: ['order'],
  params: orderFilledParamsSchema,
  merge: (held, next) => ({
    ...next,
    qty: String(BigInt(held.qty) + BigInt(next.qty)),
    amountCoin: serializeCoinAmount(BigInt(held.amountCoin) + BigInt(next.amountCoin)),
    fullyFilled: held.fullyFilled || next.fullyFilled,
    orderFilledQty: maxDecimal(held.orderFilledQty, next.orderFilledQty),
  }),
});

/** 52-3: the cancel reasons that notify — a system batch the member did not make. */
export const NOTIFIED_CANCEL_REASONS = [
  'paused',
  'admin_role',
  'restricted',
] as const satisfies readonly OrderCancelReason[];
export type NotifiedCancelReason = (typeof NOTIFIED_CANCEL_REASONS)[number];

/**
 * `orders_cancelled` (N05 §4 취소 완료; 52-3, 52-4): the recipient's resting orders a system batch
 * cancelled — one per event and member. `paused` is a market's event (일시 중단, the ledger-failure
 * recovery's cancel included): its `marketTitle`, one market. `admin_role` and `restricted` are
 * account events across markets (`marketCount`), with no title.
 */
export const ordersCancelledParamsSchema = z
  .object({
    reason: z.enum(NOTIFIED_CANCEL_REASONS),
    orderCount: countSchema,
    marketCount: countSchema,
    marketTitle: noticeTitleSchema.nullable(),
  })
  .refine(
    (params) =>
      params.marketCount <= params.orderCount &&
      (params.reason === 'paused'
        ? params.marketTitle !== null && params.marketCount === 1
        : params.marketTitle === null),
    { message: 'a market event names its one market; an account event none' },
  );
export type OrdersCancelledParams = z.infer<typeof ordersCancelledParamsSchema>;

export const ORDERS_CANCELLED_NOTIFICATION = defineNotification({
  type: 'orders_cancelled',
  category: 'trade',
  targets: ['order', 'order_history'],
  params: ordersCancelledParamsSchema,
  merge: null,
});

/**
 * Why a market's resting orders expired (52-4, 52-5): the market's status after its transition —
 * `closed` 거래 마감, `cancelled` 시장 취소.
 */
export const ORDER_EXPIRY_CAUSES = ['closed', 'cancelled'] as const;
export type OrderExpiryCause = (typeof ORDER_EXPIRY_CAUSES)[number];

/**
 * `orders_expired` (N05 §4 주문 만료; 52-4, 52-5): the recipient's resting orders a market's end
 * expired — one per member and market.
 */
export const ordersExpiredParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  cause: z.enum(ORDER_EXPIRY_CAUSES),
  orderCount: countSchema,
});
export type OrdersExpiredParams = z.infer<typeof ordersExpiredParamsSchema>;

export const ORDERS_EXPIRED_NOTIFICATION = defineNotification({
  type: 'orders_expired',
  category: 'trade',
  targets: ['order', 'order_history'],
  params: ordersExpiredParamsSchema,
  merge: null,
});

// ---- 시장 상태 알림 (#54, ADR-0159) ----------------------------------------------------------
//
// The five 시장 types (52-21: category `market`), each one discrete change of a market's state
// told "그 순간에 한 건" (52-8) to its watchers and its holders of one contract or more (52-1) —
// the audience @buddha/db `marketAudience` reads. None merges (one type is one merge group,
// ADR-0157 결정 3): a pause and its resume keep their order, and two unread supplements keep
// their own version and reason. Every one leads to the market's detail (`market` target, 54-4)
// and stores no time (the row's 발생 시각 is the event's), no count, no holding and nothing about
// the watchers (#54 AC 8).

/**
 * Public free text: an approved supplement's request reason (#54), a 판정 지연 record's reason and a
 * dispute decision's reason (#188) — each `approvalReasonSchema`, at most
 * APPROVAL_REASON_MAX_LENGTH, which equals NOTIFICATION_PARAM_STRING_MAX (notifications.test.ts
 * pins it, so a raised approval cap cannot roll an approval, a record or a decision back).
 */
const noticeTextSchema = z.string().min(1).max(NOTIFICATION_PARAM_STRING_MAX);

/**
 * A pause's reason (MARKET_PAUSE_REASONS), as a plain enum: `marketPauseReasonSchema` carries an
 * OpenAPI id, which turns its JSON Schema into a `$ref` the definitions' flatness check refuses.
 */
const noticePauseReasonSchema = z.enum(MARKET_PAUSE_REASONS);

/**
 * `market_closed` (N05 §4 거래 마감; 52-1, 52-8): the market's trading ended CLOSED — at its
 * `close_at` (OPEN, or PAUSED on schedule: `early` false) or by an approved 조기 마감 (`early`
 * true). A market that ends with no fill a person's account is on is `market_cancelled` instead,
 * never both.
 */
export const marketClosedParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  early: z.boolean(),
});
export type MarketClosedParams = z.infer<typeof marketClosedParamsSchema>;

export const MARKET_CLOSED_NOTIFICATION = defineNotification({
  type: 'market_closed',
  category: 'market',
  targets: ['market'],
  params: marketClosedParamsSchema,
  merge: null,
});

/**
 * `market_paused` (N05 §4 전체 거래 중단, N03 §3; 52-9, 54-5): OPEN → PAUSED, by an admin or by
 * the reconciliation's automatic ledger-failure pause. `reason` is the pause's public label
 * (MARKET_PAUSE_REASONS, as the 공개 판정 기록 shows it) — never its note, which the detail shows.
 */
export const marketPausedParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  reason: noticePauseReasonSchema,
});
export type MarketPausedParams = z.infer<typeof marketPausedParamsSchema>;

export const MARKET_PAUSED_NOTIFICATION = defineNotification({
  type: 'market_paused',
  category: 'market',
  targets: ['market'],
  params: marketPausedParamsSchema,
  merge: null,
});

/**
 * `market_resumed` (52-9 "재개도 알리고", 54-2): an approved resume, PAUSED → OPEN, told to the
 * audience at the resume. `reason` is the ended pause's label: which pause ended.
 */
export const marketResumedParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  reason: noticePauseReasonSchema,
});
export type MarketResumedParams = z.infer<typeof marketResumedParamsSchema>;

export const MARKET_RESUMED_NOTIFICATION = defineNotification({
  type: 'market_resumed',
  category: 'market',
  targets: ['market'],
  params: marketResumedParamsSchema,
  merge: null,
});

/**
 * `market_cancelled` (52-5 시장 취소 알림): the market ended CANCELLED — at its `close_at` or by
 * an approved 조기 마감 with no fill a person's account is on (#20), or a SCHEDULED market's
 * cancel before its open. Nobody holds a contract there, so its audience is the watchers.
 */
export const marketCancelledParamsSchema = z.object({ marketTitle: noticeTitleSchema });
export type MarketCancelledParams = z.infer<typeof marketCancelledParamsSchema>;

export const MARKET_CANCELLED_NOTIFICATION = defineNotification({
  type: 'market_cancelled',
  category: 'market',
  targets: ['market'],
  params: marketCancelledParamsSchema,
  merge: null,
});

/**
 * `market_rules_supplemented` (N05 §4 중요한 규칙 보충, N03 §4; 52-10, 54-3, 54-7): an approved
 * supplement that changed a NOTIFIED_SUPPLEMENT_ITEMS item (market-supplement.ts). `marketTitle`
 * is the title after it, `ruleVersion` the version it made (2 or more: v1 is the open's) and
 * `reason` its public reason, as the version history shows them (#54 AC 4).
 */
export const marketRulesSupplementedParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  ruleVersion: z.number().int().min(2),
  reason: noticeTextSchema,
});
export type MarketRulesSupplementedParams = z.infer<typeof marketRulesSupplementedParamsSchema>;

export const MARKET_RULES_SUPPLEMENTED_NOTIFICATION = defineNotification({
  type: 'market_rules_supplemented',
  category: 'market',
  targets: ['market'],
  params: marketRulesSupplementedParamsSchema,
  merge: null,
});

// ---- 판정·정산 알림 (#188, ADR-0160) ---------------------------------------------------------
//
// The six 판정·정산 types (52-21: category `market` — N05 §4's 시장 list names 판정 지연, 잠정
// 결과·이의 기한 and 최종 정산, and a dispute's outcome is about the market's judgement). Four go to
// the market's watchers and holders of one contract or more (52-1, 52-14 "대상은 관심·보유 기준
// 그대로다"): 판정 지연 (52-11: each operator record that is the first of its episode or changes
// the reason or the next review time, 188-5), 잠정 결과 and 판정 정정 (52-12, a grounds-only
// correction included, 188-1) and 지급 완료 때의 최종 정산 (52-12; the holders the payout recorded,
// ADR-0159 결과 6). Two go to a dispute's submitter alone (52-14): 기각·수용 with the public
// decision reason (188-3), and 정정으로 종결 with the new deadline. None merges (one type is one
// merge group, ADR-0157 결정 3), every one leads to the market's detail (`market` target, 188-4)
// and none stores a count, a quantity, a P&L, an expected payout, an operator or another member
// (52-15, #188 AC 11): a payout is the recipient's own. Times are ISO instants the web renders in
// the member's zone, with the market's 판정 기준 시간대 beside them when it differs (52-15, #22).

/**
 * A whole number ≥ 0 as a decimal string: a member's payout, 0 included (52-15 '지급액(0 포함)').
 * positiveDecimalSchema (#134) refuses '0' — it would refuse every loser and roll the payout back.
 */
const payoutDecimalSchema = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);

/**
 * A result (MARKET_RESULTS) as a plain enum: marketResultSchema carries `.meta({ id })`, a `$ref`
 * the definitions' flatness check refuses (ADR-0159 12-8).
 */
const noticeResultSchema = z.enum(MARKET_RESULTS);

/** An instant (ISO, `toISOString()`), rendered in the member's zone (52-15). */
const noticeInstantSchema = z.iso.datetime();

/**
 * The market's public 판정 기준 시간대 at the event (#22), null for a market opened before #22.
 * Whatever `markets.judgement_time_zone` can hold — NOT timeZoneSchema (its `isKnownTimeZone`
 * refine runs Intl on the server: a zone a newer tzdata stored would refuse the input and roll the
 * approval or the payout back), no `.min(1)` and the generic cap, not TIME_ZONE_MAX_LENGTH: the
 * column is varchar(64) in code points with no CHECK (checked on entry only), zod counts UTF-16
 * units, and a '' or long value a fixture or raw write left would otherwise roll the event back —
 * noticeTitleSchema's reasoning (ADR-0158 12-16). The web drops a zone it cannot read, '' and
 * unknown ones included (`judgementLineZone` → `isKnownTimeZone`).
 */
const noticeJudgementZoneSchema = z.string().max(NOTIFICATION_PARAM_STRING_MAX).nullable();

/**
 * `market_judgement_delayed` (N05 §4 판정 지연, N03 §4; 52-11, 52-15, 188-5): an operator's 판정
 * 지연 기록 on a CLOSED or PROVISIONAL market — the first of its episode (the status and the
 * judgement version) or one that changes the reason or the next review time; never a time passing
 * (ADR-0106 결정 6). `reason` is the record's public reason, `nextReviewAt` its 다음 검토 시각.
 */
export const marketJudgementDelayedParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  reason: noticeTextSchema,
  nextReviewAt: noticeInstantSchema,
  judgementTimeZone: noticeJudgementZoneSchema,
});
export type MarketJudgementDelayedParams = z.infer<typeof marketJudgementDelayedParamsSchema>;

export const MARKET_JUDGEMENT_DELAYED_NOTIFICATION = defineNotification({
  type: 'market_judgement_delayed',
  category: 'market',
  targets: ['market'],
  params: marketJudgementDelayedParamsSchema,
  merge: null,
});

/**
 * `market_provisional_result` (N05 §4 잠정 결과·이의 기한, N03 §5; 52-12, 52-13, 52-15): a first
 * judgement's approval, CLOSED → PROVISIONAL — its result (YES·NO·VOID) and its 이의 기한. No
 * expected payout (52-15 '예상 지급액 없음'), and no notice as the deadline draws near (52-13).
 */
export const marketProvisionalResultParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  result: noticeResultSchema,
  disputeDeadline: noticeInstantSchema,
  judgementTimeZone: noticeJudgementZoneSchema,
});
export type MarketProvisionalResultParams = z.infer<typeof marketProvisionalResultParamsSchema>;

export const MARKET_PROVISIONAL_RESULT_NOTIFICATION = defineNotification({
  type: 'market_provisional_result',
  category: 'market',
  targets: ['market'],
  params: marketProvisionalResultParamsSchema,
  merge: null,
});

/**
 * `market_judgement_corrected` (N03 §7 '이의 기한을 다시 제공한다'; 52-12, 52-14, 188-1): an
 * approved 판정 정정 of a PROVISIONAL market, v(n) → v(n+1) — every one, a grounds-only correction
 * that keeps the result included — with the new version's result and its new 이의 기한. Not the
 * previous result (188-1).
 */
export const marketJudgementCorrectedParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  result: noticeResultSchema,
  disputeDeadline: noticeInstantSchema,
  judgementTimeZone: noticeJudgementZoneSchema,
});
export type MarketJudgementCorrectedParams = z.infer<typeof marketJudgementCorrectedParamsSchema>;

export const MARKET_JUDGEMENT_CORRECTED_NOTIFICATION = defineNotification({
  type: 'market_judgement_corrected',
  category: 'market',
  targets: ['market'],
  params: marketJudgementCorrectedParamsSchema,
  merge: null,
});

/** 52-14: the decisions told to a dispute's submitter — 기각 and 수용 (a decided dispute's status). */
export const NOTIFIED_DISPUTE_DECISIONS = [
  'dismissed',
  'accepted',
] as const satisfies readonly MarketDisputeStatus[];
export type NotifiedDisputeDecision = (typeof NOTIFIED_DISPUTE_DECISIONS)[number];

/**
 * `market_dispute_decided` (N03 §5; 52-14, 188-3): an admin's 기각 or 수용 of the recipient's own
 * 판정 이의, with the decision's public reason (#173 13항 — the 공개 판정 기록 shows it). A dispute
 * sent back to pending by a correction's 반려·철회 is not told (188-6); deciding it again is a new
 * notice.
 */
export const marketDisputeDecidedParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  decision: z.enum(NOTIFIED_DISPUTE_DECISIONS),
  reason: noticeTextSchema,
});
export type MarketDisputeDecidedParams = z.infer<typeof marketDisputeDecidedParamsSchema>;

export const MARKET_DISPUTE_DECIDED_NOTIFICATION = defineNotification({
  type: 'market_dispute_decided',
  category: 'market',
  targets: ['market'],
  params: marketDisputeDecidedParamsSchema,
  merge: null,
});

/**
 * `market_dispute_closed_by_correction` (N03 §7; 52-14 '정정으로 종결이면 새 이의 기한도 싣는다',
 * 188-1): the recipient's pending 판정 이의 closed by an approved correction, with the new
 * version's 이의 기한 only — the corrected result is in the correction notice and on the detail.
 */
export const marketDisputeClosedByCorrectionParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  disputeDeadline: noticeInstantSchema,
  judgementTimeZone: noticeJudgementZoneSchema,
});
export type MarketDisputeClosedByCorrectionParams = z.infer<
  typeof marketDisputeClosedByCorrectionParamsSchema
>;

export const MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION = defineNotification({
  type: 'market_dispute_closed_by_correction',
  category: 'market',
  targets: ['market'],
  params: marketDisputeClosedByCorrectionParamsSchema,
  merge: null,
});

/**
 * `market_settled` (N05 §4 최종 정산, N03 §5·§6; 52-12 '지급 완료 때 최종 정산', 52-15): the payout
 * done, SETTLING → SETTLED — the confirmed result and, for a holder at the payout, `payoutCoin`:
 * the sum of the recipient's own payouts there (both outcomes, 0 included; no P&L). Null for a
 * watcher who held nothing. A VOID payout is a 지급, never a refund (N03 §6).
 */
export const marketSettledParamsSchema = z.object({
  marketTitle: noticeTitleSchema,
  result: noticeResultSchema,
  payoutCoin: payoutDecimalSchema.nullable(),
});
export type MarketSettledParams = z.infer<typeof marketSettledParamsSchema>;

export const MARKET_SETTLED_NOTIFICATION = defineNotification({
  type: 'market_settled',
  category: 'market',
  targets: ['market'],
  params: marketSettledParamsSchema,
  merge: null,
});

// ---- 커뮤니티 알림 (#135, ADR-0161) ----------------------------------------------------------
//
// The six 커뮤니티 types (52-21: category `community` — N05 §4 "커뮤니티: 내 글의 답글·운영 처리
// 결과", 52-16 "이 알림은 N05 §4의 커뮤니티 분류다", 52-19 "커뮤니티 분류로 두고"). A reply goes to
// the author right above it (52-18): a 댓글 to the post's author (`post_replied`), a 대댓글 — one
// answering a 대댓글 included — to its 댓글's author (`comment_replied`); never to the writer
// (135-3). The two merge while unread, per post and per 댓글 (52-7, no cap), and keep only the
// latest reply's id and time: never its body (135-4) nor its author, whom the API reads through
// `replyId` when the list is read (52-15). An action taken on the recipient (52-16: every one,
// account restrictions of any reason included), its cancellation and a restriction's 감경 or 조기
// 해제 carry the action's kind and, for a restriction, its own end (135-2, 135-6) — never the
// reason, the operator, an approval, a report or a reporter (#45 13항). A proposal's 채택 or 반려
// carries the decision and the recipient's own question (52-19 "결론만"). The words are 135-5's.

/**
 * A reply (#48): the latest one a reply notice holds — its id and its `created_at` as
 * `toISOString()` writes it (52-7, 52-15). The id is public (every comment list answers it); the
 * author is read through it when the list is read (the API's `replyAuthor`), never stored.
 */
export const replyParamsSchema = z.object({
  replyId: uuidSchema,
  replyCreatedAt: noticeInstantSchema,
});
export type ReplyParams = z.infer<typeof replyParamsSchema>;

/**
 * 52-7: the later of two replies by (created_at, id) — the order the post page lists them in.
 * Commutative and associative (a max), so the write path's event-key order never matters
 * (ADR-0158 결정 1), and with the producer's `occurredAt` the reply's own `created_at`, the row's
 * 발생 시각 (GREATEST) and the params name the same reply under concurrent merges too.
 */
const laterReply = (held: ReplyParams, next: ReplyParams): ReplyParams => {
  const heldAt = Date.parse(held.replyCreatedAt);
  const nextAt = Date.parse(next.replyCreatedAt);
  if (heldAt !== nextAt) return heldAt > nextAt ? held : next;
  return held.replyId >= next.replyId ? held : next;
};

export type PostRepliedParams = ReplyParams;

/**
 * `post_replied` (N05 §2·§4 내 글의 답글; 52-7, 52-15, 52-18, 135-3, 135-4): a 댓글 another member
 * wrote on the recipient's post, merged per post while unread (the merge key is the post: the
 * target, which cannot change as replies merge).
 */
export const POST_REPLIED_NOTIFICATION = defineNotification({
  type: 'post_replied',
  category: 'community',
  targets: ['post'],
  params: replyParamsSchema,
  merge: laterReply,
});

export type CommentRepliedParams = ReplyParams;

/**
 * `comment_replied` (52-7, 52-15, 52-18, 135-3, 135-4): a 대댓글 another member wrote under the
 * recipient's 댓글 — one answering a 대댓글 there included (52-18) — merged per 댓글 while unread
 * (the merge key is that 댓글, the target; never the reply).
 */
export const COMMENT_REPLIED_NOTIFICATION = defineNotification({
  type: 'comment_replied',
  category: 'community',
  targets: ['comment'],
  params: replyParamsSchema,
  merge: laterReply,
});

/**
 * MODERATION_ACTION_TYPES as a plain enum: moderationActionTypeSchema carries `.meta({ id })`, a
 * `$ref` the definitions' flatness check refuses (ADR-0159 12-8).
 */
const noticeActionSchema = z.enum(MODERATION_ACTION_TYPES);

/** The two restrictions (#185, #139): the only actions with an end, a 감경 and a 조기 해제. */
export const RESTRICTION_ACTION_TYPES = [
  'writing_restriction',
  'account_restriction',
] as const satisfies readonly ModerationActionType[];
export type RestrictionActionType = (typeof RESTRICTION_ACTION_TYPES)[number];

/** Whether an action is one of the two restrictions. */
const isRestrictionAction = (action: string): action is RestrictionActionType =>
  (RESTRICTION_ACTION_TYPES as readonly string[]).includes(action);

/**
 * `moderation_action_taken` (N05 §4·§5 운영 처리 결과; 52-16, 135-2, 135-6): an action taken on
 * the recipient — a hiding of their post or comment, a warning, a profile item's action, a writing
 * restriction or an account restriction (at its approval, any reason). `endsAt` is a restriction's
 * own end (135-6: the value its MY card shows), null for 무기한 and for the five others; what it
 * hid, why, by whom and on whose report stay in MY 조치·신고 내역 (135-2).
 */
export const moderationActionTakenParamsSchema = z
  .object({ action: noticeActionSchema, endsAt: noticeInstantSchema.nullable() })
  .refine((params) => params.endsAt === null || isRestrictionAction(params.action), {
    message: 'only a restriction has an end',
  });
export type ModerationActionTakenParams = z.infer<typeof moderationActionTakenParamsSchema>;

export const MODERATION_ACTION_TAKEN_NOTIFICATION = defineNotification({
  type: 'moderation_action_taken',
  category: 'community',
  targets: ['moderation_action'],
  params: moderationActionTakenParamsSchema,
  merge: null,
});

/**
 * `moderation_action_cancelled` (52-16 '그 취소'): an operator's cancellation of an action taken on
 * the recipient — #50's cancel, an approved account-restriction cancel, an accepted 제재 이의's
 * (ADR-0084: the appeal itself is answered by email) — an ended restriction's included.
 */
export const moderationActionCancelledParamsSchema = z.object({ action: noticeActionSchema });
export type ModerationActionCancelledParams = z.infer<typeof moderationActionCancelledParamsSchema>;

export const MODERATION_ACTION_CANCELLED_NOTIFICATION = defineNotification({
  type: 'moderation_action_cancelled',
  category: 'community',
  targets: ['moderation_action'],
  params: moderationActionCancelledParamsSchema,
  merge: null,
});

/**
 * `moderation_restriction_end_changed` (52-16 '감경·조기 해제', 135-2, 135-5 (h)): a restriction's
 * end brought forward — `shorten` (감경) to `endsAt`, the new end, or `lift` (조기 해제) at once
 * (`endsAt` its instant). One per change: never the expiry itself (52-16 "기간이 끝나 저절로
 * 풀리는 것은 알리지 않는다").
 */
export const moderationRestrictionEndChangedParamsSchema = z.object({
  action: z.enum(RESTRICTION_ACTION_TYPES),
  change: z.enum(RESTRICTION_END_CHANGE_KINDS),
  endsAt: noticeInstantSchema,
});
export type ModerationRestrictionEndChangedParams = z.infer<
  typeof moderationRestrictionEndChangedParamsSchema
>;

export const MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION = defineNotification({
  type: 'moderation_restriction_end_changed',
  category: 'community',
  targets: ['moderation_action'],
  params: moderationRestrictionEndChangedParamsSchema,
  merge: null,
});

/** 52-19 "채택·반려 결론만": the decisions told to a proposal's proposer — both final. */
export const NOTIFIED_PROPOSAL_DECISIONS = [
  'adopted',
  'rejected',
] as const satisfies readonly ProposalStatus[];
export type NotifiedProposalDecision = (typeof NOTIFIED_PROPOSAL_DECISIONS)[number];

/**
 * `proposal_decided` (N05 §6; 52-19): the 채택 or 반려 of the recipient's own 시장 제안 and its
 * question — never the rejection's reason or explanation, nor an operator's memo (MY 내 제안 shows
 * them). The question is the proposer's own (≤ PROPOSAL_QUESTION_MAX, never edited); no `.min(1)`
 * and the generic cap — noticeTitleSchema's reasoning (ADR-0158 12-16): a raw value outside the
 * entry schema must not roll a decision back.
 */
export const proposalDecidedParamsSchema = z.object({
  decision: z.enum(NOTIFIED_PROPOSAL_DECISIONS),
  question: z.string().max(NOTIFICATION_PARAM_STRING_MAX),
});
export type ProposalDecidedParams = z.infer<typeof proposalDecidedParamsSchema>;

export const PROPOSAL_DECIDED_NOTIFICATION = defineNotification({
  type: 'proposal_decided',
  category: 'community',
  targets: ['proposal'],
  params: proposalDecidedParamsSchema,
  merge: null,
});

/**
 * The product's notification types (N05 §4). #53 shipped none (52-20 lists no type outside N05's
 * but the post-payout correction and compensation, #144; 시작 Coin, a re-grant's result, a
 * review's rejection and a market's opening are not notifications). #134 ships the 거래 three
 * (ADR-0158), #54 the 시장 five (ADR-0159), #188 the 판정·정산 six (ADR-0160), #135 the 커뮤니티
 * six (ADR-0161, 52-19's 제안 included). #144 (정정·보상) appends its own here with its guard
 * entry (NOTIFICATION_TYPE_REGISTRY) and its web renderer, and edits the pin in
 * notifications.test.ts.
 */
export const NOTIFICATION_DEFINITIONS = [
  ORDER_FILLED_NOTIFICATION,
  ORDERS_CANCELLED_NOTIFICATION,
  ORDERS_EXPIRED_NOTIFICATION,
  MARKET_CLOSED_NOTIFICATION,
  MARKET_PAUSED_NOTIFICATION,
  MARKET_RESUMED_NOTIFICATION,
  MARKET_CANCELLED_NOTIFICATION,
  MARKET_RULES_SUPPLEMENTED_NOTIFICATION,
  MARKET_JUDGEMENT_DELAYED_NOTIFICATION,
  MARKET_PROVISIONAL_RESULT_NOTIFICATION,
  MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
  MARKET_DISPUTE_DECIDED_NOTIFICATION,
  MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION,
  MARKET_SETTLED_NOTIFICATION,
  POST_REPLIED_NOTIFICATION,
  COMMENT_REPLIED_NOTIFICATION,
  MODERATION_ACTION_TAKEN_NOTIFICATION,
  MODERATION_ACTION_CANCELLED_NOTIFICATION,
  MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION,
  PROPOSAL_DECIDED_NOTIFICATION,
] as const satisfies readonly NotificationDefinition[];
export type NotificationType = (typeof NOTIFICATION_DEFINITIONS)[number]['type'];

// ---- DTOs ---------------------------------------------------------------------------------------

/** The unread count: 0 to NOTIFICATION_UNREAD_COUNT_CAP, the cap meaning "the cap or more". */
const unreadCountSchema = z.number().int().min(0).max(NOTIFICATION_UNREAD_COUNT_CAP);

/**
 * One notification of the member's inbox (`GET /me/notifications`, newest first by `occurredAt`).
 * `type` is a pattern string, not the list: the web renders a type it does not know with its
 * category's fallback title (53-11 ④). `eventCount` is how many events a merged one holds (52-6
 * 횟수); `occurredAt` is its 발생 시각 — a merge raises it to the latest event's (134-2); `readAt`
 * is when the member first opened it (53-2), null while unread.
 *
 * `replyAuthor` (#135, ADR-0161; 52-15 '답글 작성자 닉네임'): on the two reply types only, the public
 * face of the latest reply's author (`params.replyId`) as the post page shows it — read by the API
 * when the list is read, never stored: '탈퇴한 사용자' (`former_member`) for a closed account, the
 * nickname as it is now, '운영자' for an admin; null when that reply is hidden or deleted (its
 * placeholder hides its author, 135-4) or gone. Absent on every other type. A DTO field, not a
 * param: the flatness and identity rules of the params do not apply.
 */
export const notificationSchema = z
  .object({
    id: z.uuid(),
    type: z.string().regex(NOTIFICATION_TYPE_PATTERN),
    category: notificationCategorySchema,
    params: notificationParamsSchema,
    target: notificationTargetSchema,
    eventCount: z.number().int().min(1),
    occurredAt: z.iso.datetime(),
    readAt: z.iso.datetime().nullable(),
    replyAuthor: postAuthorSchema.nullable().optional(),
  })
  .meta({ id: 'Notification' });
export type Notification = z.infer<typeof notificationSchema>;

/** `GET /me/notifications/unread-count`, and what `POST /me/notifications/read-all` answers. */
export const notificationUnreadCountSchema = z
  .object({ unreadCount: unreadCountSchema })
  .meta({ id: 'NotificationUnreadCount' });
export type NotificationUnreadCount = z.infer<typeof notificationUnreadCountSchema>;

/** `POST /me/notifications/:id/read`: the notification as it now stands, and the unread count. */
export const notificationReadResultSchema = z
  .object({ notification: notificationSchema, unreadCount: unreadCountSchema })
  .meta({ id: 'NotificationReadResult' });
export type NotificationReadResult = z.infer<typeof notificationReadResultSchema>;
