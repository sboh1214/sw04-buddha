import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENT_KEY_PATTERN,
  NOTIFICATION_TYPE_PATTERN,
  type NotificationParams,
  type NotificationTarget,
} from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';

/** NOTIFICATION_CATEGORIES as the SQL list the CHECK holds the column to. */
const CATEGORIES_SQL = sql.raw(
  NOTIFICATION_CATEGORIES.map((category) => `'${category}'`).join(', '),
);

/** NOTIFICATION_TYPE_PATTERN as the SQL literal the CHECKs match a type with. */
const TYPE_PATTERN_SQL = sql.raw(`'${NOTIFICATION_TYPE_PATTERN.source}'`);

/** NOTIFICATION_EVENT_KEY_PATTERN as the SQL literal the CHECKs match a key with. */
const EVENT_KEY_PATTERN_SQL = sql.raw(`'${NOTIFICATION_EVENT_KEY_PATTERN.source}'`);

/**
 * 알림함 (#53, ADR-0157): one row per open person's account — the gate every notification writer
 * and the account closure meet on. Made with the account by the "user" trigger
 * (`create_profile_for_user`, migration 0078; filled for every open person's account by its
 * backfill): a member and an admin get one, the 운영 마켓메이커 never (#115, 53-5 — the trigger
 * `refuse_operating_account_rows`), nor a closed account (`refuse_closed_account_rows`).
 *
 * The write path (@buddha/db `createNotifications`) takes the inbox FOR KEY SHARE SKIP LOCKED
 * before it writes: an account with no inbox — the operating account, a closed one — or one a
 * closure holds FOR UPDATE is skipped, never waited on (53-5 «탈퇴한 계정은 받지 않음»). The
 * closure takes its member's inbox FOR UPDATE first and deletes it, which cascades its
 * notifications and their keys (53-7 «탈퇴하면 한 번에 지움»; `profiles_closed_completely` checks
 * it went). buddha_app keeps the default DML: a row lock needs UPDATE privilege on some column.
 */
export const notificationInboxes = pgTable('notification_inboxes', {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
});

