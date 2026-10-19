import {
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  POST_SEARCH_TERM_MAX,
  postImageNotUsableMessage,
  sanitizePostDocument,
} from '@buddha/shared';
import { hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type PostAuthor } from './api';
import { isPrivateQueryKey } from './market-keys';
import {
  COMMUNITY_PATH,
  POSTS_KEY,
  POST_LIST_KEY,
  authorView,
  communityFiltersFromSearchParams,
  communityPath,
  communityPostsKey,
  communitySearchFields,
  isFiltered,
  isOwnPost,
  nameInitial,
  postEditPath,
  postFirstLine,
  postKey,
  postListQuery,
  postPath,
  postPlaceholderMessage,
  postReadErrorMessage,
  postWriteErrorMessage,
  refusedImageIds,
  writePath,
} from './posts';

/**
 * The community's URL, keys and refusals (#46, ADR-0073): pure functions, so they run here under
 * node. The pages and the hooks only wire these.
 */

const MARKET = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const market = MARKET.toLowerCase();
const POST = 'B7C9A1D2-6F34-4E58-9B0A-2D1E5F8C7A46';

const member = (over: Partial<Extract<PostAuthor, { kind: 'member' }>> = {}): PostAuthor => ({
  kind: 'member',
  publicId: 'k7m2p9qx4z',
  nickname: '근거왕',
  imageUrl: null,
  isAdmin: false,
  ...over,
});

const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError(status, { code, message: 'x', details } as never);

describe('the community URL', () => {
  it('keeps a uuid market (lower-cased), a category and a trimmed term', () => {
    expect(
      communityFiltersFromSearchParams({ market: MARKET, category: 'economy', q: '  금리  ' }),
    ).toEqual({ market, category: 'economy', q: '금리' });
  });

  it('drops what the API would refuse instead of answering 400', () => {
    expect(communityFiltersFromSearchParams({ market: 'not-a-uuid' })).toEqual({});
    expect(communityFiltersFromSearchParams({ q: '   ' })).toEqual({});
    expect(communityFiltersFromSearchParams({ q: 'a'.repeat(POST_SEARCH_TERM_MAX + 1) })).toEqual(
      {},
    );
    expect(communityFiltersFromSearchParams({ q: 'a\u0000b' })).toEqual({});
    expect(communityFiltersFromSearchParams({ category: '' })).toEqual({});
  });

  it('reads the first of a repeated param, as every list does', () => {
    expect(communityFiltersFromSearchParams({ q: ['rain', 'snow'] })).toEqual({ q: 'rain' });
  });

  it('writes only what is picked, and reads back what it wrote', () => {
    expect(communityPath({})).toBe(COMMUNITY_PATH);
    const filters = { market, category: 'economy', q: '금리 인하' };
    const path = communityPath(filters);
    expect(path).toBe(
      `/community?market=${market}&category=economy&q=%EA%B8%88%EB%A6%AC+%EC%9D%B8%ED%95%98`,
    );
    const params = Object.fromEntries(new URL(path, 'http://x').searchParams);
    expect(communityFiltersFromSearchParams(params)).toEqual(filters);
  });

  it('says whether a filter is on', () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ q: 'a' })).toBe(true);
    expect(isFiltered({ market })).toBe(true);
    expect(isFiltered({ category: 'economy' })).toBe(true);
  });

  it('carries the market and the category, never the term, beside the search box', () => {
    expect(communitySearchFields({ market, category: 'economy', q: 'old' })).toEqual([
      ['market', market],
      ['category', 'economy'],
    ]);
    expect(communitySearchFields({ q: 'old' })).toEqual([]);
  });

  it('addresses a post, its edit screen and the write screen', () => {
    expect(postPath(POST)).toBe(`/community/posts/${POST}`);
    expect(postEditPath(POST)).toBe(`/community/posts/${POST}/edit`);
    expect(writePath()).toBe('/community/write');
    expect(writePath(market)).toBe(`/community/write?market=${market}`);
  });
});

describe('the post keys and requests', () => {
  it('put every list and page under one public root', () => {
    const list = communityPostsKey({ q: 'a' });
    expect(list.slice(0, 2)).toEqual([...POST_LIST_KEY]);
    expect(POST_LIST_KEY.slice(0, 1)).toEqual([...POSTS_KEY]);
    expect(postKey(POST)).toEqual(['posts', 'post', POST.toLowerCase()]);
    // Public: the pages read them on the server and dehydrate them.
    expect(isPrivateQueryKey(list)).toBe(false);
    expect(isPrivateQueryKey(postKey(POST))).toBe(false);
  });

  it('keys each filter object apart', () => {
    expect(hashKey(communityPostsKey({}))).not.toBe(hashKey(communityPostsKey({ market })));
    expect(hashKey(communityPostsKey({ q: 'a' }))).not.toBe(hashKey(communityPostsKey({ q: 'b' })));
  });

  it('leaves a filter that is not on out of the request, and names the market as marketId', () => {
    expect(postListQuery({})).toEqual({});
    expect(postListQuery({ market, category: 'economy', q: '금리' }, 'c1')).toEqual({
      marketId: market,
      category: 'economy',
      q: '금리',
      cursor: 'c1',
    });
  });
});

