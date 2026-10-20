import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';

/**
 * 올린 이미지 (#46, ADR-0073; ADR-0069 decision 2 #45-3): one row per image the API received,
 * checked by its content, converted (EXIF and every other piece of metadata gone, the long side at
 * most 2,048px, a GIF still moving) and wrote to object storage (@buddha/storage) under
 * `storage_key`. The row is what the object is — whose, which type, how large — and the store
 * keeps only the bytes; nothing outside the API reads either (`GET /media/:mediaId` decides
 * whether an image may be shown).
 *
 * - `owner_id`: the account that uploaded it, the only one whose post may use it — or, for an
 *   admin, add it to a notice (#138; a notice keeps its images through any admin's edit) — or
 *   whose profile image it is.
 * - `kind`: what it is for (MEDIA_KINDS in @buddha/shared): `post_image`, or `profile_image` — a
 *   member's profile image (#141, ADR-0079), in the same store as ADR-0069 decision 3 #37-6 asks.
 *   A post or a notice takes only a `post_image` (PostsService, NoticesService); a profile only a
 *   `profile_image` of its own account (`profiles_image_fk`, which the unique
 *   `(id, owner_id, kind)` below is the target of).
 * - `content_type`: one of IMAGE_CONTENT_TYPES, what the conversion wrote (its own encoder's type,
 *   never the browser's claim), and the `Content-Type` it is served with.
 * - `attached_at`: when a post first used it (`post_images`) — or a notice (`notice_images`,
 *   #138: written in the posts' editor, so its images are this kind too) — or NULL while nothing
 *   has. An upload left unattached ORPHAN_MEDIA_HOURS is removed by the worker
 *   (`media.orphan_cleanup`): the row, its object key queued in the same transaction
 *   (`media_deletions`), then the object, and the key only once the store has removed it. Once
 *   attached it stays as long as the post's history needs it: a post's earlier versions and its
 *   deleted original are kept for operators (#45-4, #45-5), and their removal after the retention
 *   period is #184's. A notice's images stay with its history, which has no retention period
 *   (owner decision 2026-10-21, ADR-0077). A profile image is the profile's from the transaction
 *   that stores it — it never waits to be taken — so it is attached from its first moment (the
 *   CHECK below), and the worker never removes one: the member's replacement or deletion does, at
 *   once (ADR-0069 decision 4 #141), and an image an operator removes stays for operators only for
 *   the retention period (#37-10, #50's to do, #184's to remove), attached and shown by nothing.
 *
 * Rows outlive a withdrawal (`user` RESTRICT, like every record #140 anonymises around).
 */
export const mediaObjects = pgTable(
  'media_objects',
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    kind: varchar({ length: 16 }).notNull(),
    /** The object's key in the store (`post-images/<id>.<ext>`, OBJECT_KEY_PATTERN). */
    storageKey: varchar({ length: 160 }).notNull().unique('media_objects_storage_key_unique'),
    contentType: varchar({ length: 32 }).notNull(),
    byteSize: integer().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    createdAt: createdAt(),
    attachedAt: timestampTz(),
  },
  (t) => [
    check('media_objects_kind_check', sql`${t.kind} IN ('post_image', 'profile_image')`),
    check(
      'media_objects_content_type_check',
      sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')`,
    ),
    check(
      'media_objects_size_check',
      sql`${t.byteSize} > 0 AND ${t.width} > 0 AND ${t.height} > 0`,
    ),
    /** A profile image is attached from the start: the orphan clean-up never reaches one (#141). */
    check(
      'media_objects_profile_image_attached_check',
      sql`${t.kind} <> 'profile_image' OR ${t.attachedAt} IS NOT NULL`,
    ),
    /**
     * The target of `profiles_image_fk` (#141): a profile names an image of its own account and of
     * the profile image's kind. `id` alone is unique already; the three together are what the
     * foreign key can point at.
     */
    unique('media_objects_id_owner_id_kind_unique').on(t.id, t.ownerId, t.kind),
    /** The worker's scan: uploads nothing took, oldest first (`media.orphan_cleanup`). */
    index('media_objects_unattached_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.attachedAt} IS NULL`),
    /** An account's uploads (#140 and #184 reach them by account). */
    index('media_objects_owner_id_idx').on(t.ownerId),
  ],
);
