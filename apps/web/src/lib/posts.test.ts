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
import { ApiError, isApiError, type Post, type PostAuthor, type PublishedPost } from './api';
import { goneBoxReason } from './comments';
import { formatKst } from './datetime';
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
  marketPostsKey,
  marketPostsQuery,
  nameInitial,
  POST_EDIT_ON_SCREEN,
  postEditClosed,
  postEditDeleted,
  postEditPath,
  postEditGoneAfter,
  postEditHeldMessage,
  postEditHidden,
  postEditUnavailableMessage,
  postFirstLine,
  postGoneAfter,
  postHeadingElement,
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
import { refusalOf } from './restriction';

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

/** A WRITE_LIMITED answer (#187) that arrived at 2026-10-21 15:41:30 in Seoul. */
const limited = (reason: string, limit: number, retryAfterSeconds: number) =>
  new ApiError(
    429,
    { code: 'WRITE_LIMITED', message: 'x', details: { reason, limit, retryAfterSeconds } } as never,
    Date.parse('2026-10-21T06:41:30.000Z'),
  );

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

describe('a market detail’s 토론 (#47, ADR-0075)', () => {
  it('is keyed by the lower-cased market under the lists’ root, so the writes that mark the lists stale reach it', () => {
    expect(marketPostsKey(MARKET)).toEqual(['posts', 'list', 'market', market]);
    expect(marketPostsKey(MARKET).slice(0, 2)).toEqual([...POST_LIST_KEY]);
    expect(isPrivateQueryKey(marketPostsKey(MARKET))).toBe(false);
    // Not the community list's market filter: a different request (no count) under its own entry.
    expect(hashKey(marketPostsKey(MARKET))).not.toBe(hashKey(communityPostsKey({ market })));
    expect(hashKey(marketPostsKey(MARKET))).not.toBe(
      hashKey(marketPostsKey('9c858901-8a57-4791-81fe-4c455b099bc9')),
    );
  });

  it('asks a page by its cursor alone: newest first is the only order, 20 the API’s page', () => {
    expect(marketPostsQuery()).toEqual({});
    expect(marketPostsQuery('c2')).toEqual({ cursor: 'c2' });
  });

  it('opens the write screen with the market picked', () => {
    expect(writePath(market)).toBe(`/community/write?market=${market}`);
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
      href: '/u/k7m2p9qx4z',
    });
    expect(authorView(member({ isAdmin: true }))).toMatchObject({ isAdmin: true });
  });

  it('leads to the public profile by the public id, never by the nickname (#41, #37-2)', () => {
    expect(authorView(member({ nickname: '새이름' }))).toMatchObject({
      name: '새이름',
      href: '/u/k7m2p9qx4z',
    });
    // A withdrawn author has no profile and no link (#37-16).
    expect(authorView({ kind: 'former_member' })).not.toHaveProperty('href');
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

  it('is what the post page and the edit screen draw from, and both then draw the server page again (the 404) — the post page once no comment text is held apart', () => {
    // No component renders under node: the screens' wiring is pinned in their source, as the
    // write screen's is below.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const refreshAtOnce =
      /useEffect\(\(\) => \{\s*if \(gone\) router\.refresh\(\);\s*\}, \[gone, router\]\);/;
    // The post page (#48, ADR-0074 7-27): the server page is drawn again once the comment section
    // holds no text apart — at once when it holds none (오너 결정 2026-10-21 답 1) — not as the post
    // goes.
    const page = source('../app/community/posts/[postId]/post-screen.tsx');
    expect(page).toContain('const [gone, setGone] = useState(false);');
    expect(page).toContain('const nowGone = postGoneAfter(gone, query);');
    expect(page).toContain('if (nowGone !== gone) setGone(nowGone);');
    expect(page).not.toMatch(refreshAtOnce);
    expect(page).toMatch(
      /const toNotFound = useCallback\(\(\) => \{[\s\S]*?router\.refresh\(\);\s*\}, \[router\]\);/,
    );
    expect(page).toContain(
      '<CommentsSection post={post} gone={gone} onNothingHeld={toNotFound} focusGone={focusGone} />',
    );
    // The sentence in place of the post (or its placeholder) and its market, in the one tree the
    // comment section stays mounted in (#48, ADR-0074 결정 6).
    expect(page).toMatch(
      /\{gone \? \([\s\S]*?data-testid="post-gone"[\s\S]*?\{copy\.postNotFound\}[\s\S]*?\) : post\.state !== 'published' \? \(/,
    );
    expect(page).toContain('{!gone && <MarketBox market={post.market} />}');
    // The edit screen: the same read decides it — and so does a read of a deleted post's
    // placeholder over the post it had published (#48, below) — and the server page waits for what
    // the form holds to be closed (오너 결정 2026-10-24, below).
    const edit = source('../app/community/posts/[postId]/edit/edit-screen.tsx');
    expect(edit).toContain('const nowNotFound = postGoneAfter(notFound, query);');
    expect(edit).toContain('gone: nowNotFound || postEditDeleted(published, post),');
    expect(edit).not.toMatch(refreshAtOnce);
  });
});

describe('an edit screen whose post is gone (postEditGoneAfter, 오너 결정 2026-10-24, ADR-0073 9-52)', () => {
  const onScreen = POST_EDIT_ON_SCREEN;

  it('changes nothing while the post is there, whatever the form holds', () => {
    expect(postEditGoneAfter(onScreen, { gone: false, hidden: false, formHolding: false })).toBe(
      onScreen,
    );
    expect(postEditGoneAfter(onScreen, { gone: false, hidden: false, formHolding: true })).toBe(
      onScreen,
    );
  });

  it('keeps the form, held, when it holds something of the writer’s as the post goes; one holding nothing — or none on screen — is the 404 at once', () => {
    expect(postEditGoneAfter(onScreen, { gone: true, hidden: false, formHolding: true })).toEqual({
      gone: true,
      hidden: false,
      held: true,
    });
    expect(postEditGoneAfter(onScreen, { gone: true, hidden: false, formHolding: false })).toEqual({
      gone: true,
      hidden: false,
      held: false,
    });
  });

  it('is decided as the post goes: held until closed or until the form leaves the screen, and never held later', () => {
    const held = { gone: true, hidden: false, held: true };
    expect(postEditGoneAfter(held, { gone: true, hidden: false, formHolding: true })).toBe(held);
    // The form taken away under it (the gate's sign-in prompt for a session gone, say).
    expect(postEditGoneAfter(held, { gone: true, hidden: false, formHolding: false })).toEqual({
      gone: true,
      hidden: false,
      held: false,
    });
    // Closed (닫기), or the 404 at once: a form saying it holds something afterwards changes
    // nothing.
    const closed = { gone: true, hidden: false, held: false };
    expect(postEditGoneAfter(closed, { gone: true, hidden: false, formHolding: true })).toBe(
      closed,
    );
    expect(postEditGoneAfter(closed, { gone: true, hidden: false, formHolding: false })).toBe(
      closed,
    );
  });

  it('hears a read that puts a deleted post’s placeholder in place of the post the screen had published as the post going: the API answers it, not NOT_FOUND, once comments hang under the post (#48, ADR-0074 7-35)', () => {
    const postMarket = {
      id: '6f1c0f5e-8a0e-4f8b-9d7e-2b1a3c4d5e6f',
      slug: 'rate-cut',
      title: '금리 인하',
      status: 'open',
      category: { slug: 'economy', nameKo: '경제' },
    } as const;
    const id = POST.toLowerCase();
    const published: PublishedPost = {
      state: 'published',
      id,
      title: '고칠 글',
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '근거 한 줄' }] }],
      },
      author: member(),
      market: postMarket,
      createdAt: '2026-10-19T00:00:00.000Z',
      editedAt: null,
      commentCount: 1,
      likeCount: 0,
    };
    const deleted: Post = { state: 'deleted', id, market: postMarket, commentCount: 1 };
    const hidden: Post = { state: 'hidden', id, market: postMarket, commentCount: 1 };
    expect(postEditDeleted(published, deleted)).toBe(true);
    // Read again published (edited elsewhere, say), or hidden (#50 — heard apart, `postEditHidden`,
    // below): not deleted.
    expect(postEditDeleted(published, { ...published, title: '다른 탭에서 고친 글' })).toBe(false);
    expect(postEditDeleted(published, hidden)).toBe(false);
    // Opened on the placeholder: nothing was published on this screen, and it shows the
    // placeholder as a reload does.
    expect(postEditDeleted(undefined, deleted)).toBe(false);
    // Heard as NOT_FOUND is: the form held while it holds something of the writer's, the server
    // page at once otherwise.
    expect(
      postEditGoneAfter(onScreen, {
        gone: postEditDeleted(published, deleted),
        hidden: postEditHidden(published, deleted),
        formHolding: true,
      }),
    ).toEqual({ gone: true, hidden: false, held: true });
    expect(
      postEditGoneAfter(onScreen, {
        gone: postEditDeleted(published, deleted),
        hidden: postEditHidden(published, deleted),
        formHolding: false,
      }),
    ).toEqual({ gone: true, hidden: false, held: false });
  });

  it('is what the edit screen draws from: the form held, read-only, with the sentence and 닫기, and the 404 once closed', () => {
    // No component renders under node: the wiring is pinned in the source, as above.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const edit = source('../app/community/posts/[postId]/edit/edit-screen.tsx');
    expect(edit).toContain('const [formHolding, setFormHolding] = useState(false);');
    expect(edit).toContain(
      'const [state, setState] = useState<PostEditGone>(POST_EDIT_ON_SCREEN);',
    );
    expect(edit).toContain('const [notFound, setNotFound] = useState(false);');
    expect(edit).toContain('if (nowNotFound !== notFound) setNotFound(nowNotFound);');
    expect(edit).toMatch(
      /const next = postEditGoneAfter\(state, \{\s*gone: nowNotFound \|\| postEditDeleted\(published, post\),\s*hidden: postEditHidden\(published, post\),\s*formHolding,\s*\}\);/,
    );
    expect(edit).toContain('if (next !== state) setState(next);');
    // The server page drawn again once nothing is held — and again as NOT_FOUND follows the
    // placeholder (#48).
    expect(edit).toMatch(
      /useEffect\(\(\) => \{\s*if \(gone && !held\) router\.refresh\(\);\s*\}, \[gone, held, notFound, router\]\);/,
    );
    // The sentence in the form's place once nothing is held, before the gate and the form — for
    // a post gone from every view; a deleted post's placeholder is the gate's, as a reload draws it.
    expect(edit).toMatch(
      /\{gone && !held && notFound \? \(\s*<EmptyState message=\{copy\.postNotFound\} data-testid="post-edit-gone" \/>\s*\) : \(\s*<WriteGate/,
    );
    // Held, the form is drawn from the post as the screen last had it published (#48: the query
    // may hold the placeholder now), kept as each published read comes.
    expect(edit).toContain(
      "const [published, setPublished] = useState(post.state === 'published' ? post : undefined);",
    );
    expect(edit).toContain(
      "if (post.state === 'published' && post !== published) setPublished(post);",
    );
    expect(edit).toContain('const shown = held && published !== undefined ? published : post;');
    expect(edit).toMatch(/\(writer\) =>\s+shown\.state !== 'published' \? \(/);
    expect(edit).toContain('!isOwnPost(shown.author, writer.publicId)');
    // The form hears the post gone, closes it, and says what it holds.
    expect(edit).toMatch(
      /<EditForm\s+key=\{closings\}\s+post=\{shown\}\s+accountId=\{writer\.accountId\}\s+held=\{held\}\s+heldMessage=\{postEditHeldMessage\(state\)\}\s+heldHidden=\{state\.hidden\}\s+onClose=\{\(\) => \{\s*setState\(postEditClosed\(state\)\);\s*setClosings\(closings \+ 1\);\s*\}\}\s+onHoldingChange=\{setFormHolding\}\s+\/>/,
    );
    expect(edit).toMatch(
      /gone=\{held\}\s+goneMessage=\{heldMessage\}\s+goneAction=\{heldHidden \? <HiddenModerationLink \/> : undefined\}\s+onClose=\{onClose\}\s+onHoldingChange=\{onHoldingChange\}\s+onSubmit=/,
    );
    // A post not published in the form's place — once closed too — as a reload draws it.
    expect(edit).toMatch(
      /<EmptyState\s+message=\{postEditUnavailableMessage\(shown\.state\)\}\s+action=\{shown\.state === 'hidden' \? <HiddenModerationLink \/> : undefined\}\s+data-testid="post-edit-unavailable"/,
    );

    const form = source('../components/post/post-form.tsx');
    // What it says it holds: what leaving would lose and no landed write — and, gone, the form.
    expect(form).toContain('const holding = gone || (dirty && !saved);');
    expect(form).toMatch(
      /useEffect\(\(\) => \{\s*onHoldingChange\?\.\(holding\);\s*\}, \[holding, onHoldingChange\]\);/,
    );
    expect(form).toContain('useEffect(() => () => onHoldingChange?.(false), [onHoldingChange]);');
    // Leaving asks while it is held.
    expect(form).toContain('useLeaveGuard(gone || (!pending && dirty), copy.postLeaveConfirm);');
    // The sentence on top; the title and the body read-only (selectable, never changed), and
    // nothing to send or discard.
    expect(form).toContain('{gone && <GoneNotice message={goneMessage} action={goneAction} />}');
    expect(form).toContain('goneMessage = copy.errPostGone,');
    expect(form).toContain('{restored !== null && !gone && (');
    expect(form).toMatch(/readOnly=\{gone\}\s+disabled=\{pending && !gone\}/);
    expect(form).toMatch(/disabled=\{pending \|\| gone\}\s+readOnly=\{gone\}/);
    expect(form).toMatch(/const blocked =\s+gone \|\|/);
    expect(form).toContain('{errorMessage !== undefined && !gone && (');
    expect(form).toContain('open={held.asking && props.gone !== true}');
    expect(form).toMatch(
      /\{gone \? \(\s*(?:\/\/[^\n]*\n\s*)*<Button\s+key="close"[\s\S]*?onClick=\{onClose\}\s+data-testid="post-form-close"\s*>\s*\{copy\.close\}/,
    );
    expect(form).toContain('<Alert.Description id={textId}>{message}</Alert.Description>');
    // The post going clears no draft of the tab: the form clears one only where a draft taken
    // back is taken in, or discarded.
    expect(form.match(/clearSessionPostDraft\(/g)).toHaveLength(2);
    expect(form).not.toContain('postDraftLanded');

    const editor = source('../components/post/post-editor.tsx');
    expect(editor).toContain("if (readOnly) dom.setAttribute('aria-readonly', 'true');");
    expect(editor).toContain('if (!disabled) void insertImages(files);');
    // Selected by the browser while locked: ProseMirror's triple click selected nothing there.
    expect(editor).toContain('mousedown: (view) => !view.editable,');
  });

  it('puts an upload landing in the form it holds in after the selection, and sends no more files: the held state, not the lock (오너 결정 2026-10-25 (2차), 9-53)', () => {
    // Locking stops the writer, not `insertContentAt`: an upload landing after the post went put
    // its image over a line selected when it was picked (Codex review of #219, round 6). Now it
    // goes in after what is selected, the selection kept to what it held (`insertHeldImage`,
    // post-editor.test.ts), and no file leaves after it; `uploadImageBatch` tells `insert` whether
    // the form is held and stops the turns (post-editor.test.ts). Here, that the editor's `held`
    // is the form's `readOnly` — never `isEditable`, which a send in flight sets too — that a
    // send again after a 429 asks only whether the editor is there (the upload on its way), and
    // that the inserts go through `place`.
    const editor = readFileSync(
      new URL('../components/post/post-editor.tsx', import.meta.url),
      'utf8',
    );
    expect(editor).toContain('const heldRef = useRef(readOnly);');
    expect(editor).toMatch(
      /useLayoutEffect\(\(\) => \{\s*heldRef\.current = readOnly;\s*\}, \[readOnly\]\);/,
    );
    expect(editor).toContain('const alive = () => !editor.isDestroyed;');
    expect(editor).toContain('const held = () => heldRef.current;');
    expect(editor).toContain('const sendsMore = () => alive() && !held();');
    expect(editor).not.toMatch(/editor\.isEditable|\.isEditable\(/);
    // A pick whose dialog was open as the post went, and each file's turn.
    expect(editor).toContain('if (!sendsMore()) return;');
    expect(editor).toMatch(/uploadImageBatch\(batch\.sending, slots, sends, \{\s*alive,\s*held,/);
    // A wait to send again: the file on its way is sent again in a held form too (오너 결정
    // 2026-10-25 (2차) «남긴 양식에 넣음»), given up only by an editor gone — as the image of what
    // the editor writes (`imagePurpose`, #185: a post's or a notice's).
    expect(editor).toMatch(
      /sendRetrying\(\(\) => upload\(picked, accountId, imagePurpose\), \{\s*sleep: pause,\s*alive,\s*\}\)/,
    );
    expect(editor).not.toContain('alive: sendsMore');
    expect(editor.match(/sendsMore\(\)/g)).toHaveLength(1);
    // The inserts, the preview with them, inside `place`: held, after the selection, the selection
    // kept to what it held and the focus left as it is (`insertHeldImage`); else over a text
    // selection, as before. The form hears of the preview only for an image that went in.
    const place = editor.indexOf('const placed = place((heldNow) => {');
    const preview = editor.indexOf(
      'if (placed && preview !== undefined) onPreview?.(uploaded.id, preview);',
    );
    expect(place).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(place);
    const placing = editor.slice(place, preview);
    expect(editor.match(/insertContentAt\(/g)).toHaveLength(1);
    expect(placing.match(/insertContentAt\(/g)).toHaveLength(1);
    expect(editor.match(/insertHeldImage\(/g)).toHaveLength(1);
    expect(placing).toMatch(
      /if \(heldNow\) \{[\s\S]*?editor\s*\.chain\(\)\s*\.command\(\(\{ tr \}\) => \{\s*insertHeldImage\(tr, image\);\s*return true;\s*\}\)\s*\.run\(\);\s*return;\s*\}/,
    );
    expect(placing.match(/\.focus\(\)/g)).toHaveLength(1);
    expect(placing.indexOf('.focus()')).toBeGreaterThan(placing.indexOf('return;'));
    expect(placing.indexOf('insertContentAt(')).toBeGreaterThan(placing.indexOf('return;'));
    expect(editor.match(/previews\.set\(uploaded\.id, preview\)/g)).toHaveLength(1);
    expect(placing.indexOf('previews.set(uploaded.id, preview)')).toBeGreaterThan(-1);
    expect(placing.indexOf('previews.set(uploaded.id, preview)')).toBeLessThan(
      placing.indexOf('insertHeldImage('),
    );
    // A drop and the toolbar stay shut while the editor is locked, held or sending.
    expect(editor).toContain('if (!disabled) void insertImages(files);');
  });

  it('takes the body’s baseline as the editor is mounted, before any key can reach it (ADR-0073 9-52)', () => {
    // TipTap runs `create` a task after it makes the view, which may be on the page by then: a key
    // pressed before it went into the baseline and counted as no change, so a form whose post went
    // could hold nothing for it. `mount` runs as the view is made, in TipTap's constructor.
    const editor = readFileSync(
      new URL('../components/post/post-editor.tsx', import.meta.url),
      'utf8',
    );
    expect(editor).not.toContain('onCreate');
    expect(editor).toMatch(
      /onMount: \(\{ editor: made \}\) => \{\s*if \(settled\.has\(made\)\) return;\s*settled\.add\(made\);[\s\S]*?made\.view\.dispatch\(made\.state\.tr\.setMeta\('addToHistory', false\)\);\s*onReady\?\.\(made\.getJSON\(\)\);\s*\},/,
    );
    const form = readFileSync(new URL('../components/post/post-form.tsx', import.meta.url), 'utf8');
    expect(form).toMatch(/onReady=\{\(json\) => \{\s*baseline\.current = JSON\.stringify\(json\);/);
  });
});

describe('an edit screen whose post an operator hides (postEditHidden, 오너 결정 2026-10-25 «숨김에도 글자를 남김», ADR-0081 7-29)', () => {
  const postMarket = {
    id: '6f1c0f5e-8a0e-4f8b-9d7e-2b1a3c4d5e6f',
    slug: 'rate-cut',
    title: '금리 인하',
    status: 'open',
    category: { slug: 'economy', nameKo: '경제' },
  } as const;
  const id = POST.toLowerCase();
  const published: PublishedPost = {
    state: 'published',
    id,
    title: '고칠 글',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '근거 한 줄' }] }],
    },
    author: member(),
    market: postMarket,
    createdAt: '2026-10-19T00:00:00.000Z',
    editedAt: null,
    commentCount: 1,
    likeCount: 0,
  };
  const hidden: Post = { state: 'hidden', id, market: postMarket, commentCount: 1 };
  const deleted: Post = { state: 'deleted', id, market: postMarket, commentCount: 1 };
  const heldHidden = { gone: false, hidden: true, held: true };
  const closedHidden = { gone: false, hidden: true, held: false };
  const heard = (now: { gone?: boolean; hidden?: boolean; formHolding: boolean }) => ({
    gone: false,
    hidden: false,
    ...now,
  });

  it('hears a read that puts a hidden post’s placeholder in place of the post the screen had published — never on a screen opened on it, and never a deletion', () => {
    expect(postEditHidden(published, hidden)).toBe(true);
    // Opened on the hidden post: nothing was published on this screen — #45-5's refusal, as a
    // reload draws it.
    expect(postEditHidden(undefined, hidden)).toBe(false);
    expect(postEditHidden(published, { ...published, title: '다른 탭에서 고친 글' })).toBe(false);
    // A hidden post its author deleted is deleted (the API's `publicStateOf`).
    expect(postEditHidden(published, deleted)).toBe(false);
    expect(postEditDeleted(published, hidden)).toBe(false);
  });

  it('keeps the form, held, when it holds something of the writer’s as the post is hidden, under the refusal’s sentence; one holding nothing is the refusal at once (오너 결정 2026-10-25 «이대로» for #46)', () => {
    const held = postEditGoneAfter(POST_EDIT_ON_SCREEN, heard({ hidden: true, formHolding: true }));
    expect(held).toEqual(heldHidden);
    expect(postEditHeldMessage(held)).toBe('운영 정책에 따라 숨긴 글은 고칠 수 없습니다.');
    expect(postEditHeldMessage(held)).toBe(copy.errPostNotEditable);
    expect(
      postEditGoneAfter(POST_EDIT_ON_SCREEN, heard({ hidden: true, formHolding: false })),
    ).toEqual(closedHidden);
    // A deletion's held form says the deletion's.
    expect(postEditHeldMessage({ gone: true, hidden: false, held: true })).toBe(copy.errPostGone);
  });

  it('is held until it is closed or the form leaves the screen — through a read that finds the hiding cancelled, too', () => {
    const held = postEditGoneAfter(POST_EDIT_ON_SCREEN, heard({ hidden: true, formHolding: true }));
    expect(postEditGoneAfter(held, heard({ hidden: true, formHolding: true }))).toBe(held);
    // An operator cancelled the hiding meanwhile: the form stays as it is until it is closed.
    expect(postEditGoneAfter(held, heard({ hidden: false, formHolding: true }))).toBe(held);
    // The form taken away under it (the gate's sign-in prompt for a session gone, say).
    expect(postEditGoneAfter(held, heard({ hidden: true, formHolding: false }))).toEqual(
      closedHidden,
    );
    expect(postEditClosed(held)).toEqual(closedHidden);
    expect(postEditClosed(closedHidden)).toBe(closedHidden);
    expect(postEditClosed(POST_EDIT_ON_SCREEN)).toBe(POST_EDIT_ON_SCREEN);
  });

  it('closed, stays the hidden post’s refusal while the reads say it hidden, and is over once one does not: the form is the post’s again, and a later hiding holds again', () => {
    // The closed form's last word ('holding') changes nothing: it is not taken up later.
    expect(postEditGoneAfter(closedHidden, heard({ hidden: true, formHolding: true }))).toBe(
      closedHidden,
    );
    expect(postEditGoneAfter(closedHidden, heard({ hidden: true, formHolding: false }))).toBe(
      closedHidden,
    );
    expect(postEditGoneAfter(closedHidden, heard({ hidden: false, formHolding: false }))).toBe(
      POST_EDIT_ON_SCREEN,
    );
    expect(
      postEditGoneAfter(POST_EDIT_ON_SCREEN, heard({ hidden: true, formHolding: true })),
    ).toEqual(heldHidden);
  });

  it('gives way to a deletion, which nothing undoes: a held form stays held under the deletion’s sentence and closes to what a reload of the deleted post draws; a closed one is that at once', () => {
    const goneHeld = { gone: true, hidden: false, held: true };
    const goneClosed = { gone: true, hidden: false, held: false };
    expect(postEditGoneAfter(heldHidden, heard({ gone: true, formHolding: true }))).toEqual(
      goneHeld,
    );
    expect(postEditGoneAfter(closedHidden, heard({ gone: true, formHolding: false }))).toEqual(
      goneClosed,
    );
    // One read says one of them; were both heard, the deletion comes first, as on the API.
    expect(
      postEditGoneAfter(
        POST_EDIT_ON_SCREEN,
        heard({ gone: true, hidden: true, formHolding: true }),
      ),
    ).toEqual(goneHeld);
    expect(postEditGoneAfter(goneClosed, heard({ hidden: true, formHolding: true }))).toBe(
      goneClosed,
    );
  });

  it('says in the form’s place what a reload of the edit screen says: the refusal for a hidden post, the placeholder for a deleted one', () => {
    expect(postEditUnavailableMessage('hidden')).toBe(copy.errPostNotEditable);
    expect(postEditUnavailableMessage('deleted')).toBe(copy.postDeletedPlaceholder);
  });

  it('puts the way to 조치·신고 내역 under the hiding’s refusal wherever the edit screen says it — in the form’s place, atop a held form, under the form for a refused save — and under no deletion’s (오너 결정 2026-10-25 «링크를 둠», #186, ADR-0084)', () => {
    // No component renders under node: the wiring is pinned in the source, as above. The link is
    // the restriction's refusal's own («제한 거절 문구와 같은 꼴»): `RestrictedModerationLink`, to
    // MY_MODERATION_PATH with '조치·신고 내역 보기', under the edit screen's own test id.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const edit = source('../app/community/posts/[postId]/edit/edit-screen.tsx');
    expect(edit).toMatch(
      /function HiddenModerationLink\(\) \{\s*return <RestrictedModerationLink data-testid="post-edit-hidden-moderation" \/>;\s*\}/,
    );
    // Each of the three places draws it for a hiding alone: the placeholder of a post deleted with
    // comments under it (#48) and a deletion's held form say the deletion's sentence, with nothing
    // under it.
    expect(edit.match(/<HiddenModerationLink \/>/g)).toHaveLength(3);
    expect(edit).toContain(
      "action={shown.state === 'hidden' ? <HiddenModerationLink /> : undefined}",
    );
    expect(edit).toContain('heldHidden={state.hidden}');
    expect(edit).toContain('goneAction={heldHidden ? <HiddenModerationLink /> : undefined}');
    // Under the refusal's own line, for the save refused as the hiding's
    // (`postWriteErrorMessage` → '운영 정책에 따라 숨긴 글은 고칠 수 없습니다.') — and no other.
    expect(edit).toMatch(
      /errorAction=\{\s*isApiError\(update\.error, 'POST_NOT_EDITABLE'\) \? <HiddenModerationLink \/> : undefined\s*\}/,
    );
    const hiding = new ApiError(409, {
      code: 'POST_NOT_EDITABLE',
      message: 'x',
      details: { reason: 'hidden' },
    });
    expect(postWriteErrorMessage(hiding, formatKst)).toBe(copy.errPostNotEditable);
    for (const code of ['NOT_FOUND', 'FORBIDDEN', 'RESTRICTED', 'WRITE_LIMITED'] as const) {
      const refused = new ApiError(code === 'NOT_FOUND' ? 404 : 403, {
        code,
        message: 'x',
        details: code === 'RESTRICTED' ? { kind: 'writing', endsAt: null } : {},
      });
      expect(isApiError(refused, 'POST_NOT_EDITABLE'), code).toBe(false);
      expect(postWriteErrorMessage(refused, formatKst), code).not.toBe(copy.errPostNotEditable);
    }
    // The three sentences it goes under are that one sentence.
    expect(postEditUnavailableMessage('hidden')).toBe(copy.errPostNotEditable);
    expect(postEditHeldMessage({ gone: false, hidden: true, held: true })).toBe(
      copy.errPostNotEditable,
    );

    const form = source('../components/post/post-form.tsx');
    // Atop a held form: under the sentence, outside the description that names the notice.
    expect(form).toMatch(
      /<Alert\.Description id=\{textId\}>\{message\}<\/Alert\.Description>\s*\{action\}\s*<\/Alert\.Content>/,
    );
    // Under the refusal's line: inside its alert, after the sentence.
    expect(form).toMatch(
      /<RefusalText message=\{errorMessage\} restricted=\{errorRestricted\} \/>\s*<\/Alert\.Description>\s*\{errorAction\}/,
    );

    const link = source('../components/moderation/refusal-text.tsx');
    expect(link).toContain("'data-testid': testId = 'restricted-moderation-link',");
    expect(link).toMatch(
      /<NextLink href=\{MY_MODERATION_PATH\} data-testid=\{testId\}>\s*\{copy\.myModerationOpen\}/,
    );
  });
});

describe('a post taken from under an open screen: one rule for its page and its edit screen (#46 postGoneAfter, #48 held texts, #50 hiding — ADR-0081 7-29)', () => {
  const postMarket = {
    id: '6f1c0f5e-8a0e-4f8b-9d7e-2b1a3c4d5e6f',
    slug: 'rate-cut',
    title: '금리 인하',
    status: 'open',
    category: { slug: 'economy', nameKo: '경제' },
  } as const;
  const id = POST.toLowerCase();
  const published: PublishedPost = {
    state: 'published',
    id,
    title: '열어 둔 글',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '근거 한 줄' }] }],
    },
    author: member(),
    market: postMarket,
    createdAt: '2026-10-19T00:00:00.000Z',
    editedAt: null,
    commentCount: 1,
    likeCount: 0,
  };
  const ok = { isError: false, error: null };
  // What the query holds after each read, and how that read went: NOT_FOUND keeps the post read
  // before; a placeholder is a 200.
  const reads = [
    {
      name: 'deleted with nothing under it (NOT_FOUND)',
      read: { isError: true, error: refusal(404, 'NOT_FOUND') },
      data: published as Post,
      page: copy.postNotFound,
      box: copy.errPostGone,
      held: copy.errPostGone,
      closed: copy.postNotFound,
    },
    {
      name: 'deleted with comments under it (#48)',
      read: ok,
      data: { state: 'deleted', id, market: postMarket, commentCount: 1 } as Post,
      page: copy.postDeletedPlaceholder,
      box: copy.commentClosedPostDeleted,
      held: copy.errPostGone,
      closed: copy.postDeletedPlaceholder,
    },
    {
      name: 'hidden by an operator (#50)',
      read: ok,
      data: { state: 'hidden', id, market: postMarket, commentCount: 1 } as Post,
      page: copy.postHiddenPlaceholder,
      box: copy.commentClosedPostHidden,
      held: copy.errPostNotEditable,
      closed: copy.errPostNotEditable,
    },
  ];

  it.each(reads)(
    '$name: the page draws what a reload draws and holds the comment boxes’ texts with why; the edit screen holds its form with why, and closes to what a reload draws',
    ({ read, data, page, box, held, closed }) => {
      // The post page (post-screen.tsx): gone only on NOT_FOUND — it then waits for the texts it
      // holds apart, and its 404 comes once they are closed; a placeholder is drawn at once in the
      // post's place, its comments under it, as a reload draws it.
      const gone = postGoneAfter(false, read);
      expect(gone).toBe(data.state === 'published');
      expect(gone ? copy.postNotFound : postPlaceholderMessage(data.state as 'deleted')).toBe(page);
      // A new 댓글's box with text in it goes, and its text is held with why until it is closed
      // (`goneBoxReason`, comments-section.tsx's `postState`).
      expect(
        goneBoxReason({ kind: 'post' }, { postState: gone ? 'gone' : data.state, threads: [] }),
      ).toBe(box);

      // The edit screen (edit-screen.tsx), its form holding something of the writer's.
      const notFound = postGoneAfter(false, read);
      const now = {
        gone: notFound || postEditDeleted(published, data),
        hidden: postEditHidden(published, data),
      };
      const state = postEditGoneAfter(POST_EDIT_ON_SCREEN, { ...now, formHolding: true });
      expect(state.held).toBe(true);
      expect(postEditHeldMessage(state)).toBe(held);
      // 닫기 — and at once for a form holding nothing: what the screen draws in the form's place.
      const shownAfter = (after: typeof state) =>
        after.gone && !after.held && notFound
          ? copy.postNotFound
          : postEditUnavailableMessage(data.state as 'deleted');
      const after = postEditClosed(state);
      expect(after.held).toBe(false);
      expect(shownAfter(after)).toBe(closed);
      const atOnce = postEditGoneAfter(POST_EDIT_ON_SCREEN, { ...now, formHolding: false });
      expect(atOnce.held).toBe(false);
      expect(shownAfter(atOnce)).toBe(closed);
      // A reload: the server's 404 for NOT_FOUND (page.tsx's `notFound()`), else a screen opened
      // on the placeholder, which hears nothing taken from under it.
      if (!notFound) {
        const reloaded = postEditGoneAfter(POST_EDIT_ON_SCREEN, {
          gone: postEditDeleted(undefined, data),
          hidden: postEditHidden(undefined, data),
          formHolding: false,
        });
        expect(reloaded).toBe(POST_EDIT_ON_SCREEN);
        expect(postEditUnavailableMessage(data.state as 'deleted')).toBe(closed);
      }
    },
  );

  it('keeps the post through a read that fails otherwise, on both screens', () => {
    const failed = { isError: true, error: refusal(503, 'INTERNAL') };
    expect(postGoneAfter(false, failed)).toBe(false);
    expect(
      postEditGoneAfter(POST_EDIT_ON_SCREEN, {
        gone: postGoneAfter(false, failed) || postEditDeleted(published, published),
        hidden: postEditHidden(published, published),
        formHolding: true,
      }),
    ).toBe(POST_EDIT_ON_SCREEN);
  });

  it('a writing restriction’s refusal of the save (RESTRICTED, #185) takes nothing from under the form: the edit screen stays on screen, and its form editable under the refusal with its end and the way to 조치·신고 내역 (ADR-0082 결과 5 «다시 쌓기(2026-10-25)»)', () => {
    const endsAt = '2026-10-31T00:00:00.000Z';
    const zone = (iso: string) => `<${iso}>`;
    const restricted = refusal(403, 'RESTRICTED', { kind: 'writing', endsAt });
    // The server asks the writer before the post (ADR-0082 7-5): the refusal says nothing about the
    // post — published, hidden or deleted meanwhile — so the post is not read again for it
    // (`updatePostOptions`: POST_NOT_EDITABLE and NOT_FOUND only), and the query keeps the post
    // the form was drawn from. Nor would a read so refused be the post gone.
    expect(postGoneAfter(false, { isError: true, error: restricted })).toBe(false);
    const state = postEditGoneAfter(POST_EDIT_ON_SCREEN, {
      gone: postGoneAfter(false, ok) || postEditDeleted(published, published),
      hidden: postEditHidden(published, published),
      formHolding: true,
    });
    expect(state).toBe(POST_EDIT_ON_SCREEN);
    expect(state.held).toBe(false);
    // The form's refusal line (not a held form's notice): the restriction with its end, and the
    // way to 조치·신고 내역 under it (`errorRestricted`) — neither a deletion's nor a hiding's.
    const message = postWriteErrorMessage(restricted, zone);
    expect(message).toBe(`${copy.errRestrictedWriting}(<${endsAt}>까지).`);
    expect(message).not.toBe(copy.errPostGone);
    expect(message).not.toBe(copy.errPostNotEditable);
    expect(refusalOf(restricted, message)).toEqual({ message, restricted: true });
    // The wiring, pinned in the source as above: the held form (`gone`) follows the post's reads
    // alone, and a refused save goes to the form's refusal line; the post is read again after a
    // refused save for a hiding or a deletion alone.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const edit = source('../app/community/posts/[postId]/edit/edit-screen.tsx');
    expect(edit).toContain('gone={held}');
    expect(edit).toMatch(
      /errorMessage=\{refusal\?\.message\}\s*errorRestricted=\{refusal\?\.restricted\}/,
    );
    expect(edit).toContain('setRefusal(refusalOf(error, postWriteErrorMessage(error, format)))');
    const hooks = source('../hooks/use-posts.ts');
    expect(hooks).toMatch(
      /\/\/ Hidden or deleted meanwhile: the page is read again so it shows what the post is now\.\s*if \(isApiError\(error, 'POST_NOT_EDITABLE'\) \|\| isApiError\(error, 'NOT_FOUND'\)\) \{\s*await queryClient\.invalidateQueries\(\{ queryKey: postKey\(postId\), exact: true \}\);/,
    );
    // The form draws its refusal line only while it is not held (post-form.tsx): editable under it.
    const form = source('../components/post/post-form.tsx');
    expect(form).toContain('{errorMessage !== undefined && !gone && (');
    expect(form).toContain('readOnly={gone}');
  });

  it('a write limit’s refusal of the save (WRITE_LIMITED, #187 — edits, 10 in 10 minutes) takes nothing from under the form either: the edit screen stays on screen, and its form editable under the limit and the time it can be edited again, with no way to 조치·신고 내역 (ADR-0083 결과 5 «다시 쌓기(2026-10-25)»)', () => {
    const edits = limited('edits_10m', 10, 540);
    // The server counts an edit only once it found the post the writer's own and not hidden, and
    // only an edit that changes it (ADR-0083 7-4): the refusal says the post was there to edit. It
    // is not one the post is read again for (the hook's test, pinned above: POST_NOT_EDITABLE and
    // NOT_FOUND only), so the query keeps the post the form was drawn from; nor would a read so
    // refused be the post gone.
    expect(isApiError(edits, 'POST_NOT_EDITABLE') || isApiError(edits, 'NOT_FOUND')).toBe(false);
    expect(postGoneAfter(false, { isError: true, error: edits })).toBe(false);
    const state = postEditGoneAfter(POST_EDIT_ON_SCREEN, {
      gone: postGoneAfter(false, ok) || postEditDeleted(published, published),
      hidden: postEditHidden(published, published),
      formHolding: true,
    });
    expect(state).toBe(POST_EDIT_ON_SCREEN);
    expect(state.held).toBe(false);
    // The form's refusal line (not a held form's notice): the limit, and the time it can be edited
    // again in the screen's zone — neither a deletion's nor a hiding's — and, not a restriction, no
    // way to 조치·신고 내역 under it.
    const message = postWriteErrorMessage(edits, formatKst);
    expect(message).toBe(
      `${copy.errWriteLimitEdits10m} 2026. 10. 21. 오후 3:51${copy.writeLimitRetryEdit}`,
    );
    expect(message).not.toBe(copy.errPostGone);
    expect(message).not.toBe(copy.errPostNotEditable);
    expect(refusalOf(edits, message)).toEqual({ message, restricted: false });
    // The edit screen has no way of its own for it: the same wiring as the restriction's above.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('../app/community/posts/[postId]/edit/edit-screen.tsx')).not.toContain(
      'WRITE_LIMITED',
    );
    expect(source('../hooks/use-posts.ts')).not.toContain('WRITE_LIMITED');
  });

  it('is written once for the post page: its comment section hears the post as the page holds it', () => {
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const section = source('../components/post/comments-section.tsx');
    expect(section).toContain("const postState: CommentsPostState = gone ? 'gone' : post.state;");
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
      commentCount: 0,
      likeCount: 0,
    };
    const answers: (Post | null)[] = [
      published,
      { state: 'hidden', id, market: postMarket, commentCount: 0 },
      { state: 'deleted', id, market: postMarket, commentCount: 0 },
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
    const hidden = postPageMetadata({ state: 'hidden', id, market: postMarket, commentCount: 0 });
    expect(hidden.title).toBe(`${copy.postHiddenPlaceholder} | ${copy.appName}`);
    expect(hidden.description).toBeUndefined();
    const deleted = postPageMetadata({ state: 'deleted', id, market: postMarket, commentCount: 0 });
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

describe('a post body’s headings', () => {
  it('start at h3 on the post page, under its h1 and the post’s h2', () => {
    expect([1, 2, 3].map((level) => postHeadingElement(level).tag)).toEqual(['h3', 'h4', 'h5']);
    // Anything else draws as the editor's last level, as before.
    expect(postHeadingElement(7)).toEqual({ tag: 'h5', ariaLevel: 5 });
  });

  it('start at h4 under a title that is an h3 (an earlier version of a notice, #138)', () => {
    expect([1, 2, 3].map((level) => postHeadingElement(level, 4).tag)).toEqual(['h4', 'h5', 'h6']);
  });

  it('start at h5 under the operators’ page h3 and a block’s h4, past h6 as an ARIA heading', () => {
    expect([1, 2, 3].map((level) => postHeadingElement(level, 5))).toEqual([
      { tag: 'h5', ariaLevel: 5 },
      { tag: 'h6', ariaLevel: 6 },
      { tag: 'div', ariaLevel: 7 },
    ]);
  });
});

describe('a refused write', () => {
  it('names the rule the server applied', () => {
    expect(
      postWriteErrorMessage(
        refusal(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'other account' }]),
        formatKst,
      ),
    ).toBe(copy.sessionChanged);
    expect(postWriteErrorMessage(refusal(403, 'FORBIDDEN'), formatKst)).toBe(copy.errPostNotYours);
    expect(
      postWriteErrorMessage(refusal(409, 'POST_NOT_EDITABLE', { reason: 'hidden' }), formatKst),
    ).toBe(copy.errPostNotEditable);
    expect(
      postWriteErrorMessage(
        refusal(404, 'NOT_FOUND', [{ path: ['marketId'], message: 'no such market' }]),
        formatKst,
      ),
    ).toBe(copy.errPostMarketUnavailable);
    expect(postWriteErrorMessage(refusal(404, 'NOT_FOUND'), formatKst)).toBe(copy.errPostGone);
    expect(postWriteErrorMessage(refusal(409, 'ONBOARDING_REQUIRED'), formatKst)).toBe(
      copy.errPostOnboarding,
    );
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
        formatKst,
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
        formatKst,
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

  it('says a writing restriction with its end in the writer’s zone, or 무기한 — no appeal sentence (#185)', () => {
    const endsAt = '2026-10-23T06:00:00.000Z';
    const zone = (iso: string) => `<${iso}>`;
    expect(
      postWriteErrorMessage(refusal(403, 'RESTRICTED', { kind: 'writing', endsAt }), zone),
    ).toBe(`${copy.errRestrictedWriting}(<${endsAt}>까지).`);
    expect(
      postWriteErrorMessage(refusal(403, 'RESTRICTED', { kind: 'writing', endsAt: null }), zone),
    ).toBe(`${copy.errRestrictedWriting}(무기한).`);
  });

  it('says which limit refused a post or an edit, and when it can be written again (#187)', () => {
    expect(postWriteErrorMessage(limited('posts_10m', 3, 600), formatKst)).toBe(
      `${copy.errWriteLimitPosts10m} 2026. 10. 21. 오후 3:52${copy.writeLimitRetryWrite}`,
    );
    expect(postWriteErrorMessage(limited('posts_24h', 20, 7_200), formatKst)).toBe(
      `${copy.errWriteLimitPosts24h} 2026. 10. 21. 오후 5:42${copy.writeLimitRetryWrite}`,
    );
    expect(postWriteErrorMessage(limited('edits_24h', 50, 60), formatKst)).toBe(
      `${copy.errWriteLimitEdits24h} 2026. 10. 21. 오후 3:43${copy.writeLimitRetryEdit}`,
    );
    // The zone is the screen's: the time is formatted by what the page passes.
    expect(postWriteErrorMessage(limited('posts_10m', 3, 600), () => '그때')).toBe(
      `${copy.errWriteLimitPosts10m} 그때${copy.writeLimitRetryWrite}`,
    );
  });

  it('says an unreachable server apart from anything else', () => {
    expect(postWriteErrorMessage(new TypeError('Failed to fetch'), formatKst)).toBe(
      copy.errNetwork,
    );
    expect(postWriteErrorMessage(new ApiError(502, undefined), formatKst)).toBe(copy.errNetwork);
    expect(postWriteErrorMessage(refusal(500, 'INTERNAL'), formatKst)).toBe(copy.errUnknown);
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
