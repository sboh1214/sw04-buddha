import {
  APPEAL_WINDOW_DAYS,
  DISMISS_REPORTS_MAX,
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH,
  NICKNAME_HOLD_DAYS,
  OTHER_NEEDS_TEXT_MESSAGE,
  REPORTS_PER_DAY,
  REPORT_DESCRIPTION_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_WINDOW_HOURS,
  type ErrorCode,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ApiError,
  type AdminModerationAction,
  type AdminReport,
  type MyModerationAction,
  type ReportTarget,
} from './api';
import { reportReasonLabel } from './authored';
import { isPrivateQueryKey } from './market-keys';
import {
  ADMIN_ACTIONS_KEY,
  ADMIN_MODERATION_KEY,
  ADMIN_REPORTS_PATH,
  MY_ACTIONS_KEY,
  MY_MODERATION_KEY,
  MY_MODERATION_PATH,
  MY_REPORTS_KEY,
  REPORT_REASON_OPTIONS,
  actionReasonDraft,
  actionReasonText,
  actionSubjectView,
  adminCommentModerationKey,
  adminCommentModerationPath,
  adminPostModerationKey,
  adminPostModerationPath,
  adminProfileModerationKey,
  adminProfileModerationPath,
  adminReportQueueKey,
  adminReportQueueOf,
  adminReportQueuePath,
  adminTargetPath,
  adminUserModerationKey,
  adminUserModerationPath,
  appealDeadline,
  authorPublicIdOf,
  concernsOperator,
  countText,
  dismissBatch,
  dismissBatchText,
  isCancellable,
  isOperator,
  moderationActionLabel,
  moderationFailure,
  moderationItemStateLabel,
  moderationRows,
  operatorLineText,
  pendingReportIds,
  queueEntryText,
  reasonCountsText,
  recordReasonDraft,
  removedItemLabel,
  reportButtonName,
  reportDialogTitle,
  reportDraft,
  reportFailure,
  reportLengthText,
  reportReasonOf,
  reportStatusLabel,
  reportTargetTypeLabel,
  reportTargetView,
  sanctionInForce,
  warningInWindow,
} from './moderation';
import { formatKst } from './datetime';
import { formatWait } from './phone-verification';

/**
 * 신고와 운영 처리 on the web (#50, ADR-0081): the report dialog's rules and refusals, the member's
 * 조치·신고 내역, the sanction banner's rule and the operators' dialogs — pure functions, so they
 * run here under node.
 */

const POST = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';
const COMMENT = '9b2e3c1d-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
const USER = 'Qz8kL2mN4pR6sT8vX0yA2bC4dE6fG8hJ';

function refused(status: number, code: ErrorCode, details?: unknown): ApiError {
  return new ApiError(status, { code, message: code, details });
}

const validation = (field: string, message: string) =>
  refused(400, 'VALIDATION_ERROR', [{ path: [field], message }]);

const otherAccount = refused(403, 'FORBIDDEN', [
  { path: ['expectedAccountId'], message: 'not the signed-in account' },
]);

describe('addresses', () => {
  it('puts 조치·신고 내역 under MY, not among its tabs', () => {
    expect(MY_MODERATION_PATH).toBe('/my/moderation');
  });

  it('reads the queue’s half from ?status=, pending for anything but resolved', () => {
    expect(adminReportQueueOf('resolved')).toBe('resolved');
    expect(adminReportQueueOf('pending')).toBe('pending');
    expect(adminReportQueueOf(undefined)).toBe('pending');
    expect(adminReportQueueOf(['resolved', 'pending'])).toBe('pending');
    expect(adminReportQueuePath('pending')).toBe(ADMIN_REPORTS_PATH);
    expect(adminReportQueuePath('resolved')).toBe('/admin/reports?status=resolved');
  });

  it('leads each target to its moderation page, the uuids lower-cased', () => {
    expect(adminPostModerationPath(POST.toUpperCase())).toBe(`/admin/moderation/posts/${POST}`);
    expect(adminCommentModerationPath(COMMENT)).toBe(`/admin/moderation/comments/${COMMENT}`);
    // An account id is text with capitals of its own: kept as it is.
    expect(adminUserModerationPath(USER)).toBe(`/admin/moderation/users/${USER}`);
    expect(adminTargetPath({ type: 'post', postId: POST })).toBe(adminPostModerationPath(POST));
    expect(adminTargetPath({ type: 'comment', commentId: COMMENT, postId: POST })).toBe(
      adminCommentModerationPath(COMMENT),
    );
    expect(adminTargetPath({ type: 'profile', userId: USER })).toBe(adminUserModerationPath(USER));
  });

  it('leads a public profile’s 운영 to its member’s page by the public id, lower-cased (owner decision 2026-10-21)', () => {
    expect(adminProfileModerationPath('K7M2P9QX4Z')).toBe('/admin/moderation/profiles/k7m2p9qx4z');
  });

  it('shows 운영 to an operator alone, by the role GET /me answers', () => {
    expect(isOperator('admin')).toBe(true);
    expect(isOperator('user')).toBe(false);
    expect(isOperator(undefined)).toBe(false);
  });
});

