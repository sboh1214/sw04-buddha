import {
  MODERATION_ACTION_TAKEN_NOTIFICATION,
  MODERATION_ACTION_TYPES,
  MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION,
  type ModerationActionType,
  NOTIFICATION_PARAM_STRING_MAX,
  NOTIFICATION_TYPE_REGISTRY,
  PROPOSAL_DECIDED_NOTIFICATION,
  RESTRICTION_ACTION_TYPES,
  findExcludedText,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_RENDERERS } from '@/components/notifications/notification-renderers';
import { copy } from '@/copy';
import type { PostAuthor } from './api';
import {
  commentRepliedTitle,
  moderationCancelledTitle,
  moderationTakenHasTerm,
  moderationTakenTitle,
  postRepliedTitle,
  proposalDecidedTitle,
  restrictionEndChangedTitle,
} from './community-notifications';
import { formatKst } from './datetime';
import { notificationTextKeys } from './trade-notifications';

/** The six types of #135 (ADR-0161), in NOTIFICATION_DEFINITIONS' order. */
const COMMUNITY_TYPES = [
  'post_replied',
  'comment_replied',
  'moderation_action_taken',
  'moderation_action_cancelled',
  'moderation_restriction_end_changed',
  'proposal_decided',
] as const;

/** 2026-09-08 15:00 and 2026-09-01 15:00 in Seoul, the owner's examples' times (135-5). */
const ENDS_AT = '2026-09-08T06:00:00.000Z';
const SHORTENED_TO = '2026-09-01T06:00:00.000Z';

/** A `format` that shows what it was handed: the title holds the caller's formatting. */
const marked = (iso: string) => `<${iso}>`;

/** A `format` a title with no time must never call. */
const untimed = () => {
  throw new Error('formatted a time that is not drawn');
};

const member = (nickname: string, isAdmin = false): PostAuthor => ({
  kind: 'member',
  publicId: 'k7m2p9qx4z',
  nickname,
  imageUrl: null,
  isAdmin,
});
const FORMER: PostAuthor = { kind: 'former_member' };

/** Each action's word as MY 조치·신고 내역 names it. */
const ACTION_WORDS: Readonly<Record<ModerationActionType, string>> = {
  hide: '숨김',
  warning: '경고',
  nickname_reset: '닉네임 강제 변경',
  bio_clear: '소개 비우기',
  image_remove: '프로필 이미지 삭제',
  writing_restriction: '작성 제한',
  account_restriction: '계정 제한',
};

/**
 * 커뮤니티 알림's words (#135, ADR-0161; owner answers 135-5 — the table and readings (a)–(h) as
 * shown —, 135-6 a restriction's own end, 52-15 the reply's author): each type's title from the
 * params its definition stores and the row's `replyAuthor`, filled into copy.ts' templates.
 */
describe('the sentences (135-5)', () => {
  it('are the owner’s, word for word', () => {
    expect([
      copy.notificationPostReplied,
      copy.notificationPostRepliedMerged,
      copy.notificationPostRepliedNoAuthor,
      copy.notificationPostRepliedMergedNoAuthor,
      copy.notificationCommentReplied,
      copy.notificationCommentRepliedMerged,
      copy.notificationCommentRepliedNoAuthor,
      copy.notificationCommentRepliedMergedNoAuthor,
      copy.notificationReplyAuthorAdmin,
      copy.notificationModerationTaken,
      copy.notificationModerationTakenTerm,
      copy.notificationModerationCancelled,
      copy.notificationRestrictionShortened,
      copy.notificationRestrictionLifted,
      copy.notificationProposalDecided,
    ]).toEqual([
      '내 글에 새 댓글 · {author}',
      '내 글에 새 댓글 {count}개 · 마지막: {author}',
      '내 글에 새 댓글',
      '내 글에 새 댓글 {count}개',
      '내 댓글에 새 답글 · {author}',
      '내 댓글에 새 답글 {count}개 · 마지막: {author}',
      '내 댓글에 새 답글',
      '내 댓글에 새 답글 {count}개',
      '{nickname}(운영자)',
      '운영 조치: {action}',
      '운영 조치: {action} · {term}',
      '운영 조치 취소: {action}',
      '운영 조치 감경: {action} · {term}',
      '운영 조치 조기 해제: {action}',
      '시장 제안 {decision} · {question}',
    ]);
  });

  it('say the owner’s examples', () => {
    expect(postRepliedTitle(1, member('첫눈러버'))).toBe('내 글에 새 댓글 · 첫눈러버');
    expect(postRepliedTitle(3, member('눈사람'))).toBe('내 글에 새 댓글 3개 · 마지막: 눈사람');
    expect(commentRepliedTitle(1, member('운영팀장', true))).toBe(
      '내 댓글에 새 답글 · 운영팀장(운영자)',
    );
    expect(commentRepliedTitle(2, null)).toBe('내 댓글에 새 답글 2개');
    expect(postRepliedTitle(1, FORMER)).toBe('내 글에 새 댓글 · 탈퇴한 사용자');
    expect(moderationTakenTitle({ action: 'hide', endsAt: null }, untimed)).toBe('운영 조치: 숨김');
    expect(moderationTakenTitle({ action: 'warning', endsAt: null }, untimed)).toBe(
      '운영 조치: 경고',
    );
    expect(
      moderationTakenTitle({ action: 'writing_restriction', endsAt: ENDS_AT }, formatKst),
    ).toBe('운영 조치: 작성 제한 · 2026. 9. 8. 오후 3:00까지');
    expect(moderationTakenTitle({ action: 'account_restriction', endsAt: null }, untimed)).toBe(
      '운영 조치: 계정 제한 · 무기한',
    );
    expect(moderationCancelledTitle({ action: 'hide' })).toBe('운영 조치 취소: 숨김');
    expect(
      restrictionEndChangedTitle(
        { action: 'writing_restriction', change: 'shorten', endsAt: SHORTENED_TO },
        formatKst,
      ),
    ).toBe('운영 조치 감경: 작성 제한 · 2026. 9. 1. 오후 3:00까지');
    expect(
      restrictionEndChangedTitle(
        { action: 'account_restriction', change: 'lift', endsAt: SHORTENED_TO },
        untimed,
      ),
    ).toBe('운영 조치 조기 해제: 계정 제한');
    expect(proposalDecidedTitle({ decision: 'adopted', question: '첫눈이 서울에 올까?' })).toBe(
      '시장 제안 채택 · 첫눈이 서울에 올까?',
    );
    expect(proposalDecidedTitle({ decision: 'rejected', question: '첫눈이 서울에 올까?' })).toBe(
      '시장 제안 반려 · 첫눈이 서울에 올까?',
    );
  });
});