describe('an author', () => {
  it('is the current nickname, its first letter and the 운영자 mark of an admin', () => {
    expect(authorView(member())).toEqual({
      kind: 'member',
      name: '근거왕',
      initial: '근',
      imageUrl: null,
      isAdmin: false,
    });
    expect(authorView(member({ isAdmin: true }))).toMatchObject({ isAdmin: true });
  });

  it('is 탈퇴한 사용자 and nothing else once withdrawn (#140)', () => {
    expect(authorView({ kind: 'former_member' })).toEqual({
      kind: 'former',
      name: copy.postAuthorFormer,
      initial: '',
    });
  });

  it('takes the first character as a person reads it', () => {
    expect(nameInitial('alice')).toBe('A');
    expect(nameInitial('😀smile')).toBe('😀');
    expect(nameInitial('  홍길동')).toBe('홍');
    expect(nameInitial('')).toBe('');
  });

  it('is the viewer only by the public id', () => {
    expect(isOwnPost(member(), 'k7m2p9qx4z')).toBe(true);
    expect(isOwnPost(member(), 'zzzzzzzzzz')).toBe(false);
    expect(isOwnPost(member(), undefined)).toBe(false);
    expect(isOwnPost({ kind: 'former_member' }, 'k7m2p9qx4z')).toBe(false);
  });
});

describe('what a post page says instead of a post (#45-5)', () => {
  it('names neither the author nor the post', () => {
    expect(postPlaceholderMessage('deleted')).toBe('삭제된 글입니다.');
    expect(postPlaceholderMessage('hidden')).toBe('운영 정책에 따라 숨긴 글입니다.');
  });
});

describe('a post without a title', () => {
  it('is named by the first line of its text, for the heading a screen reader lists', () => {
    expect(postFirstLine('\n  첫 줄  \n둘째 줄')).toBe('첫 줄');
    expect(postFirstLine('한 줄')).toBe('한 줄');
    expect(postFirstLine('')).toBe('');
  });
});

describe('a refused write', () => {
  it('names the rule the server applied', () => {
    expect(
      postWriteErrorMessage(
        refusal(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'other account' }]),
      ),
    ).toBe(copy.sessionChanged);
    expect(postWriteErrorMessage(refusal(403, 'FORBIDDEN'))).toBe(copy.errPostNotYours);
    expect(postWriteErrorMessage(refusal(409, 'POST_NOT_EDITABLE', { reason: 'hidden' }))).toBe(
      copy.errPostNotEditable,
    );
    expect(
      postWriteErrorMessage(
        refusal(404, 'NOT_FOUND', [{ path: ['marketId'], message: 'no such market' }]),
      ),
    ).toBe(copy.errPostMarketUnavailable);
    expect(postWriteErrorMessage(refusal(404, 'NOT_FOUND'))).toBe(copy.errPostGone);
    expect(postWriteErrorMessage(refusal(409, 'ONBOARDING_REQUIRED'))).toBe(copy.errPostOnboarding);
  });

  it('tells the body’s refusals apart by the messages the server writes', () => {
    // The server's own messages, from the functions that write them: rewording one there changes
    // what is read here, or fails this test — never a stale copy of the words.
    const sanitised = (input: unknown) => {
      const result = sanitizePostDocument(input);
      if (result.ok) throw new Error('accepted');
      return result.issues[0]!.message;
    };
    const doc = (...content: unknown[]) => ({ type: 'doc', content });
    const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const image = { type: 'image', attrs: { mediaId: market } };
    const body = (message: string) =>
      postWriteErrorMessage(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['body', 'content', 0], message }]),
      );
    expect(body(sanitised(doc()))).toBe(copy.errPostBodyEmpty);
    expect(body(sanitised(doc(p('가'.repeat(POST_BODY_MAX_LENGTH + 1)))))).toBe(
      copy.errPostBodyTooLong,
    );
    expect(
      body(sanitised(doc(p('x'), ...Array.from({ length: POST_IMAGES_MAX + 1 }, () => image)))),
    ).toBe(copy.errPostTooManyImages);
    expect(body(postImageNotUsableMessage(market))).toBe(copy.errPostImageUnusable);
    expect(body('nested deeper than 24 levels')).toBe(copy.errPostInvalid);
    expect(
      postWriteErrorMessage(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['title'], message: 'at most 100 characters' }]),
      ),
    ).toBe(copy.errPostTitle);
  });

  it('names the images a refused write could not use, for the editor to mark', () => {
    const other = POST.toLowerCase();
    expect(
      refusedImageIds(
        refusal(400, 'VALIDATION_ERROR', [
          { path: ['body'], message: postImageNotUsableMessage(market) },
          { path: ['body'], message: postImageNotUsableMessage(other) },
        ]),
      ),
    ).toEqual([market, other]);
    expect(
      refusedImageIds(
        refusal(400, 'VALIDATION_ERROR', [{ path: ['body'], message: 'must have some text' }]),
      ),
    ).toEqual([]);
    expect(refusedImageIds(refusal(409, 'ONBOARDING_REQUIRED'))).toEqual([]);
    expect(refusedImageIds(new TypeError('Failed to fetch'))).toEqual([]);
  });

  it('says an unreachable server apart from anything else', () => {
    expect(postWriteErrorMessage(new TypeError('Failed to fetch'))).toBe(copy.errNetwork);
    expect(postWriteErrorMessage(new ApiError(502, undefined))).toBe(copy.errNetwork);
    expect(postWriteErrorMessage(refusal(500, 'INTERNAL'))).toBe(copy.errUnknown);
    expect(postReadErrorMessage(new TypeError('Failed to fetch'))).toBe(copy.errNetwork);
    expect(postReadErrorMessage(refusal(500, 'INTERNAL'))).toBe(copy.errUnknown);
  });
});
