import * as z from 'zod';
import { NICKNAME_HOLD_DAYS } from './nickname.js';

/**
 * 개인정보 보존기간 (#184, ADR-0069 decision 1 #57-18, decision 4 #184 rows and decision 7). The
 * records a withdrawal (#140) or a deletion leaves for operators are kept for a period per data
 * kind, then deleted by the worker's daily `retention.purge` job:
 *
 * - The periods are release settings (ADR-0055, `RETENTION_PERIOD_SETTINGS` in release-settings.ts),
 *   one per data kind the owner listed, entered in `/admin/settings`. Only a period whose status is
 *   `approved` is ever applied (decision 7: undecided, proposal and test values delete nothing — the
 *   records are kept), and a changed value applies to the runs after the change: a run reads each
 *   period once, when it starts.
 * - The period counts from the withdrawal (`profiles.closed_at`) for a withdrawn account's remaining
 *   records, and from the deletion for what a live account deleted (decision 4 #184 «기간의 기준
 *   시각»). Edit history always counts from when the version was replaced, and a record still being
 *   processed is never deleted before its processing ends — its period then counts from the later
 *   of the withdrawal and the processing (decision 7). What a pending report or a pending account
 *   restriction request is about keeps its deleted original and its edit history until it is
 *   processed, decided or retracted (owner decisions 2026-10-24 4 and 12).
 * - The ledger and the operational records (`admin_actions`, the purge records below) are kept with
 *   no period (#57-18), and so are the watch events (ADR-0064), likes, posts that were not deleted
 *   and the start grants: nothing here names them.
 * - Each run records, per kind it processed, how many it deleted and when — no personal content
 *   (decision 4 #184 «경과 처리 기록»): `retention_purges`, read at `GET /admin/retention-purges`.
 *
 * A personal data kind added after #184 (notifications #53, visit records #151, …) registers its
 * period the same way: the period the owner decides for it — a new setting in
 * RETENTION_PERIOD_SETTINGS or an existing one's, whose description then names the kind too — a
 * purge kind here, and its step in the worker's job (docs/SETTINGS.md '보존기간 항목 등록하기').
 */

/**
 * The longest period a retention setting takes, in days: about twenty years. A bound against a
 * typo in the admin screen (as START_GRANT_MAX_COIN is), not a decided value — #133 decides the
 * values.
 */
export const RETENTION_PERIOD_MAX_DAYS = 7_300;

/**
 * The data kinds that have a retention period of their own, each one release setting
 * (RETENTION_PERIOD_SETTINGS):
 * - `consent_records`: 동의 기록 — a withdrawn account's consent records (`consent_records`).
 * - `phone_verification_records`: 본인확인 기록 — a withdrawn account's code sends
 *   (`phone_verification_codes`: number, real name, code hash, times, client address — ADR-0070,
 *   kept past the withdrawal by the owner's exception to #57-18's immediate deletion).
 * - `deleted_posts`: 지운 글 원문 — what an author deleted (posts, 댓글 and 대댓글) and, with the same
 *   period (decision 7), the operator-only edit history of posts and comments, with the images only
 *   they used.
 * - `moderation_records`: 신고·제재 기록 — the reports a withdrawn account sent or a withdrawn member
 *   received (owner decision 2026-10-24 1), the actions on a withdrawn member (with their end
 *   changes and their two-person approval requests), and the content of a withdrawn member's post
 *   or comment an operator still hides, emptied as its hiding goes (owner decision 2026-10-24 3);
 *   later the judgement objections (#175) and #187's link flags join it (owner decision 2026-10-24
 *   13).
 * - `removed_profile_items`: 운영자가 지운 프로필 항목 — the nickname, 소개 or image an operator took
 *   away (#37-10, `profile_item_removals`).
 */
export const RETENTION_PERIODS = [
  'consent_records',
  'phone_verification_records',
  'deleted_posts',
  'moderation_records',
  'removed_profile_items',
] as const;
export type RetentionPeriod = (typeof RETENTION_PERIODS)[number];

