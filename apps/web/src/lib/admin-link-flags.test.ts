import {
  LINK_FLAG_REASONS,
  LINK_REPEAT_THRESHOLD,
  LINK_REPEAT_WINDOW_SECONDS,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  linkFlagFlaggedAt,
  linkFlagItemPath,
  linkFlagKindLabel,
  linkFlagReasonLabel,
  linkFlagStates,
  linkFlagWrittenAt,
} from './admin-link-flags';
import { type AdminLinkFlag } from './api';
import { postPath } from './posts';

/** 반복 링크 검토 목록 (#187, ADR-0083) as the admin screen words it. */

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
    // The screen's own explanation says both rules, the window, and what is not counted.
    for (const words of ['24시간', '3개 이상', '3명 이상', '공식 출처', '운영자의 글', '그대로']) {
      expect(copy.adminLinkFlagsIntro).toContain(words);
    }
  });

  it('says what carries the link and where to read it: the post’s page for a comment too', () => {
    expect(linkFlagKindLabel('post')).toBe(copy.adminLinkFlagPost);
    expect(linkFlagKindLabel('comment')).toBe(copy.adminLinkFlagComment);
    expect(linkFlagItemPath(flag().target)).toBe(postPath(POST));
    expect(linkFlagItemPath(flag({ kind: 'comment', commentId: COMMENT }).target)).toBe(
      postPath(POST),
    );
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
