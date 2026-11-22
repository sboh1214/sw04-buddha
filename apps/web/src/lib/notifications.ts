import {
  NOTIFICATION_UNREAD_COUNT_CAP,
  type NotificationCategory,
  type NotificationTarget,
  type NotificationTargetKind,
  notificationTargetSchema,
} from '@buddha/shared';
import { copy } from '@/copy';
import type { InboxNotification } from './api';
import { MY_MODERATION_PATH } from './moderation';
import { myOrderPath } from './my';
import { myHistoryPath } from './my-history';
import { postPath } from './posts';
import { MY_PROPOSALS_PATH } from './proposals';

/**
 * 알림함 (#53, ADR-0157; N05 §4·§8, owner answers 53-1…53-11) as the member's screens read it: MY ›
 * 알림 (`/my/notifications`), its preview on MY 요약, and the unread count beside MY in the header,
 * the bottom tabs and MY's 알림 tab. A notification is a type, its flat params and a typed target —
 * never a sentence (@buddha/shared notifications.ts): the words are this web's (the type's
 * renderer, components/notifications), and where it leads is this module's map of target kinds to
 * paths, so nothing stored is a URL.
 *
 * Pure functions and keys, kept out of the components so vitest can run them under its node
 * environment (notifications.test.ts); the queries and writes are hooks/use-notifications.ts'.
 */

/**
 * The query keys. `['notifications']` is a private root (`PRIVATE_QUERY_ROOTS`, market-keys.ts):
 * an account's inbox is its own (PRIVATE_DATA `notifications`), read with its cookie, never fetched
 * on the server or dehydrated — and it is in the realtime provider's `PRIVATE_SNAPSHOT_KEYS`, so a
 * reconnect reads the count and the list again (a missed `user:notification` is a change nothing
 * else brings).
 *
 * Both end with the account the screen shows — the `Me` it was drawn from — as ADR-0091's
 * (`myDisputesKey`): the answers name no owner, and a read or '모두 읽음' acts on what was drawn
 * from them, naming that account. `['me']` can turn from A to B in place before the session does
 * (ADR-0090 결정 4-2): one entry for both would draw A's inbox, and A's count beside MY, under B's
 * name. SessionCacheGuard resets them with the rest all the same. `accountId` is undefined while
 * that account is not known: the queries are off then.
 */
export const NOTIFICATIONS_KEY = ['notifications'] as const;
/** Every account's list: what an invalidation of all of them names. */
export const NOTIFICATION_LIST_KEY = [...NOTIFICATIONS_KEY, 'list'] as const;
export const notificationListKey = (accountId: string | undefined) =>
  [...NOTIFICATION_LIST_KEY, accountId] as const;
/** Every account's unread count. */
export const NOTIFICATION_UNREAD_KEY = [...NOTIFICATIONS_KEY, 'unread'] as const;
export const notificationUnreadKey = (accountId: string | undefined) =>
  [...NOTIFICATION_UNREAD_KEY, accountId] as const;

/**
 * The window of the unread count's and the list's re-read on `user:notification` (53-1, owner
 * answer 53-9: 30 s), leading and trailing (`RoundWindow`, realtime-provider.tsx): a lone signal is
 * read at once, and signals that keep coming — since #134 (ADR-0158), a resting order's every
 * later fill publishes one — are read together at most this long after. The count is on every
 * page beside MY, so its rounds count against every page's request budget: at 30 s, 3 a minute,
 * which lowers the wallet's entry limit from 9 ledger pages to 5 (ADR-0144 결정 6, ADR-0157;
 * use-wallet-budget.test.ts) and /my/history's from 7 loaded pages to 6 (ADR-0148;
 * use-my-history-budget.test.ts).
 */
export const NOTIFICATION_REFRESH_MS = 30_000;

/** The most the count shows as a number; past it, `99+` (53-11 ①). */
export const UNREAD_COUNT_SHOWN_MAX = 99;

/**
 * The unread count as the header, the bottom tabs and the 알림 tab show it: nothing at 0, the
 * number up to 99, `99+` beyond — the server counts up to `NOTIFICATION_UNREAD_COUNT_CAP` (100),
 * which means "100 or more" (53-11 ①).
 */
export function unreadCountLabel(count: number): string | null {
  if (!(count > 0)) return null;
  return count > UNREAD_COUNT_SHOWN_MAX ? `${String(UNREAD_COUNT_SHOWN_MAX)}+` : String(count);
}

/**
 * What a screen reader hears for the count — the description of the link it sits beside
 * (`aria-describedby`), so the link's name stays 'MY' or '알림': '안 읽은 알림 3개', and past 99
 * '안 읽은 알림 99개 넘게'. Null at 0, when nothing is shown.
 */
export function unreadNotificationsText(count: number): string | null {
  if (!(count > 0)) return null;
  return count > UNREAD_COUNT_SHOWN_MAX
    ? `${copy.unreadNotifications} ${String(UNREAD_COUNT_SHOWN_MAX)}${copy.unreadNotificationsOver}`
    : `${copy.unreadNotifications} ${String(count)}${copy.unreadNotificationsCount}`;
}

