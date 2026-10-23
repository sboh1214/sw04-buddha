import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTION_TYPES,
  MODERATION_ACTION_TYPES,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  RESTRICTION_END_CHANGE_KINDS,
} from './enums.js';
import { ERROR_CODES } from './api/errors.js';
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
  RESTRICTION_KINDS,
  WRITING_RESTRICTION_DAYS,
  adminMediaPath,
  adminModerationActionSchema,
  adminReportGroupSchema,
  adminReportQuerySchema,
  appealDeadlineOf,
  cancelModerationBodySchema,
  createReportBodySchema,
  dismissReportsBodySchema,
  liftRestrictionBodySchema,
  moderationActionBodySchema,
  myModerationActionSchema,
  myReportSchema,
  myRestrictionEndChangeSchema,
  myRestrictionSchema,
  nicknameHoldEndOf,
  reportTargetSchema,
  restrictedDetailsSchema,
  shortenRestrictionBodySchema,
  textTooLongMessage,
  warningBodySchema,
  writingRestrictionBodySchema,
  writingRestrictionEndOf,
} from './moderation.js';
import { NICKNAME_HOLD_DAYS } from './nickname.js';

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

  it('acts by hiding, warning, the three profile items and the writing restriction, chosen by weight (#45-11, #37-10, #185)', () => {
    expect(MODERATION_ACTION_TYPES).toEqual([
      'hide',
      'warning',
      'nickname_reset',
      'bio_clear',
      'image_remove',
      'writing_restriction',
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

  it('ends a reset’s hold of the nickname it took away 30 days after the reset (owner decision 2026-10-22)', () => {
    expect(NICKNAME_HOLD_DAYS).toBe(30);
    expect(nicknameHoldEndOf(AT).toISOString()).toBe('2026-11-19T01:02:03.000Z');
    expect(nicknameHoldEndOf(new Date(AT)).toISOString()).toBe('2026-11-19T01:02:03.000Z');
  });

  it('serves stored images to operators at their own address', () => {
    expect(adminMediaPath(ID)).toBe(`/api/v1/admin/media/${ID}`);
  });
});

describe('the writing restriction (#185)', () => {
  it('takes the owner’s terms: 1, 3, 7 or 30 days, or 무기한 (#45-12)', () => {
    expect(WRITING_RESTRICTION_DAYS).toEqual([1, 3, 7, 30]);
    expect(writingRestrictionEndOf(AT, 1)?.toISOString()).toBe('2026-10-21T01:02:03.000Z');
    expect(writingRestrictionEndOf(new Date(AT), 30)?.toISOString()).toBe(
      '2026-11-19T01:02:03.000Z',
    );
    expect(writingRestrictionEndOf(AT, null)).toBeNull();
  });

  it('records each change of an end as a shortening or a lift, and audits all three writes', () => {
    expect(RESTRICTION_END_CHANGE_KINDS).toEqual(['shorten', 'lift']);
    expect(ADMIN_ACTION_TYPES).toEqual(
      expect.arrayContaining([
        'moderation_writing_restriction',
        'moderation_restriction_shorten',
        'moderation_restriction_lift',
      ]),
    );
  });

  it('refuses with a code of its own carrying the kind and the end, null for 무기한', () => {
    expect(ERROR_CODES).toContain('RESTRICTED');
    expect(RESTRICTION_KINDS).toEqual(['writing']);
    expect(restrictedDetailsSchema.parse({ kind: 'writing', endsAt: AT })).toEqual({
      kind: 'writing',
      endsAt: AT,
    });
    expect(restrictedDetailsSchema.parse({ kind: 'writing', endsAt: null }).endsAt).toBeNull();
    expect(restrictedDetailsSchema.safeParse({ kind: 'account', endsAt: null }).success).toBe(
      false,
    );
  });

  it('answers the member the restriction that governs as a refusal names it, or none', () => {
    expect(myRestrictionSchema.parse({ restriction: { kind: 'writing', endsAt: AT } })).toEqual({
      restriction: { kind: 'writing', endsAt: AT },
    });
    expect(myRestrictionSchema.parse({ restriction: { kind: 'writing', endsAt: null } })).toEqual({
      restriction: { kind: 'writing', endsAt: null },
    });
    expect(myRestrictionSchema.parse({ restriction: null })).toEqual({ restriction: null });
    // Nothing but the kind and the end: never the operator, the reason nor a report (#45-13).
    expect(
      Object.keys(
        myRestrictionSchema.parse({
          restriction: { kind: 'writing', endsAt: AT, reason: 'spam', createdBy: ID },
        }).restriction ?? {},
      ),
    ).toEqual(['kind', 'endsAt']);
  });

  it('takes a term always said, a reason as every action’s and a warning’s subject', () => {
    for (const days of [...WRITING_RESTRICTION_DAYS, null]) {
      expect(
        writingRestrictionBodySchema.parse({ reason: 'spam', days, expectedAccountId: ACCOUNT }),
      ).toEqual({ reason: 'spam', note: null, days, subject: null, expectedAccountId: ACCOUNT });
    }
    for (const days of [0, 2, 14, 31, '7', undefined]) {
      expect(
        writingRestrictionBodySchema.safeParse({ reason: 'spam', days, expectedAccountId: ACCOUNT })
          .success,
        String(days),
      ).toBe(false);
    }
    expect(
      writingRestrictionBodySchema.safeParse({
        reason: 'other',
        days: 7,
        expectedAccountId: ACCOUNT,
      }).error?.issues,
    ).toEqual([expect.objectContaining({ path: ['note'], message: OTHER_NEEDS_TEXT_MESSAGE })]);
    expect(
      writingRestrictionBodySchema.parse({
        reason: 'spam',
        days: 3,
        subject: { type: 'comment', commentId: ID.toUpperCase() },
        expectedAccountId: ACCOUNT,
      }).subject,
    ).toEqual({ type: 'comment', commentId: ID });
  });

  it('brings an end forward to an instant, and lifts, each with a reason operators read', () => {
    expect(
      shortenRestrictionBodySchema.parse({
        endsAt: AT,
        reason: ' 이의 일부 인정 ',
        expectedAccountId: ACCOUNT,
      }),
    ).toEqual({ endsAt: AT, reason: '이의 일부 인정', expectedAccountId: ACCOUNT });
    for (const endsAt of ['tomorrow', '2026-10-20', null, undefined]) {
      expect(
        shortenRestrictionBodySchema.safeParse({
          endsAt,
          reason: '이의',
          expectedAccountId: ACCOUNT,
        }).success,
      ).toBe(false);
    }
    expect(
      liftRestrictionBodySchema.parse({ reason: '소명 확인', expectedAccountId: ACCOUNT }),
    ).toEqual({ reason: '소명 확인', expectedAccountId: ACCOUNT });
    for (const reason of ['', '   ', 'x'.repeat(MODERATION_REASON_MAX_LENGTH + 1)]) {
      expect(
        liftRestrictionBodySchema.safeParse({ reason, expectedAccountId: ACCOUNT }).success,
      ).toBe(false);
      expect(
        shortenRestrictionBodySchema.safeParse({ endsAt: AT, reason, expectedAccountId: ACCOUNT })
          .success,
      ).toBe(false);
    }
  });

  it('shows operators every change of an end, the member its kind and the end it was given only', () => {
    expect(Object.keys(adminModerationActionSchema.shape)).toContain('endChanges');
    expect(Object.keys(myModerationActionSchema.shape)).not.toContain('endChanges');
    // Owner decision 2026-10-23 answer 4: '조기 해제됨'·'감경됨', the changed end (`endsAt`) and the
    // original end — never the reason, the operator or when it changed.
    const given = {
      id: ID,
      type: 'writing_restriction',
      reason: { code: 'spam', note: null },
      subject: null,
      createdAt: AT,
      endsAt: AT,
      cancelledAt: null,
    };
    const lifted = myModerationActionSchema.parse({
      ...given,
      endChange: {
        kind: 'lift',
        originalEndsAt: '2026-10-30T00:00:00.000Z',
        previousEndsAt: '2026-10-29T00:00:00.000Z',
        reason: '소명 확인',
        createdBy: { id: 'admin-1', nickname: '운영자' },
        createdAt: AT,
      },
    });
    expect(lifted.endChange).toEqual({ kind: 'lift', originalEndsAt: '2026-10-30T00:00:00.000Z' });
    expect(
      myModerationActionSchema.parse({
        ...given,
        endChange: { kind: 'shorten', originalEndsAt: null },
      }).endChange,
    ).toEqual({ kind: 'shorten', originalEndsAt: null });
    expect(myModerationActionSchema.parse({ ...given, endChange: null }).endChange).toBeNull();
    expect(
      myModerationActionSchema.safeParse({
        ...given,
        endChange: { kind: 'cancel', originalEndsAt: null },
      }).success,
    ).toBe(false);
    expect(myModerationActionSchema.safeParse(given).success).toBe(false);
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
      endChange: null,
      cancelledAt: null,
      createdBy: 'admin-1',
      reportCount: 3,
    });
    expect(Object.keys(action).sort()).toEqual(
      ['cancelledAt', 'createdAt', 'endChange', 'endsAt', 'id', 'reason', 'subject', 'type'].sort(),
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
      ...Object.keys(myRestrictionEndChangeSchema.shape),
      ...Object.keys(myReportSchema.shape),
      ...Object.keys(adminReportGroupSchema.shape),
      'MyModerationAction',
      'MyRestrictionEndChange',
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
