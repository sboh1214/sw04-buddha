import { NOTICE_PIN_LIMIT, type PostDocument } from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, timestampTz } from './columns.js';
import { mediaObjects } from './media-objects.js';

/**
 * 운영 공지 (#138; ADR-0069 decision 2 #45-8, decision 4 #138): one row per notice an operator
 * wrote. No author column: a notice is shown as 운영팀's, and who wrote, edited, pinned or unpinned
 * it is the audit log's (`admin_actions` `notice_*`, the admin and the time, #138), which the
 * admin's notice screen lists. Only a pinned notice is public (owner decision 2026-10-21).
 *
 * - `title`: required, at most 100 characters (`NOTICE_TITLE_MAX_LENGTH`, the post title's).
 * - `body`, `body_text`, `image_ids`: as a post's (posts.ts) — the normalised document of the
 *   posts' editor, its text without formatting and its images in order, derived when written.
 *   `GET /media/:mediaId` serves an image while it is in a pinned notice's `image_ids`.
 * - `edited_at`: the last edit that changed something ('수정됨'), or NULL; the versions it
 *   replaced are `notice_revisions`. It is also the version an edit names (`expectedEditedAt`):
 *   each edit is stamped strictly after the one before, so no two versions share it.
 * - `pinned_at` / `pin_slot`: pinned above the community list since then, in one of the
 *   NOTICE_PIN_LIMIT slots — or both NULL; only a pinned notice is public. The slot is how the
 *   database holds the limit (#45-8: «최대 3개») whoever writes: a slot is 1..NOTICE_PIN_LIMIT and
 *   unique, so a pin past the limit is a constraint violation even for a writer that skipped the
 *   API's lock. It means nothing else: the fixed area orders by `pinned_at`, the latest first.
 *
 * Notices are never deleted (#45-8: an unpinned notice stays on the admin screen and can be pinned
 * again) and hold no comment, like or report (#45-8).
 */
export const notices = pgTable(
  'notices',
  {
    id: uuid().primaryKey().defaultRandom(),
    title: varchar({ length: 100 }).notNull(),
    body: jsonb().$type<PostDocument>().notNull(),
    bodyText: text().notNull(),
    imageIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    editedAt: timestampTz(),
    pinnedAt: timestampTz(),
    pinSlot: smallint(),
  },
  (t) => [
    /** A title has text: the API refuses a blank one. */
    check('notices_title_check', sql`btrim(${t.title}) <> ''`),
    /** NULL passes a CHECK, so an unpinned notice has no slot and a pinned one one of the few. */
    check(
      'notices_pin_slot_check',
      sql`${t.pinSlot} BETWEEN 1 AND ${sql.raw(String(NOTICE_PIN_LIMIT))}`,
    ),
    /** Pinned means both: a time and a slot. */
    check('notices_pinned_check', sql`(${t.pinnedAt} IS NULL) = (${t.pinSlot} IS NULL)`),
    /** One notice per slot (NULLs are distinct): at most NOTICE_PIN_LIMIT pinned at a time. */
    unique('notices_pin_slot_unique').on(t.pinSlot),
    /** The admin screen's unpinned list, newest first (`GET /admin/notices?state=unpinned`). */
    index('notices_unpinned_created_at_id_idx')
      .on(desc(t.createdAt), desc(t.id))
      .where(sql`${t.pinnedAt} IS NULL`),
  ],
);

/**
 * 수정 이력 (#138: «수정 전 내용은 근거 글과 같이 운영자 전용 이력으로 남긴다»): every version an edit
 * replaced, title and body as they were, for operators only — the admin's notice screen lists them
 * and shows each whole (`GET /admin/notices/:noticeId/revisions`, owner decision 2026-10-21). Never
 * rewritten: buddha_app loses UPDATE (migration 0036), as on `post_revisions`. Kept with no
 * retention period (owner decision 2026-10-21: «지우지 않음, 보존기간 대상 아님»), so nothing
 * deletes a version; buddha_app keeps DELETE so that a later decision to delete needs no privilege
 * migration («DB는 나중에 지울 수 있게»).
 *
 * - `written_at`: when that version began — the notice's creation or the edit before.
 * - `replaced_at`: when an edit replaced it.
 */
export const noticeRevisions = pgTable(
  'notice_revisions',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    noticeId: uuid()
      .notNull()
      .references(() => notices.id, { onDelete: 'restrict' }),
    title: varchar({ length: 100 }).notNull(),
    body: jsonb().$type<PostDocument>().notNull(),
    bodyText: text().notNull(),
    imageIds: uuid().array().notNull(),
    writtenAt: timestampTz().notNull(),
    replacedAt: createdAt(),
  },
  (t) => [
    /** A notice's history in order. */
    index('notice_revisions_notice_id_id_idx').on(t.noticeId, t.id),
  ],
);

/**
 * Which notice an upload belongs to, as `post_images` says which post: written when a notice first
 * uses the image (creation or edit) and kept for its history. An image belongs to one notice (the
 * unique `media_id`) and to no post — that second rule is the API's alone, no constraint spans the
 * two tables: it refuses an upload a post holds for a notice, and one a notice holds for a post,
 * under the upload's row lock (NoticesService, PostsService).
 */
export const noticeImages = pgTable(
  'notice_images',
  {
    noticeId: uuid()
      .notNull()
      .references(() => notices.id, { onDelete: 'restrict' }),
    mediaId: uuid()
      .notNull()
      .unique('notice_images_media_id_unique')
      .references(() => mediaObjects.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.noticeId, t.mediaId] })],
);
