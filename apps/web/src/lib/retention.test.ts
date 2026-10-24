import { RETENTION_PERIOD_SETTINGS, RETENTION_PURGE_KINDS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ADMIN_RETENTION_PURGES_KEY } from '@/hooks/use-admin-retention';
import { type RetentionPurge } from './api';
import { isPrivateQueryKey } from './market-keys';
import {
  ADMIN_RELEASE_SETTINGS_PATH,
  ADMIN_RETENTION_PATH,
  retentionCountText,
  retentionPeriodText,
  retentionPurgeKindLabel,
  retentionRuns,
} from './retention';

const LATER = '2026-10-23T19:30:00.000Z';
const EARLIER = '2026-10-22T19:30:00.000Z';

/** A record as the API answers it. */
function record(
  id: number,
  ranAt: string,
  kind: RetentionPurge['kind'],
  count: number,
  periodDays: number,
  outcome: RetentionPurge['outcome'] = 'done',
): RetentionPurge {
  return { id: String(id), kind, count, periodDays, ranAt, outcome };
}

describe('보존기간 처리 기록 (#184, ADR-0087)', () => {
  it('names every kind a run counts, each its own name', () => {
    const labels = RETENTION_PURGE_KINDS.map((kind) => retentionPurgeKindLabel(kind));
    for (const label of labels) expect(label.trim()).not.toBe('');
    expect(new Set(labels).size).toBe(RETENTION_PURGE_KINDS.length);
    expect(retentionPurgeKindLabel('consent_records')).toBe(copy.adminRetentionKindConsentRecords);
    expect(retentionPurgeKindLabel('phone_verification_records')).toBe('본인확인 기록');
    // The nickname holds' period is #57-6's fixed 30 days: the name says so.
    expect(retentionPurgeKindLabel('nickname_holds')).toContain('30일');
    // The requests go by the name the admin screens give them (the list, its menu).
    expect(retentionPurgeKindLabel('approval_requests')).toBe(copy.adminAccountRequests);
    // A withdrawn member's items still hidden, emptied (owner decision 2026-10-24 3).
    expect(retentionPurgeKindLabel('hidden_posts')).toBe('숨긴 글 원문');
    expect(retentionPurgeKindLabel('hidden_comments')).toBe('숨긴 댓글 원문');
  });

  it('says counts in 건 and the period in 일, with thousands grouped — 0 too', () => {
    expect(retentionCountText(0)).toBe('0건');
    expect(retentionCountText(1_012)).toBe('1,012건');
    expect(retentionPeriodText(30)).toBe(`${copy.adminRetentionPeriod} 30일`);
    expect(retentionPeriodText(1_825)).toBe('기간 1,825일');
    // The unit is the settings' own (RETENTION_PERIOD_SETTINGS), so the screens agree.
    for (const definition of Object.values(RETENTION_PERIOD_SETTINGS)) {
      expect(definition.unit).toBe(copy.adminRetentionDayUnit);
    }
  });

  it('gathers the records by run, newest first, one line per kind in the order a run takes them, batches summed', () => {
    // As `GET /admin/retention-purges` answers: newest run first, and within a run the record
    // written last first.
    const records = [
      record(7, LATER, 'consent_records', 0, 365),
      record(6, LATER, 'approval_requests', 1, 1_825),
      record(5, LATER, 'moderation_actions', 2, 1_825),
      record(4, LATER, 'approval_requests', 2, 1_825),
      record(3, LATER, 'post_revisions', 12, 90),
      record(2, LATER, 'post_revisions', 500, 90),
      record(1, LATER, 'nickname_holds', 3, 30),
      record(0, EARLIER, 'nickname_holds', 0, 30),
    ];
    expect(retentionRuns(records)).toEqual([
      {
        ranAt: LATER,
        kinds: [
          {
            kind: 'nickname_holds',
            label: copy.adminRetentionKindNicknameHolds,
            count: 3,
            periodDays: 30,
            failed: false,
          },
          {
            kind: 'post_revisions',
            label: copy.adminRetentionKindPostRevisions,
            count: 512,
            periodDays: 90,
            failed: false,
          },
          {
            kind: 'moderation_actions',
            label: copy.adminRetentionKindModerationActions,
            count: 2,
            periodDays: 1_825,
            failed: false,
          },
          // The requests the actions came in by and those decided without one: one line.
          {
            kind: 'approval_requests',
            label: copy.adminRetentionKindApprovalRequests,
            count: 3,
            periodDays: 1_825,
            failed: false,
          },
          {
            kind: 'consent_records',
            label: copy.adminRetentionKindConsentRecords,
            count: 0,
            periodDays: 365,
            failed: false,
          },
        ],
      },
      {
        ranAt: EARLIER,
        kinds: [
          {
            kind: 'nickname_holds',
            label: copy.adminRetentionKindNicknameHolds,
            count: 0,
            periodDays: 30,
            failed: false,
          },
        ],
      },
    ]);
    expect(retentionRuns([])).toEqual([]);
  });

  it('lists the runs of every page loaded, each page ending at a run’s end as the API answers', () => {
    // The API completes a page to its last run's end (retention-purges.service.ts): the later
    // run's records all on the first page, the batch written last (the smaller) first.
    const first = [
      record(3, LATER, 'deleted_posts', 7, 90),
      record(2, LATER, 'deleted_posts', 500, 90),
      record(1, LATER, 'deleted_posts', 500, 90),
    ];
    const second = [record(0, EARLIER, 'reports', 4, 1_825)];
    expect(retentionRuns(first)).toEqual([
      {
        ranAt: LATER,
        kinds: [
          {
            kind: 'deleted_posts',
            label: copy.adminRetentionKindDeletedPosts,
            count: 1_007,
            periodDays: 90,
            failed: false,
          },
        ],
      },
    ]);
    const runs = retentionRuns([...first, ...second]);
    expect(runs.map((run) => run.ranAt)).toEqual([LATER, EARLIER]);
    expect(runs.map((run) => run.kinds.map(({ kind, count }) => [kind, count]))).toEqual([
      [['deleted_posts', 1_007]],
      [['reports', 4]],
    ]);
  });

  it('marks a kind the run gave up on as failed, with what its earlier batches deleted (owner decision 2026-10-24 14)', () => {
    // As the worker writes them: two batches, then the failure (0); another kind failed at once.
    const runs = retentionRuns([
      record(4, LATER, 'consent_records', 0, 365),
      record(3, LATER, 'deleted_posts', 0, 90, 'failed'),
      record(2, LATER, 'deleted_posts', 500, 90),
      record(1, LATER, 'post_revisions', 0, 90, 'failed'),
      record(0, LATER, 'nickname_holds', 0, 30),
    ]);
    expect(runs[0]?.kinds.map(({ kind, count, failed }) => ({ kind, count, failed }))).toEqual([
      { kind: 'nickname_holds', count: 0, failed: false },
      { kind: 'post_revisions', count: 0, failed: true },
      { kind: 'deleted_posts', count: 500, failed: true },
      { kind: 'consent_records', count: 0, failed: false },
    ]);
    expect(copy.adminRetentionFailed).toBe('실패');
    // Its count says it is what went before the error, so the 실패 beside the name does not make
    // it read as a number of failures — '실패 500건', '실패 0건'.
    expect(retentionCountText(500, true)).toBe('오류 전까지 500건');
    expect(retentionCountText(0, true)).toBe('오류 전까지 0건');
    expect(retentionCountText(1_012, true)).toBe(
      `${copy.adminRetentionCountBeforeFailure} 1,012건`,
    );
    expect(retentionCountText(500, false)).toBe('500건');
  });

  it('keeps apart, within a run, batches of one kind under different periods', () => {
    const runs = retentionRuns([
      record(1, LATER, 'reports', 1, 400),
      record(0, LATER, 'reports', 2, 365),
    ]);
    expect(runs[0]?.kinds.map(({ count, periodDays }) => [count, periodDays])).toEqual([
      [2, 365],
      [1, 400],
    ]);
  });

  it('points the operator at the periods: the release settings screen, which lists them', () => {
    expect(ADMIN_RETENTION_PATH).toBe('/admin/retention');
    expect(ADMIN_RELEASE_SETTINGS_PATH).toBe('/admin/settings');
    // Only an approved period deletes, and the screen says so, with the nickname holds' rule.
    expect(copy.adminRetentionSettingsNotice).toContain('승인됨');
    expect(copy.adminRetentionSettingsNotice).toContain('미정·설계 제안·시험값');
    expect(copy.adminRetentionSettingsNotice).toContain('30일');
    // A kind that failed has its line, marked 실패 (owner decision 2026-10-24 14).
    expect(copy.adminRetentionSettingsNotice).toContain('오류');
    expect(copy.adminRetentionSettingsNotice).toContain('실패로 표시');
    // A failure the database would not even record shows no 실패 (ADR-0087 7-21): no line, or
    // only what went before.
    expect(copy.adminRetentionSettingsNotice).toContain('실패 기록마저 남기지 못한 오류는');
    expect(copy.adminRetentionSettingsNotice).toContain('줄이 없거나 실패 표시 없이');
    expect(copy.adminRetentionIntro).toContain('지운 내용은 남지 않습니다');
  });

  it('caches the records under the private admin root', () => {
    expect(isPrivateQueryKey(ADMIN_RETENTION_PURGES_KEY)).toBe(true);
  });
});
