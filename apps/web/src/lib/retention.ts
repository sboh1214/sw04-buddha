import { RETENTION_PURGE_KINDS } from '@buddha/shared';
import { copy } from '@/copy';
import { type RetentionPurge, type RetentionPurgeKind } from './api';

/**
 * 보존기간 처리 기록 (#184, ADR-0087) as the admin screen reads it: what the worker's daily
 * `retention.purge` recorded (`GET /admin/retention-purges` — kind, count, the period applied and
 * the run's instant, no personal content, ADR-0069 decision 4 #184 «경과 처리 기록»), put in words
 * and gathered by run. Kept out of the component so vitest can run it under its node environment
 * (retention.test.ts).
 */

/** The admin screen of the records; the periods themselves are entered at /admin/settings. */
export const ADMIN_RETENTION_PATH = '/admin/retention';
export const ADMIN_RELEASE_SETTINGS_PATH = '/admin/settings';

/** The name of each kind a run counts, one copy key each (copy.ts). */
const KIND_LABELS: Readonly<Record<RetentionPurgeKind, string>> = {
  nickname_holds: copy.adminRetentionKindNicknameHolds,
  post_revisions: copy.adminRetentionKindPostRevisions,
  comment_revisions: copy.adminRetentionKindCommentRevisions,
  deleted_posts: copy.adminRetentionKindDeletedPosts,
  deleted_comments: copy.adminRetentionKindDeletedComments,
  reports: copy.adminRetentionKindReports,
  hidden_posts: copy.adminRetentionKindHiddenPosts,
  hidden_comments: copy.adminRetentionKindHiddenComments,
  removed_profile_items: copy.adminRetentionKindRemovedProfileItems,
  moderation_actions: copy.adminRetentionKindModerationActions,
  approval_requests: copy.adminRetentionKindApprovalRequests,
  consent_records: copy.adminRetentionKindConsentRecords,
  phone_verification_records: copy.adminRetentionKindPhoneVerificationRecords,
};

export function retentionPurgeKindLabel(kind: RetentionPurgeKind): string {
  return KIND_LABELS[kind];
}

/**
 * A count of records: `1,012건` — 0 too, the record that the run looked and found nothing due. A
 * kind the run gave up on (`failed`) says what it deleted before the error, `오류 전까지 500건`: a
 * bare `500건` after its 실패 would read as 500 failures — a label then its count, as /admin/sms
 * reads '보내지 못함' and its 건.
 */
export function retentionCountText(count: number, failed = false): string {
  const text = `${count.toLocaleString('ko-KR')}${copy.adminRetentionCountUnit}`;
  return failed ? `${copy.adminRetentionCountBeforeFailure} ${text}` : text;
}

/** The period a run applied, as a label and its value: `기간 365일`. */
export function retentionPeriodText(days: number): string {
  return `${copy.adminRetentionPeriod} ${days.toLocaleString('ko-KR')}${copy.adminRetentionDayUnit}`;
}

/** One kind's line in a run: its batches summed. */
export interface RetentionRunKind {
  kind: RetentionPurgeKind;
  label: string;
  /** What its batches deleted — before the failure, for a kind that failed ('오류 전까지 N건'). */
  count: number;
  periodDays: number;
  /**
   * The run gave the kind up (a `failed` record, owner decision 2026-10-24 14): its batch rolled
   * back, the next run tries it again.
   */
  failed: boolean;
}

/** One run: its instant (the database clock's, shared by every record it wrote) and its kinds. */
export interface RetentionRun {
  ranAt: string;
  kinds: RetentionRunKind[];
}

/**
 * The records as the screen lists them: one entry per run, newest first as the API answers them
 * (`(ran_at, id)` descending — a run's records share its instant), and in each run one line per kind
 * in the order the run took them (RETENTION_PURGE_KINDS), the counts of its batches summed — a kind
 * with more due than one batch writes a record per batch, and the screen says what the run deleted
 * of it. A kind the run gave up on has its `failed` record (count 0) beside the batches it
 * finished: its line is marked failed, with what those deleted. The API ends each page at a run's
 * end, so a run's records all come on one page; the pages loaded are read together, newest run
 * first. A kind's batches in one run share the period it read once at the start; a line per period
 * keeps them apart were it otherwise.
 */
export function retentionRuns(records: readonly RetentionPurge[]): RetentionRun[] {
  const runs = new Map<string, Map<string, RetentionRunKind>>();
  for (const record of records) {
    let kinds = runs.get(record.ranAt);
    if (kinds === undefined) {
      kinds = new Map();
      runs.set(record.ranAt, kinds);
    }
    const key = `${record.kind}:${String(record.periodDays)}`;
    const failed = record.outcome === 'failed';
    const line = kinds.get(key);
    if (line === undefined) {
      kinds.set(key, {
        kind: record.kind,
        label: retentionPurgeKindLabel(record.kind),
        count: record.count,
        periodDays: record.periodDays,
        failed,
      });
    } else {
      line.count += record.count;
      line.failed ||= failed;
    }
  }
  const order = (kind: RetentionPurgeKind) => RETENTION_PURGE_KINDS.indexOf(kind);
  return [...runs].map(([ranAt, kinds]) => ({
    ranAt,
    kinds: [...kinds.values()].sort(
      (a, b) => order(a.kind) - order(b.kind) || a.periodDays - b.periodDays,
    ),
  }));
}