/**
 * One notification of a member's inbox (#53, ADR-0157; N05 §4): a type, its flat parameters and a
 * typed target — never a sentence (the web renders the copy by type) and never another member's
 * identity (52-15: the API reads it when the list is read, through the id the type keeps — a
 * reply's author through `replyId`, ADR-0161). Written only by `createNotifications` in the
 * transaction of the event it tells (53-4), which holds the type list (NOTIFICATION_DEFINITIONS):
 * the database holds the shape only — the type's pattern, the category list, an object of params
 * and a target with a kind — so a producer adds a type without a migration, and the tests' own
 * types never ship in the product's list.
 *
 * - `id` is a uuid, not a bigserial: what the member reads by, and a sequence would tell every
 *   member how many notifications everybody gets (as `market_searches`).
 * - `merge_key` is set by a mergeable type only (an order's fills, 52-6; replies to one post or
 *   comment, 52-7): at most one unread row per (account, type, merge key) is the merge target,
 *   and a read row never is — the next event after reading makes a new notification.
 * - `event_count` is how many events it holds (52-6 횟수); `occurred_at` its 발생 시각, the newest
 *   list order and the retention's anchor (53-10), which a merge raises to the latest event's
 *   (134-2) and never lowers; `read_at` when the member first opened it (53-2), kept once set.
 *
 * buddha_app may UPDATE `params`, `event_count`, `occurred_at` and `read_at` only (migration
 * 0078), and the trigger `notifications_kept` holds every role to the rules above. The retention
 * purge deletes by `occurred_at` (`retention.notifications`, approved values only), and the
 * closure with the inbox.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: text()
      .notNull()
      .references(() => notificationInboxes.userId, { onDelete: 'cascade' }),
    /** A type of NOTIFICATION_DEFINITIONS (the write path's list); the shape only here. */
    type: varchar({ length: 48 }).notNull(),
    /** The type's settings unit (NOTIFICATION_CATEGORIES, 52-21). */
    category: varchar({ length: 16 }).notNull(),
    /** The type's flat parameters, as the web renders them. */
    params: jsonb().$type<NotificationParams>().notNull(),
    /** Where it leads (`notificationTargetSchema`): a kind and its key, never a URL. */
    target: jsonb().$type<NotificationTarget>().notNull(),
    /** What the merged events are about (an order, a post, a comment); null when not mergeable. */
    mergeKey: varchar({ length: 128 }),
    eventCount: integer().notNull().default(1),
    occurredAt: timestampTz().notNull(),
    createdAt: createdAt(),
    readAt: timestampTz(),
  },
  (t) => [
    /** The target of `notification_keys`' foreign key: a key names its row's account and type. */
    unique('notifications_id_user_id_type_unique').on(t.id, t.userId, t.type),
    check('notifications_type_check', sql`${t.type} ~ ${TYPE_PATTERN_SQL}`),
    check('notifications_category_check', sql`${t.category} IN (${CATEGORIES_SQL})`),
    check('notifications_params_check', sql`jsonb_typeof(${t.params}) = 'object'`),
    check(
      'notifications_target_check',
      // IS NOT DISTINCT FROM: a target with no `kind` reads NULL, which `=` would let through.
      sql`jsonb_typeof(${t.target}) = 'object' AND jsonb_typeof(${t.target} -> 'kind') IS NOT DISTINCT FROM 'string'`,
    ),
    check('notifications_merge_key_check', sql`${t.mergeKey} ~ ${EVENT_KEY_PATTERN_SQL}`),
    check('notifications_event_count_check', sql`${t.eventCount} >= 1`),
    /** `GET /me/notifications`: one account's, newest first, the keyset `(occurred_at, id)`. */
    index('notifications_user_id_occurred_at_id_idx').on(t.userId, desc(t.occurredAt), desc(t.id)),
    /** The unread count (capped) and '모두 읽음': one account's unread rows. */
    index('notifications_user_id_unread_idx')
      .on(t.userId)
      .where(sql`${t.readAt} IS NULL`),
    /** At most one unread merge target per (account, type, merge key): the merge's arbiter. */
    uniqueIndex('notifications_merge_target_uidx')
      .on(t.userId, t.type, t.mergeKey)
      .where(sql`${t.readAt} IS NULL AND ${t.mergeKey} IS NOT NULL`),
    /** The retention purge's `ORDER BY occurred_at, id` past its cutoff. */
    index('notifications_occurred_at_id_idx').on(t.occurredAt, t.id),
  ],
);

/**
 * 중복 방지 키 (#53, ADR-0157 53-4): one row per event a notification holds — the one that made
 * it and every one merged into it — keyed per member by type and event id. The same event
 * reprocessed for the same member finds its key and is skipped (`duplicate`); another type, or
 * another member, is a key of its own. Claimed in the event's transaction after the row it names,
 * so a concurrent duplicate waits on the key's unique index and is skipped once the first commits.
 *
 * Lives as long as its notification (the composite foreign key's cascade): once the retention
 * deletes a row, the same event reprocessed would notify again — accepted (the period is days or
 * more, ADR-0157 구현의 선택). buddha_app may INSERT, SELECT and DELETE: a key is never changed.
 */
export const notificationKeys = pgTable(
  'notification_keys',
  {
    userId: text().notNull(),
    type: varchar({ length: 48 }).notNull(),
    /** The event's id as the producer keys it (NOTIFICATION_EVENT_KEY_PATTERN). */
    eventKey: varchar({ length: 128 }).notNull(),
    notificationId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.type, t.eventKey] }),
    /** The notification it was delivered in: its own account and type. */
    foreignKey({
      name: 'notification_keys_notification_fk',
      columns: [t.notificationId, t.userId, t.type],
      foreignColumns: [notifications.id, notifications.userId, notifications.type],
    }).onDelete('cascade'),
    check('notification_keys_type_check', sql`${t.type} ~ ${TYPE_PATTERN_SQL}`),
    check('notification_keys_event_key_check', sql`${t.eventKey} ~ ${EVENT_KEY_PATTERN_SQL}`),
    /** The cascade from a deleted notification finds its keys by it. */
    index('notification_keys_notification_id_idx').on(t.notificationId),
  ],
);