/** The server's cap, restated where the web relies on it (notifications.test.ts pins the two). */
export const UNREAD_COUNT_CAP = NOTIFICATION_UNREAD_COUNT_CAP;

/** Each category's name (52-21): 거래 · 시장 · 커뮤니티. */
const CATEGORY_LABELS: Readonly<Record<NotificationCategory, string>> = {
  trade: copy.notificationCategoryTrade,
  market: copy.notificationCategoryMarket,
  community: copy.notificationCategoryCommunity,
};

/** A category's name; undefined for one a newer server sends that this web does not know. */
export function notificationCategoryLabel(category: NotificationCategory): string | undefined {
  return Object.hasOwn(CATEGORY_LABELS, category) ? CATEGORY_LABELS[category] : undefined;
}

/**
 * The title of a notification whose type this web does not render (53-11 ④): its category's name
 * and '알림' — '시장 알림' ('알림' alone for a category this web does not know). A type a newer
 * server sends reaches it, and params its definition refuses; a producer's type comes with its
 * renderer (components/notifications — #134's 거래 three, ADR-0158).
 */
export function notificationFallbackTitle(category: NotificationCategory): string {
  const label = notificationCategoryLabel(category);
  return label === undefined ? copy.notificationFallback : `${label} ${copy.notificationFallback}`;
}

/** Each target kind's own target, by its kind. */
type TargetOfKind = {
  [Kind in NotificationTargetKind]: Extract<NotificationTarget, { kind: Kind }>;
};

/**
 * Where each target kind leads, one entry per kind of the union (the type makes a kind a producer
 * adds without its path a compile error here). A market by its slug: the detail answers
 * in every public status — 마감, 지급 완료 and 취소 included (#53 AC 4) — and the target names no
 * status, so the path is the same whatever the market has become since. #134's two (ADR-0158,
 * 52-4): one of the member's own orders, its 주문 상세 (ADR-0141 — the final state, the filled and
 * the ended quantity); and the member's ended orders on 거래·정산 이력 (ADR-0143, the default
 * list), of one market or, for an account event, of all. #135's four (ADR-0161, 135-7 '화면 맨
 * 위'): a reply notice's post or 댓글 leads to the post page's top — published, its placeholder with
 * its comments, or 'post-gone' (135-4: the notice stays, the page says what is there); an action
 * on the member to MY 조치·신고 내역 (135-2) and a proposal's decision to MY 내 제안, each at its
 * top. The 댓글, action and proposal ids the targets keep are not read yet: a later anchor can use
 * them with no data change (targets are frozen, `notifications_kept`).
 */
const NOTIFICATION_TARGET_PATHS: {
  [Kind in NotificationTargetKind]: (target: TargetOfKind[Kind]) => string;
} = {
  // The slug as the schema took it (a-z, 0-9, Korean syllables and -): written as every market
  // link of this web writes it.
  market: (target) => `/markets/${target.slug}`,
  // The ids as the schema took them: uuids, lower-cased.
  order: (target) => myOrderPath(target.orderId),
  order_history: (target) =>
    myHistoryPath(target.marketId === null ? {} : { market: target.marketId }),
  post: (target) => postPath(target.postId),
  comment: (target) => postPath(target.postId),
  moderation_action: () => MY_MODERATION_PATH,
  proposal: () => MY_PROPOSALS_PATH,
};

/** A target's path, by its kind's entry (generic, so the entry and the target are one kind's). */
function targetPath<Kind extends NotificationTargetKind>(
  kind: Kind,
  target: TargetOfKind[Kind],
): string {
  return NOTIFICATION_TARGET_PATHS[kind](target);
}

/**
 * Where a notification leads, or null: a target the shared schema does not take — a kind a newer
 * server sends that this web does not know, a malformed one — leads nowhere, and its row only marks
 * the notification read (ADR-0157). Never a URL from the data: the path is built here.
 */
export function notificationHref(target: unknown): string | null {
  const parsed = notificationTargetSchema.safeParse(target);
  if (!parsed.success) return null;
  return targetPath(parsed.data.kind, parsed.data);
}

/** Whether the member has not read it yet (53-2: a read keeps its first `readAt`). */
export function isUnread(notification: Pick<InboxNotification, 'readAt'>): boolean {
  return notification.readAt === null;
}

/** One page of `GET /me/notifications`: newest first, the cursor of the next page. */
export interface NotificationPage {
  items: InboxNotification[];
  nextCursor: string | null;
}

/** What an infinite query holds of the list. */
export interface NotificationPages {
  pages: NotificationPage[];
  pageParams: unknown[];
}

/**
 * The list's pages with `notification` in place of the row of its id, as a read answered it; the
 * pages as they were (the same object) when no row has that id, so a write that changed nothing
 * costs no render.
 */
export function withNotification(
  held: NotificationPages | undefined,
  notification: InboxNotification,
): NotificationPages | undefined {
  if (held === undefined) return held;
  let changed = false;
  const pages = held.pages.map((page) => {
    if (!page.items.some((item) => item.id === notification.id)) return page;
    changed = true;
    return {
      ...page,
      items: page.items.map((item) => (item.id === notification.id ? notification : item)),
    };
  });
  return changed ? { ...held, pages } : held;
}
