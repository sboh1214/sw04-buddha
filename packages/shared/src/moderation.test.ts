import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_RESTRICTION_REASONS,
  ADMIN_ACTION_TYPES,
  APPROVAL_STATUSES,
  MODERATION_ACTION_TYPES,
  MODERATION_REASONS,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  RESTRICTION_END_CHANGE_KINDS,
} from './enums.js';
import { ERROR_CODES } from './api/errors.js';
import { APPROVAL_REFUSALS } from './approvals.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import {
  ACCOUNT_RESTRICTION_APPROVAL_KINDS,
  ACCOUNT_RESTRICTION_CHANGES,
  ACCOUNT_RESTRICTION_DAYS,
  ACCOUNT_RESTRICTION_MOOTS,
  ACCOUNT_RESTRICTION_REQUEST_QUEUES,
  APPEAL_WINDOW_DAYS,
  DISMISS_REPORTS_MAX,
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH,
  MODERATION_REFUSALS,
  OTHER_NEEDS_TEXT_MESSAGE,
  REPORTS_PER_DAY,
  REPORT_DESCRIPTION_MAX_LENGTH,
  REPORT_WINDOW_HOURS,
  RESTRICTION_KINDS,
  WRITING_RESTRICTION_DAYS,
  accountRestrictionBodySchema,
  accountRestrictionChangeOf,
  accountRestrictionEndOf,
  accountRestrictionRequestQuerySchema,
  accountRestrictionRequestSchema,
  accountRestrictionTargetSchema,
  adminMediaPath,
  adminModerationActionSchema,
  adminReportGroupSchema,
  adminReportQuerySchema,
  appealDeadlineOf,
  appealWindowEndOf,
  approvalDecisionBodySchema,
  approvalRetractionBodySchema,
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

  it('acts by hiding, warning, the three profile items and the writing and the account restriction, chosen by weight (#45-11, #37-10, #185, #139)', () => {
    expect(MODERATION_ACTION_TYPES).toEqual([
      'hide',
      'warning',
      'nickname_reset',
      'bio_clear',
      'image_remove',
      'writing_restriction',
      'account_restriction',
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

  it('keeps an appeal in time to the end of the minute its deadline shows (owner decision 2026-10-23 답 5)', () => {
    // 01:02:03 shows as 1:02: in time to 01:02:59.999, late from 01:03.
    expect(appealWindowEndOf(AT).toISOString()).toBe('2026-11-03T01:03:00.000Z');
    expect(appealWindowEndOf(new Date(AT)).toISOString()).toBe('2026-11-03T01:03:00.000Z');
    // A deadline on the minute's first instant still has the whole of that minute.
    expect(appealWindowEndOf('2026-10-20T01:02:00.000Z').toISOString()).toBe(
      '2026-11-03T01:03:00.000Z',
    );
    // And one on its last millisecond, none of the next.
    expect(appealWindowEndOf('2026-10-20T01:02:59.999Z').toISOString()).toBe(
      '2026-11-03T01:03:00.000Z',
    );
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
    // #139 added the account restriction's kind.
    expect(RESTRICTION_KINDS).toEqual(['writing', 'account']);
    expect(restrictedDetailsSchema.parse({ kind: 'writing', endsAt: AT })).toEqual({
      kind: 'writing',
      endsAt: AT,
    });
    expect(restrictedDetailsSchema.parse({ kind: 'writing', endsAt: null }).endsAt).toBeNull();
    expect(restrictedDetailsSchema.safeParse({ kind: 'trading', endsAt: null }).success).toBe(
      false,
    );
  });

  it('answers the member the restrictions that govern as a refusal names them, or none', () => {
    const none = { restriction: null, accountRestriction: null };
    expect(
      myRestrictionSchema.parse({ ...none, restriction: { kind: 'writing', endsAt: AT } }),
    ).toEqual({ ...none, restriction: { kind: 'writing', endsAt: AT } });
    expect(
      myRestrictionSchema.parse({ ...none, restriction: { kind: 'writing', endsAt: null } }),
    ).toEqual({ ...none, restriction: { kind: 'writing', endsAt: null } });
    expect(myRestrictionSchema.parse(none)).toEqual(none);
    // #139: the account restriction beside it, each said apart; neither is left out.
    expect(
      myRestrictionSchema.parse({ ...none, accountRestriction: { kind: 'account', endsAt: AT } }),
    ).toEqual({ ...none, accountRestriction: { kind: 'account', endsAt: AT } });
    expect(myRestrictionSchema.safeParse({ restriction: null }).success).toBe(false);
    // Nothing but the kind and the end: never the operator, the reason nor a report (#45-13).
    expect(
      Object.keys(
        myRestrictionSchema.parse({
          ...none,
          restriction: { kind: 'writing', endsAt: AT, reason: 'spam', createdBy: ID },
        }).restriction ?? {},
      ),
    ).toEqual(['kind', 'endsAt']);
    expect(Object.keys(myRestrictionSchema.shape).sort()).toEqual([
      'accountRestriction',
      'restriction',
    ]);
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

describe('the account restriction (#139)', () => {
  it('takes the owner’s reasons for it, which the report reasons are not (#57-12)', () => {
    expect(ACCOUNT_RESTRICTION_REASONS).toEqual([
      'spam',
      'harassment',
      'personal_info',
      'impersonation',
      'collusion_manipulation',
      'abnormal_trading',
      'multi_account',
      'other',
    ]);
    // The enum keeps the report reasons first, then the two only an account restriction takes.
    expect(MODERATION_REASONS).toEqual([...REPORT_REASONS, 'abnormal_trading', 'multi_account']);
    for (const reason of ACCOUNT_RESTRICTION_REASONS) {
      expect(MODERATION_REASONS).toContain(reason);
    }
    expect(
      createReportBodySchema.safeParse({ reason: 'multi_account', expectedAccountId: ACCOUNT })
        .success,
    ).toBe(false);
  });

  it('takes a term or 무기한, ending a day per 24 hours from its approval', () => {
    expect(ACCOUNT_RESTRICTION_DAYS).toEqual([1, 3, 7, 30]);
    expect(accountRestrictionEndOf(AT, 7)?.toISOString()).toBe('2026-10-27T01:02:03.000Z');
    expect(accountRestrictionEndOf(new Date(AT), 30)?.toISOString()).toBe(
      '2026-11-19T01:02:03.000Z',
    );
    expect(accountRestrictionEndOf(AT, null)).toBeNull();
  });

  it('asks with a reason of its list and the explanation always, a term always said and an optional subject', () => {
    const body = {
      reason: 'abnormal_trading',
      note: ' 같은 시장의 반대 거래 ',
      days: null,
      expectedAccountId: ACCOUNT,
    };
    expect(accountRestrictionBodySchema.parse(body)).toEqual({
      ...body,
      note: '같은 시장의 반대 거래',
      subject: null,
      memo: null,
    });
    // The operators' memo (owner decision 2026-10-23): optional, trimmed, blank as none.
    expect(accountRestrictionBodySchema.parse({ ...body, memo: ' 운영자만 ' }).memo).toBe(
      '운영자만',
    );
    expect(accountRestrictionBodySchema.parse({ ...body, memo: '  ' }).memo).toBeNull();
    expect(accountRestrictionBodySchema.parse({ ...body, memo: null }).memo).toBeNull();
    for (const days of ACCOUNT_RESTRICTION_DAYS) {
      expect(accountRestrictionBodySchema.safeParse({ ...body, days }).success).toBe(true);
    }
    for (const bad of [
      { days: 2 },
      { days: undefined },
      { reason: 'off_topic' },
      { reason: 'rights_infringement' },
      { note: undefined },
      { note: '   ' },
      { note: 'x'.repeat(MODERATION_NOTE_MAX_LENGTH + 1) },
      // The note is the request's reason too: at most 500 UTF-16 units, as the request keeps it.
      { note: '😀'.repeat(300) },
      { memo: 'x'.repeat(MODERATION_REASON_MAX_LENGTH + 1) },
    ]) {
      expect(
        accountRestrictionBodySchema.safeParse({ ...body, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
    expect(
      accountRestrictionBodySchema.parse({
        ...body,
        subject: { type: 'post', postId: ID.toUpperCase() },
      }).subject,
    ).toEqual({ type: 'post', postId: ID });
    expect(
      approvalDecisionBodySchema.parse({ reason: ' 확인 ', expectedAccountId: ACCOUNT }),
    ).toEqual({
      reason: '확인',
      expectedAccountId: ACCOUNT,
    });
    expect(
      approvalDecisionBodySchema.safeParse({ reason: ' ', expectedAccountId: ACCOUNT }).success,
    ).toBe(false);
  });

  it('names each step’s two-person kind, and reads a kind back to its step', () => {
    expect(ACCOUNT_RESTRICTION_CHANGES).toEqual(['apply', 'shorten', 'lift', 'cancel']);
    expect(ACCOUNT_RESTRICTION_APPROVAL_KINDS).toEqual({
      apply: 'account_restriction',
      shorten: 'account_restriction_shorten',
      lift: 'account_restriction_lift',
      cancel: 'account_restriction_cancel',
    });
    for (const change of ACCOUNT_RESTRICTION_CHANGES) {
      const kind = ACCOUNT_RESTRICTION_APPROVAL_KINDS[change];
      expect(kind).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(kind.length).toBeLessThanOrEqual(40);
      expect(accountRestrictionChangeOf(kind)).toBe(change);
    }
    expect(accountRestrictionChangeOf('bot_pause')).toBeNull();
    expect(ACCOUNT_RESTRICTION_MOOTS).toEqual(['cancelled', 'ended', 'not_earlier', 'end_passed']);
    expect(ADMIN_ACTION_TYPES).toEqual(
      expect.arrayContaining([
        'account_restriction_request',
        'account_restriction_shorten_request',
        'account_restriction_lift_request',
        'account_restriction_cancel_request',
        'account_restriction_approve',
        'account_restriction_reject',
        'account_restriction_retract',
      ]),
    );
  });

  it('closes a request by a decision or by its retraction, lists each apart, and refuses a request no admin could decide (owner decision 2026-10-23)', () => {
    expect(APPROVAL_STATUSES).toEqual(['pending', 'approved', 'rejected', 'retracted']);
    expect(APPROVAL_REFUSALS).toEqual(['requester', 'decided', 'retracted', 'not_requester']);
    expect(ACCOUNT_RESTRICTION_REQUEST_QUEUES).toEqual(['pending', 'decided', 'retracted']);
    expect(accountRestrictionRequestQuerySchema.parse({}).status).toBe('pending');
    expect(accountRestrictionRequestQuerySchema.parse({ status: 'retracted' }).status).toBe(
      'retracted',
    );
    expect(MODERATION_REFUSALS).toContain('no_decider');
    // A retraction takes the screen's admin alone: no reason.
    expect(approvalRetractionBodySchema.parse({ expectedAccountId: ACCOUNT })).toEqual({
      expectedAccountId: ACCOUNT,
    });
    expect(approvalRetractionBodySchema.safeParse({}).success).toBe(false);
  });

  it('shows operators a request with who asked and decided, withheld for the admin it is about', () => {
    const request = accountRestrictionRequestSchema.parse({
      id: ID,
      change: 'apply',
      user: { id: 'member-1', publicId: 'abcdefghjk', nickname: '회원', role: 'user' },
      actionId: null,
      target: null,
      apply: {
        reason: { code: 'multi_account', note: '설명' },
        days: 7,
        subject: null,
        memo: null,
      },
      endsAt: null,
      requestReason: '설명',
      requestedBy: null,
      requestedAt: AT,
      status: 'pending',
      decidedBy: null,
      decisionReason: null,
      decidedAt: null,
      retractedAt: null,
      moot: null,
      aboutViewer: true,
    });
    expect(request.apply?.reason.code).toBe('multi_account');
    // Retracted: when, with no decision; the memo is always said (null for none, or withheld).
    expect(
      accountRestrictionRequestSchema.parse({ ...request, status: 'retracted', retractedAt: AT })
        .retractedAt,
    ).toBe(AT);
    expect(
      accountRestrictionRequestSchema.safeParse({ ...request, retractedAt: undefined }).success,
    ).toBe(false);
    expect(
      accountRestrictionRequestSchema.safeParse({
        ...request,
        apply: { ...request.apply, memo: undefined },
      }).success,
    ).toBe(false);
    // A change names the restriction it is about as it stands, for the approving admin.
    const lift = accountRestrictionRequestSchema.parse({
      ...request,
      change: 'lift',
      actionId: OTHER,
      target: {
        createdAt: AT,
        endsAt: null,
        reason: { code: 'abnormal_trading', note: '설명' },
        cancelledAt: null,
      },
      apply: null,
    });
    expect(lift.target?.endsAt).toBeNull();
    expect(
      accountRestrictionRequestSchema.safeParse({ ...request, target: undefined }).success,
    ).toBe(false);
    expect(Object.keys(adminModerationActionSchema.shape)).toEqual(
      expect.arrayContaining(['approval', 'cancelApproval']),
    );
    // The member's record names no approval, no asking nor approving admin.
    for (const name of Object.keys(myModerationActionSchema.shape)) {
      expect(name).not.toMatch(/approv|request|createdBy|decided/i);
    }
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
      ...Object.keys(accountRestrictionRequestSchema.shape),
      ...Object.keys(accountRestrictionTargetSchema.shape),
      'AccountRestrictionRequest',
      'AccountRestrictionTarget',
      'AccountRestrictionReason',
      ...ACCOUNT_RESTRICTION_REASONS,
      ...Object.values(ACCOUNT_RESTRICTION_APPROVAL_KINDS),
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
