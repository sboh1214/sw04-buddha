import { POST_EXCERPT_MAX_LENGTH, REPORT_REASONS } from '@buddha/shared';
import { hashKey, partialMatchKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { PostAuthor } from './api';
import {
  AUTHORED_KEY,
  AUTHORED_TABS,
  MY_AUTHORED_KEY,
  authoredEmptyMessage,
  authoredPagesWithAuthorImage,
  authoredRows,
  authoredTabOf,
  authoredTabSearch,
  commentKindLabel,
  commentedPostText,
  hiddenDeleteName,
  hiddenItemName,
  hiddenNoticeView,
  myAuthoredKey,
  profileAuthoredKey,
  reportReasonLabel,
  returnsToDrawnPage,
  withoutAuthoredItem,
} from './authored';
import { isPrivateQueryKey } from './market-keys';

/**
 * 작성자별 글·댓글 (#51, ADR-0080): the tabs, the keys and what a list draws, as the profile and MY
 * '내 글' share them. The owner's part (ADR-0069): two tabs, 글 and 댓글, newest first and nothing
 * else to pick; MY marks a hidden item '숨김' with its reason, for the member alone.
 */

const POST = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';

describe('the tabs', () => {
  it('are 글 then 댓글, the owner’s two (#37-14, decision 4 #51)', () => {
    expect(AUTHORED_TABS.map((tab) => [tab.key, tab.label])).toEqual([
      ['posts', '글'],
      ['comments', '댓글'],
    ]);
  });

  it('read 댓글 from `?tab=comments` alone and 글 from anything else', () => {
    expect(authoredTabOf('comments')).toBe('comments');
    for (const param of [null, undefined, '', 'posts', 'Comments', 'comment', 'likes']) {
      expect(authoredTabOf(param), String(param)).toBe('posts');
    }
  });

  it('write the tab into the address, leaving it out for 글 and keeping every other parameter', () => {
    expect(authoredTabSearch('', 'comments')).toBe('?tab=comments');
    expect(authoredTabSearch('?tab=comments', 'posts')).toBe('');
    expect(authoredTabSearch('?a=1&tab=comments', 'posts')).toBe('?a=1');
    expect(authoredTabSearch('?a=1', 'comments')).toBe('?a=1&tab=comments');
    expect(authoredTabSearch('?tab=junk', 'comments')).toBe('?tab=comments');
  });
});

describe('the keys', () => {
  it('keep MY’s lists private and a profile’s public', () => {
    // MY '내 글' carries the hidden items and their reasons (#45-5: the member's alone), so it is
    // never fetched on the server or dehydrated; a profile's lists are the same for every reader.
    expect(isPrivateQueryKey(MY_AUTHORED_KEY)).toBe(true);
    expect(isPrivateQueryKey(myAuthoredKey('posts'))).toBe(true);
    expect(isPrivateQueryKey(myAuthoredKey('comments'))).toBe(true);
    expect(isPrivateQueryKey(profileAuthoredKey('k7m2p9qx4z', 'posts'))).toBe(false);
  });

  it('find a member by the public id lower-cased, one entry per tab', () => {
    expect(profileAuthoredKey('K7M2P9QX4Z', 'posts')).toEqual(['authored', 'k7m2p9qx4z', 'posts']);
    expect(hashKey(profileAuthoredKey('K7M2P9QX4Z', 'comments'))).toBe(
      hashKey(profileAuthoredKey('k7m2p9qx4z', 'comments')),
    );
    expect(hashKey(myAuthoredKey('posts'))).not.toBe(hashKey(myAuthoredKey('comments')));
  });

  it('never match each other’s prefix', () => {
    // react-query compares keys element-wise: an invalidation of one root never reaches the other.
    expect(partialMatchKey(profileAuthoredKey('k7m2p9qx4z', 'posts'), MY_AUTHORED_KEY)).toBe(false);
    expect(partialMatchKey(myAuthoredKey('posts'), AUTHORED_KEY)).toBe(false);
  });
});

describe('what a list draws', () => {
  const pages = [{ items: [1, 2] }, { items: [3, 4] }];

  it('is every row with 더 보기 while there is a next page', () => {
    expect(authoredRows(pages, true, undefined)).toEqual({ rows: [1, 2, 3, 4], more: true });
    expect(authoredRows(pages, false, undefined)).toEqual({ rows: [1, 2, 3, 4], more: false });
    expect(authoredRows(undefined, false, undefined)).toEqual({ rows: [], more: false });
  });

  it('is the newest few and never 더 보기 on MY’s summary, whose way on is 전체 보기', () => {
    expect(authoredRows(pages, true, 3)).toEqual({ rows: [1, 2, 3], more: false });
    expect(authoredRows([{ items: [1] }], true, 3)).toEqual({ rows: [1], more: false });
  });

  it('says what each tab lacks when it is empty', () => {
    expect(authoredEmptyMessage('posts')).toBe(copy.authoredPostsEmpty);
    expect(authoredEmptyMessage('comments')).toBe(copy.authoredCommentsEmpty);
  });
});

describe('a listed comment', () => {
  it('is a 댓글, or a 답글 — the post page’s word for a 대댓글', () => {
    expect(commentKindLabel(null)).toBe('댓글');
    expect(commentKindLabel(POST)).toBe('답글');
    expect(copy.authoredReplyKind).toBe(copy.commentReply);
  });

  it('names its post by the title, or by the first line of its text when it has none', () => {
    expect(
      commentedPostText({ state: 'published', id: POST, title: '금리 근거', excerpt: '본문' }),
    ).toBe('금리 근거');
    expect(
      commentedPostText({ state: 'published', id: POST, title: null, excerpt: '첫 줄\n둘째 줄' }),
    ).toBe('첫 줄');
  });

  it('names a deleted or hidden post by its placeholder’s words alone (#45-5)', () => {
    expect(commentedPostText({ state: 'deleted', id: POST })).toBe(copy.postDeletedPlaceholder);
    expect(commentedPostText({ state: 'hidden', id: POST })).toBe(copy.postHiddenPlaceholder);
  });
});

describe('MY’s 숨김 line (#45-5)', () => {
  it('marks a hidden item and says the report reason the hiding carries (owner decision 2026-10-22)', () => {
    expect(hiddenNoticeView({ reason: { code: 'spam', note: null } })).toEqual({
      mark: '숨김',
      reason: `${copy.authoredHiddenReason}: 스팸`,
      note: null,
    });
  });

  it('adds the operator’s explanation on its own line when there is one', () => {
    expect(
      hiddenNoticeView({
        reason: { code: 'off_topic', note: '  이 시장과 상관없는 광고입니다.\n' },
      }),
    ).toEqual({
      mark: '숨김',
      reason: `${copy.authoredHiddenReason}: 시장과 무관`,
      note: `${copy.authoredHiddenNote}: 이 시장과 상관없는 광고입니다.`,
    });
    // A blank note says nothing.
    expect(hiddenNoticeView({ reason: { code: 'other', note: '   ' } }).note).toBeNull();
  });

  it('is the mark alone until a hiding records a reason (#50)', () => {
    expect(hiddenNoticeView({ reason: null })).toEqual({ mark: '숨김', reason: null, note: null });
  });

  it('names every report reason by the owner’s words, each its own (#45-10)', () => {
    expect(REPORT_REASONS.map(reportReasonLabel)).toEqual([
      '스팸',
      '괴롭힘',
      '개인정보 노출',
      '사칭',
      '공모·조작 유도',
      '시장과 무관',
      '권리 침해',
      '기타',
    ]);
  });
});

describe('MY’s 삭제 on a hidden item (owner decision 2026-10-22)', () => {
  it('takes the item out of whichever page held it, every other row and cursor kept', () => {
    const data = {
      pages: [
        { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' },
        { items: [{ id: 'c' }], nextCursor: null },
      ],
      pageParams: [undefined, 'c1'],
    };
    expect(withoutAuthoredItem(data, 'b')).toEqual({
      pages: [
        { items: [{ id: 'a' }], nextCursor: 'c1' },
        { items: [{ id: 'c' }], nextCursor: null },
      ],
      pageParams: [undefined, 'c1'],
    });
    expect(withoutAuthoredItem(data, 'z')).toEqual(data);
    expect(withoutAuthoredItem(undefined, 'a')).toBeUndefined();
  });

  it('names the hidden item its 삭제 deletes: a post by its title or first line, a comment by its own first line (owner decision 2026-10-22, 3rd)', () => {
    // A post as its card's heading names it: the title, or the first line of its text.
    expect(hiddenItemName({ tab: 'posts', title: '금리 전망', excerpt: '본문' })).toBe('금리 전망');
    expect(hiddenItemName({ tab: 'posts', title: null, excerpt: '첫 줄\n둘째 줄' })).toBe('첫 줄');
    // A comment (a 대댓글 too) by the first non-empty line of its own text, trimmed.
    expect(hiddenItemName({ tab: 'comments', body: '\n  첫 댓글  \n더' })).toBe('첫 댓글');
    // Never its post's: two comments under one post are named apart.
    expect(hiddenItemName({ tab: 'comments', body: '둘째 댓글' })).not.toBe(
      hiddenItemName({ tab: 'comments', body: '첫 댓글' }),
    );
  });

  it('names an item whose first line is longer by its first 300 characters and an ellipsis (owner decision 2026-10-22, 4th; ADR-0080 7-19)', () => {
    // The cap the dialog's line and the button's name keep to, and what the ADR says it is.
    expect(POST_EXCERPT_MAX_LENGTH).toBe(300);
    // A comment can be 1,000 characters on one line (#45-3): its first 300, cut where they end and
    // marked as cut, without the rest of the line or the lines after it.
    const line = `${'가'.repeat(150)}${'a'.repeat(850)}`;
    expect(hiddenItemName({ tab: 'comments', body: `${line}\n둘째 줄` })).toBe(
      `${line.slice(0, 300)}…`,
    );
    expect(hiddenDeleteName({ tab: 'comments', body: line })).toBe(
      `${line.slice(0, 300)}… ${copy.commentDelete}`,
    );
    // Counted in code points, as a comment's length is: an emoji is one.
    expect(hiddenItemName({ tab: 'comments', body: '😀'.repeat(400) })).toBe(
      `${'😀'.repeat(300)}…`,
    );
    // The mark only where a cut is: a first line of 300 or fewer is whole and bare, however long
    // the lines after it.
    expect(
      hiddenItemName({ tab: 'comments', body: `${'a'.repeat(300)}\n${'b'.repeat(900)}` }),
    ).toBe('a'.repeat(300));
    expect(hiddenItemName({ tab: 'comments', body: `짧은 줄\n${'b'.repeat(900)}` })).toBe(
      '짧은 줄',
    );
    // A cut just after a space ends at the word before it, the mark beside it.
    expect(hiddenItemName({ tab: 'comments', body: `${'a'.repeat(299)} ${'b'.repeat(9)}` })).toBe(
      `${'a'.repeat(299)}…`,
    );
    // An untitled post's excerpt comes cut to the same 300 from the server, the web cuts no shorter:
    // one that reaches the cap on one line was cut there, one with a line break or shorter was not.
    expect(hiddenItemName({ tab: 'posts', title: null, excerpt: 'a'.repeat(300) })).toBe(
      `${'a'.repeat(300)}…`,
    );
    expect(hiddenDeleteName({ tab: 'posts', title: null, excerpt: 'a'.repeat(300) })).toBe(
      `${'a'.repeat(300)}… ${copy.postDelete}`,
    );
    expect(
      hiddenItemName({
        tab: 'posts',
        title: null,
        excerpt: `${'a'.repeat(200)}\n${'b'.repeat(99)}`,
      }),
    ).toBe('a'.repeat(200));
    expect(hiddenItemName({ tab: 'posts', title: null, excerpt: 'a'.repeat(299) })).toBe(
      'a'.repeat(299),
    );
    // A title is never cut (at most 100 characters), however long the text under it.
    expect(hiddenItemName({ tab: 'posts', title: '금리 전망', excerpt: 'a'.repeat(300) })).toBe(
      '금리 전망',
    );
  });

  it('cuts a long first line between two characters as they are seen, never inside an emoji (owner decision 2026-10-22, 4th)', () => {
    // Four people joined by three ZWJs: seven code points, one character on screen.
    const family = '👨‍👩‍👧‍👦';
    expect([...family]).toHaveLength(7);
    // 298 + 7 is past 300: the family is left out whole, not cut after its first person or two.
    expect(
      hiddenItemName({ tab: 'comments', body: `${'a'.repeat(298)}${family}${'b'.repeat(10)}` }),
    ).toBe(`${'a'.repeat(298)}…`);
    // 293 + 7 is 300: the family ends within the cap and stays whole.
    expect(
      hiddenItemName({ tab: 'comments', body: `${'a'.repeat(293)}${family}${'b'.repeat(10)}` }),
    ).toBe(`${'a'.repeat(293)}${family}…`);
    // A flag's pair of regional indicators, and a letter with its combining mark, likewise.
    expect(hiddenItemName({ tab: 'comments', body: `${'a'.repeat(299)}🇰🇷b` })).toBe(
      `${'a'.repeat(299)}…`,
    );
    expect(hiddenItemName({ tab: 'comments', body: `${'a'.repeat(299)}e\u0301b` })).toBe(
      `${'a'.repeat(299)}…`,
    );
    // An emoji outside the basic plane is one code point in two UTF-16 units, never split.
    expect(hiddenItemName({ tab: 'comments', body: `${'a'.repeat(299)}😀😀` })).toBe(
      `${'a'.repeat(299)}😀…`,
    );
  });

  it('names each 삭제 by its item, ending with the word on screen (ADR-0080 7-19)', () => {
    expect(hiddenDeleteName({ tab: 'posts', title: '금리 전망', excerpt: '본문' })).toBe(
      `금리 전망 ${copy.postDelete}`,
    );
    expect(hiddenDeleteName({ tab: 'posts', title: null, excerpt: '첫 줄\n둘째 줄' })).toBe(
      `첫 줄 ${copy.postDelete}`,
    );
    expect(hiddenDeleteName({ tab: 'comments', body: '\n  첫 댓글  \n더' })).toBe(
      `첫 댓글 ${copy.commentDelete}`,
    );
    // The name is the item the dialog shows, then the word: one naming for both (3rd answer).
    for (const item of [
      { tab: 'posts', title: null, excerpt: '첫 줄\n둘째 줄' },
      { tab: 'comments', body: '대댓글 첫 줄\n둘째 줄' },
    ] as const) {
      expect(hiddenDeleteName(item).startsWith(`${hiddenItemName(item)} `)).toBe(true);
    }
  });
});

describe('a member’s new profile image on the lists held (#141; ADR-0080 7-24)', () => {
  const OWN = 'k7m2p9q4r1';
  const face = (publicId: string, imageUrl: string | null): PostAuthor => ({
    kind: 'member',
    publicId,
    nickname: publicId === OWN ? '근거왕' : '반론왕',
    imageUrl,
    isAdmin: false,
  });
  const OLD = '/api/v1/media/3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const NEW = '/api/v1/media/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

  it('goes on every row of the member’s, a card or a comment alike, the rest of each row, page and cursor as they were', () => {
    const other = { id: 'c', author: face('a2b3c4d5e6', NEW), hidden: null };
    const held = {
      pages: [
        {
          items: [
            { id: 'a', author: face(OWN, OLD), hidden: null },
            { id: 'b', author: face(OWN, OLD), parentId: 'a', hidden: { reason: null } },
          ],
          nextCursor: 'c1',
        },
        { items: [other], nextCursor: null },
      ],
      pageParams: [undefined, 'c1'],
    };
    const next = authoredPagesWithAuthorImage(held, OWN, NEW);
    expect(next.pages[0]?.items).toEqual([
      { id: 'a', author: face(OWN, NEW), hidden: null },
      { id: 'b', author: face(OWN, NEW), parentId: 'a', hidden: { reason: null } },
    ]);
    expect(next.pages[0]?.nextCursor).toBe('c1');
    expect(next.pageParams).toEqual([undefined, 'c1']);
    // A page with none of the member's rows is the very page held.
    expect(next.pages[1]).toBe(held.pages[1]);
    // Deleted: null, the nickname's first letter.
    expect(
      authoredPagesWithAuthorImage(next, OWN, null).pages[0]?.items.map((row) => row.author),
    ).toEqual([face(OWN, null), face(OWN, null)]);
  });

  it('is the pages held when nothing changes: another member’s list, a withdrawn author, a face already there', () => {
    const held = {
      pages: [
        {
          items: [
            { id: 'a', author: face('a2b3c4d5e6', OLD) },
            { id: 'b', author: { kind: 'former_member' } as PostAuthor },
            { id: 'c', author: face(OWN, NEW) },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    };
    expect(authoredPagesWithAuthorImage(held, OWN, NEW)).toBe(held);
  });
});

describe('a profile page returned to (ADR-0080 7-16)', () => {
  it('is one already drawn in this document: Back or Forward brings the same page instance', () => {
    // Next's `bfcacheId`: '_b_0_' for the page the document hydrated, a new one per page opened.
    const drawn = new Set<string>();
    expect(returnsToDrawnPage(drawn, '_b_0_')).toBe(false); // the page the document opened on
    expect(returnsToDrawnPage(drawn, '_b_4_')).toBe(false); // another profile, opened by a link
    expect(returnsToDrawnPage(drawn, '_b_0_')).toBe(true); // Back to the first: drawn again
    expect(returnsToDrawnPage(drawn, '_b_4_')).toBe(true); // Forward to the second
    expect(returnsToDrawnPage(drawn, '_b_9_')).toBe(false); // the first profile opened afresh
  });
});