describe('a reply notice (52-7, 52-15, 135-4, 135-5 (a)–(d))', () => {
  it('counts the merged replies and names the latest one’s author, both types alike', () => {
    for (const [title, head] of [
      [postRepliedTitle, '내 글에 새 댓글'],
      [commentRepliedTitle, '내 댓글에 새 답글'],
    ] as const) {
      expect(title(1, member('눈사람'))).toBe(`${head} · 눈사람`);
      expect(title(2, member('눈사람'))).toBe(`${head} 2개 · 마지막: 눈사람`);
      expect(title(120, member('눈사람'))).toBe(`${head} 120개 · 마지막: 눈사람`);
      // A count past a thousand is grouped as every count of the inbox is.
      expect(title(1_200, member('눈사람'))).toBe(`${head} 1,200개 · 마지막: 눈사람`);
    }
  });

  it('names no one when the latest reply is hidden or deleted — null, or no key at all', () => {
    for (const author of [null, undefined]) {
      expect(postRepliedTitle(1, author)).toBe('내 글에 새 댓글');
      expect(postRepliedTitle(3, author)).toBe('내 글에 새 댓글 3개');
      expect(commentRepliedTitle(1, author)).toBe('내 댓글에 새 답글');
      expect(commentRepliedTitle(2, author)).toBe('내 댓글에 새 답글 2개');
    }
  });

  it('tags an admin’s reply (운영자, #45-9) and names a closed account 탈퇴한 사용자 (ADR-0086)', () => {
    expect(postRepliedTitle(1, member('운영팀장', true))).toBe(
      '내 글에 새 댓글 · 운영팀장(운영자)',
    );
    expect(postRepliedTitle(4, member('운영팀장', true))).toBe(
      '내 글에 새 댓글 4개 · 마지막: 운영팀장(운영자)',
    );
    expect(commentRepliedTitle(2, FORMER)).toBe('내 댓글에 새 답글 2개 · 마지막: 탈퇴한 사용자');
    // A former member is never tagged, whatever it was.
    expect(commentRepliedTitle(1, FORMER)).not.toContain('운영자');
    expect(copy.postAuthorFormer).toBe('탈퇴한 사용자');
  });

  it('writes a nickname as it is, braces, dollar signs and astral letters included', () => {
    for (const nickname of ['{x}', '{author}', '$&', "$1 $$ $` $'", '{{x}}', '𝔸눈🙂']) {
      expect(postRepliedTitle(1, member(nickname))).toBe(`내 글에 새 댓글 · ${nickname}`);
      expect(commentRepliedTitle(3, member(nickname, true))).toBe(
        `내 댓글에 새 답글 3개 · 마지막: ${nickname}(운영자)`,
      );
    }
  });

  it('carries no post or market title and no reply body (135-4, 135-5 (d))', () => {
    // The titles take only the count and the author: nothing else can reach the sentence.
    expect(postRepliedTitle.length).toBe(2);
    expect(commentRepliedTitle.length).toBe(2);
    for (const template of [
      copy.notificationPostReplied,
      copy.notificationPostRepliedMerged,
      copy.notificationCommentReplied,
      copy.notificationCommentRepliedMerged,
    ]) {
      expect(notificationTextKeys(template).every((key) => ['author', 'count'].includes(key))).toBe(
        true,
      );
    }
  });
});

