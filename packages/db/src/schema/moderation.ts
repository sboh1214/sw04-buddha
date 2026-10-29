import {
  MODERATION_ACTION_TYPES,
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH,
  REPORT_DESCRIPTION_MAX_LENGTH,
  RESTRICTION_END_CHANGE_KINDS,
} from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { reportReasonEnum, reportStatusEnum, reportTargetTypeEnum } from './enums.js';
import { mediaObjects } from './media-objects.js';
import { postComments } from './post-comments.js';
import { posts } from './posts.js';

/** MODERATION_ACTION_TYPES as the SQL list the CHECK holds the column to (constants, quoted). */
const ACTION_TYPES_SQL = sql.raw(MODERATION_ACTION_TYPES.map((type) => `'${type}'`).join(', '));

/** RESTRICTION_END_CHANGE_KINDS as the SQL list the CHECK holds the column to. */
const END_CHANGE_KINDS_SQL = sql.raw(
  RESTRICTION_END_CHANGE_KINDS.map((kind) => `'${kind}'`).join(', '),
);

/**
 * 운영 조치 (#50, ADR-0081; ADR-0069 decision 2 #45-5, #45-11…#45-14, decision 3 #37-10, decision 4
 * #50 rows): one row per action an operator took on a member — from the report queue or directly,
 * without a report (decision 4 #50) — chosen by the violation's weight, never step by step and
 * never by a count of reports (#45-10, #45-11). The record the member reads on MY (type, reason,
 * end, cancellation — never the operator, #45-13) and operators read in full (ADR-0056 1-2).
 *
 * - `type`: MODERATION_ACTION_TYPES — `hide` (a post or a comment, `posts.hidden_at` /
 *   `post_comments.hidden_at` set in the same transaction), `warning` (a record and the member's
 *   notice only, #45-11), `nickname_reset`, `bio_clear`, `image_remove` (#37-10; what was taken
 *   away is kept in `profile_item_removals`), `writing_restriction` (작성 제한, #185, ADR-0082 —
 *   migration 0040). A varchar the CHECK below holds to the list, so #139's account restriction
 *   adds its type by replacing the CHECK in the migration that uses it, as 0040 did (a Postgres
 *   enum's new value cannot be used in that batch).
 * - `user_id`: the member acted on — a hidden item's author, a profile's member, the member
 *   restricted. Never the acting operator (decision 4 #50 «다른 운영자만 처리한다»: the CHECK holds
 *   it whoever writes).
 * - `post_id`, `comment_id`: what a hiding hid (one of them), what a warning or a writing
 *   restriction is about (at most one, or none — the item whose pending reports it resolved),
 *   nothing for the profile items.
 * - `reason`, `note`: one of the report reasons and the operator's explanation the member reads
 *   (owner decision 2026-10-22, ADR-0080: «사유 목록 중 하나 + 운영자 설명»); '기타' needs a note.
 * - `ends_at`: a writing restriction's end (#185): its own time and the term picked (1, 3, 7 or 30
 *   days), or null for 무기한 — and brought forward, never back, when an operator lifts it early or
 *   shortens it (감경, each a `restriction_end_changes` row). It stands while not cancelled and the
 *   clock is before the end: nothing runs when it ends. Null for every other type (the CHECK); #139
 *   adds the account restriction's.
 * - `cancelled_*`: an operator's cancellation, with a reason (decision 4 #50 «사유를 남기고 취소»),
 *   once. A hiding's cancellation shows the item again; a profile item is never restored (#37-10);
 *   a restriction's ends at once. The cancelling operator is not the member either.
 *
 * Only the cancellation ever changes, once, and a writing restriction's end, earlier each time and
 * only while it stands (trigger `moderation_actions_keep_record`, migrations 0039 and 0040). DELETE
 * stays for #184: the actions are kept for the retention period (#57-18 «신고·제재·이의 기록»). Rows
 * of a withdrawn member stay with the account (RESTRICT, as every record #140 anonymises around).
 */
