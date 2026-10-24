import { readFileSync } from 'node:fs';
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
import { ApiError, type Post, type PostAuthor } from './api';
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
  postGoneAfter,
  postKey,
  postListQuery,
  postPageMetadata,
  postPath,
  postPlaceholderMessage,
  postReadErrorMessage,
  postWriteErrorMessage,
  refusedImageIds,
  writeMarketAfter,
  writePath,
  writeScreenMarket,
  writeScreenStart,
  writeScreenView,
  type WriteMarket,
  type WriteMarketLookup,
  type WriteScreenEvent,
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

describe('a post gone while its page is open (postGoneAfter, Codex review of #219, round 5)', () => {
  const failed = (error: unknown) => ({ isError: true, error });
  const read = { isError: false, error: null };

  it('is gone once a read answers NOT_FOUND — the query still holds the post it read before', () => {
    expect(postGoneAfter(false, failed(refusal(404, 'NOT_FOUND')))).toBe(true);
    expect(postGoneAfter(false, read)).toBe(false);
  });

  it('keeps the post through a read that fails otherwise: it says nothing about the post', () => {
    // A 5xx, a 429, a body the API did not write (a 404 too: not the API's NOT_FOUND), and a
    // request that never reached it.
    expect(postGoneAfter(false, failed(refusal(503, 'INTERNAL')))).toBe(false);
    expect(postGoneAfter(false, failed(refusal(429, 'RATE_LIMITED')))).toBe(false);
    expect(postGoneAfter(false, failed(new ApiError(500, undefined)))).toBe(false);
    expect(postGoneAfter(false, failed(new ApiError(404, undefined)))).toBe(false);
    expect(postGoneAfter(false, failed(new TypeError('fetch failed')))).toBe(false);
  });

  it('stays gone: a later read failing otherwise, or none failing, does not bring the post back', () => {
    expect(postGoneAfter(true, failed(new TypeError('fetch failed')))).toBe(true);
    expect(postGoneAfter(true, failed(refusal(503, 'INTERNAL')))).toBe(true);
    expect(postGoneAfter(true, read)).toBe(true);
  });

  it('is what the post page and the edit screen draw from, and both then draw the server page again (the 404)', () => {
    // No component renders under node: the screens' wiring is pinned in their source, as the
    // write screen's is below.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const file of [
      '../app/community/posts/[postId]/post-screen.tsx',
      '../app/community/posts/[postId]/edit/edit-screen.tsx',
    ]) {
      const screen = source(file);
      expect(screen, file).toContain('const [gone, setGone] = useState(false);');
      expect(screen, file).toContain('const nowGone = postGoneAfter(gone, query);');
      expect(screen, file).toContain('if (nowGone !== gone) setGone(nowGone);');
      expect(screen, file).toMatch(
        /useEffect\(\(\) => \{\s*if \(gone\) router\.refresh\(\);\s*\}, \[gone, router\]\);/,
      );
    }
    // The post page: the sentence and the way back in place of the post and its market.
    const page = source('../app/community/posts/[postId]/post-screen.tsx');
    expect(page).toMatch(
      /if \(gone\) \{\s*return \(\s*<Stack gap="6" data-testid="post-screen">\s*<Alert\.Root status="info" data-testid="post-gone">[\s\S]*?\{copy\.postNotFound\}[\s\S]*?<BackLink \/>\s*<\/Stack>\s*\);\s*\}\s*if \(post\.state !== 'published'\)/,
    );
    // The edit screen: the sentence in the form's place, before the gate and the form.
    const edit = source('../app/community/posts/[postId]/edit/edit-screen.tsx');
    expect(edit).toMatch(
      /\{gone \? \(\s*<EmptyState message=\{copy\.postNotFound\} data-testid="post-edit-gone" \/>\s*\) : \(\s*<WriteGate/,
    );
  });
});