describe('cache keys', () => {
  it('keeps the member’s reports and actions private and the operators’ under admin', () => {
    for (const key of [MY_MODERATION_KEY, MY_REPORTS_KEY, MY_ACTIONS_KEY]) {
      expect(isPrivateQueryKey(key)).toBe(true);
    }
    for (const key of [
      ADMIN_MODERATION_KEY,
      ADMIN_ACTIONS_KEY,
      adminReportQueueKey('pending'),
      adminPostModerationKey(POST),
      adminCommentModerationKey(COMMENT),
      adminUserModerationKey(USER),
      adminProfileModerationKey('k7m2p9qx4z'),
    ]) {
      expect(isPrivateQueryKey(key)).toBe(true);
      expect(key.slice(0, 2)).toEqual([...ADMIN_MODERATION_KEY]);
    }
    expect(adminPostModerationKey(POST.toUpperCase())).toEqual(adminPostModerationKey(POST));
    expect(adminProfileModerationKey('K7M2P9QX4Z')).toEqual(
      adminProfileModerationKey('k7m2p9qx4z'),
    );
    expect(adminReportQueueKey('pending')).not.toEqual(adminReportQueueKey('resolved'));
  });
});

describe('names', () => {
  it('lists the eight reasons in the owner’s order with their names (#45-10)', () => {
    expect(REPORT_REASON_OPTIONS.map((option) => option.code)).toEqual([...REPORT_REASONS]);
    expect(REPORT_REASON_OPTIONS.map((option) => option.label)).toEqual([
      '스팸',
      '괴롭힘',
      '개인정보 노출',
      '사칭',
      '공모·조작 유도',
      '시장과 무관',
      '권리 침해',
      '기타',
    ]);
    expect(reportReasonOf('spam')).toBe('spam');
    expect(reportReasonOf('')).toBeNull();
    expect(reportReasonOf('wrong_forecast')).toBeNull();
  });

  it('names the results 접수 · 조치함 · 기각 (#45-13)', () => {
    expect(reportStatusLabel('pending')).toBe('접수');
    expect(reportStatusLabel('actioned')).toBe('조치함');
    expect(reportStatusLabel('dismissed')).toBe('기각');
  });

  it('names each action, target and state', () => {
    expect(moderationActionLabel('hide')).toBe(copy.moderationActionHide);
    expect(moderationActionLabel('warning')).toBe(copy.moderationActionWarning);
    expect(moderationActionLabel('nickname_reset')).toBe(copy.moderationActionNicknameReset);
    expect(moderationActionLabel('bio_clear')).toBe(copy.moderationActionBioClear);
    expect(moderationActionLabel('image_remove')).toBe(copy.moderationActionImageRemove);
    expect(reportTargetTypeLabel('post')).toBe('글');
    expect(reportTargetTypeLabel('comment')).toBe('댓글');
    expect(reportTargetTypeLabel('profile')).toBe('프로필');
    expect(moderationItemStateLabel('gone')).toBe(copy.adminModerationStateGone);
    expect(reportDialogTitle('post')).toBe(copy.reportPostTitle);
    expect(reportDialogTitle('comment')).toBe(copy.reportCommentTitle);
    expect(reportDialogTitle('profile')).toBe(copy.reportProfileTitle);
  });

  it('names a card’s 신고 by the item it reports, ending with the word on screen', () => {
    // A post by its card's heading: the title, or the first line of its text without one.
    expect(reportButtonName({ type: 'post', title: '금리 전망', excerpt: '본문' })).toBe(
      `금리 전망 ${copy.reportAction}`,
    );
    expect(reportButtonName({ type: 'post', title: null, excerpt: '\n  첫 줄 \n둘째 줄' })).toBe(
      `첫 줄 ${copy.reportAction}`,
    );
    // A comment by the first line of its own text, so two under one post differ.
    expect(reportButtonName({ type: 'comment', body: '첫 댓글\n더' })).toBe(
      `첫 댓글 ${copy.reportAction}`,
    );
    expect(reportButtonName({ type: 'comment', body: '둘째 댓글' })).not.toBe(
      reportButtonName({ type: 'comment', body: '첫 댓글' }),
    );
    for (const name of [
      reportButtonName({ type: 'post', title: '제목', excerpt: '본문' }),
      reportButtonName({ type: 'comment', body: '댓글' }),
    ]) {
      expect(name.endsWith(copy.reportAction)).toBe(true);
    }
  });

  it('writes a reason and the operator’s explanation, a blank one as none', () => {
    expect(actionReasonText({ code: 'harassment', note: '  상대를 깎아내림 ' })).toEqual({
      reason: '괴롭힘',
      note: '상대를 깎아내림',
    });
    expect(actionReasonText({ code: 'spam', note: '   ' })).toEqual({ reason: '스팸', note: null });
    expect(actionReasonText({ code: 'spam', note: null })).toEqual({ reason: '스팸', note: null });
  });
});

