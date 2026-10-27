import { describe, expect, it } from 'vitest';
import {
  IMAGE_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  MEDIA_KINDS,
  ORPHAN_MEDIA_HOURS,
  imageNotAllowedDetailsSchema,
  mediaPath,
  uploadImageQuerySchema,
  uploadedImageSchema,
} from './media.js';
import {
  POST_TITLE_MAX_LENGTH,
  createPostBodySchema,
  deletePostBodySchema,
  postAuthorSchema,
  postDeletionSchema,
  postListQuerySchema,
  postNotEditableDetailsSchema,
  postSchema,
  postSummarySchema,
  postTitleInputSchema,
  updatePostBodySchema,
} from './post.js';
import {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_PATTERN,
  publicIdSchema,
} from './public-id.js';

const MARKET = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
const BODY = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '근거' }] }],
};

describe('a post’s title', () => {
  it('is optional: absent, null and blank are no title', () => {
    for (const title of [undefined, null, '', '   ']) {
      expect(postTitleInputSchema.parse(title)).toBeNull();
    }
  });

  it('is trimmed, one line and at most 100 characters, counted in code points', () => {
    expect(postTitleInputSchema.parse('  금리 전망  ')).toBe('금리 전망');
    expect(postTitleInputSchema.parse('😀'.repeat(POST_TITLE_MAX_LENGTH))).toBe(
      '😀'.repeat(POST_TITLE_MAX_LENGTH),
    );
    for (const title of [
      '가'.repeat(POST_TITLE_MAX_LENGTH + 1),
      '😀'.repeat(POST_TITLE_MAX_LENGTH + 1),
      'a\nb',
      'a\tb',
      'a\u0007b',
    ]) {
      expect(postTitleInputSchema.safeParse(title).success, JSON.stringify(title)).toBe(false);
    }
  });

  it('turns a lone surrogate into U+FFFD, as the body and Postgres do, and keeps a pair', () => {
    const title = JSON.parse('"a\\ud800b\\udfffc😀"') as string;
    expect(postTitleInputSchema.parse(title)).toBe('a�b�c😀');
    // The same title sent again is the same title (an edit that changes nothing stays one).
    expect(postTitleInputSchema.parse(postTitleInputSchema.parse(title))).toBe(
      postTitleInputSchema.parse(title),
    );
  });
});

