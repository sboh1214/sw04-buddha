import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTION_TYPES,
  MODERATION_ACTION_TYPES,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
} from './enums.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import {
  APPEAL_WINDOW_DAYS,
  DISMISS_REPORTS_MAX,
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH,
  OTHER_NEEDS_TEXT_MESSAGE,
  REPORTS_PER_DAY,
  REPORT_DESCRIPTION_MAX_LENGTH,
  REPORT_WINDOW_HOURS,
  adminMediaPath,
  adminReportGroupSchema,
  adminReportQuerySchema,
  appealDeadlineOf,
  cancelModerationBodySchema,
  createReportBodySchema,
  dismissReportsBodySchema,
  moderationActionBodySchema,
  myModerationActionSchema,
  myReportSchema,
  reportTargetSchema,
  textTooLongMessage,
  warningBodySchema,
} from './moderation.js';

const ID = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
const OTHER = '1c7a7b4f-3d2e-4d9f-8a1b-2c3d4e5f6071';
const AT = '2026-10-20T01:02:03.000Z';
const ACCOUNT = 'account-1';

describe('the moderation lists (#50)', () => {
  it('takes reports on posts, comments and profiles — never a notice (#45-8, #37-10)', () => {
    expect(REPORT_TARGET_TYPES).toEqual(['post', 'comment', 'profile']);
  });

  it('answers a report pending, then actioned or dismissed (#45-13: 조치함·기각)', () => {
    expect(REPORT_STATUSES).toEqual(['pending', 'actioned', 'dismissed']);
  });

  it('acts by hiding, warning and the three profile items, chosen by weight (#45-11, #37-10)', () => {
    expect(MODERATION_ACTION_TYPES).toEqual([
      'hide',
      'warning',
      'nickname_reset',
      'bio_clear',
      'image_remove',
    ]);
  });

  it('records every operator mutation of #50 in the admin log', () => {
    expect(ADMIN_ACTION_TYPES).toEqual(
      expect.arrayContaining([
        'moderation_post_hide',
        'moderation_comment_hide',
        'moderation_warning',
        'moderation_nickname_reset',
        'moderation_bio_clear',
        'moderation_image_remove',
        'moderation_cancel',
        'report_dismiss',
      ]),
    );
    // admin_actions.type is varchar(40).
    for (const type of ADMIN_ACTION_TYPES) expect(type.length).toBeLessThanOrEqual(40);
  });

  it('holds the owner’s fixed values: 20 reports in the last 24 hours, appeals within 14 days', () => {
    expect(REPORTS_PER_DAY).toBe(20);
    expect(REPORT_WINDOW_HOURS).toBe(24);
    expect(APPEAL_WINDOW_DAYS).toBe(14);
    expect(appealDeadlineOf(AT).toISOString()).toBe('2026-11-03T01:02:03.000Z');
    expect(appealDeadlineOf(new Date(AT)).toISOString()).toBe('2026-11-03T01:02:03.000Z');
  });

  it('serves stored images to operators at their own address', () => {
    expect(adminMediaPath(ID)).toBe(`/api/v1/admin/media/${ID}`);
  });
});

describe('createReportBodySchema', () => {
  it('takes one reason, and a description that is optional but for 기타 (#45-10)', () => {
    for (const reason of REPORT_REASONS.filter((r) => r !== 'other')) {
      expect(createReportBodySchema.parse({ reason, expectedAccountId: ACCOUNT })).toEqual({
        reason,
        description: null,
        expectedAccountId: ACCOUNT,
      });
    }
    const other = createReportBodySchema.safeParse({ reason: 'other', expectedAccountId: ACCOUNT });
    expect(other.success).toBe(false);
    expect(other.error?.issues).toEqual([
      expect.objectContaining({ path: ['description'], message: OTHER_NEEDS_TEXT_MESSAGE }),
    ]);
    expect(
      createReportBodySchema.safeParse({
        reason: 'other',
        description: '   \n ',
        expectedAccountId: ACCOUNT,
      }).success,
    ).toBe(false);
    expect(
      createReportBodySchema.parse({
        reason: 'other',
        description: '  저작권 침해\r\n둘째 줄  ',
        expectedAccountId: ACCOUNT,
      }).description,
    ).toBe('저작권 침해\n둘째 줄');
  });

  it('refuses a reason outside the list, a wrong forecast among them (#45-10)', () => {
    expect(
      createReportBodySchema.safeParse({ reason: 'wrong_forecast', expectedAccountId: ACCOUNT })
        .success,
    ).toBe(false);
    expect(createReportBodySchema.safeParse({ reason: 'spam' }).success).toBe(false);
  });

  it('counts the description in code points, at most REPORT_DESCRIPTION_MAX_LENGTH', () => {
    const at = '😀'.repeat(REPORT_DESCRIPTION_MAX_LENGTH);
    expect(
      createReportBodySchema.parse({ reason: 'spam', description: at, expectedAccountId: ACCOUNT })
        .description,
    ).toBe(at);
    const over = createReportBodySchema.safeParse({
      reason: 'spam',
      description: `${at}a`,
      expectedAccountId: ACCOUNT,
    });
    expect(over.error?.issues.map((issue) => issue.message)).toEqual([
      textTooLongMessage(REPORT_DESCRIPTION_MAX_LENGTH, REPORT_DESCRIPTION_MAX_LENGTH + 1),
    ]);
  });
});