/**
 * What a purge record counts (`retention_purges.kind`), in the order a run processes them — the
 * order the foreign keys ask for (a report before the action it names, a removed profile item and
 * an expired nickname hold before their action, an action before its approval requests):
 * - `nickname_holds`: nickname holds whose NICKNAME_HOLD_DAYS have passed — they hold nothing any
 *   more (#57-6 «30일 남는다»); a fixed period, no setting.
 * - `post_revisions`, `comment_revisions`: earlier versions of posts and comments.
 * - `deleted_posts`, `deleted_comments`: deleted originals, emptied in place (the row stays: the
 *   placeholder of a deleted 댓글 with replies, the likes and the records name it).
 * - `reports`: reports a withdrawn account sent or a withdrawn member received.
 * - `hidden_posts`, `hidden_comments`: a withdrawn member's posts and comments an operator still
 *   hides, emptied in place the same way — they stay hidden — with their hidings, which the run
 *   counts as `moderation_actions` (owner decision 2026-10-24 3): after the reports, which may name
 *   a hiding.
 * - `removed_profile_items`: what an operator took away from a profile.
 * - `moderation_actions`: actions on a withdrawn member (each with its end changes).
 * - `approval_requests`: the account restriction requests about a withdrawn member.
 * - `consent_records`, `phone_verification_records`: as their periods.
 */
export const RETENTION_PURGE_KINDS = [
  'nickname_holds',
  'post_revisions',
  'comment_revisions',
  'deleted_posts',
  'deleted_comments',
  'reports',
  'hidden_posts',
  'hidden_comments',
  'removed_profile_items',
  'moderation_actions',
  'approval_requests',
  'consent_records',
  'phone_verification_records',
] as const;
export type RetentionPurgeKind = (typeof RETENTION_PURGE_KINDS)[number];
export const retentionPurgeKindSchema = z
  .enum(RETENTION_PURGE_KINDS)
  .meta({ id: 'RetentionPurgeKind' });

/** The period each purge kind is deleted after; null for the nickname holds' fixed 30 days. */
export const RETENTION_PURGE_KIND_PERIODS: Readonly<
  Record<RetentionPurgeKind, RetentionPeriod | null>
> = {
  nickname_holds: null,
  post_revisions: 'deleted_posts',
  comment_revisions: 'deleted_posts',
  deleted_posts: 'deleted_posts',
  deleted_comments: 'deleted_posts',
  reports: 'moderation_records',
  hidden_posts: 'moderation_records',
  hidden_comments: 'moderation_records',
  removed_profile_items: 'removed_profile_items',
  moderation_actions: 'moderation_records',
  approval_requests: 'moderation_records',
  consent_records: 'consent_records',
  phone_verification_records: 'phone_verification_records',
};

/** The days a nickname hold is kept: the hold itself (#57-6), recorded as its purge's period. */
export const NICKNAME_HOLD_PURGE_DAYS = NICKNAME_HOLD_DAYS;

/** One day, as the periods count it: 24 hours of the database clock. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a period of `days` counted to `now` began: a record whose period starts at or before
 * it has kept its period whole and is deleted (a record exactly `days` old is due).
 */
export function retentionCutoffOf(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * What a purge record says of its kind (`retention_purges.outcome`; owner decision 2026-10-24 14):
 * - `done`: a batch that committed what it counts, or the one 0 of a kind the run found nothing due
 *   in.
 * - `failed` (실패): the run gave the kind up — a batch's transaction rejected, rolled back with
 *   what it would have deleted — and goes on to the next kind; `count` 0, and the batches before it
 *   stand recorded as `done`. The next run tries the kind again.
 */
export const RETENTION_PURGE_OUTCOMES = ['done', 'failed'] as const;
export type RetentionPurgeOutcome = (typeof RETENTION_PURGE_OUTCOMES)[number];
export const retentionPurgeOutcomeSchema = z
  .enum(RETENTION_PURGE_OUTCOMES)
  .meta({ id: 'RetentionPurgeOutcome' });

// ---- DTOs ---------------------------------------------------------------------------------------

/**
 * One purge record (`GET /admin/retention-purges`): a run deleted `count` records of `kind` at
 * `ranAt` (the run's instant, the database clock), with the period it read (`periodDays`). A run
 * writes one for each batch that deleted something, in the transaction that deleted it, or one of
 * `count` 0 for a kind it processed and found nothing due in, or — `outcome` `failed` — one of
 * `count` 0 for a kind it gave up on (owner decision 2026-10-24 14); a kind whose period is not
 * approved gets none. Never personal content.
 */
export const retentionPurgeSchema = z
  .object({
    id: z.string(),
    kind: retentionPurgeKindSchema,
    count: z.number().int().min(0),
    periodDays: z.number().int().min(1),
    ranAt: z.iso.datetime(),
    outcome: retentionPurgeOutcomeSchema,
  })
  .meta({ id: 'RetentionPurge' });
export type RetentionPurge = z.infer<typeof retentionPurgeSchema>;