describe('the bodies of the writes', () => {
  it('takes a market, an optional title and a normalised body, naming the account', () => {
    const parsed = createPostBodySchema.parse({
      marketId: MARKET.toUpperCase(),
      body: { ...BODY, extra: 1 },
      expectedAccountId: 'acct',
    });
    expect(parsed).toEqual({
      marketId: MARKET,
      title: null,
      body: { document: BODY, text: '근거', length: 2, imageIds: [] },
      expectedAccountId: 'acct',
    });
    expect(createPostBodySchema.safeParse({ marketId: MARKET, body: BODY }).success).toBe(false);
    const empty = createPostBodySchema.safeParse({
      marketId: MARKET,
      body: { type: 'doc', content: [] },
      expectedAccountId: 'acct',
    });
    expect(empty.error?.issues.map((issue) => issue.path)).toEqual([['body']]);
  });

  it('edits the title and the body, never the market', () => {
    const parsed = updatePostBodySchema.parse({
      marketId: MARKET,
      title: '새 제목',
      body: BODY,
      expectedAccountId: 'acct',
    });
    expect(parsed).not.toHaveProperty('marketId');
    expect(parsed.title).toBe('새 제목');
    expect(deletePostBodySchema.parse({ expectedAccountId: 'acct' })).toEqual({
      expectedAccountId: 'acct',
    });
    expect(deletePostBodySchema.safeParse({}).success).toBe(false);
  });

  it('lists newest first by market, category and a search term', () => {
    expect(postListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      postListQuerySchema.parse({
        marketId: MARKET.toUpperCase(),
        category: ' economy ',
        q: ' 금리 ',
      }),
    ).toEqual({ limit: 20, marketId: MARKET, category: 'economy', q: '금리' });
    expect(postListQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(postListQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(postListQuerySchema.safeParse({ marketId: 'nope' }).success).toBe(false);
  });
});

describe('the public shapes', () => {
  const author = {
    kind: 'member',
    publicId: 'abcdefgh23',
    nickname: '예측가',
    imageUrl: null,
    isAdmin: false,
  } as const;
  const market = {
    id: MARKET,
    slug: 'base-rate',
    title: '기준금리',
    status: 'closed',
    category: { slug: 'economy', nameKo: '경제' },
  } as const;

  it('names an author by public id, nickname, image and the 운영자 mark, or as a former member', () => {
    expect(postAuthorSchema.parse(author)).toEqual(author);
    expect(postAuthorSchema.parse({ kind: 'former_member' })).toEqual({ kind: 'former_member' });
    expect(postAuthorSchema.safeParse({ ...author, publicId: 'Not-Public' }).success).toBe(false);
  });

  it('draws a card and a post page in each state', () => {
    const createdAt = '2026-10-19T00:00:00.000Z';
    expect(
      postSummarySchema.safeParse({
        id: MARKET,
        title: null,
        excerpt: '근거',
        thumbnailUrl: mediaPath(MARKET),
        author,
        market,
        createdAt,
        editedAt: null,
      }).success,
    ).toBe(true);
    expect(
      postSchema.safeParse({
        state: 'published',
        id: MARKET,
        title: '제목',
        body: BODY,
        author,
        market,
        createdAt,
        editedAt: createdAt,
      }).success,
    ).toBe(true);
    for (const state of ['deleted', 'hidden'] as const) {
      expect(postSchema.parse({ state, id: MARKET, market })).toEqual({
        state,
        id: MARKET,
        market,
      });
    }
    expect(postDeletionSchema.parse({ id: MARKET, placeholder: false }).placeholder).toBe(false);
    expect(postNotEditableDetailsSchema.parse({ reason: 'hidden' })).toEqual({ reason: 'hidden' });
  });
});

describe('uploaded images', () => {
  it('fixes the owner’s rules', () => {
    expect(MEDIA_KINDS).toEqual(['post_image']);
    expect(IMAGE_CONTENT_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    expect(IMAGE_MAX_BYTES).toBe(5_242_880);
    expect(IMAGE_MAX_DIMENSION).toBe(2_048);
    expect(ORPHAN_MEDIA_HOURS).toBe(24);
  });

  it('reads an image from the API, by id', () => {
    expect(mediaPath(MARKET)).toBe(`/api/v1/media/${MARKET}`);
    expect(
      uploadedImageSchema.safeParse({
        id: MARKET,
        contentType: 'image/webp',
        width: 10,
        height: 20,
        byteSize: 30,
      }).success,
    ).toBe(true);
    expect(uploadImageQuerySchema.safeParse({}).success).toBe(false);
    expect(imageNotAllowedDetailsSchema.parse({ reason: 'type' })).toEqual({ reason: 'type' });
  });
});

describe('public ids', () => {
  it('is 10 of 32 characters without look-alikes', () => {
    expect(PUBLIC_ID_ALPHABET).toHaveLength(32);
    expect(new Set(PUBLIC_ID_ALPHABET).size).toBe(32);
    for (const ambiguous of ['0', '1', 'o', 'i'])
      expect(PUBLIC_ID_ALPHABET).not.toContain(ambiguous);
    expect(PUBLIC_ID_LENGTH).toBe(10);
    expect(PUBLIC_ID_PATTERN.test('abcdefgh23')).toBe(true);
    for (const id of ['abcdefgh2', 'abcdefgh234', 'ABCDEFGH23', 'abcdefgh10']) {
      expect(publicIdSchema.safeParse(id).success, id).toBe(false);
    }
  });
});