describe('the operators’ bodies', () => {
  it('takes a report reason and the member’s explanation, required with 기타', () => {
    expect(
      moderationActionBodySchema.parse({ reason: 'spam', expectedAccountId: ACCOUNT }),
    ).toEqual({ reason: 'spam', note: null, expectedAccountId: ACCOUNT });
    expect(
      moderationActionBodySchema.parse({
        reason: 'harassment',
        note: ' 욕설 ',
        expectedAccountId: ACCOUNT,
      }).note,
    ).toBe('욕설');
    expect(
      moderationActionBodySchema.safeParse({
        reason: 'other',
        note: '',
        expectedAccountId: ACCOUNT,
      }).error?.issues,
    ).toEqual([expect.objectContaining({ path: ['note'], message: OTHER_NEEDS_TEXT_MESSAGE })]);
    expect(
      moderationActionBodySchema.safeParse({
        reason: 'spam',
        note: 'x'.repeat(MODERATION_NOTE_MAX_LENGTH + 1),
        expectedAccountId: ACCOUNT,
      }).success,
    ).toBe(false);
  });

  it('gives a warning no subject unless one is named', () => {
    expect(warningBodySchema.parse({ reason: 'spam', expectedAccountId: ACCOUNT }).subject).toBe(
      null,
    );
    expect(
      warningBodySchema.parse({
        reason: 'spam',
        subject: { type: 'post', postId: ID },
        expectedAccountId: ACCOUNT,
      }).subject,
    ).toEqual({ type: 'post', postId: ID });
    expect(
      warningBodySchema.safeParse({
        reason: 'spam',
        subject: { type: 'notice', id: ID },
        expectedAccountId: ACCOUNT,
      }).success,
    ).toBe(false);
  });

  it('lower-cases a warning subject’s id, which the reports on it are matched by', () => {
    // reports.target_key prints the uuid lower-case: an upper-case subject would resolve none.
    for (const subject of [
      { type: 'post', postId: ID.toUpperCase() },
      { type: 'comment', commentId: ID.toUpperCase() },
    ]) {
      expect(
        Object.values(
          warningBodySchema.parse({ reason: 'spam', subject, expectedAccountId: ACCOUNT })
            .subject ?? {},
        ),
      ).toContain(ID);
    }
  });

  it('needs a reason to cancel or dismiss', () => {
    expect(
      cancelModerationBodySchema.safeParse({ reason: '  ', expectedAccountId: ACCOUNT }).success,
    ).toBe(false);
    expect(
      cancelModerationBodySchema.parse({ reason: ' 이의 인정 ', expectedAccountId: ACCOUNT })
        .reason,
    ).toBe('이의 인정');
    expect(
      dismissReportsBodySchema.safeParse({
        reportIds: [],
        reason: '위반 아님',
        expectedAccountId: ACCOUNT,
      }).success,
    ).toBe(false);
    expect(
      dismissReportsBodySchema.parse({
        reportIds: [ID],
        reason: '위반 아님',
        expectedAccountId: ACCOUNT,
      }),
    ).toEqual({ reportIds: [ID], reason: '위반 아님', expectedAccountId: ACCOUNT });
  });

  it('keeps the operators’ reason to MODERATION_REASON_MAX_LENGTH code points, as its column', () => {
    // varchar(500) for cancel_reason and dismissal_reason: one more is a 400, never the database's
    // refusal (a 500).
    const longest = '😀'.repeat(MODERATION_REASON_MAX_LENGTH);
    const tooLong = `${longest}x`;
    for (const parse of [
      (reason: string) =>
        cancelModerationBodySchema.safeParse({ reason, expectedAccountId: ACCOUNT }),
      (reason: string) =>
        dismissReportsBodySchema.safeParse({ reportIds: [ID], reason, expectedAccountId: ACCOUNT }),
    ]) {
      expect(parse(longest).data?.reason).toBe(longest);
      expect(parse(tooLong).error?.issues).toEqual([
        expect.objectContaining({
          path: ['reason'],
          message: textTooLongMessage(
            MODERATION_REASON_MAX_LENGTH,
            MODERATION_REASON_MAX_LENGTH + 1,
          ),
        }),
      ]);
    }
  });

  it('dismisses DISMISS_REPORTS_MAX reports at a time, each id lower-cased', () => {
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
    const body = (reportIds: string[]) => ({
      reportIds,
      reason: '위반 아님',
      expectedAccountId: ACCOUNT,
    });
    expect(dismissReportsBodySchema.safeParse(body(ids(DISMISS_REPORTS_MAX))).success).toBe(true);
    expect(
      dismissReportsBodySchema.safeParse(body(ids(DISMISS_REPORTS_MAX + 1))).error?.issues,
    ).toEqual([expect.objectContaining({ path: ['reportIds'] })]);
    // One report named in two cases is one id: the service takes each once.
    expect(dismissReportsBodySchema.parse(body([ID, ID.toUpperCase()])).reportIds).toEqual([
      ID,
      ID,
    ]);
  });

  it('opens the queue on the pending reports', () => {
    expect(adminReportQuerySchema.parse({}).status).toBe('pending');
    expect(adminReportQuerySchema.parse({ status: 'resolved' }).status).toBe('resolved');
    expect(adminReportQuerySchema.safeParse({ status: 'all' }).success).toBe(false);
  });
});

