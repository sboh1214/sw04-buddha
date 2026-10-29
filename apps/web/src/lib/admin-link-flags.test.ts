import {
  LINK_CHECK_MAX,
  LINK_FLAG_REASONS,
  LINK_FLAG_REVIEW_OUTCOMES,
  LINK_REPEAT_THRESHOLD,
  LINK_REPEAT_WINDOW_SECONDS,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  LINK_FLAG_NOTE_MAX_LENGTH,
  linkFlagAuthorName,
  linkFlagFlaggedAt,
  linkFlagGroupActionLabel,
  linkFlagGroupCount,
  linkFlagGroupKey,
  linkFlagGroupLatest,
  linkFlagItemPath,
  linkFlagItemText,
  linkFlagKindLabel,
  linkFlagOutcomeLabel,
  linkFlagReasonLabel,
  linkFlagReviewErrorMessage,
  linkFlagReviewKeepsDialog,
  linkFlagReviewedBy,
  linkFlagStates,
  linkFlagWrittenAt,
  toLinkFlagReviewBody,
} from './admin-link-flags';
import { type AdminLinkFlag, type AdminLinkFlagGroup, ApiError } from './api';
import { adminCommentModerationPath, adminPostModerationPath, queueEntryText } from './moderation';
import { postPath } from './posts';

/** 반복 링크 검토 목록 (#187, ADR-0083; owner decision 2026-10-22) as the admin screen words it. */

const POST = '0b7c9a1d-6f34-4e58-9b0a-2d1e5f8c7a46';
const COMMENT = '6a1e2d3c-4b5a-4f69-8e7d-0c1b2a394857';

const flag = (over: Partial<AdminLinkFlag['target']> = {}): AdminLinkFlag => ({
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  url: 'https://example.com/a',
  reason: 'same_account',
  flaggedAt: '2026-10-21T06:00:00.000Z',
  target: {
    kind: 'post',
    postId: POST,
    commentId: null,
    excerpt: '근거',
    createdAt: '2026-10-21T05:59:00.000Z',
    editedAt: null,
    deletedAt: null,
    hiddenAt: null,
    author: { userId: 'u1', publicId: 'k7m2p9qx4z', nickname: '근거왕' },
    market: { id: '9c4b7a2e-1d3f-4e5a-8b6c-7d8e9f0a1b2c', slug: 'm', title: '시장' },
    ...over,
  },
});