describe('a moderation notice (52-16, 135-2, 135-5 (e)·(f)·(h), 135-6)', () => {
  it('names each of the seven actions as MY 조치·신고 내역 does', () => {
    expect([...MODERATION_ACTION_TYPES].sort()).toEqual(Object.keys(ACTION_WORDS).sort());
    for (const action of MODERATION_ACTION_TYPES) {
      const word = ACTION_WORDS[action];
      expect(moderationCancelledTitle({ action }), action).toBe(`운영 조치 취소: ${word}`);
      const restriction = (RESTRICTION_ACTION_TYPES as readonly string[]).includes(action);
      expect(moderationTakenHasTerm({ action, endsAt: null }), action).toBe(restriction);
      expect(moderationTakenTitle({ action, endsAt: null }, untimed), action).toBe(
        restriction ? `운영 조치: ${word} · 무기한` : `운영 조치: ${word}`,
      );
    }
  });

  it('gives a restriction its own end in the member’s zone, or 무기한 (135-6)', () => {
    for (const action of RESTRICTION_ACTION_TYPES) {
      const word = ACTION_WORDS[action];
      expect(moderationTakenTitle({ action, endsAt: ENDS_AT }, marked)).toBe(
        `운영 조치: ${word} · <${ENDS_AT}>까지`,
      );
      expect(moderationTakenTitle({ action, endsAt: null }, untimed)).toBe(
        `운영 조치: ${word} · 무기한`,
      );
      expect(
        restrictionEndChangedTitle({ action, change: 'shorten', endsAt: SHORTENED_TO }, marked),
      ).toBe(`운영 조치 감경: ${word} · <${SHORTENED_TO}>까지`);
      // 조기 해제: no time — the row's 발생 시각 is when (135-5 (f)).
      expect(
        restrictionEndChangedTitle({ action, change: 'lift', endsAt: SHORTENED_TO }, untimed),
      ).toBe(`운영 조치 조기 해제: ${word}`);
    }
    // The words of the MY band, the same restrictionTermText.
    expect(copy.restrictionUntil).toBe('까지');
    expect(copy.restrictionIndefinite).toBe('무기한');
  });

  it('says a hide is 숨김 alone — never what was hidden, why, by whom or on whose report', () => {
    const title = moderationTakenTitle({ action: 'hide', endsAt: null }, untimed);
    expect(title).toBe('운영 조치: 숨김');
    for (const text of [
      copy.notificationModerationTaken,
      copy.notificationModerationTakenTerm,
      copy.notificationModerationCancelled,
      copy.notificationRestrictionShortened,
      copy.notificationRestrictionLifted,
    ]) {
      expect(text).not.toMatch(/사유|운영자|관리자|신고|글|댓글|이의/);
      expect(notificationTextKeys(text).every((key) => ['action', 'term'].includes(key))).toBe(
        true,
      );
    }
  });

  it('draws what the definitions store and nothing they refuse', () => {
    // An end only on a restriction (the definition's refine), a change only of a restriction.
    expect(
      MODERATION_ACTION_TAKEN_NOTIFICATION.params.safeParse({ action: 'hide', endsAt: ENDS_AT })
        .success,
    ).toBe(false);
    expect(
      MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION.params.safeParse({
        action: 'warning',
        change: 'shorten',
        endsAt: ENDS_AT,
      }).success,
    ).toBe(false);
  });
});

describe('a proposal’s decision (52-19, 135-5 (g))', () => {
  it('names 채택 and 반려 as MY 내 제안 does and writes the question as stored', () => {
    for (const question of [
      '{x}',
      '{decision} {question}',
      '$&',
      "$1 $$ $` $'",
      '{{x}}',
      '𝔸 첫눈 🙂',
    ]) {
      expect(proposalDecidedTitle({ decision: 'adopted', question })).toBe(
        `시장 제안 채택 · ${question}`,
      );
      expect(proposalDecidedTitle({ decision: 'rejected', question })).toBe(
        `시장 제안 반려 · ${question}`,
      );
    }
  });

  it('writes the question whole at the cap, as its definition takes it', () => {
    const question = '가'.repeat(NOTIFICATION_PARAM_STRING_MAX);
    const parsed = PROPOSAL_DECIDED_NOTIFICATION.params.parse({ decision: 'adopted', question });
    expect(proposalDecidedTitle(parsed)).toBe(`시장 제안 채택 · ${question}`);
    // Never a reason: the decision and the question alone.
    expect(notificationTextKeys(copy.notificationProposalDecided).sort()).toEqual([
      'decision',
      'question',
    ]);
  });
});

