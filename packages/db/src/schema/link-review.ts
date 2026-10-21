import { LINK_FLAG_REASONS } from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import { bigserial, check, index, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, timestampTz } from './columns.js';
import { postComments } from './post-comments.js';
import { posts } from './posts.js';

/**
 * 반복 링크 탐지 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187 rows): the links put
 * into posts and comments over the last day (`link_uses`), which the two repetition rules count,
 * and the operators' review list they feed (`link_flags`). Nothing here refuses or hides a write:
 * the review list is for an operator to look at (#50's moderation acts on what it finds).
 *
 * Both name their post or comment by its own column — exactly one of `post_id` and `comment_id`,
 * a CHECK — so each is a foreign key the database holds. RESTRICT, as every reference to a post or
 * a comment (#46, #48): neither is ever deleted, only marked.
 */

/**
 * One link a post or a comment took, when it took it: the post's or the comment's writing, or an
 * edit that put in a link the item did not have before (decision 4 #187 «수정으로 넣거나 바꾼 링크도
 * 본다»). Written in that write's transaction, under the link's lock (the API's LinkReviewService),
 * so two writes of one link count one after the other. Not written for an operator's write, nor for
 * a link that is an official source of the item's market (decision 4 #187, the exceptions).
 *
 * - `url`: the link in `normaliseLink`'s form (@buddha/shared), at most POST_LINK_MAX_LENGTH;
 * - `phone_hash`: the writer as a person (ADR-0071's keyed hash; decision 7), so «the same
 *   account» and «different accounts» count people;
 * - `used_at`: the database clock read under the lock.
 *
 * Kept a day: the rules look 24 hours back, and the worker deletes rows an hour past that
 * (`community.records_purge`). buddha_app inserts, reads and deletes, never rewrites one (migration
 * 0038: no UPDATE).
 */
export const linkUses = pgTable(
  'link_uses',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    url: varchar({ length: 2048 }).notNull(),
    phoneHash: varchar({ length: 64 }).notNull(),
    postId: uuid().references(() => posts.id, { onDelete: 'restrict' }),
    commentId: uuid().references(() => postComments.id, { onDelete: 'restrict' }),
    usedAt: timestampTz().notNull(),
  },
  (t) => [
    /** One link's uses in the window: both rules ask by the link and the time. */
    index('link_uses_url_used_at_idx').on(t.url, t.usedAt),
    check('link_uses_target_check', sql`num_nonnulls(${t.postId}, ${t.commentId}) = 1`),
    check('link_uses_phone_hash_check', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * The operators' review list of repeated links (`GET /admin/link-flags`): one row per post or
 * comment, link and rule (`reason`, LINK_FLAG_REASONS) — the items a rule caught when it was met,
 * each once (the UNIQUE, nulls compared as equal so the item's empty column does not make every row
 * distinct): when the third use of a link arrives, the three items are put on the list, and a
 * fourth within the window joins them. `flagged_at` is when the item was put on it.
 *
 * Kept, with no retention period (ADR-0083 7-20, a question for the owner): neither the writer nor
 * the app changes or removes an entry afterwards (buddha_app inserts and reads, migration 0038: no
 * UPDATE, no DELETE — a retention period would need a migration granting DELETE back). What became
 * of the item since — edited, deleted, hidden — is read from the item.
 */
export const linkFlags = pgTable(
  'link_flags',
  {
    id: uuid().primaryKey().defaultRandom(),
    url: varchar({ length: 2048 }).notNull(),
    reason: varchar({ length: 16, enum: LINK_FLAG_REASONS }).notNull(),
    postId: uuid().references(() => posts.id, { onDelete: 'restrict' }),
    commentId: uuid().references(() => postComments.id, { onDelete: 'restrict' }),
    flaggedAt: createdAt(),
  },
  (t) => [
    unique('link_flags_url_reason_target_unique')
      .on(t.url, t.reason, t.postId, t.commentId)
      .nullsNotDistinct(),
    /** The review list, newest first, with the row-comparison cursor (common/keyset.ts). */
    index('link_flags_flagged_at_id_idx').on(desc(t.flaggedAt), desc(t.id)),
    check('link_flags_target_check', sql`num_nonnulls(${t.postId}, ${t.commentId}) = 1`),
    check('link_flags_reason_check', sql`${t.reason} IN ('same_account', 'many_accounts')`),
  ],
);