describe('the review list’s words', () => {
  it('names each rule, with the owner’s numbers (LINK_REPEAT_THRESHOLD in 24 hours)', () => {
    expect(LINK_REPEAT_THRESHOLD).toBe(3);
    expect(LINK_REPEAT_WINDOW_SECONDS).toBe(86_400);
    expect(linkFlagReasonLabel('same_account')).toBe(copy.adminLinkFlagSameAccount);
    expect(linkFlagReasonLabel('many_accounts')).toBe(copy.adminLinkFlagManyAccounts);
    for (const reason of LINK_FLAG_REASONS) {
      expect(linkFlagReasonLabel(reason)).toContain(String(LINK_REPEAT_THRESHOLD));
    }
    // The screen's own explanation says both rules, the window, and what is not counted — and
    // (owner decision 2026-10-22) the grouping, the first 20 links, and the mark '확인함'.
    expect(LINK_CHECK_MAX).toBe(20);
    for (const words of [
      '24시간',
      '3개 이상',
      '3명 이상',
      '공식 출처',
      '운영자의 글',
      '그대로',
      '같은 주소·규칙의 항목은 한 줄로 묶어',
      `앞의 링크 ${String(LINK_CHECK_MAX)}개까지`,
      '문제 없음·조치함',
      '확인함',
    ]) {
      expect(copy.adminLinkFlagsIntro).toContain(words);
    }
  });

  it('says what carries the link and where to act on it: its own moderation page (#50)', () => {
    expect(linkFlagKindLabel('post')).toBe(copy.adminLinkFlagPost);
    expect(linkFlagKindLabel('comment')).toBe(copy.adminLinkFlagComment);
    // The post's or the comment's page in the 신고·조치 area, where its actions are taken and
    // listed — not the public post page (ADR-0083 7-12).
    expect(linkFlagItemPath(flag().target)).toBe(adminPostModerationPath(POST));
    expect(linkFlagItemPath(flag({ kind: 'comment', commentId: COMMENT }).target)).toBe(
      adminCommentModerationPath(COMMENT),
    );
    expect(linkFlagItemPath(flag().target)).not.toBe(postPath(POST));
  });

  it('names the link to the item by what it says, and one #184’s retention emptied as the report queue does (ADR-0087 7-26)', () => {
    expect(linkFlagItemText(flag().target)).toBe('근거');
    expect(
      linkFlagItemText(flag({ kind: 'comment', commentId: COMMENT, excerpt: '댓글 근거' }).target),
    ).toBe('댓글 근거');
    // Emptied — deleted, then the 지운 글 원문 period passed while the entry's own (신고·제재 기록,
    // from its flag) has not: no title and no text is left, and the link is still named.
    const deletedAt = '2026-10-21T06:20:00.000Z';
    const comment = flag({ kind: 'comment', commentId: COMMENT, excerpt: '', deletedAt }).target;
    expect(linkFlagItemText(comment)).toBe(copy.adminModerationPurgedLine);
    expect(linkFlagItemText(flag({ excerpt: '', deletedAt }).target)).toBe(
      copy.adminModerationUntitled,
    );
    // As the report queue's line names the same item (`queueEntryText`), and its page then says it
    // was emptied (`purgedAt`).
    expect(
      queueEntryText({
        target: { type: 'comment', commentId: COMMENT, postId: POST },
        title: null,
        excerpt: '',
      }),
    ).toBe(linkFlagItemText(comment));
    expect(
      queueEntryText({ target: { type: 'post', postId: POST }, title: null, excerpt: '' }),
    ).toBe(linkFlagItemText(flag({ excerpt: '' }).target));
    // A withdrawn member's still-hidden one, emptied with its hiding kept (owner decision
    // 2026-10-24 3), alike.
    expect(
      linkFlagItemText(
        flag({ kind: 'comment', commentId: COMMENT, excerpt: '', hiddenAt: deletedAt }).target,
      ),
    ).toBe(copy.adminModerationPurgedLine);
  });

  it('writes the times in Korean time, labelled', () => {
    expect(linkFlagFlaggedAt(flag())).toBe('탐지 2026. 10. 21. 오후 3:00');
    expect(linkFlagWrittenAt(flag().target)).toBe('작성 2026. 10. 21. 오후 2:59');
  });

  it('lists what became of the item since, in the order it can happen, and nothing for none', () => {
    expect(linkFlagStates(flag().target)).toEqual([]);
    expect(
      linkFlagStates(
        flag({
          editedAt: '2026-10-21T06:10:00.000Z',
          deletedAt: '2026-10-21T06:20:00.000Z',
          hiddenAt: '2026-10-21T06:30:00.000Z',
        }).target,
      ),
    ).toEqual([
      `${copy.adminLinkFlagEdited} 2026. 10. 21. 오후 3:10`,
      `${copy.adminLinkFlagDeleted} 2026. 10. 21. 오후 3:20`,
      `${copy.adminLinkFlagHidden} 2026. 10. 21. 오후 3:30`,
    ]);
    expect(linkFlagStates(flag({ hiddenAt: '2026-10-21T06:30:00.000Z' }).target)).toEqual([
      `${copy.adminLinkFlagHidden} 2026. 10. 21. 오후 3:30`,
    ]);
  });
});

const group = (over: Partial<AdminLinkFlagGroup> = {}): AdminLinkFlagGroup => ({
  url: 'https://example.com/a',
  reason: 'many_accounts',
  itemCount: 4,
  latestFlaggedAt: '2026-10-21T06:00:00.000Z',
  review: null,
  ...over,
});
const REVIEW = {
  id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
  outcome: 'actioned' as const,
  note: '숨김 처리',
  reviewedAt: '2026-10-21T07:30:00.000Z',
  admin: { userId: 'a1', nickname: '운영팀장' },
};