describe('the templates (ADR-0158 구현의 선택: single-brace placeholders)', () => {
  it('has each template’s placeholders equal to the keys its title passes', () => {
    const expected: readonly (readonly [string, string[]])[] = [
      [copy.notificationPostReplied, ['author']],
      [copy.notificationPostRepliedMerged, ['count', 'author']],
      [copy.notificationPostRepliedNoAuthor, []],
      [copy.notificationPostRepliedMergedNoAuthor, ['count']],
      [copy.notificationCommentReplied, ['author']],
      [copy.notificationCommentRepliedMerged, ['count', 'author']],
      [copy.notificationCommentRepliedNoAuthor, []],
      [copy.notificationCommentRepliedMergedNoAuthor, ['count']],
      [copy.notificationReplyAuthorAdmin, ['nickname']],
      [copy.notificationModerationTaken, ['action']],
      [copy.notificationModerationTakenTerm, ['action', 'term']],
      [copy.notificationModerationCancelled, ['action']],
      [copy.notificationRestrictionShortened, ['action', 'term']],
      [copy.notificationRestrictionLifted, ['action']],
      [copy.notificationProposalDecided, ['decision', 'question']],
    ];
    for (const [template, keys] of expected) {
      expect(notificationTextKeys(template).sort(), template).toEqual([...keys].sort());
      expect(template, template).not.toContain('{{');
    }
    // Every title above filled its template through fillNotificationText, which throws on a
    // missing or an unknown key — so each passes exactly these.
  });

  it('are the renderers’ copy and the guard registry’s text, word for word (135-5)', () => {
    const replyFill = [copy.notificationReplyAuthorAdmin, copy.postAuthorFormer];
    const actions = Object.values(ACTION_WORDS);
    expect(NOTIFICATION_RENDERERS.post_replied.copy).toEqual([
      copy.notificationPostReplied,
      copy.notificationPostRepliedMerged,
      copy.notificationPostRepliedNoAuthor,
      copy.notificationPostRepliedMergedNoAuthor,
      ...replyFill,
    ]);
    expect(NOTIFICATION_RENDERERS.comment_replied.copy).toEqual([
      copy.notificationCommentReplied,
      copy.notificationCommentRepliedMerged,
      copy.notificationCommentRepliedNoAuthor,
      copy.notificationCommentRepliedMergedNoAuthor,
      ...replyFill,
    ]);
    expect(NOTIFICATION_RENDERERS.moderation_action_taken.copy).toEqual([
      copy.notificationModerationTaken,
      copy.notificationModerationTakenTerm,
      ...actions,
      copy.restrictionUntil,
      copy.restrictionIndefinite,
    ]);
    expect(NOTIFICATION_RENDERERS.moderation_action_cancelled.copy).toEqual([
      copy.notificationModerationCancelled,
      ...actions,
    ]);
    expect(NOTIFICATION_RENDERERS.moderation_restriction_end_changed.copy).toEqual([
      copy.notificationRestrictionShortened,
      copy.notificationRestrictionLifted,
      ACTION_WORDS.writing_restriction,
      ACTION_WORDS.account_restriction,
      copy.restrictionUntil,
    ]);
    expect(NOTIFICATION_RENDERERS.proposal_decided.copy).toEqual([
      copy.notificationProposalDecided,
      '채택',
      '반려',
    ]);
    for (const type of COMMUNITY_TYPES) {
      expect(NOTIFICATION_RENDERERS[type].copy, type).toEqual(
        NOTIFICATION_TYPE_REGISTRY[type].text,
      );
      for (const text of NOTIFICATION_RENDERERS[type].copy) {
        expect(findExcludedText(text), text).toEqual([]);
        expect(text, text).not.toMatch(/배지|badge/i);
        // N05 §2, N04 §4, #135 AC 5: a count is never a score, and no reward near a reply.
        expect(text, text).not.toMatch(
          /점수|순위|랭킹|실력|평판|등급|스코어|보상|보너스|지급|예측|좋아요/,
        );
      }
    }
    // Never the reporter or the operator who acted (#45 13항, 135-2): '운영자' only tags a
    // replier's own nickname.
    for (const type of COMMUNITY_TYPES) {
      for (const text of NOTIFICATION_RENDERERS[type].copy) {
        expect(text, text).not.toMatch(/신고|관리자|처리한/);
        if (text.includes('운영자')) expect(text).toBe('{nickname}(운영자)');
      }
    }
  });
});
