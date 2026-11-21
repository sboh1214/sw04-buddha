import {
  NOTIFICATION_DEFINITIONS,
  type NotificationDefinition,
  type NotificationParamValues,
  type NotificationType,
} from '@buddha/shared';
import type { ReactNode } from 'react';
import type { InboxNotification } from '@/lib/api';
import { notificationFallbackTitle } from '@/lib/notifications';

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
  /** The title, from params the type's definition has parsed. */
  readonly Title: (props: { params: NotificationParamValues }) => ReactNode;
}

/**
 * One renderer per type of the product's list (NOTIFICATION_DEFINITIONS), keyed by it exactly as
 * the guard's registry is: a type defined without its renderer, or a renderer left behind for a
 * removed type, fails to compile. Empty in #53, which ships no type (52-20); each producer adds
 * its own (#134 거래, #54 시장 상태, #188 판정·정산, #135 커뮤니티, #144 정정·보상).
 */
export const NOTIFICATION_RENDERERS = {} as const satisfies Record<
  NotificationType,
  NotificationRenderer
>;

/** What a row draws as its title: the type's renderer, or the fallback's words. */
export type NotificationView =
  | { known: true; Title: NotificationRenderer['Title']; params: NotificationParamValues }
  | { known: false; title: string };

/**
 * A notification's title as the row draws it: its type's renderer with the params its definition
 * parsed, when this web knows the type and the params are what the type holds; otherwise the
 * fallback — the category's name and '알림' (53-11 ④) — so a type a newer server sends, or params
 * a renderer could not draw, still show a row the member can open and mark read. The renderers and
 * definitions are parameters so a test can plant its own.
 */
export function notificationView(
  item: Pick<InboxNotification, 'type' | 'category' | 'params'>,
  renderers: Readonly<Record<string, NotificationRenderer>> = NOTIFICATION_RENDERERS,
  definitions: readonly NotificationDefinition[] = NOTIFICATION_DEFINITIONS,
): NotificationView {
  const renderer = Object.hasOwn(renderers, item.type) ? renderers[item.type] : undefined;
  const definition = definitions.find((entry) => entry.type === item.type);
  if (renderer !== undefined && definition !== undefined) {
    const parsed = definition.params.safeParse(item.params);
    if (parsed.success) return { known: true, Title: renderer.Title, params: parsed.data };
  }
  return { known: false, title: notificationFallbackTitle(item.category) };
}