describe('the review list’s groups and marks (owner decision 2026-10-22)', () => {
  it('counts a group’s entries and writes its latest time in Korean time', () => {
    expect(linkFlagGroupCount(group())).toBe('항목 4개');
    expect(linkFlagGroupLatest(group())).toBe('최근 탐지 2026. 10. 21. 오후 3:00');
  });

  it('keys a default-list row by its link and rule, a reviewed row by its mark', () => {
    expect(linkFlagGroupKey(group())).toBe('many_accounts https://example.com/a');
    expect(linkFlagGroupKey(group({ reason: 'same_account' }))).not.toBe(linkFlagGroupKey(group()));
    expect(linkFlagGroupKey(group({ review: REVIEW }))).toBe(REVIEW.id);
  });

  it('names the two outcomes as the owner did, and who marked a group and when', () => {
    expect(LINK_FLAG_REVIEW_OUTCOMES.map(linkFlagOutcomeLabel)).toEqual(['문제 없음', '조치함']);
    expect(linkFlagReviewedBy(REVIEW)).toBe('확인 2026. 10. 21. 오후 4:30 · 운영자 운영팀장');
    // An operator who closed the account since (#140, once the role was revoked) has no nickname.
    expect(linkFlagReviewedBy({ ...REVIEW, admin: { userId: 'a1', nickname: null } })).toBe(
      `확인 2026. 10. 21. 오후 4:30 · 운영자 ${copy.postAuthorFormer}`,
    );
  });

  it('names an entry’s author, and a member who closed the account as every byline does (#140)', () => {
    expect(linkFlagAuthorName(flag())).toBe('근거왕');
    expect(
      linkFlagAuthorName(
        flag({ author: { userId: 'u1', publicId: 'k7m2p9qx4z', nickname: null } }),
      ),
    ).toBe(copy.postAuthorFormer);
    expect(copy.postAuthorFormer).toBe('탈퇴한 사용자');
  });

  it('sends the row’s link, rule and latest time with the outcome, the note only when written, and the admin on screen', () => {
    expect(toLinkFlagReviewBody(group(), 'no_issue', '   ', 'admin-1')).toEqual({
      url: 'https://example.com/a',
      reason: 'many_accounts',
      outcome: 'no_issue',
      through: '2026-10-21T06:00:00.000Z',
      // ADR-0092: the server refuses a mark made under another account's cookie.
      expectedAccountId: 'admin-1',
    });
    expect(toLinkFlagReviewBody(group(), 'actioned', '  숨김 처리 \n', 'admin-1')).toMatchObject({
      outcome: 'actioned',
      note: '숨김 처리',
    });
    expect(LINK_FLAG_NOTE_MAX_LENGTH).toBe(500);
  });

  it('says a mark found nothing left to mark, and any other refusal as the common error', () => {
    const gone = new ApiError(404, { code: 'NOT_FOUND', message: 'gone' });
    expect(linkFlagReviewErrorMessage(gone)).toBe(copy.adminLinkFlagReviewGone);
    expect(
      linkFlagReviewErrorMessage(new ApiError(400, { code: 'VALIDATION_ERROR', message: 'x' })),
    ).toBe(copy.errUnknown);
    expect(linkFlagReviewErrorMessage(new Error('network'))).toBe(copy.errUnknown);
  });

  it('says the session changed when the cookie is another account’s, and closes the dialog (ADR-0092)', () => {
    const another = new ApiError(403, {
      code: 'FORBIDDEN',
      message: 'This session belongs to a different account than the one on screen',
      details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
    });
    expect(linkFlagReviewErrorMessage(another)).toBe(copy.sessionChanged);
    expect(linkFlagReviewKeepsDialog(another)).toBe(false);
    // A plain FORBIDDEN (no longer an admin) stays the common error.
    expect(linkFlagReviewErrorMessage(new ApiError(403, { code: 'FORBIDDEN', message: 'x' }))).toBe(
      copy.errUnknown,
    );
  });

  it('keeps the dialog, outcome and note, only when the request never came back', () => {
    // Nothing was decided: the operator sends it again.
    expect(linkFlagReviewKeepsDialog(new TypeError('Failed to fetch'))).toBe(true);
    expect(linkFlagReviewKeepsDialog(new Error('network'))).toBe(true);
    // An answer from the API closes it, and the lists are read again.
    for (const answer of [
      new ApiError(404, { code: 'NOT_FOUND', message: 'gone' }),
      new ApiError(400, { code: 'VALIDATION_ERROR', message: 'x' }),
      new ApiError(429, { code: 'RATE_LIMITED', message: 'slow down' }),
      new ApiError(500, { code: 'INTERNAL', message: 'boom' }),
      new ApiError(500, undefined),
    ]) {
      expect(linkFlagReviewKeepsDialog(answer)).toBe(false);
    }
  });

  it('names a row’s buttons after its rule and link, then what they say', () => {
    expect(linkFlagGroupActionLabel(group(), copy.adminLinkFlagShowItems)).toBe(
      `${copy.adminLinkFlagManyAccounts} https://example.com/a ${copy.adminLinkFlagShowItems}`,
    );
    expect(
      linkFlagGroupActionLabel(group({ reason: 'same_account' }), copy.adminLinkFlagReview),
    ).toBe(`${copy.adminLinkFlagSameAccount} https://example.com/a ${copy.adminLinkFlagReview}`);
    // Two rows of one link differ by their rule, two of one rule by their link.
    expect(linkFlagGroupActionLabel(group({ url: 'https://example.com/b' }), 'x')).not.toBe(
      linkFlagGroupActionLabel(group(), 'x'),
    );
  });
});