describe('the copy’s numbers are the rules’', () => {
  it('says the limits the server keeps', () => {
    expect(copy.errReportLimited).toContain(`${String(REPORT_WINDOW_HOURS)}시간`);
    expect(copy.errReportLimited).toContain(`${String(REPORTS_PER_DAY)}건`);
    expect(copy.reportDescriptionHint).toContain(`${String(REPORT_DESCRIPTION_MAX_LENGTH)}자`);
    expect(copy.errReportDescriptionTooLong).toContain(
      `${String(REPORT_DESCRIPTION_MAX_LENGTH)}자`,
    );
    expect(copy.myModerationAppeal).toContain(`${String(APPEAL_WINDOW_DAYS)}일`);
    expect(copy.myModerationAppeal).toContain('{{email}}');
    expect(copy.adminModerationNoteHint).toContain(`${String(MODERATION_NOTE_MAX_LENGTH)}자`);
    expect(copy.errModerationNoteTooLong).toContain(`${String(MODERATION_NOTE_MAX_LENGTH)}자`);
    expect(copy.errModerationRecordRequired).toContain(`${String(MODERATION_REASON_MAX_LENGTH)}자`);
    expect(copy.errModerationReportIds).toContain(`${String(DISMISS_REPORTS_MAX)}건`);
    expect(copy.adminModerationDismissPartial).toContain(`${String(DISMISS_REPORTS_MAX)}건`);
  });

  it('tells the reporter that a wrong forecast is not a reason (#45-10)', () => {
    expect(copy.reportNotAReason).toContain('전망');
    expect(copy.reportNotAReason).toContain('신고 사유가 아닙니다');
  });
});

