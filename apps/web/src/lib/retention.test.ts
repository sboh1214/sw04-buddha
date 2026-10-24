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
    // #187's repeated-link review list, under the 신고·제재 period (owner decision 2026-10-24 13).
    expect(retentionPurgeKindLabel('link_flags')).toBe('반복 링크 검토 목록');
    // A withdrawn account's market proposals, their own period (#77, owner decision 2026-10-24 13).
    expect(retentionPurgeKindLabel('market_proposals')).toBe('시장 제안 기록');
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
            key: 'nickname_holds:30',
            kind: 'nickname_holds',
            label: copy.adminRetentionKindNicknameHolds,
            count: 3,
            periodDays: 30,
            failed: false,
          },
          {
            key: 'post_revisions:90',
            kind: 'post_revisions',
            label: copy.adminRetentionKindPostRevisions,
            count: 512,
            periodDays: 90,
            failed: false,
          },
          {
            key: 'moderation_actions:1825',
            kind: 'moderation_actions',
            label: copy.adminRetentionKindModerationActions,
            count: 2,
            periodDays: 1_825,
            failed: false,
          },
          // The requests the actions came in by and those decided without one: one line.
          {
            key: 'approval_requests:1825',
            kind: 'approval_requests',
            label: copy.adminRetentionKindApprovalRequests,
            count: 3,
            periodDays: 1_825,
            failed: false,
          },
          {
            key: 'consent_records:365',
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
            key: 'nickname_holds:30',
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
            key: 'deleted_posts:90',
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

  it('keeps apart, within a run, one kind’s records under different periods: the edit history a hidden item’s content took with it, beside the versions’ own — and sums them under one period (owner decision 2026-10-24 (2차) 2)', () => {
    // As the worker writes them: the versions' own step under the 지운 글 원문·수정 이력 period, then
    // the hidden posts' batch — the emptied posts, their edit history and their hidings — under the
    // 신고·제재 period.
    const runs = retentionRuns([
      record(5, LATER, 'moderation_actions', 2, 1_825),
      record(4, LATER, 'post_revisions', 3, 1_825),
      record(3, LATER, 'hidden_posts', 2, 1_825),
      record(2, LATER, 'deleted_posts', 0, 90),
      record(1, LATER, 'post_revisions', 12, 90),
    ]);
    expect(
      runs[0]?.kinds.map(({ kind, label, count, periodDays }) => [kind, label, count, periodDays]),
    ).toEqual([
      ['post_revisions', copy.adminRetentionKindPostRevisions, 12, 90],
      ['post_revisions', copy.adminRetentionKindPostRevisions, 3, 1_825],
      ['deleted_posts', copy.adminRetentionKindDeletedPosts, 0, 90],
      ['hidden_posts', copy.adminRetentionKindHiddenPosts, 2, 1_825],
      ['moderation_actions', copy.adminRetentionKindModerationActions, 2, 1_825],
    ]);
    // The two periods approved at one value: one '글 수정 이력' line, what the run deleted of it.
    const [equal] = retentionRuns([
      record(9, EARLIER, 'moderation_actions', 2, 365),
      record(8, EARLIER, 'post_revisions', 3, 365),
      record(7, EARLIER, 'hidden_posts', 2, 365),
      record(6, EARLIER, 'post_revisions', 12, 365),
    ]);
    expect(equal?.kinds.map(({ kind, count, periodDays }) => [kind, count, periodDays])).toEqual([
      ['post_revisions', 15, 365],
      ['hidden_posts', 2, 365],
      ['moderation_actions', 2, 365],
    ]);
  });

  it('keeps on a line of its own what a later step deleted of a kind after the kind failed under the same period: it did not go before the error (owner decisions 2026-10-24 14 and (2차) 2)', () => {
    // Both periods approved at one value. The versions' own step deletes a batch and then fails;
    // the hidden posts' step later empties 2 posts with their 5 versions and their 2 hidings; then
    // the actions' own step fails too. Ids as the run wrote them, past a digit's width so that
    // they compare as numbers.
    const [run] = retentionRuns([
      record(13, LATER, 'moderation_actions', 0, 365, 'failed'),
      record(12, LATER, 'moderation_actions', 2, 365),
      record(11, LATER, 'post_revisions', 5, 365),
      record(10, LATER, 'hidden_posts', 2, 365),
      record(9, LATER, 'post_revisions', 0, 365, 'failed'),
      record(8, LATER, 'post_revisions', 500, 365),
    ]);
    const lines = run?.kinds ?? [];
    expect(
      lines.map(({ kind, count, periodDays, failed }) => [kind, count, periodDays, failed]),
    ).toEqual([
      // The versions' own step: what it deleted before its error.
      ['post_revisions', 500, 365, true],
      // The hidden posts' step, after it: a line of its own, right after, not failed.
      ['post_revisions', 5, 365, false],
      ['hidden_posts', 2, 365, false],
      // The hidings went before the actions' own step failed: before its error, on its line.
      ['moderation_actions', 2, 365, true],
    ]);
    expect(lines.map((line) => retentionCountText(line.count, line.failed))).toEqual([
      '오류 전까지 500건',
      '5건',
      '2건',
      '오류 전까지 2건',
    ]);
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
    // Failed at its first batch: '오류 전까지 0건', never the 3 the hidden posts' step deleted.
    const [first] = retentionRuns([
      record(4, EARLIER, 'moderation_actions', 2, 1_825),
      record(3, EARLIER, 'post_revisions', 3, 1_825),
      record(2, EARLIER, 'hidden_posts', 2, 1_825),
      record(1, EARLIER, 'post_revisions', 0, 1_825, 'failed'),
    ]);
    expect(
      first?.kinds.map((line) => [line.kind, retentionCountText(line.count, line.failed)]),
    ).toEqual([
      ['post_revisions', '오류 전까지 0건'],
      ['post_revisions', '3건'],
      ['hidden_posts', '2건'],
      ['moderation_actions', '2건'],
    ]);
  });

  it('points the operator at the periods: the release settings screen, which lists them', () => {
    expect(ADMIN_RETENTION_PATH).toBe('/admin/retention');
    expect(ADMIN_RELEASE_SETTINGS_PATH).toBe('/admin/settings');
    // Only an approved period deletes, and the screen says so, with the nickname holds' rule.
    expect(copy.adminRetentionSettingsNotice).toContain('승인됨');
    expect(copy.adminRetentionSettingsNotice).toContain('미정·설계 제안·시험값');
    expect(copy.adminRetentionSettingsNotice).toContain(
      '숨긴 채로 남은 글·댓글과 함께 지운 수정 이력은 신고·제재 기록의 기간으로 보입니다.',
    );
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