export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: uuid().primaryKey().defaultRandom(),
    type: varchar({ length: 32 }).notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    postId: uuid().references(() => posts.id, { onDelete: 'restrict' }),
    commentId: uuid().references(() => postComments.id, { onDelete: 'restrict' }),
    reason: reportReasonEnum().notNull(),
    note: varchar({ length: MODERATION_NOTE_MAX_LENGTH }),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    endsAt: timestampTz(),
    cancelledAt: timestampTz(),
    cancelledBy: text().references(() => user.id, { onDelete: 'restrict' }),
    cancelReason: varchar({ length: MODERATION_REASON_MAX_LENGTH }),
  },
  (t) => [
    check('moderation_actions_type_check', sql`${t.type} IN (${ACTION_TYPES_SQL})`),
    /**
     * A hiding hides one item; a warning and a writing restriction are about one at most; the rest
     * about none.
     */
    check(
      'moderation_actions_subject_check',
      sql`CASE ${t.type} WHEN 'hide' THEN num_nonnulls(${t.postId}, ${t.commentId}) = 1 WHEN 'warning' THEN num_nonnulls(${t.postId}, ${t.commentId}) <= 1 WHEN 'writing_restriction' THEN num_nonnulls(${t.postId}, ${t.commentId}) <= 1 ELSE num_nonnulls(${t.postId}, ${t.commentId}) = 0 END`,
    ),
    check('moderation_actions_note_check', sql`${t.note} IS NULL OR btrim(${t.note}) <> ''`),
    check(
      'moderation_actions_other_note_check',
      sql`${t.reason} <> 'other' OR ${t.note} IS NOT NULL`,
    ),
    /**
     * Only a writing restriction has an end (null for 무기한), never before its own time — a lift
     * brings it to the lift's time; #139 adds the account restriction's.
     */
    check(
      'moderation_actions_ends_at_check',
      sql`${t.endsAt} IS NULL OR (${t.type} = 'writing_restriction' AND ${t.endsAt} >= ${t.createdAt})`,
    ),
    check(
      'moderation_actions_cancellation_check',
      sql`(${t.cancelledAt} IS NULL) = (${t.cancelledBy} IS NULL) AND (${t.cancelledAt} IS NULL) = (${t.cancelReason} IS NULL) AND btrim(${t.cancelReason}) IS DISTINCT FROM ''`,
    ),
    /** Another operator acts on an operator (decision 4 #50), and cancels too. */
    check(
      'moderation_actions_not_own_check',
      sql`${t.createdBy} <> ${t.userId} AND ${t.cancelledBy} IS DISTINCT FROM ${t.userId}`,
    ),
    /**
     * One standing hiding per item: `hidden_at` is set exactly while one stands, and a second
     * hiding of a hidden item is refused (MODERATION_NOT_ALLOWED `hidden`) — this holds it when
     * two operators hide at once.
     */
    uniqueIndex('moderation_actions_standing_post_hide_idx')
      .on(t.postId)
      .where(sql`${t.type} = 'hide' AND ${t.cancelledAt} IS NULL`),
    uniqueIndex('moderation_actions_standing_comment_hide_idx')
      .on(t.commentId)
      .where(sql`${t.type} = 'hide' AND ${t.cancelledAt} IS NULL`),
    /** A member's actions, newest first: MY (#45-13) and the operators' record of the member. */
    index('moderation_actions_user_id_created_at_id_idx').on(
      t.userId,
      desc(t.createdAt),
      desc(t.id),
    ),
    /** Every action, newest first (`GET /admin/moderation/actions`). */
    index('moderation_actions_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
    /** An item's actions: its moderation page, and a hidden item's reason on MY 내 글 (#51). */
    index('moderation_actions_post_id_idx')
      .on(t.postId)
      .where(sql`${t.postId} IS NOT NULL`),
    index('moderation_actions_comment_id_idx')
      .on(t.commentId)
      .where(sql`${t.commentId} IS NOT NULL`),
    /**
     * A member's writing restrictions not cancelled: what every post, comment and edit asks before
     * it is written (`writingRestrictionOf`, #185), and every new value of a public profile item.
     */
    index('moderation_actions_standing_restriction_idx')
      .on(t.userId, t.endsAt)
      .where(sql`${t.type} = 'writing_restriction' AND ${t.cancelledAt} IS NULL`),
  ],
);

/**
 * A writing restriction's end brought forward (#185, ADR-0082): one row per change an operator made
 * — `shorten` (감경, ADR-0069 decision 2 #45-14: «종료 시각을 앞당기는 기능», 무기한 to a term included,
 * no approval for a writing restriction) or `lift` (조기 해제, #45-12: «운영자가 일찍 풀 수 있다»,
 * the end set to the lift's time). The end before (`previous_ends_at`, null for 무기한) and after,
 * the operator's reason (operators only, as a cancellation's) and who and when. Written in the
 * transaction that moves `moderation_actions.ends_at`, with the `admin_actions` row; operators read
 * it with the action. The member reads the end as it stands (`moderation_actions.ends_at`) and,
 * from these rows, the latest change's `kind` ('조기 해제됨'·'감경됨') and the first change's
 * `previous_ends_at` as the end it was given (owner decision 2026-10-23 answer 4) — never the
 * reason, the operator or the time — for a cancelled restriction too (the web hides it, ADR-0082
 * 7-17). So the rows go with their action: the member's 조치·신고 내역 reads them.
 *
 * An action's changes are ordered by their ends, never by `created_at`: each brings the end
 * strictly forward (the CHECK below and the trigger of migration 0040, under the action's lock),
 * while two made one behind the other can share a millisecond of the clock.
 *
 * Never rewritten: buddha_app loses UPDATE (migration 0040); DELETE stays for #184, which removes
 * these rows before their action (RESTRICT).
 */