describe('the report dialog', () => {
  it('needs a reason, and a description with 기타', () => {
    expect(reportDraft({ reason: null, description: '' })).toMatchObject({
      reasonError: copy.errReportReasonRequired,
      descriptionError: null,
    });
    expect(reportDraft({ reason: 'other', description: ' \n ' })).toMatchObject({
      reason: 'other',
      description: null,
      descriptionError: copy.errReportDescriptionRequired,
    });
    expect(reportDraft({ reason: 'other', description: '  사유 설명 ' })).toMatchObject({
      description: '사유 설명',
      reasonError: null,
      descriptionError: null,
    });
    expect(reportDraft({ reason: 'spam', description: '' })).toMatchObject({
      description: null,
      reasonError: null,
      descriptionError: null,
    });
  });

  it('counts the description in code points as the server does, up to the limit', () => {
    const atLimit = '가'.repeat(REPORT_DESCRIPTION_MAX_LENGTH);
    expect(reportDraft({ reason: 'spam', description: atLimit })).toMatchObject({
      length: REPORT_DESCRIPTION_MAX_LENGTH,
      descriptionError: null,
    });
    const emoji = '😀'.repeat(REPORT_DESCRIPTION_MAX_LENGTH);
    expect(reportDraft({ reason: 'spam', description: emoji }).descriptionError).toBeNull();
    expect(reportDraft({ reason: 'other', description: `${atLimit}!` })).toMatchObject({
      length: REPORT_DESCRIPTION_MAX_LENGTH + 1,
      descriptionError: copy.errReportDescriptionTooLong,
    });
    expect(reportLengthText(12)).toBe('12 / 500자');
    expect(reportLengthText(1234)).toBe('1,234 / 500자');
  });

  it('says a refusal of the rules in the dialog, and which ones left the page stale', () => {
    const notAllowed = (reason: string) => refused(409, 'REPORT_NOT_ALLOWED', { reason });
    expect(reportFailure(notAllowed('own'), 'post')).toEqual({
      kind: 'alert',
      message: copy.errReportOwn,
      stale: false,
    });
    expect(reportFailure(notAllowed('duplicate'), 'comment')).toEqual({
      kind: 'alert',
      message: copy.errReportDuplicate,
      stale: false,
    });
    expect(reportFailure(notAllowed('deleted'), 'comment')).toEqual({
      kind: 'alert',
      message: copy.errReportDeleted,
      stale: true,
    });
    expect(reportFailure(notAllowed('hidden'), 'post')).toEqual({
      kind: 'alert',
      message: copy.errReportHidden,
      stale: true,
    });
    expect(reportFailure(notAllowed('something_new'), 'post')).toMatchObject({
      message: copy.errUnknown,
    });
  });

  it('says the daily limit with the wait, rounded up, and the address bucket apart', () => {
    const limited = refused(429, 'REPORT_LIMITED', { limit: 20, retryAfterSeconds: 3_660 });
    expect(reportFailure(limited, 'profile')).toEqual({
      kind: 'alert',
      message: `${copy.errReportLimited} ${formatWait(3_660)} ${copy.verificationRetryAfter}`,
      stale: false,
    });
    expect(formatWait(3_660)).toBe('1시간 1분');
    expect(reportFailure(refused(429, 'REPORT_LIMITED'), 'post')).toMatchObject({
      message: copy.errReportLimited,
    });
    expect(reportFailure(refused(429, 'RATE_LIMITED'), 'post')).toMatchObject({
      message: copy.errTooManyRequests,
    });
  });

  it('says a target gone by what it was, and asks the page to read it again', () => {
    expect(reportFailure(refused(404, 'NOT_FOUND'), 'post')).toEqual({
      kind: 'alert',
      message: copy.errPostGone,
      stale: true,
    });
    expect(reportFailure(refused(404, 'NOT_FOUND'), 'comment')).toMatchObject({
      message: copy.errCommentGone,
    });
    expect(reportFailure(refused(404, 'NOT_FOUND'), 'profile')).toMatchObject({
      message: copy.profileNotFound,
    });
  });

  it('puts the description’s refusals under it', () => {
    expect(reportFailure(validation('description', OTHER_NEEDS_TEXT_MESSAGE), 'post')).toEqual({
      kind: 'field',
      message: copy.errReportDescriptionRequired,
    });
    expect(
      reportFailure(validation('description', 'at most 500 characters, not 501'), 'post'),
    ).toEqual({ kind: 'field', message: copy.errReportDescriptionTooLong });
    expect(reportFailure(validation('reason', 'Invalid option'), 'post')).toMatchObject({
      kind: 'alert',
      message: copy.errReportReasonRequired,
    });
  });

  it('says the rest as every write does', () => {
    expect(reportFailure(otherAccount, 'post')).toMatchObject({ message: copy.sessionChanged });
    expect(reportFailure(refused(409, 'ONBOARDING_REQUIRED'), 'post')).toMatchObject({
      message: copy.errPostOnboarding,
    });
    expect(reportFailure(new TypeError('Failed to fetch'), 'post')).toMatchObject({
      message: copy.errNetwork,
    });
    expect(reportFailure(refused(500, 'INTERNAL'), 'post')).toMatchObject({
      message: copy.errUnknown,
    });
  });

  it('tells the reader’s own item by the author’s public id, never a withdrawn member’s', () => {
    expect(
      authorPublicIdOf({
        kind: 'member',
        publicId: 'k7m2p9qx4z',
        nickname: '근거왕',
        imageUrl: null,
        isAdmin: false,
      }),
    ).toBe('k7m2p9qx4z');
    expect(authorPublicIdOf({ kind: 'former_member' })).toBeNull();
  });
});