describe('what a member reads', () => {
  it('shows the reporter a placeholder by its id alone', () => {
    expect(
      reportTargetSchema.parse({ type: 'post', post: { state: 'hidden', id: ID, title: 'x' } }),
    ).toEqual({ type: 'post', post: { state: 'hidden', id: ID } });
    expect(
      reportTargetSchema.parse({
        type: 'comment',
        postId: OTHER,
        comment: { state: 'deleted', id: ID, excerpt: 'x' },
      }),
    ).toEqual({ type: 'comment', postId: OTHER, comment: { state: 'deleted', id: ID } });
  });

  it('carries no operator, report or reporter on an action, and no action on a report', () => {
    const action = myModerationActionSchema.parse({
      id: ID,
      type: 'hide',
      reason: { code: 'spam', note: null },
      subject: { type: 'post', id: OTHER, title: null, excerpt: '본문' },
      createdAt: AT,
      endsAt: null,
      cancelledAt: null,
      createdBy: 'admin-1',
      reportCount: 3,
    });
    expect(Object.keys(action).sort()).toEqual(
      ['cancelledAt', 'createdAt', 'endsAt', 'id', 'reason', 'subject', 'type'].sort(),
    );
    const report = myReportSchema.parse({
      id: ID,
      target: { type: 'profile', member: { kind: 'former_member' } },
      reason: 'impersonation',
      description: null,
      createdAt: AT,
      status: 'actioned',
      resolvedAt: AT,
      actionId: OTHER,
      resolvedBy: 'admin-1',
    });
    expect(Object.keys(report).sort()).toEqual(
      ['createdAt', 'description', 'id', 'reason', 'resolvedAt', 'status', 'target'].sort(),
    );
  });

  it('names no excluded feature: counts for operators, never a score (N04 §4)', () => {
    for (const name of [
      ...Object.keys(myModerationActionSchema.shape),
      ...Object.keys(myReportSchema.shape),
      ...Object.keys(adminReportGroupSchema.shape),
      'MyModerationAction',
      'MyReport',
      'ReportTarget',
      'AdminReportGroup',
      'AdminModerationAction',
      'ModerationTarget',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
    }
  });

  it('keeps reports and sanctions out of public field names', () => {
    expect(findPrivateField('reportCount').map((hit) => hit.item)).toContain('reports');
    expect(findPrivateField('reporter').map((hit) => hit.item)).toContain('reports');
    expect(findPrivateField('warnings').map((hit) => hit.item)).toContain('risk-flag');
    expect(findPrivateField('sanctions').map((hit) => hit.item)).toContain('risk-flag');
  });
});
