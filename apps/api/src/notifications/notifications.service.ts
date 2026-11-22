import { Inject, Injectable } from '@nestjs/common';
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationPage,
  schema,
  unreadNotificationCount,
  type Db,
  type NotificationRow,
} from '@buddha/db';
import {
  COMMENT_REPLIED_NOTIFICATION,
  POST_REPLIED_NOTIFICATION,
  decodeKeyset,
  encodeKeyset,
  notificationCategorySchema,
  notificationEvent,
  replyParamsSchema,
  type CursorQuery,
  type Notification,
  type NotificationReadResult,
  type NotificationUnreadCount,
  type PostAuthor,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { authorColumns, postAuthorOf } from '../posts/posts.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { type Page } from '../wallet/wallet.service.js';

/** Whatever reads: the pool or a transaction. */
type Executor = Pick<Db, 'select'>;

/** The two types whose notice names a reply (#135): their params hold its id (`replyId`). */
const REPLY_TYPES: ReadonlySet<string> = new Set([
  POST_REPLIED_NOTIFICATION.type,
  COMMENT_REPLIED_NOTIFICATION.type,
]);

/** The reply a reply notice holds (its params' `replyId`), or null when they do not parse. */
function replyIdOf(row: NotificationRow): string | null {
  if (!REPLY_TYPES.has(row.type)) return null;
  const params = replyParamsSchema.safeParse(row.params);
  return params.success ? params.data.replyId : null;
}

/**
 * The public face of each reply the rows' reply notices hold (#135, ADR-0161; 52-15 '답글 작성자
 * 닉네임', ADR-0157 결정 3: read when the list is read, never stored), by reply id: in ONE
 * statement, no lock, and none when no row holds a reply. The face every public answer gives
 * (`postAuthorOf`: the public id, the CURRENT nickname, the image, the 운영자 mark; '탈퇴한 사용자'
 * for a closed account) — never the account id. A reply hidden or deleted since, or gone, has none
 * (null): its public placeholder hides its author (ADR-0074, #45-5; 135-4).
 */
export async function replyAuthorsOf(
  executor: Executor,
  rows: readonly NotificationRow[],
): Promise<Map<string, PostAuthor | null>> {
  const ids = [...new Set(rows.flatMap((row) => replyIdOf(row) ?? []))];
  const authors = new Map<string, PostAuthor | null>();
  if (ids.length === 0) return authors;
  const { postComments, profiles } = schema;
  const found = await executor
    .select({
      id: postComments.id,
      deletedAt: postComments.deletedAt,
      hiddenAt: postComments.hiddenAt,
      ...authorColumns,
    })
    .from(postComments)
    .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
    .where(sql`${postComments.id} = ANY(${sql.param(ids)}::uuid[])`);
  for (const { id, deletedAt, hiddenAt, ...author } of found) {
    authors.set(id, deletedAt !== null || hiddenAt !== null ? null : postAuthorOf(author));
  }
  return authors;
}

/**
 * One notification as the API answers it (`notificationSchema`): what its row stores and, on the
 * two reply types only, `replyAuthor` from `authors` (`replyAuthorsOf` — null when the reply is
 * hidden, deleted or gone, or the params do not parse). Every other row's answer has no such key.
 */
export function toNotification(
  row: NotificationRow,
  authors: ReadonlyMap<string, PostAuthor | null> = new Map(),
): Notification {
  const notification: Notification = {
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
  if (!REPLY_TYPES.has(row.type)) return notification;
  const replyId = replyIdOf(row);
  return { ...notification, replyAuthor: replyId === null ? null : (authors.get(replyId) ?? null) };
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

  /**
   * The member's notifications, newest first, one cursor page (53-3); a reply notice with its
   * reply's author's public face (`replyAuthorsOf` — one more statement when the page holds one).
   */
  async list(userId: string, query: CursorQuery): Promise<Page<Notification>> {
    const keyset = decodeKeyset(query.cursor, 'uuid');
    const { items, next } = await notificationPage(this.db, userId, {
      after: keyset ? { at: keyset.createdAt, id: keyset.id } : null,
      limit: query.limit,
    });
    const authors = await replyAuthorsOf(this.db, items);
    return {
      items: items.map((row) => toNotification(row, authors)),
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
   * answers the same, untouched. One already read answers as it is, its first `read_at` kept. A
   * reply notice answers with its reply's author as the list does (#135) — the web puts this
   * answer in place of the listed row.
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
    const authors = await replyAuthorsOf(this.db, [marked.row]);
    return { notification: toNotification(marked.row, authors), unreadCount: marked.unreadCount };
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
