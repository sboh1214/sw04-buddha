import * as z from 'zod';
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
 * shape only (`notifications.type` is a pattern, not a list — ADR-0157). #53 ships no type
 * (52-20); the producers add theirs (#134 거래, #54 시장 상태, #188 판정·정산, #135 커뮤니티, #144
 * 정정·보상), each with its guard entry (guards/notifications.ts) and its web renderer.
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
 * nothing redirects off the site and a route can move). #53 has one kind, a market by its slug —
 * a market's slug changes only in `draft` (`PATCH /admin/markets/:id`), and a market anybody can
 * be notified about is public (scheduled onward, CANCELLED included), so the stored slug never
 * goes stale and the detail answers in every public status (N05 §3, #53 AC 4). The producers add
 * the kinds they lead to (an order, the order history of one market, a post, a comment, the
 * moderation history, the proposals, the disputes) with their issues.
 */
export const notificationMarketTargetSchema = z
  .object({ kind: z.literal('market'), slug: marketSlugSchema })
  .meta({ id: 'NotificationMarketTarget' });
export type NotificationMarketTarget = z.infer<typeof notificationMarketTargetSchema>;

export const notificationTargetSchema = z
  .discriminatedUnion('kind', [notificationMarketTargetSchema])
  .meta({ id: 'NotificationTarget' });
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;
export type NotificationTargetKind = NotificationTarget['kind'];

/** Every target kind, in the union's order (notifications.test.ts keeps the two equal). */
export const NOTIFICATION_TARGET_KINDS = [
  'market',
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

/**
 * The product's notification types (N05 §4). Empty in #53: 52-20 lists no type outside N05's but
 * the post-payout correction and compensation (#144), and 시작 Coin, a re-grant's result, a
 * review's rejection and a market's opening are not notifications. Each producer appends its own
 * here — #134 (거래), #54 (시장 상태), #188 (판정·정산), #135 (커뮤니티, 52-19's 제안 included),
 * #144 (정정·보상) — with its guard entry (NOTIFICATION_TYPE_REGISTRY) and its web renderer, and
 * edits the pin in notifications.test.ts.
 */
export const NOTIFICATION_DEFINITIONS = [] as const satisfies readonly NotificationDefinition[];
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