describe('a post page’s metadata', () => {
  const postMarket = {
    id: '6f1c0f5e-8a0e-4f8b-9d7e-2b1a3c4d5e6f',
    slug: 'rate-cut',
    title: '금리 인하',
    status: 'open',
    category: { slug: 'economy', nameKo: '경제' },
  } as const;
  const id = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

  it('keeps every answer out of search engines: the post, both placeholders and none (owner decision 2026-10-19)', () => {
    const published: Post = {
      state: 'published',
      id,
      title: null,
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '근거 한 줄' }] }],
      },
      author: { kind: 'former_member' },
      market: postMarket,
      createdAt: '2026-10-19T00:00:00.000Z',
      editedAt: null,
    };
    const answers: (Post | null)[] = [
      published,
      { state: 'hidden', id, market: postMarket },
      { state: 'deleted', id, market: postMarket },
      null,
    ];
    for (const post of answers) {
      expect(postPageMetadata(post).robots).toEqual({ index: false });
    }
    expect(postPageMetadata(published)).toMatchObject({
      title: `근거 한 줄 | ${copy.appName}`,
      description: '근거 한 줄',
    });
  });

  it('names a placeholder by what it says, never by the post', () => {
    const hidden = postPageMetadata({ state: 'hidden', id, market: postMarket });
    expect(hidden.title).toBe(`${copy.postHiddenPlaceholder} | ${copy.appName}`);
    expect(hidden.description).toBeUndefined();
    const deleted = postPageMetadata({ state: 'deleted', id, market: postMarket });
    expect(deleted.title).toBe(`${copy.postDeletedPlaceholder} | ${copy.appName}`);
    expect(postPageMetadata(null).title).toBe(`${copy.postNotFound} | ${copy.appName}`);
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

describe('the market the write screen’s form shows (writeMarketAfter)', () => {
  const shown: WriteMarket = { id: market, title: '기준금리 인하?', status: 'open' };
  const other: WriteMarket = { id: POST.toLowerCase(), title: '환율 1,400원?', status: 'closed' };

  it('is the market found, or none when the API says there is no such market', () => {
    expect(writeMarketAfter(null, { kind: 'found', market: shown })).toEqual(shown);
    expect(writeMarketAfter(shown, { kind: 'found', market: other })).toEqual(other);
    expect(writeMarketAfter(null, { kind: 'none' })).toBeNull();
    expect(writeMarketAfter(shown, { kind: 'none' })).toBeNull();
  });

  it('keeps the form shown, and its draft, when the read failed (Codex review of #219, round 2)', () => {
    // The market just picked shows already; the read of its address failed for a moment.
    expect(writeMarketAfter(other, { kind: 'failed', marketId: other.id })).toBe(other);
    // No form yet: none to keep (the screen offers to read again).
    expect(writeMarketAfter(null, { kind: 'failed', marketId: other.id })).toBeNull();
  });
});

describe('the write screen’s market (writeScreenMarket, writeScreenView)', () => {
  const a: WriteMarket = { id: market, title: '기준금리 인하?', status: 'open' };
  const b: WriteMarket = { id: POST.toLowerCase(), title: '환율 1,400원?', status: 'closed' };
  const found = (shown: WriteMarket): WriteMarketLookup => ({ kind: 'found', market: shown });
  const none = (): WriteMarketLookup => ({ kind: 'none' });
  const failed = (of: WriteMarket): WriteMarketLookup => ({ kind: 'failed', marketId: of.id });
  // Each read of the page comes as a new object, as the page renders one per read.
  const read = (lookup: WriteMarketLookup): WriteScreenEvent => ({ kind: 'read', lookup });
  const picked = (of: WriteMarket): WriteScreenEvent => ({ kind: 'picked', market: of });
  /** The screen once its first read has come and each event after it in turn. */
  const after = (first: WriteMarketLookup, ...events: WriteScreenEvent[]) =>
    events.reduce(writeScreenMarket, writeScreenStart(first));

  it('opens on the form under a market found, the picker for none, and the failure with no form', () => {
    expect(writeScreenView(after(found(a)))).toEqual({
      kind: 'form',
      market: a,
      back: writePath(a.id),
    });
    expect(writeScreenView(after(none()))).toEqual({ kind: 'picker', back: writePath() });
    // Not the picker: the failure and its retry, and the sign-in comes back to that market.
    expect(writeScreenView(after(failed(a)))).toEqual({ kind: 'failed', back: writePath(a.id) });
  });

  it('keeps the form, under the market picked, when the read of its address fails (Codex review of #219, round 2)', () => {
    expect(writeScreenView(after(found(a), picked(b), read(failed(b))))).toEqual({
      kind: 'form',
      market: b,
      back: writePath(b.id),
    });
  });

  it('shows a market picked at once — through a render with the read before it — until the page reads it', () => {
    const first = found(a);
    const state = after(first, picked(b));
    expect(writeScreenView(state)).toEqual({ kind: 'form', market: b, back: writePath(b.id) });
    // The page renders again with the read it had, before the address has followed: nothing moves.
    expect(writeScreenMarket(state, read(first))).toBe(state);
    expect(writeScreenView(after(first, picked(b), read(found(b))))).toMatchObject({
      kind: 'form',
      market: b,
    });
    // From the picker too.
    expect(writeScreenView(after(none(), picked(a)))).toMatchObject({ kind: 'form', market: a });
  });

  it('takes the form away only when the API says the market picked is none', () => {
    expect(writeScreenView(after(found(a), picked(b), read(none())))).toEqual({
      kind: 'picker',
      back: writePath(),
    });
  });

  it('shows the form once a retry after a failure finds the market, and the failure while it fails', () => {
    expect(writeScreenView(after(failed(a), read(found(a))))).toEqual({
      kind: 'form',
      market: a,
      back: writePath(a.id),
    });
    expect(writeScreenView(after(failed(a), read(failed(a))))).toEqual({
      kind: 'failed',
      back: writePath(a.id),
    });
    expect(writeScreenView(after(failed(a), read(none())))).toEqual({
      kind: 'picker',
      back: writePath(),
    });
  });

  it('is what WriteScreen holds and draws, and the page reads its market through lookUpWriteMarketServer', () => {
    // No component renders under node and the e2e cannot fail the page's server-side read, so the
    // screen's wiring is pinned in its source: the steps tested above are the ones it takes.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const screen = source('../app/community/write/write-screen.tsx');
    expect(screen).toContain('useState(() => writeScreenStart(lookup))');
    expect(screen).toContain("const market = writeScreenMarket(held, { kind: 'read', lookup });");
    expect(screen).toContain('if (market !== held) setHeld(market);');
    expect(screen).toContain('const view = writeScreenView(market);');
    // A pick shows the market picked before its address follows.
    expect(screen).toMatch(
      /setHeld\(\(current\) => writeScreenMarket\(current, \{ kind: 'picked', market: picked \}\)\);\s*router\.replace\(writePath\(picked\.id\)/,
    );
    expect(screen).toContain('<WriteGate back={view.back}>');
    expect(screen).toMatch(/view\.kind === 'form' \?\s*\(\s*<WriteForm market=\{view\.market\}/);
    expect(screen).toContain("view.kind === 'failed' ?");
    // What the screen shows comes from those steps alone.
    expect(screen).not.toMatch(/writeMarketAfter|lookup\.kind|setShown/);
    const page = source('../app/community/write/page.tsx');
    expect(page).toContain('const lookup = await lookUpWriteMarketServer(marketId);');
    expect(page).toContain('<WriteScreen lookup={lookup} />');
  });
});
