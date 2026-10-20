import { describe, expect, it } from 'vitest';
import {
  authoredCommentSchema,
  commentedPostSchema,
  hiddenNoticeSchema,
  myCommentSchema,
  myPostSchema,
} from './authored.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import { postSummarySchema } from './post.js';

const ID = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
const OTHER = '1c7a7b4f-3d2e-4d9f-8a1b-2c3d4e5f6071';
const AT = '2026-10-20T01:02:03.000Z';
const AUTHOR = {
  kind: 'member',
  publicId: 'abcdefghjk',
  nickname: '예측가',
  imageUrl: null,
  isAdmin: false,
} as const;
const MARKET = {
  id: OTHER,
  slug: 'rate-cut',
  title: '금리 인하',
  status: 'settled',
  category: { slug: 'economy', nameKo: '경제' },
} as const;
const CARD = {
  id: ID,
  title: '근거',
  excerpt: '첫 줄',
  thumbnailUrl: null,
  author: AUTHOR,
  market: MARKET,
  createdAt: AT,
  editedAt: null,
  commentCount: 2,
  likeCount: 3,
};
const COMMENT = {
  id: ID,
  parentId: null,
  body: '댓글',
  author: AUTHOR,
  createdAt: AT,
  editedAt: null,
  likeCount: 0,
  post: { state: 'published', id: OTHER, title: null, excerpt: '글의 첫 줄' },
  market: MARKET,
};

describe('commentedPostSchema', () => {
  it('names a published post by its title and text, and a placeholder by its id alone', () => {
    expect(
      commentedPostSchema.parse({ state: 'published', id: ID, title: '근거', excerpt: '첫 줄' }),
    ).toEqual({ state: 'published', id: ID, title: '근거', excerpt: '첫 줄' });
    // A placeholder carries no word of the post (#45-5): extra keys are stripped.
    for (const state of ['deleted', 'hidden'] as const) {
      expect(
        commentedPostSchema.parse({ state, id: ID, title: '숨긴 제목', excerpt: 'x' }),
      ).toEqual({ state, id: ID });
    }
    expect(commentedPostSchema.safeParse({ state: 'gone', id: ID }).success).toBe(false);
  });
});

describe('authoredCommentSchema', () => {
  it('is the comment as its post page shows it, with the post and the market it leads to', () => {
    expect(authoredCommentSchema.parse(COMMENT)).toEqual(COMMENT);
    expect(Object.keys(authoredCommentSchema.shape)).toEqual([
      'id',
      'parentId',
      'body',
      'author',
      'createdAt',
      'editedAt',
      'likeCount',
      'post',
      'market',
    ]);
    expect(authoredCommentSchema.parse({ ...COMMENT, parentId: OTHER }).parentId).toBe(OTHER);
  });
});

describe('MY 내 글 (#45-5, #51)', () => {
  it('is the public item and a hiding’s notice, null while the item is not hidden', () => {
    expect(myPostSchema.parse({ ...CARD, hidden: null })).toEqual({ ...CARD, hidden: null });
    expect(myPostSchema.parse({ ...CARD, hidden: { reason: null } }).hidden).toEqual({
      reason: null,
    });
    expect(myCommentSchema.parse({ ...COMMENT, hidden: { reason: '스팸' } }).hidden).toEqual({
      reason: '스팸',
    });
    // `hidden` is required: an item says whether it is hidden.
    expect(myPostSchema.safeParse(CARD).success).toBe(false);
    expect(myCommentSchema.safeParse(COMMENT).success).toBe(false);
    // The card is the community list's, so every field of it is there.
    expect(Object.keys(myPostSchema.shape)).toEqual([
      ...Object.keys(postSummarySchema.shape),
      'hidden',
    ]);
    // Nothing of the operator or a report rides on the notice (#45-13).
    expect(Object.keys(hiddenNoticeSchema.shape)).toEqual(['reason']);
  });

  it('keeps the hiding to the member: PRIVATE_DATA names it, the public items do not (ADR-0080)', () => {
    expect(findPrivateField('hidden').map((hit) => hit.item)).toEqual(['moderation']);
    for (const name of [
      ...Object.keys(authoredCommentSchema.shape),
      ...Object.keys(postSummarySchema.shape),
      'state',
      'title',
      'excerpt',
    ]) {
      expect(findPrivateField(name), name).toEqual([]);
    }
  });

  it('names no excluded feature: counts beside an item, never a score (N05 §2, D5)', () => {
    for (const name of [
      ...Object.keys(myCommentSchema.shape),
      ...Object.keys(myPostSchema.shape),
      'AuthoredComment',
      'CommentedPost',
      'MyPost',
      'MyComment',
      'HiddenNotice',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
    }
  });
});
