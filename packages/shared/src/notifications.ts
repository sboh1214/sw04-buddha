import * as z from 'zod';
import { serializeCoinAmount } from './api/coin-amount.js';
import { uuidSchema } from './api/uuid.js';
import { orderSideSchema, outcomeSchema, type OrderCancelReason } from './enums.js';
import { MARKET_PAUSE_REASONS } from './market-pause.js';
import { marketSlugSchema } from './market.js';

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
 * id, a public id, an address) is never stored: a type that shows one reads it when the list is
 * read, through the object its target names (52-15's reply author, ADR-0086's '탈퇴한 사용자').
 *
 * The product's types are NOTIFICATION_DEFINITIONS, and nothing else: the one write path
 * (@buddha/db `createNotifications`) refuses a type it does not list, and the database holds the
 * shape only (`notifications.type` is a pattern, not a list — ADR-0157). #53 shipped no type
 * (52-20); the producers add theirs, each with its guard entry (guards/notifications.ts) and its
 * web renderer: #134 the 거래 three (ADR-0158 — `order_filled`, `orders_cancelled`,
 * `orders_expired`, below), #54 the 시장 상태 five (ADR-0159 — `market_closed`, `market_paused`,
 * `market_resumed`, `market_cancelled`, `market_rules_supplemented`), then #188 판정·정산, #135
 * 커뮤니티, #144 정정·보상.
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
 *   account event's, 52-4).
 * The later producers add the kinds they lead to (a post, a comment, the moderation history, the
 * proposals, the disputes) with their issues.
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

export const notificationTargetSchema = z
  .discriminatedUnion('kind', [
    notificationMarketTargetSchema,
    notificationOrderTargetSchema,
    notificationOrderHistoryTargetSchema,
  ])
  .meta({ id: 'NotificationTarget' });
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;
export type NotificationTargetKind = NotificationTarget['kind'];

/** Every target kind, in the union's order (notifications.test.ts keeps the two equal). */
export const NOTIFICATION_TARGET_KINDS = [
  'market',
  'order',
  'order_history',
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
 * Public free text of an approved supplement: its request's reason, at most
 * APPROVAL_REASON_MAX_LENGTH, which equals NOTIFICATION_PARAM_STRING_MAX (notifications.test.ts
 * pins it, so a raised approval cap cannot roll a supplement's approval back).
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

/**
 * The product's notification types (N05 §4). #53 shipped none (52-20 lists no type outside N05's
 * but the post-payout correction and compensation, #144; 시작 Coin, a re-grant's result, a
 * review's rejection and a market's opening are not notifications). #134 ships the 거래 three
 * (ADR-0158), #54 the 시장 five (ADR-0159). Each later producer appends its own here — #188
 * (판정·정산), #135 (커뮤니티, 52-19's 제안 included), #144 (정정·보상) — with its guard entry
 * (NOTIFICATION_TYPE_REGISTRY) and its web renderer, and edits the pin in notifications.test.ts.
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