export const restrictionEndChanges = pgTable(
  'restriction_end_changes',
  {
    id: uuid().primaryKey().defaultRandom(),
    actionId: uuid()
      .notNull()
      .references(() => moderationActions.id, { onDelete: 'restrict' }),
    kind: varchar({ length: 16 }).notNull(),
    previousEndsAt: timestampTz(),
    endsAt: timestampTz().notNull(),
    reason: varchar({ length: MODERATION_REASON_MAX_LENGTH }).notNull(),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    check('restriction_end_changes_kind_check', sql`${t.kind} IN (${END_CHANGE_KINDS_SQL})`),
    check('restriction_end_changes_reason_check', sql`btrim(${t.reason}) <> ''`),
    /** Earlier only: a change never puts an end back, nor turns one into 무기한. */
    check(
      'restriction_end_changes_earlier_check',
      sql`${t.previousEndsAt} IS NULL OR ${t.endsAt} < ${t.previousEndsAt}`,
    ),
    /** An action's changes, read with it (ordered by their ends — above). */
    index('restriction_end_changes_action_id_created_at_idx').on(t.actionId, t.createdAt),
  ],
);

/**
 * 신고 (#50, ADR-0081; ADR-0069 decision 2 #45-10, #45-13, #45-15, decision 3 #37-10, decision 7):
 * one row per report a member filed on a post, a comment (댓글 or 대댓글) or a profile.
 *
 * - `target_type` and the target: `post_id` for a post, `comment_id` for a comment, neither for a
 *   profile (the CHECK); `reported_user_id` is always the member reported — the item's author or
 *   the profile's member — so the queue groups by it and an operator's own is told at once.
 *   `target_key` (generated) is the target as one text, the queue's group.
 * - `reporter_id`, `reporter_phone_hash`: who reported — the account and the keyed hash of its
 *   verified number (ADR-0071) when it reported: the same person is the same number (decision 7),
 *   so a member who withdrew and came back on the number keeps their pending reports and their
 *   count of the day. An operator's change of the member's number moves the hash of their pending
 *   reports and those of the last 24 hours to the new number (docs/OPERATIONS.md, owner decision
 *   2026-10-21, ADR-0081), so the same person follows the number. Never the member reported (the
 *   CHECK), and never shown to them (#45-13).
 * - `reason`, `description`: one of the eight reasons (#50 «하나»), and the member's text —
 *   required with '기타' (#45-10).
 * - `status`, `resolved_at`, `resolved_by`: pending until an operator processes it, once —
 *   `actioned` naming the action that resolved it (`action_id`), or `dismissed` (기각) with the
 *   operator's reason. The intake and processing times are what #95's report processing time is
 *   counted from (N05 §8). The operator is never the member reported (decision 4 #50).
 *
 * One pending report per account and target (the unique index; ADR-0069 decision 7: «처리 중일 때만
 * 막는다»), and the API refuses the same of a withdrawn account on the same number. Only the
 * processing ever changes a row, once, and the number change's hash alone (trigger
 * `reports_keep_record`, migration 0039: only to the hash and for the reports that change's
 * transaction names, so no write of the API moves it). DELETE
 * stays for #184 (#57-18: kept for the retention period; a pending one until it is processed,
 * decision 7). Nothing public ever reads this table (PRIVATE_DATA `reports`).
 */
