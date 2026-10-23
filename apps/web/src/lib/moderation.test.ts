import {
  ACCOUNT_RESTRICTION_DAYS,
  ACCOUNT_RESTRICTION_REASONS,
  APPEAL_WINDOW_DAYS,
  APPROVAL_REASON_MAX_LENGTH,
  DISMISS_REPORTS_MAX,
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH,
  NICKNAME_HOLD_DAYS,
  NICKNAME_MAX_LENGTH,
  NO_EMAIL_DOMAIN,
  OTHER_NEEDS_TEXT_MESSAGE,
  POST_EXCERPT_MAX_LENGTH,
  REPORTS_PER_DAY,
  REPORT_DESCRIPTION_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_WINDOW_HOURS,
  WRITING_RESTRICTION_DAYS,
  postExcerpt,
  readPostDocument,
  type ErrorCode,
} from '@buddha/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { BUSINESS_INFO } from '@/legal/business-info';
import { templateKeys } from '@/legal/template';
import { SRC } from '../test/screen-text';
import {
  ApiError,
  type AccountRestrictionRequest,
  type AdminModerationAction,
  type AdminReport,
  type MyModerationAction,
  type PublishedPost,
  type ReportTarget,
} from './api';
import { hiddenItemName, reportReasonLabel } from './authored';
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
  appealDeadlineView,
  appealEmailRequired,
  appealGuidanceText,
  appealWindowOpen,
  authorPublicIdOf,
  cancelDialogBody,
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
  nicknameHoldShown,
  operatorLineText,
  pendingReportIds,
  postReportItem,
  queueEntryText,
  reasonCountsText,
  recordReasonDraft,
  removedItemLabel,
  reportButtonName,
  reportDialogTitle,
  reportDraft,
  reportFailure,
  reportItemName,
  reportLengthText,
  reportReasonOf,
  reportStatusLabel,
  reportTargetTypeLabel,
  reportTargetView,
  RESTRICTION_TERM_OPTIONS,
  ACCOUNT_RESTRICTION_REASON_OPTIONS,
  ACCOUNT_RESTRICTION_TERM_OPTIONS,
  ADMIN_ACCOUNT_REQUESTS_PATH,
  accountRequestChangeLabel,
  accountRequestMemoDraft,
  accountRequestMootNotice,
  accountRequestMootText,
  accountRestrictionDraft,
  accountRestrictionReasonOf,
  adminAccountRequestQueueKey,
  adminAccountRequestQueueOf,
  adminAccountRequestQueuePath,
  adminRestrictionEndText,
  adminActionAnchor,
  adminActionPath,
  accountRequestTargetText,
  approvalStatusLabel,
  endChangeLabel,
  endChangeText,
  isAccountRestriction,
  isRestriction,
  myEndChangeView,
  requestStanding,
  restrictionStanding,
  restrictionTermLabel,
  restrictionTermOf,
  shortenEndDraft,
  warningInWindow,
} from './moderation';
import { formatKst } from './datetime';
import { type RestrictedWrite, restrictedMessage } from './restriction';
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

  it('names the item a report is about: a post by its title or first line, a comment by its own first line (owner decision 2026-10-22 답 4)', () => {
    expect(reportItemName({ type: 'post', title: '금리 전망', excerpt: '본문' })).toBe('금리 전망');
    expect(reportItemName({ type: 'post', title: null, excerpt: '첫 줄\n둘째 줄' })).toBe('첫 줄');
    // A comment (a 대댓글 too) by the first non-empty line of its own text, trimmed.
    expect(reportItemName({ type: 'comment', body: '\n  첫 댓글  \n더' })).toBe('첫 댓글');
    // Never its post's: two comments under one post are named apart.
    expect(reportItemName({ type: 'comment', body: '둘째 댓글' })).not.toBe(
      reportItemName({ type: 'comment', body: '첫 댓글' }),
    );
  });

  it('names a reported profile by the member’s current nickname, whole (owner decision 2026-10-22 (2차) 4)', () => {
    expect(reportItemName({ type: 'profile', nickname: '시장읽는사람' })).toBe('시장읽는사람');
    expect(reportItemName({ type: 'profile', nickname: 'user_7KQ2' })).toBe('user_7KQ2');
    // A nickname is at most 20 characters: never cut, never an ellipsis.
    const longest = 'N'.repeat(NICKNAME_MAX_LENGTH);
    expect(reportItemName({ type: 'profile', nickname: longest })).toBe(longest);
    // Each profile its own: the line names the member, not the kind of item.
    expect(reportItemName({ type: 'profile', nickname: '하나' })).not.toBe(
      reportItemName({ type: 'profile', nickname: '둘' }),
    );
  });

  it('names an item whose first line is longer by its first 300 characters and an ellipsis, as #51’s dialog (owner decision 2026-10-22 답 4)', () => {
    // The cap: a card's preview's.
    expect(POST_EXCERPT_MAX_LENGTH).toBe(300);
    // A comment can be 1,000 characters on one line: its first 300, cut where they end and marked
    // as cut, without the rest of the line or the lines after it.
    const line = `${'가'.repeat(150)}${'a'.repeat(850)}`;
    expect(reportItemName({ type: 'comment', body: `${line}\n둘째 줄` })).toBe(
      `${line.slice(0, 300)}…`,
    );
    expect(reportButtonName({ type: 'comment', body: line })).toBe(
      `${line.slice(0, 300)}… ${copy.reportAction}`,
    );
    // Counted in code points, as a comment's length is: an emoji is one.
    expect(reportItemName({ type: 'comment', body: '😀'.repeat(400) })).toBe(
      `${'😀'.repeat(300)}…`,
    );
    // The mark only where a cut is: a first line of 300 or fewer is whole and bare.
    expect(
      reportItemName({ type: 'comment', body: `${'a'.repeat(300)}\n${'b'.repeat(900)}` }),
    ).toBe('a'.repeat(300));
    // A cut just after a space ends at the word before it, the mark beside it.
    expect(reportItemName({ type: 'comment', body: `${'a'.repeat(299)} ${'b'.repeat(9)}` })).toBe(
      `${'a'.repeat(299)}…`,
    );
    // A post's excerpt comes cut at the same 300: one that reaches the cap on one line was cut
    // there; one with a line break or shorter was not.
    expect(reportItemName({ type: 'post', title: null, excerpt: 'a'.repeat(300) })).toBe(
      `${'a'.repeat(300)}…`,
    );
    expect(
      reportItemName({
        type: 'post',
        title: null,
        excerpt: `${'a'.repeat(200)}\n${'b'.repeat(99)}`,
      }),
    ).toBe('a'.repeat(200));
    expect(reportItemName({ type: 'post', title: null, excerpt: 'a'.repeat(299) })).toBe(
      'a'.repeat(299),
    );
    // A title is never cut, however long the text under it.
    expect(reportItemName({ type: 'post', title: '금리 전망', excerpt: 'a'.repeat(300) })).toBe(
      '금리 전망',
    );
  });

  it('names a post on its page as its card does: the page’s text cut as the card’s preview is (owner decision 2026-10-22 답 4)', () => {
    const doc = (...lines: string[]) =>
      ({
        type: 'doc',
        content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
      }) as PublishedPost['body'];
    // An untitled post whose first line is past the cap, with a line after it: its whole text
    // keeps the line break, and a name from it would lose the cut's '…'.
    const long = `${'가'.repeat(150)}${'a'.repeat(200)}`;
    const body = doc(long, '둘째 줄');
    expect(readPostDocument(body).text).toContain('\n');
    // The card's item: the API's `excerpt`, `postExcerpt` of the same text.
    const card = {
      type: 'post',
      title: null,
      excerpt: postExcerpt(readPostDocument(body).text),
    } as const;
    const page = postReportItem({ title: null, body });
    expect(page).toEqual(card);
    expect(reportItemName(page)).toBe(`${long.slice(0, POST_EXCERPT_MAX_LENGTH)}…`);
    expect(reportItemName(page)).toBe(reportItemName(card));
    // A short first line is whole and bare; a titled post is its title.
    expect(reportItemName(postReportItem({ title: null, body: doc('첫 줄', '둘째 줄') }))).toBe(
      '첫 줄',
    );
    expect(reportItemName(postReportItem({ title: '금리 전망', body }))).toBe('금리 전망');
  });

  it('cuts a long first line between two characters as they are seen, never inside an emoji', () => {
    // Four people joined by three ZWJs: seven code points, one character on screen.
    const family = '👨‍👩‍👧‍👦';
    expect([...family]).toHaveLength(7);
    expect(
      reportItemName({ type: 'comment', body: `${'a'.repeat(298)}${family}${'b'.repeat(10)}` }),
    ).toBe(`${'a'.repeat(298)}…`);
    expect(
      reportItemName({ type: 'comment', body: `${'a'.repeat(293)}${family}${'b'.repeat(10)}` }),
    ).toBe(`${'a'.repeat(293)}${family}…`);
    expect(reportItemName({ type: 'comment', body: `${'a'.repeat(299)}🇰🇷b` })).toBe(
      `${'a'.repeat(299)}…`,
    );
    expect(reportItemName({ type: 'comment', body: `${'a'.repeat(299)}😀😀` })).toBe(
      `${'a'.repeat(299)}😀…`,
    );
  });

  it('names a post or a comment by the one rule MY’s dialog for a hidden item names it by (ADR-0081 결과 5)', () => {
    // #51's `hiddenItemName` (ADR-0080, owner decisions 2026-10-22 3rd and 4th) and the report
    // dialog's name were two copies of one rule until the restack; the report's now asks it. Every
    // shape the two tests above and authored.test.ts walk names an item alike in both.
    const family = '👨‍👩‍👧‍👦';
    const posts = [
      { title: '금리 전망', excerpt: 'a'.repeat(300) },
      { title: null, excerpt: 'a'.repeat(300) },
      { title: null, excerpt: 'a'.repeat(299) },
      { title: null, excerpt: `${'a'.repeat(200)}\n${'b'.repeat(99)}` },
      { title: null, excerpt: '\n  첫 줄  \n둘째 줄' },
    ];
    for (const post of posts) {
      expect(reportItemName({ type: 'post', ...post })).toBe(
        hiddenItemName({ tab: 'posts', ...post }),
      );
    }
    const comments = [
      '첫 댓글',
      `${'가'.repeat(150)}${'a'.repeat(850)}\n둘째 줄`,
      `${'a'.repeat(300)}\n${'b'.repeat(900)}`,
      `${'a'.repeat(299)} ${'b'.repeat(9)}`,
      '😀'.repeat(400),
      `${'a'.repeat(298)}${family}${'b'.repeat(10)}`,
      `${'a'.repeat(299)}🇰🇷b`,
    ];
    for (const body of comments) {
      expect(reportItemName({ type: 'comment', body })).toBe(
        hiddenItemName({ tab: 'comments', body }),
      );
    }
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
    // The item the dialog it opens names, then the word: one naming for both.
    for (const item of [
      { type: 'post', title: null, excerpt: '첫 줄\n둘째 줄' },
      { type: 'comment', body: '대댓글 첫 줄\n둘째 줄' },
    ] as const) {
      expect(reportButtonName(item)).toBe(`${reportItemName(item)} ${copy.reportAction}`);
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
    expect(copy.appealGuidance).toContain(`${String(APPEAL_WINDOW_DAYS)}일`);
    expect(copy.adminModerationNoteHint).toContain(`${String(MODERATION_NOTE_MAX_LENGTH)}자`);
    expect(copy.errModerationNoteTooLong).toContain(`${String(MODERATION_NOTE_MAX_LENGTH)}자`);
    expect(copy.errModerationRecordRequired).toContain(`${String(MODERATION_REASON_MAX_LENGTH)}자`);
    expect(copy.errModerationReportIds).toContain(`${String(DISMISS_REPORTS_MAX)}건`);
    expect(copy.adminModerationDismissPartial).toContain(`${String(DISMISS_REPORTS_MAX)}건`);
    expect(copy.moderationNicknameHeld).toContain(`${String(NICKNAME_HOLD_DAYS)}일`);
    expect(copy.adminModerationCancelNicknameResetBody).toContain(
      `${String(NICKNAME_HOLD_DAYS)}일`,
    );
  });

  it('says the owner’s words for a nickname reset and its cancellation (owner decision 2026-10-22 답 2·3)', () => {
    expect(copy.moderationNicknameHeld).toBe('이전 닉네임은 30일 동안 다시 쓸 수 없습니다.');
    // The owner's example sentence, and that nothing is restored.
    expect(copy.adminModerationCancelNicknameResetBody).toContain(
      '이전 닉네임은 이 회원만 다시 고를 수 있습니다.',
    );
    expect(copy.adminModerationCancelNicknameResetBody).toContain('되살리지 않습니다');
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

describe('the nickname reset’s hold on 조치·신고 내역 (owner decision 2026-10-22 답 3)', () => {
  const NOW = Date.parse('2026-10-22T12:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1_000;
  const reset = (overrides: Partial<MyModerationAction>): MyModerationAction => ({
    id: '22222222-2222-4222-8222-222222222222',
    type: 'nickname_reset',
    reason: { code: 'impersonation', note: null },
    subject: { type: 'profile' },
    createdAt: new Date(NOW - DAY_MS).toISOString(),
    endsAt: null,
    endChange: null,
    cancelledAt: null,
    ...overrides,
  });

  it('says it for the 30 days of the hold — NICKNAME_HOLD_DAYS from the reset — and no longer', () => {
    expect(nicknameHoldShown(reset({}), NOW)).toBe(true);
    expect(
      nicknameHoldShown(
        reset({ createdAt: new Date(NOW - NICKNAME_HOLD_DAYS * DAY_MS + 1).toISOString() }),
        NOW,
      ),
    ).toBe(true);
    // At the hold's end the nickname is anybody's again (`nickname_held()`: less than 30 days).
    expect(
      nicknameHoldShown(
        reset({ createdAt: new Date(NOW - NICKNAME_HOLD_DAYS * DAY_MS).toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });

  it('says nothing once the reset is cancelled — the hold is the member’s then — nor on any other action', () => {
    expect(
      nicknameHoldShown(reset({ cancelledAt: new Date(NOW - 1_000).toISOString() }), NOW),
    ).toBe(false);
    for (const type of ['hide', 'warning', 'bio_clear', 'image_remove'] as const) {
      expect(nicknameHoldShown(reset({ type }), NOW)).toBe(false);
    }
  });
});

describe('a standing restriction (#185)', () => {
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');
  const action = (overrides: Partial<MyModerationAction>): MyModerationAction => ({
    id: '11111111-1111-4111-8111-111111111111',
    type: 'warning',
    reason: { code: 'spam', note: null },
    subject: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    endsAt: null,
    endChange: null,
    cancelledAt: null,
    ...overrides,
  });
  const restriction = (overrides: Partial<MyModerationAction>) =>
    action({ type: 'writing_restriction', ...overrides });

  it('holds until the end and not at it, as the server counts (#45-12: it ends by itself)', () => {
    expect(restrictionStanding(restriction({ endsAt: new Date(NOW).toISOString() }), NOW)).toBe(
      false,
    );
    expect(restrictionStanding(restriction({ endsAt: new Date(NOW + 1).toISOString() }), NOW)).toBe(
      true,
    );
  });

  it('stands with no end (무기한) until cancelled, and a cancellation ends any at once', () => {
    expect(restrictionStanding(restriction({ endsAt: null }), NOW)).toBe(true);
    const cancelledAt = '2026-10-21T00:00:00.000Z';
    expect(restrictionStanding(restriction({ endsAt: null, cancelledAt }), NOW)).toBe(false);
    expect(
      restrictionStanding(restriction({ endsAt: '2026-12-01T00:00:00.000Z', cancelledAt }), NOW),
    ).toBe(false);
  });

  it('counts a lifted or a shortened restriction by its end as it stands now', () => {
    // A lift sets the end to the lift's time; a 감경 to an earlier one (ADR-0082).
    expect(
      restrictionStanding(restriction({ endsAt: new Date(NOW - 60_000).toISOString() }), NOW),
    ).toBe(false);
    expect(
      restrictionStanding(restriction({ endsAt: new Date(NOW + 60_000).toISOString() }), NOW),
    ).toBe(true);
  });

  it('tells the member a lifted or shortened one — 조기 해제됨 or 감경됨 and the end it was given — but not a cancelled one (owner decision 2026-10-23 answers 4 and 10)', () => {
    const original = '2026-10-27T00:00:00.000Z';
    expect(
      myEndChangeView(
        restriction({
          endsAt: '2026-10-21T09:00:00.000Z',
          endChange: { kind: 'lift', originalEndsAt: original },
        }),
      ),
    ).toEqual({ label: '조기 해제됨', originalEndsAt: original });
    // 무기한 brought to a term: the end it was given is 무기한 (null).
    expect(
      myEndChangeView(
        restriction({
          endsAt: '2026-10-23T00:00:00.000Z',
          endChange: { kind: 'shorten', originalEndsAt: null },
        }),
      ),
    ).toEqual({ label: '감경됨', originalEndsAt: null });
    // Its end never changed: nothing more than '끝나는 때'.
    expect(myEndChangeView(restriction({ endsAt: original }))).toBeNull();
    // Cancelled: '취소됨' and when alone.
    expect(
      myEndChangeView(
        restriction({
          endsAt: '2026-10-21T09:00:00.000Z',
          endChange: { kind: 'lift', originalEndsAt: original },
          cancelledAt: '2026-10-21T10:00:00.000Z',
        }),
      ),
    ).toBeNull();
    // Another type has no end to change.
    expect(
      myEndChangeView(action({ endChange: { kind: 'shorten', originalEndsAt: original } })),
    ).toBeNull();
    expect(copy.moderationEndLifted).toBe('조기 해제됨');
    expect(copy.moderationEndShortened).toBe('감경됨');
  });

  it('reads an account restriction as a writing one: its end, 진행 중, 조기 해제됨·감경됨 and the end it was given (#139, ADR-0069 decision 4 #139 «제한 사실·사유·종료 시각·이의 경로»)', () => {
    const account = (overrides: Partial<MyModerationAction>) =>
      action({
        type: 'account_restriction',
        reason: { code: 'multi_account', note: '설명' },
        ...overrides,
      });
    expect(isRestriction('account_restriction')).toBe(true);
    expect(restrictionStanding(account({ endsAt: null }), NOW)).toBe(true);
    expect(restrictionStanding(account({ endsAt: new Date(NOW + 1).toISOString() }), NOW)).toBe(
      true,
    );
    expect(restrictionStanding(account({ endsAt: new Date(NOW).toISOString() }), NOW)).toBe(false);
    expect(
      restrictionStanding(account({ endsAt: null, cancelledAt: '2026-10-21T00:00:00.000Z' }), NOW),
    ).toBe(false);
    expect(
      myEndChangeView(
        account({
          endsAt: '2026-10-21T09:00:00.000Z',
          endChange: { kind: 'lift', originalEndsAt: null },
        }),
      ),
    ).toEqual({ label: '조기 해제됨', originalEndsAt: null });
    // Its reason is the owner's words, 다계정 and 이상 거래 among them.
    expect(reportReasonLabel('multi_account')).toBe('다계정');
    expect(reportReasonLabel('abnormal_trading')).toBe('이상 거래');
    expect(moderationActionLabel('account_restriction')).toBe('계정 제한');
  });

  it('takes no other type for a restriction, whatever its end', () => {
    expect(isRestriction('writing_restriction')).toBe(true);
    expect(isAccountRestriction('account_restriction')).toBe(true);
    expect(isAccountRestriction('writing_restriction')).toBe(false);
    for (const type of [
      'hide',
      'warning',
      'nickname_reset',
      'bio_clear',
      'image_remove',
    ] as const) {
      expect(isRestriction(type)).toBe(false);
      expect(restrictionStanding(action({ type, endsAt: null }), NOW)).toBe(false);
    }
  });
});

describe('the appeal guidance (#186, ADR-0084)', () => {
  const DAY_MS = 24 * 60 * 60 * 1_000;
  const TAKEN = '2026-10-21T03:00:00.000Z';

  it('says the four things of #45-14 and the owner’s line, with the window the shared rule counts', () => {
    // By the customer centre's email, once per action, within APPEAL_WINDOW_DAYS of it; the action
    // stands while reviewed and the answer comes by email (ADR-0069 decision 2 #45-14) — and which
    // action, from the sign-up email (owner decision 2026-10-22 답 6), one sentence of its own: the
    // owner's sentence, its parentheses asking for the post's or comment's title or first line too,
    // as the ask-back does (owner decision 2026-10-23 답 1).
    expect(copy.appealGuidance).toContain('고객센터 이메일({{email}})');
    expect(copy.appealGuidance).toContain(
      '어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 가입한 이메일로 보내 주세요.',
    );
    expect(copy.appealGuidance).toContain('조치마다 한 번');
    expect(copy.appealGuidance).toContain(`조치한 때부터 ${String(APPEAL_WINDOW_DAYS)}일 안`);
    expect(copy.appealGuidance).toContain('검토하는 동안 조치는 그대로');
    expect(copy.appealGuidance).toContain('결과는 이메일로');
    // Once above the list, with no deadline beside it: no '이 기한' to point at (답 4).
    expect(copy.appealGuidance).not.toContain('이 기한');
    expect(templateKeys(copy.appealGuidance)).toEqual(['email']);
    // The card's line, and the owner's sentence for one whose deadline has passed (답 2).
    expect(copy.moderationAppealDeadline).toBe('이의 기한');
    expect(copy.moderationAppealDeadlinePassed).toBe('이의 기한이 지났습니다.');
  });

  it('asks for the action in the words the operator’s ask-backs use (owner decision 2026-10-23 답 1, (2차) 답 1)', () => {
    // docs/OPERATIONS.md's two ask-backs, the owner's texts — the usual one, and the late one that
    // ends '3일 안에' (owner decision 2026-10-23 (2차) 답 1): the member reads the same 'which
    // action' on the page as in either mail that asks them again (ADR-0084 6-2).
    const operations = readFileSync(path.join(SRC, '../../../docs/OPERATIONS.md'), 'utf8');
    const askBacks = [
      '어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 그 조치의 이의 기한 안에 다시 보내 주세요.',
      '어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 3일 안에 다시 보내 주세요.',
    ];
    const which = /어느 조치인지\([^)]*\)를 적어/;
    for (const askBack of askBacks) {
      expect(operations).toContain(`\n     ${askBack}\n`);
      expect(which.exec(copy.appealGuidance)?.[0]).toBe(which.exec(askBack)?.[0]);
    }
  });

  it('fills in the business info’s email — 미정 until the owner supplies it', () => {
    const text = appealGuidanceText();
    expect(text).toContain(`고객센터 이메일(${BUSINESS_INFO.email})`);
    expect(text).not.toContain('{{');
  });

  it('asks an account on a Kakao or Naver placeholder address alone to register an email first, by GET /me’s email', () => {
    // Owner decision 2026-10-22 (2차) 3: the owner's sentence word for word, and a link of its own
    // to MY 설정 (where the 계정 card registers the address).
    expect(copy.appealEmailRequired).toBe(
      '이의를 보내려면 MY 설정에서 이메일을 먼저 등록해 주세요.',
    );
    expect(copy.appealEmailRequiredOpen).toContain('MY 설정');
    expect(templateKeys(copy.appealEmailRequired)).toEqual([]);
    // The placeholder a Kakao or Naver sign-in without an email stores, whatever its case.
    expect(appealEmailRequired({ email: `kakao_42@${NO_EMAIL_DOMAIN}` })).toBe(true);
    expect(appealEmailRequired({ email: `NAVER_abc@${NO_EMAIL_DOMAIN.toUpperCase()}` })).toBe(true);
    // A real address — one registered over a placeholder too — sends appeals itself.
    expect(appealEmailRequired({ email: 'member@example.com' })).toBe(false);
    expect(appealEmailRequired({ email: `member@sub.${NO_EMAIL_DOMAIN}` })).toBe(false);
    // `GET /me` not answered yet, or not readable: nothing is known, so nothing is added.
    expect(appealEmailRequired(undefined)).toBe(false);
  });

  // 12:00:45.600 KST: the deadline shows as 오후 12:00 fourteen days on, 45.6 seconds into the minute.
  const MID_MINUTE = '2026-10-21T03:00:45.600Z';
  const MINUTE_MS = 60 * 1_000;

  it('holds the window open to the end of the minute the deadline shows, 14 days on, and never for a cancelled action', () => {
    const taken = Date.parse(MID_MINUTE);
    const deadline = taken + APPEAL_WINDOW_DAYS * DAY_MS;
    const standing = { createdAt: MID_MINUTE, cancelledAt: null };
    expect(appealDeadline(standing)).toBe(new Date(deadline).toISOString());
    expect(appealWindowOpen(standing, taken)).toBe(true);
    // Owner decision 2026-10-23 답 5: in time to the displayed minute's last second (…:59) — past
    // the exact instant inside it — and late as that minute ends.
    const minuteEnds = Date.parse('2026-11-04T03:01:00.000Z');
    expect(appealWindowOpen(standing, deadline)).toBe(true);
    expect(appealWindowOpen(standing, deadline + 14_000)).toBe(true);
    expect(appealWindowOpen(standing, minuteEnds - 1)).toBe(true);
    expect(appealWindowOpen(standing, minuteEnds)).toBe(false);
    // A deadline on the minute's first instant has that whole minute too.
    const onTheMinute = { createdAt: TAKEN, cancelledAt: null };
    const onTheMinuteDeadline = Date.parse(TAKEN) + APPEAL_WINDOW_DAYS * DAY_MS;
    expect(appealWindowOpen(onTheMinute, onTheMinuteDeadline + MINUTE_MS - 1)).toBe(true);
    expect(appealWindowOpen(onTheMinute, onTheMinuteDeadline + MINUTE_MS)).toBe(false);
    const cancelled = { createdAt: MID_MINUTE, cancelledAt: '2026-10-21T04:00:00.000Z' };
    expect(appealWindowOpen(cancelled, taken)).toBe(false);
  });

  it('gives a standing action’s card its deadline, then that it has passed with the same deadline, and a cancelled one none', () => {
    // Owner decision 2026-10-22 답 1: the exact instant, 14×24 hours on; 답 2: once passed,
    // '이의 기한이 지났습니다.' and that deadline only — the line stays, the same instant. Passed once
    // the minute it shows has ended (owner decision 2026-10-23 답 5).
    const taken = Date.parse(MID_MINUTE);
    const deadline = new Date(taken + APPEAL_WINDOW_DAYS * DAY_MS).toISOString();
    const minuteEnds = Date.parse('2026-11-04T03:01:00.000Z');
    const standing = { createdAt: MID_MINUTE, cancelledAt: null };
    expect(appealDeadlineView(standing, taken)).toEqual({ deadline, passed: false });
    expect(appealDeadlineView(standing, Date.parse(deadline))).toEqual({
      deadline,
      passed: false,
    });
    expect(appealDeadlineView(standing, minuteEnds - 1)).toEqual({ deadline, passed: false });
    expect(appealDeadlineView(standing, minuteEnds)).toEqual({ deadline, passed: true });
    expect(appealDeadlineView(standing, taken + (APPEAL_WINDOW_DAYS + 30) * DAY_MS)).toEqual({
      deadline,
      passed: true,
    });
    // Nothing left to appeal once an operator cancelled it (ADR-0081 7-17), the window open or not.
    const cancelled = { createdAt: TAKEN, cancelledAt: '2026-10-21T04:00:00.000Z' };
    expect(appealDeadlineView(cancelled, taken)).toBeNull();
    expect(appealDeadlineView(cancelled, taken + (APPEAL_WINDOW_DAYS + 1) * DAY_MS)).toBeNull();
  });

  /**
   * The function declaration `name` of `file`, read with the compiler rather than a pattern so a
   * comment naming what is looked for does not count.
   */
  function declaration(
    file: string,
    name: string,
  ): { tree: ts.SourceFile; fn: ts.FunctionDeclaration } {
    const source = readFileSync(path.join(SRC, file), 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let fn: ts.FunctionDeclaration | undefined;
    const find = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) fn = node;
      else ts.forEachChild(node, find);
    };
    find(tree);
    if (fn === undefined) throw new Error(`${file} declares no function ${name}`);
    return { tree, fn };
  }

  /** Every node under `root` (itself included) that `pick` accepts. */
  function nodesIn<N extends ts.Node>(root: ts.Node, pick: (node: ts.Node) => node is N): N[] {
    const found: N[] = [];
    const visit = (node: ts.Node): void => {
      if (pick(node)) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  }

  const copyTexts: Readonly<Record<string, string>> = copy;

  /**
   * That `name` in `file` says nothing of the appeal: it calls nothing of it, reads no copy key whose
   * words speak of 이의, fills in no business info (where the email comes from) and writes no 이의
   * itself. With `readsCopy`, it reads its own words from the copy (a banner); without, its words
   * come to it (a refusal's sentence, `RefusalText`).
   */
  function expectNoAppeal(file: string, name: string, readsCopy: boolean): void {
    const { tree, fn } = declaration(file, name);
    const where = `${file} ${name}`;
    const identifiers = nodesIn(fn, ts.isIdentifier).map((node) => node.text);
    expect(
      identifiers.filter((text) => /appeal/i.test(text)),
      where,
    ).toEqual([]);
    expect(identifiers, where).not.toContain('fillBusinessInfo');
    const copyRead = nodesIn(fn, ts.isPropertyAccessExpression)
      .filter((access) => access.expression.getText(tree) === 'copy')
      .map((access) => access.name.text);
    if (readsCopy)
      expect(copyRead.length, `${where} reads its words from the copy`).toBeGreaterThan(0);
    for (const key of copyRead)
      expect(copyTexts[key] ?? '', `${where} copy.${key}`).not.toContain('이의');
    const written = [
      ...nodesIn(fn, ts.isStringLiteralLike).map((node) => node.text),
      ...nodesIn(fn, ts.isJsxText).map((node) => node.text),
    ];
    for (const text of written) expect(text, where).not.toContain('이의');
  }

  it('is not on the warning and sanction banners, which name their end or the owner’s sentence and the link alone', () => {
    // Owner decision 2026-10-22 답 3: «경고·제재 띠 → 이의 안내를 빼고 정해진 문장(경고)이나 끝나는
    // 시각(제한)과 조치·신고 내역 링크만». The sanction banner is #185's writing restriction's — on
    // the MY summary, the write page and MY 설정 alike (owner decision 2026-10-23 답 6 for MY 설정,
    // the one component under three test ids) — and #185, built beside this, drew an appeal
    // sentence on it when last seen before the restack (ADR-0084 결과 5): so neither banner may say
    // anything of the appeal.
    for (const name of ['SanctionBanner', 'WarningBanner']) {
      expectNoAppeal('components/moderation/sanction-banner.tsx', name, true);
    }
  });

  it('is not in a writing restriction’s refusal, which names its end and the way to 조치·신고 내역 alone', () => {
    // Owner decision 2026-10-22 답 8: «제한 중 거절 → 끝나는 시각과 조치·신고 내역 링크(14일 기한은
    // 적지 않음)». The way there under a refusal is #185's (`RefusalText`, `RestrictedModerationLink`,
    // components/moderation/refusal-text.tsx) — joined to this list at the restack (ADR-0084 결과 5) —
    // and the refusal's sentence is lib/restriction.ts's: what is closed, until when, what stays
    // open. Neither says anything of the appeal, whichever write was refused, with an end or 무기한.
    expectNoAppeal('components/moderation/refusal-text.tsx', 'RefusalText', false);
    expectNoAppeal('components/moderation/refusal-text.tsx', 'RestrictedModerationLink', true);
    const writes: readonly RestrictedWrite[] = [
      'writing',
      'profile',
      'onboardingInterests',
      'nickname',
    ];
    for (const write of writes) {
      for (const endsAt of ['2026-10-24T06:00:00.000Z', null]) {
        const refused = new ApiError(403, {
          code: 'RESTRICTED',
          message: 'RESTRICTED',
          details: { kind: 'writing', endsAt },
        });
        const message = restrictedMessage(refused, write, formatKst) ?? '';
        expect(message, `${write} ${String(endsAt)}`).toContain(
          endsAt === null ? copy.restrictionIndefinite : copy.restrictionUntil,
        );
        expect(message, `${write} ${String(endsAt)}`).not.toContain('이의');
        expect(message, `${write} ${String(endsAt)}`).not.toContain(BUSINESS_INFO.email);
      }
    }
  });

  it('is not on a hidden post’s edit screen, which says the hiding’s refusal and the way to 조치·신고 내역 alone', () => {
    // 오너 결정 2026-10-25 «링크를 둠» («제한 거절 문구와 같은 꼴»): under '운영 정책에 따라 숨긴 글은
    // 고칠 수 없습니다.' — wherever the edit screen says it: in the form's place, atop a form held
    // as the post is hidden under it (#50, ADR-0081 7-29) and under the form for a refused save —
    // the link of a restriction's refusal (`RestrictedModerationLink`, above), and no more: the
    // appeal's guidance and its deadline are 조치·신고 내역's, once (답 4). The screen, its form, the
    // link it draws and the held form's notice say nothing of the appeal, nor does the sentence.
    const screen = 'app/community/posts/[postId]/edit/edit-screen.tsx';
    expectNoAppeal(screen, 'HiddenModerationLink', false);
    expectNoAppeal(screen, 'EditScreen', true);
    expectNoAppeal(screen, 'EditForm', true);
    expectNoAppeal('components/post/post-form.tsx', 'GoneNotice', false);
    expect(copy.errPostNotEditable).not.toContain('이의');
    expect(copy.errPostNotEditable).not.toContain(BUSINESS_INFO.email);
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
    endChange: null,
    cancelledAt: null,
    ...overrides,
  });

  it('shows a warning for its appeal window — APPEAL_WINDOW_DAYS from it, to its minute’s end — and no longer', () => {
    const warning = action({});
    expect(warningInWindow([warning], NOW)).toBe(warning);
    // NOW is a minute's first instant. A deadline at it is in its minute's window (owner decision
    // 2026-10-23 답 5); one a millisecond before it is in the minute that has just ended.
    const lastMinute = action({
      createdAt: new Date(NOW - APPEAL_WINDOW_DAYS * DAY_MS).toISOString(),
    });
    expect(warningInWindow([lastMinute], NOW)).toBe(lastMinute);
    const over = action({
      createdAt: new Date(NOW - APPEAL_WINDOW_DAYS * DAY_MS - 1).toISOString(),
    });
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
    expect(restrictionStanding(action({}), NOW)).toBe(false);
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

  it('says in a nickname reset’s cancellation that the nickname taken away is the member’s to pick again while its hold runs, and that the hold has ended after it (owner decisions 2026-10-22 답 2, (2차) 2·3)', () => {
    const NOW = Date.parse('2026-10-22T12:00:00.000Z');
    const DAY_MS = 24 * 60 * 60 * 1_000;
    const at = (ms: number) => new Date(ms).toISOString();
    const reset = (createdAt: string) => ({
      type: 'nickname_reset' as const,
      createdAt,
      endsAt: null,
      cancelledAt: null,
    });
    expect(cancelDialogBody(reset(at(NOW - DAY_MS)), NOW)).toBe(
      copy.adminModerationCancelNicknameResetBody,
    );
    // Up to the hold's last instant — NICKNAME_HOLD_DAYS from the reset, as the member's line.
    expect(cancelDialogBody(reset(at(NOW - NICKNAME_HOLD_DAYS * DAY_MS + 1)), NOW)).toBe(
      copy.adminModerationCancelNicknameResetBody,
    );
    // From its end the cancellation hands nothing: the nickname is anybody's (`nickname_held()`:
    // less than 30 days), and the dialog says the hold has ended (owner decision 2026-10-22 (2차) 3).
    for (const createdAt of [at(NOW - NICKNAME_HOLD_DAYS * DAY_MS), at(NOW - 40 * DAY_MS)]) {
      expect(cancelDialogBody(reset(createdAt), NOW)).toBe(
        copy.adminModerationCancelNicknameResetEndedBody,
      );
    }
    // The owner's sentences, as given.
    expect(copy.adminModerationCancelNicknameResetEndedBody).toBe(
      '닉네임은 되살리지 않습니다. 이전 닉네임의 30일 보류는 끝났습니다.',
    );
    expect(copy.adminModerationCancelNicknameResetBody).toBe(
      '닉네임은 되살리지 않습니다. 이전 닉네임은 이 회원만 다시 고를 수 있습니다. 다른 회원은 강제 변경한 때부터 30일 동안 쓸 수 없습니다.',
    );
    // The 30 the ended dialog names is the hold's.
    expect(copy.adminModerationCancelNicknameResetEndedBody).toContain(
      `${String(NICKNAME_HOLD_DAYS)}일 보류`,
    );
    // Every other type keeps the words for a hiding and the profile items, whenever it was.
    for (const type of ['hide', 'warning', 'bio_clear', 'image_remove'] as const) {
      for (const createdAt of [at(NOW - DAY_MS), at(NOW - 40 * DAY_MS)]) {
        expect(cancelDialogBody({ type, createdAt, endsAt: null, cancelledAt: null }, NOW)).toBe(
          copy.adminModerationCancelBody,
        );
      }
    }
    expect(copy.adminModerationCancelBody).not.toContain('이 회원만');
    expect(copy.adminModerationCancelBody).not.toContain('보류');
    // A standing writing restriction's cancellation ends it at once and is told apart from a lift
    // (#185): a term still to come, or 무기한.
    const restriction = (endsAt: string | null) => ({
      type: 'writing_restriction' as const,
      createdAt: at(NOW - DAY_MS),
      endsAt,
      cancelledAt: null,
    });
    for (const endsAt of [at(NOW + DAY_MS), at(NOW + 1), null]) {
      expect(cancelDialogBody(restriction(endsAt), NOW)).toBe(
        copy.adminModerationCancelRestrictionBody,
      );
    }
    expect(copy.adminModerationCancelRestrictionBody).toContain(copy.adminModerationLift);
    // One that has ended — its term passed, or lifted (its end the lift's time) — has nothing to
    // end and no 조기 해제 on its row: the dialog says neither (an appeal accepted after it, #45-14).
    for (const endsAt of [at(NOW), at(NOW - 1), at(NOW - DAY_MS)]) {
      const body = cancelDialogBody(restriction(endsAt), NOW);
      expect(body).toBe(copy.adminModerationCancelRestrictionEndedBody);
      expect(body).not.toContain(copy.adminModerationLift);
      expect(body).not.toContain('곧바로 끝나');
    }
  });

  describe('the writing restriction (#185, ADR-0082)', () => {
    const NOW = Date.parse('2026-10-22T03:00:00.000Z');
    const HOUR_MS = 60 * 60 * 1_000;

    it('offers the owner’s terms in order — 1, 3, 7, 30 days and 무기한 — none picked by default', () => {
      expect(RESTRICTION_TERM_OPTIONS.map((option) => option.days)).toEqual([
        ...WRITING_RESTRICTION_DAYS,
        null,
      ]);
      expect(RESTRICTION_TERM_OPTIONS.map((option) => option.label)).toEqual([
        '1일',
        '3일',
        '7일',
        '30일',
        '무기한',
      ]);
      expect(restrictionTermOf('7', RESTRICTION_TERM_OPTIONS)).toEqual({ days: 7 });
      expect(restrictionTermOf('none', RESTRICTION_TERM_OPTIONS)).toEqual({ days: null });
      for (const value of ['', '2', '14', 'null']) {
        expect(restrictionTermOf(value, RESTRICTION_TERM_OPTIONS)).toBeUndefined();
      }
    });

    it('writes an end in Korean time, 무기한 for none, and each change of it', () => {
      expect(adminRestrictionEndText(null)).toBe('무기한');
      expect(adminRestrictionEndText('2026-10-23T06:00:00.000Z')).toBe(
        formatKst('2026-10-23T06:00:00.000Z'),
      );
      expect(endChangeLabel('shorten')).toBe('감경');
      expect(endChangeLabel('lift')).toBe('조기 해제');
      expect(
        endChangeText({
          kind: 'shorten',
          previousEndsAt: null,
          endsAt: '2026-10-25T06:00:00.000Z',
        }),
      ).toBe(`감경 · 무기한 → ${formatKst('2026-10-25T06:00:00.000Z')}`);
      expect(
        endChangeText({
          kind: 'lift',
          previousEndsAt: '2026-10-25T06:00:00.000Z',
          endsAt: '2026-10-22T03:00:00.000Z',
        }),
      ).toBe(
        `조기 해제 · ${formatKst('2026-10-25T06:00:00.000Z')} → ${formatKst('2026-10-22T03:00:00.000Z')}`,
      );
    });

    it('reads a 감경’s new end in Korean time: still to come, and before the end now (any, for 무기한)', () => {
      // 2026-10-22 12:00 KST is 03:00Z, NOW: an hour later is still to come.
      expect(shortenEndDraft('2026-10-22T13:00', null, NOW)).toEqual({
        endsAt: '2026-10-22T04:00:00.000Z',
        error: null,
      });
      expect(shortenEndDraft('', null, NOW)).toEqual({
        endsAt: null,
        error: copy.errModerationEndRequired,
      });
      expect(shortenEndDraft('2026-10-22T12:00', null, NOW).error).toBe(
        copy.errModerationEndPassed,
      );
      const end = new Date(NOW + 2 * HOUR_MS).toISOString();
      expect(shortenEndDraft('2026-10-22T13:00', end, NOW).error).toBeNull();
      expect(shortenEndDraft('2026-10-22T14:00', end, NOW).error).toBe(
        copy.errModerationNotEarlier,
      );
      expect(shortenEndDraft('2026-10-22T15:00', end, NOW).error).toBe(
        copy.errModerationNotEarlier,
      );
    });
  });

  describe('the account restriction (#139, ADR-0085)', () => {
    const NOW = Date.parse('2026-10-23T03:00:00.000Z');
    const at = (ms: number) => new Date(ms).toISOString();
    const REQUEST = '44444444-4444-4444-8444-444444444444';
    const request = (overrides: Partial<AccountRestrictionRequest>): AccountRestrictionRequest => ({
      id: REQUEST,
      change: 'apply',
      user: { id: USER, nickname: '회원', publicId: 'p1', role: 'user' },
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
      requestedBy: { id: 'admin-a', nickname: '운영자A' },
      requestedAt: '2026-10-23T02:00:00.000Z',
      status: 'pending',
      decidedBy: null,
      decisionReason: null,
      decidedAt: null,
      retractedAt: null,
      moot: null,
      aboutViewer: false,
      ...overrides,
    });

    it('lists its own requests’ page in the area and keeps it under admin', () => {
      expect(ADMIN_ACCOUNT_REQUESTS_PATH).toBe('/admin/moderation/account-restriction-requests');
      expect(adminAccountRequestQueueOf('decided')).toBe('decided');
      expect(adminAccountRequestQueueOf('retracted')).toBe('retracted');
      for (const param of ['pending', undefined, null, 'x', ['decided'], ['retracted']]) {
        expect(adminAccountRequestQueueOf(param)).toBe('pending');
      }
      expect(adminAccountRequestQueuePath('pending')).toBe(ADMIN_ACCOUNT_REQUESTS_PATH);
      expect(adminAccountRequestQueuePath('decided')).toBe(
        `${ADMIN_ACCOUNT_REQUESTS_PATH}?status=decided`,
      );
      expect(adminAccountRequestQueuePath('retracted')).toBe(
        `${ADMIN_ACCOUNT_REQUESTS_PATH}?status=retracted`,
      );
      // Under the area's key: every action and decision re-reads it.
      expect(adminAccountRequestQueueKey('pending').slice(0, 2)).toEqual([...ADMIN_MODERATION_KEY]);
      expect(isPrivateQueryKey(adminAccountRequestQueueKey('decided'))).toBe(true);
    });

    it('offers the owner’s eight reasons in order, and the terms with none picked (ADR-0069 decision 1 #57-12)', () => {
      expect(ACCOUNT_RESTRICTION_REASON_OPTIONS.map((option) => option.label)).toEqual([
        '스팸',
        '괴롭힘',
        '개인정보 노출',
        '사칭',
        '공모·조작 유도',
        '이상 거래',
        '다계정',
        '기타',
      ]);
      expect(ACCOUNT_RESTRICTION_REASON_OPTIONS.map((option) => option.code)).toEqual([
        ...ACCOUNT_RESTRICTION_REASONS,
      ]);
      // Not a report reason the owner's list leaves out.
      expect(accountRestrictionReasonOf('off_topic')).toBeNull();
      expect(accountRestrictionReasonOf('rights_infringement')).toBeNull();
      expect(accountRestrictionReasonOf('')).toBeNull();
      expect(accountRestrictionReasonOf('multi_account')).toBe('multi_account');
      expect(ACCOUNT_RESTRICTION_TERM_OPTIONS.map((option) => option.days)).toEqual([
        ...ACCOUNT_RESTRICTION_DAYS,
        null,
      ]);
      expect(ACCOUNT_RESTRICTION_TERM_OPTIONS.map((option) => option.label)).toEqual([
        '1일',
        '3일',
        '7일',
        '30일',
        '무기한',
      ]);
      expect(restrictionTermOf('', ACCOUNT_RESTRICTION_TERM_OPTIONS)).toBeUndefined();
      expect(restrictionTermOf('none', ACCOUNT_RESTRICTION_TERM_OPTIONS)).toEqual({ days: null });
      expect(restrictionTermLabel(30)).toBe('30일');
      expect(restrictionTermLabel(null)).toBe('무기한');
    });

    it('needs a reason and the explanation whatever the reason, in both length counts the server keeps', () => {
      expect(accountRestrictionDraft({ reason: null, note: '설명' })).toMatchObject({
        reasonError: copy.errModerationReasonRequired,
        noteError: null,
      });
      // Required with any reason, not only 기타 (#57-12 «필수 설명»).
      expect(accountRestrictionDraft({ reason: 'spam', note: '  ' })).toMatchObject({
        noteError: copy.errModerationAccountNoteRequired,
      });
      expect(accountRestrictionDraft({ reason: 'abnormal_trading', note: ' 설명 ' })).toEqual({
        reason: 'abnormal_trading',
        note: '설명',
        reasonError: null,
        noteError: null,
      });
      expect(
        accountRestrictionDraft({
          reason: 'spam',
          note: '가'.repeat(MODERATION_NOTE_MAX_LENGTH + 1),
        }).noteError,
      ).toBe(copy.errModerationNoteTooLong);
      // 300 emoji are 300 code points but 600 UTF-16 units — over what the request keeps.
      expect(accountRestrictionDraft({ reason: 'spam', note: '😀'.repeat(300) }).noteError).toBe(
        copy.errModerationNoteTooLong,
      );
      // An approval request's reason is held to the same units; a cancellation's is not.
      const emoji = '😀'.repeat(APPROVAL_REASON_MAX_LENGTH / 2 + 1);
      expect(recordReasonDraft(emoji).error).toBeNull();
      expect(recordReasonDraft(emoji, true).error).toBe(copy.errModerationRecordRequired);
      expect(recordReasonDraft(' 소명 확인 ', true)).toEqual({ reason: '소명 확인', error: null });
    });

    it('says in a cancellation request that another admin approves it, standing or ended (ADR-0085 7-4)', () => {
      const action = (endsAt: string | null) => ({
        type: 'account_restriction' as const,
        createdAt: at(NOW - 60_000),
        endsAt,
        cancelledAt: null,
      });
      for (const endsAt of [at(NOW + 1), null]) {
        expect(cancelDialogBody(action(endsAt), NOW)).toBe(copy.adminModerationAccountCancelBody);
      }
      for (const endsAt of [at(NOW), at(NOW - 1)]) {
        expect(cancelDialogBody(action(endsAt), NOW)).toBe(
          copy.adminModerationAccountCancelEndedBody,
        );
      }
      expect(copy.adminModerationAccountCancelBody).toContain('다른 운영자가 승인하면');
      expect(copy.adminModerationAccountCancelEndedBody).toContain('다른 운영자가 승인하면');
    });

    it('names each request and its status, and why a moot one is closed by a rejection', () => {
      expect(accountRequestChangeLabel('apply')).toBe('계정 제한');
      expect(accountRequestChangeLabel('shorten')).toBe('계정 제한 감경');
      expect(accountRequestChangeLabel('lift')).toBe('계정 제한 조기 해제');
      expect(accountRequestChangeLabel('cancel')).toBe('계정 제한 취소');
      expect(approvalStatusLabel('pending')).toBe('승인 대기');
      expect(approvalStatusLabel('approved')).toBe('승인됨');
      expect(approvalStatusLabel('rejected')).toBe('거절됨');
      expect(approvalStatusLabel('retracted')).toBe('철회됨');
      expect(accountRequestMootText(null)).toBeNull();
      for (const moot of ['cancelled', 'ended', 'not_earlier', 'end_passed'] as const) {
        expect(accountRequestMootText(moot)).toContain('승인할 수 없습니다');
        expect(accountRequestMootText(moot)).toContain('거절');
      }
    });

    it('says which restriction a change request changes, as it stands, and links to its row (ADR-0085 7-12)', () => {
      const ACTION = '55555555-5555-4555-8555-555555555555';
      const given = '2026-10-20T03:00:00.000Z';
      const ends = '2026-10-27T03:00:00.000Z';
      expect(accountRequestTargetText({ createdAt: given, endsAt: ends, cancelledAt: null })).toBe(
        `${formatKst(given)} · 끝나는 때 ${formatKst(ends)}`,
      );
      expect(accountRequestTargetText({ createdAt: given, endsAt: null, cancelledAt: null })).toBe(
        `${formatKst(given)} · 끝나는 때 무기한`,
      );
      expect(accountRequestTargetText({ createdAt: given, endsAt: ends, cancelledAt: ends })).toBe(
        `${formatKst(given)} · 끝나는 때 ${formatKst(ends)} · 취소됨`,
      );
      // Its row on the member's page, by the id the row carries there.
      expect(adminActionAnchor(ACTION.toUpperCase())).toBe(`moderation-action-${ACTION}`);
      expect(adminActionPath(USER, ACTION)).toBe(
        `${adminUserModerationPath(USER)}#moderation-action-${ACTION}`,
      );
      expect(copy.adminAccountRequestTarget).toBe('대상 계정 제한');
      expect(copy.adminAccountRequestTargetReason).toBe('대상 제한의 사유');
    });

    it('says to an admin a request is about that they decide nothing on it, nor see who asked or decided', () => {
      expect(copy.adminAccountRequestAboutMe).toContain('나에 관한 요청');
      expect(copy.adminAccountRequestAboutMe).toContain('승인하거나 거절할 수 없고');
      expect(copy.adminAccountRequestAboutMe).not.toContain('내게 온');
    });

    it('lets an admin who neither asked nor is the member decide (ADR-0056 decision 1-7)', () => {
      expect(requestStanding(request({}), undefined)).toBeUndefined();
      expect(requestStanding(request({}), 'admin-b')).toBe('decide');
      // The one who asked: another admin decides, in every environment.
      expect(requestStanding(request({}), 'admin-a')).toBe('requester');
      // About the reader: their asking and deciding admins withheld, decided by another.
      expect(requestStanding(request({ aboutViewer: true, requestedBy: null }), USER)).toBe('own');
      expect(requestStanding(request({}), USER)).toBe('own');
      for (const status of ['approved', 'rejected', 'retracted'] as const) {
        for (const reader of ['admin-a', 'admin-b']) {
          expect(requestStanding(request({ status }), reader)).toBe('closed');
        }
      }
    });

    it('lets the one who asked retract a waiting request, and says so on their line (owner decision 2026-10-23)', () => {
      // The requester's standing is the one that offers '요청 철회' (moderation-parts.tsx).
      expect(requestStanding(request({}), 'admin-a')).toBe('requester');
      expect(copy.adminAccountRequestOwn).toContain('철회할 수 있습니다');
      expect(copy.adminAccountRequestRetract).toBe('요청 철회');
      expect(copy.adminAccountRequestRetractBody).toContain('누구도 승인하거나 거절할 수 없습니다');
      expect(copy.adminAccountRequestsIntro).toContain('철회할 수 있습니다');
      expect(copy.adminAccountRequestsIntro).not.toContain('다른 운영자가 사유와 함께 거절');
    });

    it('takes the operators’ memo as optional, never more than the server keeps (owner decision 2026-10-23)', () => {
      expect(accountRequestMemoDraft('')).toEqual({ memo: null, error: null });
      expect(accountRequestMemoDraft('  \n ')).toEqual({ memo: null, error: null });
      expect(accountRequestMemoDraft(' 같은 기기 ')).toEqual({ memo: '같은 기기', error: null });
      expect(accountRequestMemoDraft('가'.repeat(MODERATION_REASON_MAX_LENGTH)).error).toBeNull();
      expect(accountRequestMemoDraft('가'.repeat(MODERATION_REASON_MAX_LENGTH + 1)).error).toBe(
        copy.errModerationMemoTooLong,
      );
      expect(copy.adminModerationAccountMemoHint).toContain('회원에게는 보이지 않고');
      // Every operator reads it — the one who asked too, before the decision and after (ADR-0085
      // 7-5): the hint names no narrower reader than that.
      expect(copy.adminModerationAccountMemoHint).toContain('운영자만 읽습니다');
      expect(copy.adminModerationAccountMemoHint).not.toContain('결정하는');
      // The server's refusal of it lands under the memo.
      expect(
        moderationFailure(
          refused(400, 'VALIDATION_ERROR', [{ path: ['memo'], message: 'too long' }]),
        ),
      ).toEqual({ kind: 'field', field: 'memo', message: copy.errModerationMemoTooLong });
    });

    it('asks only the admin who can reject a moot request to reject it (ADR-0085 7-3)', () => {
      const moot = request({ change: 'lift', apply: null, moot: 'ended' });
      expect(accountRequestMootNotice(moot, 'decide')).toBe(copy.adminAccountRequestMootEnded);
      // The one who asked and the admin it is about decide nothing: no notice asks them to.
      for (const standing of ['requester', 'own', 'closed', undefined] as const) {
        expect(accountRequestMootNotice(moot, standing)).toBeNull();
      }
      expect(accountRequestMootNotice(request({}), 'decide')).toBeNull();
    });

    it('says the two-person rule’s refusals and the direct routes’ refusal of an account restriction', () => {
      const approval = (message: string) =>
        refused(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message }]);
      expect(moderationFailure(approval('requester'))).toEqual({
        kind: 'alert',
        message: copy.errApprovalRequester,
      });
      expect(moderationFailure(approval('decided'))).toEqual({
        kind: 'alert',
        message: copy.errApprovalDecided,
      });
      expect(moderationFailure(approval('retracted'))).toEqual({
        kind: 'alert',
        message: copy.errApprovalRetracted,
      });
      expect(moderationFailure(approval('not_requester'))).toEqual({
        kind: 'alert',
        message: copy.errApprovalNotRequester,
      });
      expect(moderationFailure(approval('something new'))).toEqual({
        kind: 'alert',
        message: copy.errUnknown,
      });
      const notAllowed = (reason: string) => refused(409, 'MODERATION_NOT_ALLOWED', { reason });
      expect(moderationFailure(notAllowed('approval_required'))).toEqual({
        kind: 'alert',
        message: copy.errModerationApprovalRequired,
      });
      expect(moderationFailure(notAllowed('not_account_restriction'))).toEqual({
        kind: 'alert',
        message: copy.errModerationNotAccountRestriction,
      });
      // No admin but the one asking and the member could decide it (owner decision 2026-10-23).
      expect(moderationFailure(notAllowed('no_decider'))).toEqual({
        kind: 'alert',
        message: copy.errModerationNoDecider,
      });
      expect(copy.errModerationNoDecider).toContain('결정할 운영자가 없습니다');
    });
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
      // A writing restriction's 감경 and lift (#185, ADR-0082).
      not_restriction: copy.errModerationNotRestriction,
      ended: copy.errModerationEnded,
      not_earlier: copy.errModerationNotEarlier,
      end_passed: copy.errModerationEndPassed,
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
    // A 감경's end the server could not read, a term it does not take (#185).
    expect(moderationFailure(validation('endsAt', 'Invalid ISO datetime'))).toEqual({
      kind: 'field',
      field: 'endsAt',
      message: copy.errModerationEndRequired,
    });
    expect(moderationFailure(validation('days', 'Invalid input'))).toEqual({
      kind: 'alert',
      message: copy.errModerationTermRequired,
    });
    expect(moderationFailure(new TypeError('Failed to fetch'))).toEqual({
      kind: 'alert',
      message: copy.errNetwork,
    });
  });
});