describe('the member’s 조치·신고 내역', () => {
  it('names what a report was about as the public sees it now, a placeholder by its words', () => {
    const post = (state: 'published' | 'deleted' | 'hidden', title: string | null = null) =>
      ({
        type: 'post',
        post:
          state === 'published'
            ? { state, id: POST, title, excerpt: '\n첫 줄\n둘째 줄' }
            : { state, id: POST },
      }) as ReportTarget;
    expect(reportTargetView(post('published', '제목'))).toEqual({
      text: '제목',
      href: `/community/posts/${POST}`,
    });
    expect(reportTargetView(post('published'))).toMatchObject({ text: '첫 줄' });
    // A deleted one may be gone from every view (a 404) — the answer cannot tell: no link.
    expect(reportTargetView(post('deleted'))).toEqual({
      text: copy.postDeletedPlaceholder,
      href: null,
    });
    expect(reportTargetView(post('hidden'))).toEqual({
      text: copy.postHiddenPlaceholder,
      href: `/community/posts/${POST}`,
    });

    const comment = (state: 'published' | 'deleted' | 'hidden'): ReportTarget => ({
      type: 'comment',
      postId: POST,
      comment:
        state === 'published'
          ? { state, id: COMMENT, excerpt: '댓글 첫 줄\n다음' }
          : { state, id: COMMENT },
    });
    expect(reportTargetView(comment('published'))).toEqual({
      text: '댓글 첫 줄',
      href: `/community/posts/${POST}`,
    });
    expect(reportTargetView(comment('deleted'))).toEqual({
      text: copy.commentDeletedPlaceholder,
      href: null,
    });
    expect(reportTargetView(comment('hidden'))).toEqual({
      text: copy.commentHiddenPlaceholder,
      href: `/community/posts/${POST}`,
    });

    expect(
      reportTargetView({
        type: 'profile',
        member: {
          kind: 'member',
          publicId: 'k7m2p9qx4z',
          nickname: '근거왕',
          imageUrl: null,
          isAdmin: false,
        },
      }),
    ).toEqual({ text: '근거왕', href: '/u/k7m2p9qx4z' });
    expect(reportTargetView({ type: 'profile', member: { kind: 'former_member' } })).toEqual({
      text: copy.postAuthorFormer,
      href: null,
    });
  });

  it('names what an action was about, and nothing of an item the member deleted since', () => {
    expect(actionSubjectView(null)).toBeNull();
    expect(actionSubjectView({ type: 'post', id: POST, title: '제목', excerpt: '본문' })).toEqual({
      text: '제목',
      href: `/community/posts/${POST}`,
    });
    expect(actionSubjectView({ type: 'post', id: POST, title: null, excerpt: '본문' })).toEqual({
      text: '본문',
      href: `/community/posts/${POST}`,
    });
    expect(actionSubjectView({ type: 'post', id: POST, title: null, excerpt: null })).toEqual({
      text: copy.moderationSubjectDeletedPost,
      href: null,
    });
    expect(
      actionSubjectView({ type: 'comment', id: COMMENT, postId: POST, excerpt: '내 댓글' }),
    ).toEqual({ text: '내 댓글', href: `/community/posts/${POST}` });
    expect(
      actionSubjectView({ type: 'comment', id: COMMENT, postId: POST, excerpt: null }),
    ).toEqual({ text: copy.moderationSubjectDeletedComment, href: null });
    expect(actionSubjectView({ type: 'profile' })).toEqual({
      text: copy.moderationSubjectProfile,
      href: null,
    });
  });

  it('gives a standing action its appeal deadline, 14 days on, and a cancelled one none', () => {
    expect(appealDeadline({ createdAt: '2026-10-21T03:00:00.000Z', cancelledAt: null })).toBe(
      '2026-11-04T03:00:00.000Z',
    );
    expect(
      appealDeadline({
        createdAt: '2026-10-21T03:00:00.000Z',
        cancelledAt: '2026-10-22T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('flattens the pages held', () => {
    expect(moderationRows(undefined)).toEqual([]);
    expect(moderationRows([{ items: [1, 2] }, { items: [3] }])).toEqual([1, 2, 3]);
  });
});

describe('the sanction banner', () => {
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');
  const action = (overrides: Partial<MyModerationAction>): MyModerationAction => ({
    id: '11111111-1111-4111-8111-111111111111',
    type: 'warning',
    reason: { code: 'spam', note: null },
    subject: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    endsAt: null,
    cancelledAt: null,
    ...overrides,
  });

  it('shows nothing for #50’s actions, none of which is a sanction', () => {
    expect(
      sanctionInForce(
        [
          action({ type: 'warning' }),
          action({ type: 'hide' }),
          action({ type: 'nickname_reset' }),
          action({ type: 'bio_clear' }),
          action({ type: 'image_remove' }),
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it('shows the latest-ending action whose end is ahead and that stands', () => {
    const soon = action({ id: 'a', endsAt: '2026-10-22T00:00:00.000Z' });
    const later = action({ id: 'b', endsAt: '2026-10-30T00:00:00.000Z' });
    const over = action({ id: 'c', endsAt: '2026-10-21T11:59:59.000Z' });
    const cancelled = action({
      id: 'd',
      endsAt: '2026-12-01T00:00:00.000Z',
      cancelledAt: '2026-10-21T00:00:00.000Z',
    });
    expect(sanctionInForce([soon, later, over, cancelled], NOW)).toBe(later);
    expect(sanctionInForce([over, cancelled], NOW)).toBeNull();
    expect(sanctionInForce([], NOW)).toBeNull();
  });
});

describe('the warning banner (owner decision 2026-10-21)', () => {
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1_000;
  const action = (overrides: Partial<MyModerationAction>): MyModerationAction => ({
    id: '11111111-1111-4111-8111-111111111111',
    type: 'warning',
    reason: { code: 'spam', note: null },
    subject: null,
    createdAt: new Date(NOW - DAY_MS).toISOString(),
    endsAt: null,
    cancelledAt: null,
    ...overrides,
  });

  it('shows a warning for its appeal window — APPEAL_WINDOW_DAYS from it — and no longer', () => {
    const warning = action({});
    expect(warningInWindow([warning], NOW)).toBe(warning);
    const lastInstant = action({
      createdAt: new Date(NOW - APPEAL_WINDOW_DAYS * DAY_MS + 1).toISOString(),
    });
    expect(warningInWindow([lastInstant], NOW)).toBe(lastInstant);
    const over = action({ createdAt: new Date(NOW - APPEAL_WINDOW_DAYS * DAY_MS).toISOString() });
    expect(warningInWindow([over], NOW)).toBeNull();
  });

  it('shows no cancelled warning and no other action, and the newest warning of several', () => {
    expect(
      warningInWindow([action({ cancelledAt: new Date(NOW - 1_000).toISOString() })], NOW),
    ).toBeNull();
    expect(
      warningInWindow(
        [
          action({ type: 'hide' }),
          action({ type: 'nickname_reset' }),
          action({ type: 'bio_clear' }),
          action({ type: 'image_remove' }),
        ],
        NOW,
      ),
    ).toBeNull();
    const older = action({ id: 'a', createdAt: new Date(NOW - 3 * DAY_MS).toISOString() });
    const newer = action({ id: 'b', createdAt: new Date(NOW - 2 * DAY_MS).toISOString() });
    expect(warningInWindow([older, newer], NOW)).toBe(newer);
    expect(warningInWindow([newer, older], NOW)).toBe(newer);
    expect(warningInWindow([], NOW)).toBeNull();
  });

  it('is no sanction: the write page’s banner stays for restrictions', () => {
    expect(sanctionInForce([action({})], NOW)).toBeNull();
    expect(copy.moderationWarningReceived).toBe('경고를 받았습니다.');
  });
});

describe('operators', () => {
  const report = (id: string, status: AdminReport['status']): AdminReport => ({
    id,
    target: { type: 'post', postId: POST },
    reporter: { id: 'r1', publicId: 'k7m2p9qx4z', nickname: '신고한회원', role: 'user' },
    reason: 'spam',
    description: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    status,
    resolvedAt: status === 'pending' ? null : '2026-10-21T01:00:00.000Z',
    resolvedBy: null,
    actionId: null,
    dismissalReason: null,
    aboutViewer: false,
  });

  it('knows whether a page is about the operator, once the session says who they are', () => {
    expect(concernsOperator('u1', 'u1')).toBe(true);
    expect(concernsOperator('u1', 'u2')).toBe(false);
    expect(concernsOperator('u1', undefined)).toBeUndefined();
  });

  it('dismisses only the pending reports on screen', () => {
    expect(
      pendingReportIds([report('a', 'pending'), report('b', 'actioned'), report('c', 'pending')]),
    ).toEqual(['a', 'c']);
    expect(pendingReportIds([report('d', 'dismissed')])).toEqual([]);
    const batch = dismissBatch([
      report('a', 'pending'),
      report('b', 'actioned'),
      report('c', 'pending'),
    ]);
    expect(batch.reports.map((row) => row.id)).toEqual(['a', 'c']);
    expect(batch.pendingCount).toBe(2);
    expect(dismissBatchText(batch)).toBeNull();
  });

  it('takes DISMISS_REPORTS_MAX of more pending reports, the oldest first, and says so', () => {
    // Newest first, as a page holds them; one more than a dismissal takes, and one processed.
    const at = (i: number) => new Date(Date.UTC(2026, 9, 21) + i * 1_000).toISOString();
    const pending = Array.from({ length: DISMISS_REPORTS_MAX + 1 }, (_, i) => ({
      ...report(`r${String(i).padStart(3, '0')}`, 'pending'),
      createdAt: at(i),
    })).reverse();
    const batch = dismissBatch([report('done', 'dismissed'), ...pending]);
    expect(batch.pendingCount).toBe(DISMISS_REPORTS_MAX + 1);
    expect(batch.reports).toHaveLength(DISMISS_REPORTS_MAX);
    expect(batch.reports[0]?.id).toBe('r000');
    // The newest waits for the next dismissal.
    expect(batch.reports.map((row) => row.id)).not.toContain(`r${String(DISMISS_REPORTS_MAX)}`);
    expect(dismissBatchText(batch)).toBe(
      `${copy.adminModerationDismissPartial} (대기 ${String(DISMISS_REPORTS_MAX + 1)}건)`,
    );
  });

  it('writes counts with their units and the reasons in the owner’s order', () => {
    expect(countText(copy.adminReporterCount, 2, copy.adminCountUnitPeople)).toBe('신고자 2명');
    expect(
      reasonCountsText([
        { reason: 'other', count: 1 },
        { reason: 'spam', count: 3 },
      ]),
    ).toBe(`${reportReasonLabel('spam')} 3 · ${reportReasonLabel('other')} 1`);
    expect(queueEntryText({ title: '제목', excerpt: '본문' })).toBe('제목');
    expect(queueEntryText({ title: null, excerpt: '\n첫 줄\n둘째' })).toBe('첫 줄');
  });

  it('names who processed or acted and when, the time alone on a record about the reader (owner decision 2026-10-21)', () => {
    const at = '2026-10-21T01:00:00.000Z';
    expect(operatorLineText({ nickname: '운영자둘' }, at, false)).toBe(
      `운영자둘 · ${formatKst(at)}`,
    );
    expect(operatorLineText(null, at, false)).toBe(
      `${copy.adminAccountsTargetGone} · ${formatKst(at)}`,
    );
    expect(operatorLineText(null, at, true)).toBe(formatKst(at));
    expect(copy.adminModerationWithheldReport).toContain('신고자');
    expect(copy.adminModerationWithheldAction).toContain('운영자');
  });

  it('tells the operator what a nickname reset holds and waives, in the rule’s days (owner decision 2026-10-21)', () => {
    expect(copy.adminModerationNicknameResetNote).toContain(`${String(NICKNAME_HOLD_DAYS)}일`);
    expect(copy.adminModerationNicknameResetNote).toContain('이 회원을 포함해');
  });

  it('names what a profile action took away and which actions can still be cancelled', () => {
    expect(removedItemLabel({ item: 'nickname', nickname: '옛닉' })).toBe(
      copy.adminModerationRemovedNickname,
    );
    expect(removedItemLabel({ item: 'bio', bio: '옛 소개' })).toBe(copy.adminModerationRemovedBio);
    expect(removedItemLabel({ item: 'image', imageUrl: '/api/v1/admin/media/x' })).toBe(
      copy.adminModerationRemovedImage,
    );
    const standing = { cancelledAt: null } as Pick<AdminModerationAction, 'cancelledAt'>;
    expect(isCancellable(standing)).toBe(true);
    expect(isCancellable({ cancelledAt: '2026-10-21T00:00:00.000Z' })).toBe(false);
  });

  it('needs a reason for an action, and the explanation with 기타 (owner decision 2026-10-22)', () => {
    expect(actionReasonDraft({ reason: null, note: '' })).toMatchObject({
      reasonError: copy.errModerationReasonRequired,
    });
    expect(actionReasonDraft({ reason: 'other', note: '  ' })).toMatchObject({
      note: null,
      noteError: copy.errModerationNoteRequired,
    });
    expect(actionReasonDraft({ reason: 'spam', note: ' 광고 ' })).toEqual({
      reason: 'spam',
      note: '광고',
      reasonError: null,
      noteError: null,
    });
    expect(
      actionReasonDraft({ reason: 'spam', note: '가'.repeat(MODERATION_NOTE_MAX_LENGTH + 1) }),
    ).toMatchObject({ noteError: copy.errModerationNoteTooLong });
  });

  it('needs the operators’ own reason for a cancellation and a dismissal', () => {
    expect(recordReasonDraft('  ')).toEqual({
      reason: '',
      error: copy.errModerationRecordRequired,
    });
    expect(recordReasonDraft(' 이의 받아들임 ')).toEqual({ reason: '이의 받아들임', error: null });
    expect(recordReasonDraft('가'.repeat(MODERATION_REASON_MAX_LENGTH + 1)).error).toBe(
      copy.errModerationRecordRequired,
    );
  });

  it('says each refusal of an action', () => {
    const notAllowed = (reason: string) => refused(409, 'MODERATION_NOT_ALLOWED', { reason });
    const expected: Record<string, string> = {
      own: copy.errModerationOwn,
      hidden: copy.errModerationHidden,
      deleted: copy.errModerationDeleted,
      nothing_to_remove: copy.errModerationNothingToRemove,
      cancelled: copy.errModerationCancelled,
      resolved: copy.errModerationResolved,
      not_theirs: copy.errModerationNotTheirs,
    };
    for (const [reason, message] of Object.entries(expected)) {
      expect(moderationFailure(notAllowed(reason))).toEqual({ kind: 'alert', message });
    }
    expect(moderationFailure(refused(404, 'NOT_FOUND'))).toEqual({
      kind: 'alert',
      message: copy.adminModerationNotFound,
    });
    expect(moderationFailure(validation('note', OTHER_NEEDS_TEXT_MESSAGE))).toEqual({
      kind: 'field',
      field: 'note',
      message: copy.errModerationNoteRequired,
    });
    expect(moderationFailure(validation('note', 'at most 500 characters, not 501'))).toEqual({
      kind: 'field',
      field: 'note',
      message: copy.errModerationNoteTooLong,
    });
    expect(moderationFailure(validation('reason', 'must have some text'))).toEqual({
      kind: 'field',
      field: 'reason',
      message: copy.errModerationRecordRequired,
    });
    expect(moderationFailure(otherAccount)).toEqual({
      kind: 'alert',
      message: copy.sessionChanged,
    });
    // Sending again cannot help: the session ended, or another admin revoked this one's role.
    expect(moderationFailure(refused(401, 'UNAUTHENTICATED'))).toEqual({
      kind: 'alert',
      message: copy.errUnauthenticated,
    });
    expect(moderationFailure(refused(403, 'FORBIDDEN'))).toEqual({
      kind: 'alert',
      message: copy.adminOnly,
    });
    // More reports named than one dismissal takes: the limit, not 'check what you typed'.
    expect(moderationFailure(validation('reportIds', 'Too big'))).toEqual({
      kind: 'alert',
      message: copy.errModerationReportIds,
    });
    expect(moderationFailure(new TypeError('Failed to fetch'))).toEqual({
      kind: 'alert',
      message: copy.errNetwork,
    });
  });
});