export const reports = pgTable(
  'reports',
  {
    id: uuid().primaryKey().defaultRandom(),
    targetType: reportTargetTypeEnum().notNull(),
    postId: uuid().references(() => posts.id, { onDelete: 'restrict' }),
    commentId: uuid().references(() => postComments.id, { onDelete: 'restrict' }),
    reportedUserId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** The target as one text: the post's or the comment's id, the profile's account. */
    targetKey: text()
      .notNull()
      .generatedAlwaysAs(sql`coalesce(post_id::text, comment_id::text, reported_user_id)`),
    reporterId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    reporterPhoneHash: varchar({ length: 64 }).notNull(),
    reason: reportReasonEnum().notNull(),
    description: varchar({ length: REPORT_DESCRIPTION_MAX_LENGTH }),
    status: reportStatusEnum().notNull().default('pending'),
    createdAt: createdAt(),
    resolvedAt: timestampTz(),
    resolvedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    actionId: uuid().references(() => moderationActions.id, { onDelete: 'restrict' }),
    dismissalReason: varchar({ length: MODERATION_REASON_MAX_LENGTH }),
  },
  (t) => [
    check(
      'reports_target_check',
      sql`(${t.targetType} = 'post') = (${t.postId} IS NOT NULL) AND (${t.targetType} = 'comment') = (${t.commentId} IS NOT NULL)`,
    ),
    check('reports_phone_hash_check', sql`${t.reporterPhoneHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'reports_description_check',
      sql`${t.description} IS NULL OR btrim(${t.description}) <> ''`,
    ),
    check(
      'reports_other_description_check',
      sql`${t.reason} <> 'other' OR ${t.description} IS NOT NULL`,
    ),
    check(
      'reports_resolution_check',
      sql`(${t.status} = 'pending') = (${t.resolvedAt} IS NULL) AND (${t.resolvedAt} IS NULL) = (${t.resolvedBy} IS NULL) AND (${t.status} = 'actioned') = (${t.actionId} IS NOT NULL) AND (${t.status} = 'dismissed') = (${t.dismissalReason} IS NOT NULL) AND btrim(${t.dismissalReason}) IS DISTINCT FROM ''`,
    ),
    /** Nobody reports themselves (#45-10), and nobody processes a report on themselves (#50). */
    check(
      'reports_not_own_check',
      sql`${t.reporterId} <> ${t.reportedUserId} AND ${t.resolvedBy} IS DISTINCT FROM ${t.reportedUserId}`,
    ),
    /** One pending report per account and target (decision 7). */
    uniqueIndex('reports_pending_reporter_target_idx')
      .on(t.reporterId, t.targetType, t.targetKey)
      .where(sql`${t.status} = 'pending'`),
    /** A target's reports in order: the queue's groups, a target's moderation page. */
    index('reports_target_created_at_idx').on(t.targetType, t.targetKey, t.createdAt),
    /** The member's reports, newest first (MY), and the account's count of the day. */
    index('reports_reporter_id_created_at_id_idx').on(t.reporterId, desc(t.createdAt), desc(t.id)),
    /** The person's count of the day (REPORTS_PER_DAY), by number (decision 7). */
    index('reports_reporter_phone_hash_created_at_idx').on(t.reporterPhoneHash, t.createdAt),
    /** The reports on a member's items: the member's moderation page. */
    index('reports_reported_user_id_idx').on(t.reportedUserId),
    /** The reports an action resolved. */
    index('reports_action_id_idx')
      .on(t.actionId)
      .where(sql`${t.actionId} IS NOT NULL`),
  ],
);

/**
 * What an operator took away from a profile (#37-10: «운영자만 보게 보존(보존기간 동안), 복원 없음»):
 * one row per `nickname_reset`, `bio_clear` or `image_remove` action — the nickname given back to
 * an auto nickname, the 소개 emptied, or the image removed. The member sets a new one; nothing here
 * is ever put back. Operators read it on the member's moderation page (the image at
 * `GET /admin/media/:mediaId`); nobody else does.
 *
 * - `image_id`: the image stays a `media_objects` row of kind `profile_image`, attached and named by
 *   no profile, so `GET /media/:mediaId` serves it to nobody and the orphan clean-up never takes it
 *   (ADR-0079 7-6); RESTRICT keeps its row and bytes until #184 removes this row after the retention
 *   period.
 *
 * Never rewritten: buddha_app loses UPDATE (migration 0039); DELETE stays for #184.
 */
export const profileItemRemovals = pgTable(
  'profile_item_removals',
  {
    actionId: uuid()
      .primaryKey()
      .references(() => moderationActions.id, { onDelete: 'restrict' }),
    nickname: varchar({ length: 20 }),
    bio: varchar({ length: 160 }),
    imageId: uuid()
      .unique('profile_item_removals_image_id_unique')
      .references(() => mediaObjects.id, { onDelete: 'restrict' }),
  },
  (t) => [
    check(
      'profile_item_removals_item_check',
      sql`num_nonnulls(${t.nickname}, ${t.bio}, ${t.imageId}) = 1`,
    ),
  ],
);
