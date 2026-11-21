import { Inject, Injectable } from '@nestjs/common';
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationPage,
  unreadNotificationCount,
  type Db,
  type NotificationRow,
} from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  notificationCategorySchema,
  notificationEvent,
  type CursorQuery,
  type Notification,
  type NotificationReadResult,
  type NotificationUnreadCount,
} from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { type Page } from '../wallet/wallet.service.js';

/** One notification as the API answers it (`notificationSchema`): what its row stores. */
export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.type,
    // The column's CHECK holds it to NOTIFICATION_CATEGORIES (migration 0078).
    category: notificationCategorySchema.parse(row.category),
    params: row.params,
    target: row.target,
    eventCount: row.eventCount,
    occurredAt: row.occurredAt.toISOString(),
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
  };
}

/**
 * 앱 내 알림함 (#53, ADR-0157; N05 §4·§8): the member's reads and read marks of its own inbox. The
 * rows, the locks and the write path are @buddha/db's (notifications.ts — `createNotifications`
 * is the producers' one writer, and nothing here creates a notification); this adds the answers
 * the API gives and the `user:notification` signal its writes cause. Every method is the session
 * account's own: another account's notification answers as a missing one.
 *
 * - The list (53-3): newest first by 발생 시각 — a merged one at its latest event (134-2) — with
 *   the `<millis>_<uuid>` keyset cursor every MY list uses; a cursor that does not decode serves
 *   the first page. Opening the list marks nothing read (53-2).
 * - The unread count (53-1): counted up to NOTIFICATION_UNREAD_COUNT_CAP, the cap meaning "the cap
 *   or more" (53-11 ①).
 * - Read marks (53-2): one notification when the member opens it, or every unread one ('모두
 *   읽음'). A notification already read keeps its first `read_at`, and marking it again changes
 *   nothing. After the COMMIT, and only when something changed, `user:notification` goes to the
 *   member's room (53-1: the member's other tabs and devices re-read their count and list; best
 *   effort, MarketPublisher) — a repeated mark publishes nothing.
 *
 * Read and written whatever the account's restriction (53-6). A request that passed SessionGuard
 * before a closure of the account committed finds the inbox gone with it: its mark reaches nothing
 * (NOT_FOUND for one notification, nothing changed for all), as the next request is refused.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly publisher: MarketPublisher,
  ) {}

  /** The member's notifications, newest first, one cursor page (53-3). */
  async list(userId: string, query: CursorQuery): Promise<Page<Notification>> {
    const keyset = decodeKeyset(query.cursor, 'uuid');
    const { items, next } = await notificationPage(this.db, userId, {
      after: keyset ? { at: keyset.createdAt, id: keyset.id } : null,
      limit: query.limit,
    });
    return {
      items: items.map(toNotification),
      nextCursor: next ? encodeKeyset({ createdAt: next.at, id: next.id }) : null,
    };
  }

  /** How many of the member's notifications are unread, up to the cap (53-1, 53-11 ①). */
  async unreadCount(userId: string): Promise<NotificationUnreadCount> {
    return { unreadCount: await unreadNotificationCount(this.db, userId) };
  }

  /**
   * Marks one of the member's notifications read (53-2) and answers it as it now stands with the
   * unread count after it. NOT_FOUND when the member has none of that id — another account's
   * answers the same, untouched. One already read answers as it is, its first `read_at` kept.
   */
  async read(userId: string, id: string): Promise<NotificationReadResult> {
    const marked = await this.db.transaction(async (tx) => {
      const result = await markNotificationRead(tx, userId, id);
      if (result === null) throw new AppError('NOT_FOUND', { message: 'Notification not found' });
      return { ...result, unreadCount: await unreadNotificationCount(tx, userId) };
    });
    if (marked.changed && marked.row.readAt !== null) {
      await this.publisher.publishUser(userId, notificationEvent(marked.row.readAt));
    }
    return { notification: toNotification(marked.row), unreadCount: marked.unreadCount };
  }

  /**
   * '모두 읽음' (53-2): every notification of the member unread when it runs is marked read at one
   * instant; answers the unread count after it — 0 unless a producer's notification committed in
   * between, which stays unread.
   */
  async readAll(userId: string): Promise<NotificationUnreadCount> {
    const marked = await this.db.transaction(async (tx) => {
      const { changed } = await markAllNotificationsRead(tx, userId);
      return {
        changed,
        at: await clockTimestamp(tx),
        unreadCount: await unreadNotificationCount(tx, userId),
      };
    });
    if (marked.changed > 0) {
      await this.publisher.publishUser(userId, notificationEvent(marked.at));
    }
    return { unreadCount: marked.unreadCount };
  }
}
