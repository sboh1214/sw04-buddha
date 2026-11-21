import {
  NOTIFICATION_DEFINITIONS,
  type NotificationDefinition,
  type NotificationParamValues,
  type NotificationType,
  ORDERS_CANCELLED_NOTIFICATION,
  ORDERS_EXPIRED_NOTIFICATION,
  ORDER_FILLED_NOTIFICATION,
} from '@buddha/shared';
import type { ReactNode } from 'react';
import { copy } from '@/copy';
import type { InboxNotification } from '@/lib/api';
import { notificationFallbackTitle } from '@/lib/notifications';
import {
  orderFilledTitle,
  ordersCancelledTitle,
  ordersExpiredTitle,
} from '@/lib/trade-notifications';

/**
 * How the web words each notification type (#53, ADR-0157): the type's title from its params, in
 * the member's words and zone (52-15 — a time through `DateTimeText`, an amount as Coin), with
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
 * One renderer per type of the product's list (NOTIFICATION_DEFINITIONS), keyed by it exactly as
 * the guard's registry is: a type defined without its renderer, or a renderer left behind for a
 * removed type, fails to compile. #53 shipped none (52-20); #134 words the 거래 three
 * (lib/trade-notifications.ts, ADR-0158), and each later producer adds its own (#54 시장 상태,
 * #188 판정·정산, #135 커뮤니티, #144 정정·보상).
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
