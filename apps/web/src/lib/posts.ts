import {
  postBodyRefusalOf,
  postExcerpt,
  postListQuerySchema,
  readPostDocument,
  type MarketStatus,
  type PostState,
} from '@buddha/shared';
import { type InfiniteData } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import {
  type ApiError,
  type Post,
  type PostAuthor,
  type PostSummary,
  type PublishedPost,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { firstValue } from './market-ssr';
import { profilePath } from './profile';
import { restrictedMessage } from './restriction';
import { writeLimitedMessage } from './write-limits';

/**
 * 근거 글과 커뮤니티 (#46, ADR-0073) as the screens read them: the community list's URL and its
 * cache keys, the addresses of a post, its write and edit screens, how an author is drawn and what
 * a refused write says. Pure functions of the URL and of the API's answers, kept apart from the
 * pages and the hooks so the node test runner reaches them (the rule `market-ssr.ts` states), and
 * free of `'use client'`, so the server pages build the same keys the browser's hooks read.
 *
 * Owner decisions (ADR-0069 decision 2, #45): a post belongs to one market; the list holds every
 * market's posts newest first — the only order — filtered by market and by category and searched
 * in the title and the text (#45-7); anyone reads, signed in or not, and an account that finished
 * the onboarding writes (#57-8). A card is the title, two lines of the text without formatting, a
 * small square thumbnail of the first image, the author, the time and the market's title (owner
 * decision 2026-10-18), the comment count (#48, lib/comments.ts) and the like count (#49,
 * lib/likes.ts). Likes never order the list: newest first stays the only order (D5, #45-7).
 */

/** The community list's address (N02 §2: one of the three top-level areas, #16). */
export const COMMUNITY_PATH = '/community';

/** The write screen; `?market=<id>` names the market the post goes to. */
export const WRITE_PATH = '/community/write';

/** A post page. The id is the post's uuid, never anything that names its author. */
export function postPath(postId: string): string {
  return `/community/posts/${postId}`;
}

/** The edit screen of a post (#45-4: the title and the body, never the market). */
export function postEditPath(postId: string): string {
  return `${postPath(postId)}/edit`;
}

/** The write screen for a market, or with the market still to pick (#45-1: «두 곳 모두에서»). */
export function writePath(marketId?: string): string {
  return marketId === undefined
    ? WRITE_PATH
    : `${WRITE_PATH}?${new URLSearchParams({ market: marketId }).toString()}`;
}

// ---- the write screen's market ---------------------------------------------------------------

/** The market a new post goes to, as the write screen shows it. */
export interface WriteMarket {
  id: string;
  title: string;
  status: MarketStatus;
}

/**
 * What the write page's read of `?market=` came to (WritePage, ADR-0073 9-44): `found`; `none` —
 * no `?market=`, or one that names no public market (the API's 404, or its 400 for an id it does
 * not take: a draft, one in review or an unknown id); or `failed` — the read failed otherwise (the
 * API unreachable, a 5xx, a 429), which says nothing about the market.
 */
export type WriteMarketLookup =
  { kind: 'found'; market: WriteMarket } | { kind: 'none' } | { kind: 'failed'; marketId: string };

/**
 * Reads the market `marketId` names through `read` — `fetchMarketServer`, which answers null for
 * the API's NOT_FOUND and VALIDATION_ERROR and throws anything else — into a `WriteMarketLookup`.
 * A throw is `failed`, never `none`: a transient failure is not «no such market» (Codex review of
 * #219, round 2 — the page turned every failure into none, and the screen then put the picker in
 * the form's place, its draft gone with it).
 */
export async function lookUpWriteMarket(
  marketId: string | undefined,
  read: (id: string) => Promise<WriteMarket | null>,
): Promise<WriteMarketLookup> {
  if (marketId === undefined) return { kind: 'none' };
  try {
    const market = await read(marketId);
    return market === null
      ? { kind: 'none' }
      : { kind: 'found', market: { id: market.id, title: market.title, status: market.status } };
  } catch {
    return { kind: 'failed', marketId };
  }
}

/**
 * The market the write screen's form shows once a read of the page (`lookup`) has come, while it
 * shows `shown` (null: no form — the picker, or the failure, shows instead): the market found; no
 * form only when the API said there is no such market; and on a failure the form stays as it is —
 * with the market it shows, which is the one just picked (the screen shows a market picked at once,
 * before the page is read again) — so a read that failed for a moment never takes a draft away.
 */
export function writeMarketAfter(
  shown: WriteMarket | null,
  lookup: WriteMarketLookup,
): WriteMarket | null {
  switch (lookup.kind) {
    case 'found':
      return lookup.market;
    case 'none':
      return null;
    case 'failed':
      return shown;
  }
}

/**
 * The write screen's market, all WriteScreen holds of it: the market its form shows (`shown`;
 * null: no form) and the page's read it has taken in (`read`).
 */
export interface WriteScreenMarket {
  readonly shown: WriteMarket | null;
  readonly read: WriteMarketLookup;
}

/** What moves the write screen's market: a market picked on the screen, or a read of the page. */
export type WriteScreenEvent =
  { kind: 'picked'; market: WriteMarket } | { kind: 'read'; lookup: WriteMarketLookup };

/** The write screen's market as the page's first read (`lookup`) leaves it. */
export function writeScreenStart(lookup: WriteMarketLookup): WriteScreenMarket {
  return { shown: writeMarketAfter(null, lookup), read: lookup };
}

/**
 * The write screen's market after `event` (ADR-0073 9-44). A market picked shows at once (the
 * search read it a moment ago — its title and state), before the address follows it and the page
 * reads it again. A read of the page the screen has not taken in — a new object: the page renders
 * one per read, after a pick or a retry — settles the market shown (`writeMarketAfter`: a read that
 * failed keeps the form and its draft); the read taken in already changes nothing, so a render
 * before the address has followed a pick keeps the market picked rather than going back to the
 * one that read found. Returns `state` itself when nothing changed.
 */
export function writeScreenMarket(
  state: WriteScreenMarket,
  event: WriteScreenEvent,
): WriteScreenMarket {
  switch (event.kind) {
    case 'picked': {
      const { id, title, status } = event.market;
      return { shown: { id, title, status }, read: state.read };
    }
    case 'read':
      return event.lookup === state.read
        ? state
        : { shown: writeMarketAfter(state.shown, event.lookup), read: event.lookup };
  }
}

/**
 * What the write screen shows of its market (`market`): the form under the market shown; with no
 * form, after a read that failed, the failure and its retry; or else the picker. `back` is the
 * address the sign-in returns to (WriteGate): the market's, the failed read's included, so it
 * comes back to that market.
 */
export type WriteScreenView =
  | { kind: 'form'; market: WriteMarket; back: string }
  | { kind: 'failed'; back: string }
  | { kind: 'picker'; back: string };

export function writeScreenView(market: WriteScreenMarket): WriteScreenView {
  if (market.shown !== null) {
    return { kind: 'form', market: market.shown, back: writePath(market.shown.id) };
  }
  if (market.read.kind === 'failed') {
    return { kind: 'failed', back: writePath(market.read.marketId) };
  }
  return { kind: 'picker', back: writePath() };
}

// ---- the community list's URL --------------------------------------------------------------

/**
 * The list's filters as the URL carries them, normalised once on the server and handed down as a
 * prop — the home's rule (market-ssr.ts): the object IS the cache key, so a client that re-derived
 * it from `useSearchParams` would be one default away from a second entry. `market` is a market's
 * uuid (lower-cased), `category` a category slug on either level (a top-level one includes its
 * sub-categories, as on `GET /markets`), `q` a term searched in the title and the text.
 */
export interface CommunityFilters {
  market?: string;
  category?: string;
  q?: string;
}

/** The community page's raw `searchParams` (a repeated param arrives as an array). */
export interface CommunitySearchParams {
  market?: string | string[];
  category?: string | string[];
  q?: string | string[];
}

/** `marketId`, `category` and `q` are normalised by the API's own query schema, never a copy. */
const { marketId: marketParam, category: categoryParam, q: termParam } = postListQuerySchema.shape;

/**
 * Normalises the community URL into its filters. Nothing throws and nothing redirects: a value the
 * API would refuse — a market that is not a uuid, a blank or over-long term, a NUL the API answers
 * 400 for — is dropped, and the list shows what it shows without it.
 */
export function communityFiltersFromSearchParams(
  searchParams: CommunitySearchParams,
): CommunityFilters {
  const market = marketParam.safeParse(firstValue(searchParams.market));
  const category = categoryParam.safeParse(firstValue(searchParams.category));
  const term = termParam.safeParse(firstValue(searchParams.q));
  return {
    ...(market.success && market.data !== undefined ? { market: market.data } : {}),
    ...(category.success && category.data !== undefined ? { category: category.data } : {}),
    ...(term.success && term.data !== undefined && !term.data.includes('\u0000')
      ? { q: term.data }
      : {}),
  };
}

/** Whether any filter is on: the empty list then says no post matched, not that none exists. */
export function isFiltered(filters: CommunityFilters): boolean {
  return filters.market !== undefined || filters.category !== undefined || filters.q !== undefined;
}

/** The filters as a path: `/community`, or `/community?…` with what is picked only. */
export function communityPath(filters: CommunityFilters): string {
  const query = new URLSearchParams();
  if (filters.market !== undefined) query.set('market', filters.market);
  if (filters.category !== undefined) query.set('category', filters.category);
  if (filters.q !== undefined) query.set('q', filters.q);
  const search = query.toString();
  return search === '' ? COMMUNITY_PATH : `${COMMUNITY_PATH}?${search}`;
}

/**
 * The fields the list's search box submits beside its term: the market and the category picked, so
 * a term is searched within them (as the search screen's box refines, ADR-0066).
 */
export function communitySearchFields(filters: CommunityFilters): [string, string][] {
  const fields: [string, string][] = [];
  if (filters.market !== undefined) fields.push(['market', filters.market]);
  if (filters.category !== undefined) fields.push(['category', filters.category]);
  return fields;
}

// ---- cache keys and requests -----------------------------------------------------------------

/**
 * Every post read sits under one root, so a write invalidates the lists and the post pages with
 * one call. Public — the list and a post are the same for every visitor (N05 §2) — so the pages
 * read them on the server and dehydrate them (`dehydratePublic` keeps every root but
 * `PRIVATE_QUERY_ROOTS`, and `posts` is not one).
 */
export const POSTS_KEY = ['posts'] as const;

/** The community list's pages, one entry per filter object. */
export const POST_LIST_KEY = [...POSTS_KEY, 'list'] as const;
export const communityPostsKey = (filters: CommunityFilters) =>
  [...POST_LIST_KEY, filters] as const;

/**
 * A market detail's 토론 (#47, ADR-0075): that market's posts as the list's cards, by the market's
 * lower-cased uuid. Under the lists' root rather than beside it, so every write that marks the
 * lists stale — a post written, edited or deleted (use-posts.ts), a comment that moves a card's
 * '댓글 N' (use-comments.ts) — marks the section and its count stale with them, without a line of
 * its own. Apart from `communityPostsKey`'s filter objects (`{ market }` is the community list's
 * market filter, a different request), and public like them.
 */
export const marketPostsKey = (marketId: string) =>
  [...POST_LIST_KEY, 'market', marketId.toLowerCase()] as const;

/** Every post page's entry, by prefix (`storeAuthorImage`, hooks/use-me.ts). */
export const POST_PAGE_KEY = [...POSTS_KEY, 'post'] as const;

/** One post page, by the canonical lower-cased uuid (the id the API answers with). */
export const postKey = (postId: string) => [...POST_PAGE_KEY, postId.toLowerCase()] as const;

/** One page of the list as `useInfiniteQuery` holds it (the home list's page shape). */
export interface PostPage {
  items: PostSummary[];
  nextCursor: string | null;
}

/**
 * One page of a market's 토론 (`GET /markets/:id/posts`, `CountedPageMeta`): the list's page and
 * `total`, how many posts the whole list holds — counted in the same snapshot as the page's cards
 * (ADR-0075), so one page never disagrees with itself. A later page counts again, at its own
 * moment; the section shows the first page's count, the list its 더 보기 walk continues
 * (`discussionView`, lib/discussion.ts).
 */
export interface CountedPostPage extends PostPage {
  total: number;
}

/**
 * One page of a market's 토론 as the browser's `queryFn` asks for it (the section is read in the
 * browser only, ADR-0075): the cursor when there is one, nothing else — the order is the list's
 * only one (newest first, #45-7) and the page size the API's default, 20 (ADR-0069 decision 4 #47
 * «20개씩 더 불러온다»).
 */
export function marketPostsQuery(cursor?: string): { cursor?: string } {
  return cursor === undefined ? {} : { cursor };
}

/**
 * One page of `GET /posts` as the server page and the browser's `queryFn` both ask for it, so the
 * two produce interchangeable pages under one key. A filter that is not on is left out rather than
 * sent empty: the API's query schema refuses a blank one.
 */
export function postListQuery(
  filters: CommunityFilters,
  cursor?: string,
): { marketId?: string; category?: string; q?: string; cursor?: string } {
  return {
    ...(filters.market === undefined ? {} : { marketId: filters.market }),
    ...(filters.category === undefined ? {} : { category: filters.category }),
    ...(filters.q === undefined ? {} : { q: filters.q }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

// ---- how a post is drawn ---------------------------------------------------------------------

/**
 * An author as the screens draw it (ADR-0069 decision 3, #37-3 and #37-6): the CURRENT nickname
 * beside a small round image — the profile image the member uploaded (#141, ADR-0079), the
 * nickname's first letter while there is none — and '운영자' for an account with the admin role
 * (#45-9: operating rights only, never a forecasting credential). A member's image and name lead to
 * their public profile (#41, ADR-0078: `href`, `/u/<publicId>` — the public id, so a link keeps
 * finding the member after a nickname change, #37-2). A withdrawn author (#140) is '탈퇴한 사용자' with
 * nothing else and no link (#37-16).
 */
export type AuthorView =
  | {
      kind: 'member';
      name: string;
      initial: string;
      imageUrl: string | null;
      isAdmin: boolean;
      /** The author's public profile. */
      href: string;
    }
  | { kind: 'former'; name: string; initial: string };

/** The first character of a name as a person reads it (a whole emoji, a capital Latin letter). */
export function nameInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? '';
  return first.toLocaleUpperCase('ko-KR');
}

export function authorView(author: PostAuthor): AuthorView {
  if (author.kind === 'former_member') {
    return { kind: 'former', name: copy.postAuthorFormer, initial: '' };
  }
  return {
    kind: 'member',
    name: author.nickname,
    initial: nameInitial(author.nickname),
    imageUrl: author.imageUrl,
    isAdmin: author.isAdmin,
    href: profilePath(author.publicId),
  };
}

// ---- a member's new image on what is held ---------------------------------------------------

/**
 * `items` with `map` applied to each, or `items` itself when `map` changed none of them (returned
 * each as it was): a cache write that changed nothing writes nothing.
 */
export function mapKept<T>(items: T[], map: (item: T) => T): T[] {
  let changed = false;
  const mapped = items.map((item) => {
    const next = map(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? mapped : items;
}

/**
 * `author` with the profile image the member `publicId` has now (#141, ADR-0079 7-21): its
 * address, or null once deleted. Any other author — another member, a withdrawn one — and a face
 * already at that address is returned as it is, the same object.
 */
export function withAuthorImage(
  author: PostAuthor,
  publicId: string,
  imageUrl: string | null,
): PostAuthor {
  return author.kind === 'member' && author.publicId === publicId && author.imageUrl !== imageUrl
    ? { ...author, imageUrl }
    : author;
}

/**
 * A post page (`postKey`) with the member's new image on its byline (`withAuthorImage`); a
 * placeholder names no author, and is returned as it is.
 */
export function postWithAuthorImage(post: Post, publicId: string, imageUrl: string | null): Post {
  if (post.state !== 'published') return post;
  const author = withAuthorImage(post.author, publicId, imageUrl);
  return author === post.author ? post : { ...post, author };
}

/**
 * The cards' pages — the community list's (`communityPostsKey`) and a market's 토론
 * (`marketPostsKey`, with its `total`) — with the member's new image on every card of theirs
 * (`withAuthorImage`); the pages themselves, when no card is theirs or each already shows it.
 */
export function postPagesWithAuthorImage<P extends PostPage>(
  held: InfiniteData<P>,
  publicId: string,
  imageUrl: string | null,
): InfiniteData<P> {
  const pages = mapKept(held.pages, (page) => {
    const items = mapKept(page.items, (card) => {
      const author = withAuthorImage(card.author, publicId, imageUrl);
      return author === card.author ? card : { ...card, author };
    });
    return items === page.items ? page : { ...page, items };
  });
  return pages === held.pages ? held : { ...held, pages };
}

/**
 * What names a post that has no title (#45-1: the title is optional) where a heading has to: the
 * first non-empty line of its text — the card's link name, the post page's hidden `h2` — so a
 * screen reader's list of headings reaches every post, titled or not.
 */
export function postFirstLine(text: string): string {
  return postExcerpt(text).split('\n')[0] ?? '';
}

/**
 * Where a post body's headings start (the level of the editor's 제목 1): 3 on the post page and a
 * notice's, under the page's `h1` and the title's `h2` (A-M4-31); 4 under a title that is an `h3` —
 * an earlier version of a notice on the admin's screen (#138); 5 where the body sits deeper still —
 * the operators' moderation page, under its `h3` and a block's `h4` (#50, ADR-0081).
 */
export type PostHeadingStart = 3 | 4 | 5;

/**
 * The element a body heading of `level` (the editor's 1–3; anything else as 3) is drawn as, the
 * levels counted on from `from` — h3/h4/h5, h4/h5/h6, or h5/h6 and, past HTML's last heading, a
 * `div` with `role="heading"` and `aria-level` 7 — so a screen reader's outline keeps the post's
 * headings under the page's own wherever the body sits.
 */
export function postHeadingElement(
  level: number,
  from: PostHeadingStart = 3,
): { tag: 'h3' | 'h4' | 'h5' | 'h6' | 'div'; ariaLevel: number } {
  const depth = level === 1 || level === 2 || level === 3 ? level : 3;
  const ariaLevel = from + depth - 1;
  const tags = { 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const;
  return {
    tag: ariaLevel <= 6 ? tags[ariaLevel as keyof typeof tags] : 'div',
    ariaLevel,
  };
}

/**
 * Whether the viewer wrote the post: its author's public id is the viewer's (`Me.profile.publicId`,
 * never the account id, which no public answer carries — ADR-0069 decision 5). Decides only
 * whether the screen offers 수정 and 삭제; the server checks the author on every write.
 */
export function isOwnPost(author: PostAuthor, viewerPublicId: string | undefined): boolean {
  return (
    viewerPublicId !== undefined && author.kind === 'member' && author.publicId === viewerPublicId
  );
}

/**
 * What a post page shows instead of a post (#45-5): '삭제된 글입니다' for a deleted post comments
 * still hang under (#48) and '운영 정책에 따라 숨긴 글입니다' for a hidden one — never the author or
 * a word of the post, only its market and its comments.
 */
export function postPlaceholderMessage(state: Exclude<PostState, 'published'>): string {
  return state === 'deleted' ? copy.postDeletedPlaceholder : copy.postHiddenPlaceholder;
}

/**
 * What the edit screen says in its form's place for a post that is not published (#45-5): for a
 * hidden one the refusal, '운영 정책에 따라 숨긴 글은 고칠 수 없습니다.' — the sentence of a save
 * refused for it, and of a held form while the post is hidden under it (#50, ADR-0081 7-29) — and
 * for one deleted with comments under it its placeholder, '삭제된 글입니다.' (#48). What a reload of
 * the edit screen draws, and so what it draws once a held form is closed (`postEditClosed`).
 */
export function postEditUnavailableMessage(state: Exclude<PostState, 'published'>): string {
  return state === 'hidden' ? copy.errPostNotEditable : postPlaceholderMessage(state);
}

/**
 * Whether a post page — or its edit screen — holds its post to be gone (ADR-0073 9-50, Codex review
 * of #219, round 5), from what it held before (`gone`) and the post's read as the query has it
 * now (`read`: its `isError` and `error`). The query keeps the post it last read through a read
 * that fails, so the screen tells the failures apart itself: NOT_FOUND is the API's answer that
 * the post left every view — deleted with nothing under it (#45-5), never undone, the 404 a reload
 * gets — while any other failure (unreachable, a 5xx, a 429) says nothing about the post, and the
 * post read before stays on screen. Once gone, gone: a later read failing otherwise does not
 * bring the post back as it was last read. A post deleted with comments under it (#48) or hidden
 * by an operator (#50) has not left: a read answers its placeholder, which the post page draws in
 * the post's place as a reload does, its comments under it — the boxes that take no write there
 * any more hold their texts with why until closed (`goneBoxReason`), and no 404 waits — while the
 * edit screen, whose form no placeholder can take, hears either apart (`postEditDeleted`,
 * `postEditHidden`; ADR-0081 7-29).
 */
export function postGoneAfter(gone: boolean, read: { isError: boolean; error: unknown }): boolean {
  return gone || (read.isError && isApiError(read.error, 'NOT_FOUND'));
}

/**
 * Whether a read has put a deleted post's placeholder in place of the post an edit screen had
 * published (`published`, what its form was drawn from) — deleted in another tab while comments
 * still hang under it (#48, ADR-0074 7-35). The API answers that read with the placeholder (#45-5:
 * '삭제된 글입니다' stays at the address with its comments), not NOT_FOUND, so `postGoneAfter` does
 * not hear it, while a save is refused as NOT_FOUND all the same (only a published post is edited):
 * the post is deleted under the form as the owner's answer of 2026-10-24 means it (ADR-0073 9-52),
 * and the screen keeps what its form held the same way (`postEditGoneAfter`). Never undone: a
 * deleted post is not restored, and a later read answers the placeholder or NOT_FOUND. A screen
 * opened on the placeholder had no post published, and shows the placeholder as before.
 */
export function postEditDeleted(published: PublishedPost | undefined, read: Post): boolean {
  return published !== undefined && read.state === 'deleted';
}

/**
 * Whether a read has put a hidden post's placeholder in place of the post an edit screen had
 * published (`published`) — an operator hid it while the form was open (#50, ADR-0081 7-29). The
 * API answers that read with the placeholder (#45-5: '운영 정책에 따라 숨긴 글입니다' at the
 * address, its comments under it), never NOT_FOUND, and refuses a save as POST_NOT_EDITABLE: the
 * post is taken from under the form as a deletion takes it, and the screen keeps what its form
 * held the same way (오너 결정 2026-10-25 «숨김에도 글자를 남김», `postEditGoneAfter`), saying
 * that refusal's sentence. Unlike a deletion, a hiding is undone — an operator cancels it — so it
 * is heard only while the reads say it. A post its author deleted is deleted, hidden or not
 * (`publicStateOf`, the API): `postEditDeleted` hears that. A screen opened on the hidden post had
 * no post published, and shows #45-5's refusal as a reload draws it.
 */
export function postEditHidden(published: PublishedPost | undefined, read: Post): boolean {
  return published !== undefined && read.state === 'hidden';
}

/**
 * An edit screen whose post was taken from under its form: it left every view (오너 결정
 * 2026-10-24, ADR-0073 9-52), stands as its placeholder, deleted with comments under it (#48,
 * `postEditDeleted`), or an operator hid it (#50, `postEditHidden`, 오너 결정 2026-10-25). What it
 * draws: the form keeps what the writer had in it — the title and the body, which they can select
 * and copy but no longer change — with why ('없거나 삭제된 글입니다.', or '운영 정책에 따라 숨긴
 * 글은 고칠 수 없습니다.' for a hiding) and 닫기, until they close it (`held`); then, and at once
 * when the form held nothing of theirs, the screen is the server's page as a reload draws it: the
 * 404, the placeholder's '삭제된 글입니다.', or the hidden post's '운영 정책에 따라 숨긴 글은 고칠 수
 * 없습니다.'. The rule of #48's comment boxes (ADR-0074, 오너 결정 2026-10-20 답 4, 2026-10-21 답
 * 1·2): a box going with a changed text is held with why until it is closed, the page's 404 waits
 * for it, and one holding nothing of the writer's is not.
 */
export interface PostEditGone {
  /**
   * The post left every view (`postGoneAfter`), or a read put its placeholder in its place
   * (`postEditDeleted`): no later read brings it back.
   */
  gone: boolean;
  /**
   * An operator hid the post under the form (`postEditHidden`), and no read since has said
   * otherwise — held for that, or closed and the hidden post's refusal on screen. Never with
   * `gone`: a deletion comes first, as on the API.
   */
  hidden: boolean;
  /** The form is on screen holding what the writer had in it, until they close it. */
  held: boolean;
}

/** An edit screen whose post is there: nothing taken from under the form. */
export const POST_EDIT_ON_SCREEN: PostEditGone = { gone: false, hidden: false, held: false };

/**
 * The edit screen's `PostEditGone` once `now` is heard: whether a read says the post is gone
 * (`postGoneAfter`, `postEditDeleted`) or hidden (`postEditHidden`), and whether the form holds
 * something of the writer's (`formHolding`, the form's own word as of its last render — a changed
 * title or body, a draft taken back, an upload on its way, and no save that landed: what leaving
 * would lose). Held is decided as the post goes, by what the form held then, and is never taken up
 * later; it ends when the writer closes it (`postEditClosed`), or when the form leaves the screen
 * under it (the session gone in another tab, say: the gate's sign-in prompt in its place) — there
 * is nothing left on screen to hold. A deletion heard ends a hiding — the sentence becomes the
 * deletion's, and closing is what a reload of the deleted post draws — and is never undone. A
 * hiding held stays held through a read that finds it cancelled, until it is closed; closed, it is
 * over once a read no longer says the post hidden — the form is the post's again, as a reload
 * draws it, and a later hiding holds again what it holds then. The same object when nothing
 * changes.
 */
export function postEditGoneAfter(
  state: PostEditGone,
  now: { gone: boolean; hidden: boolean; formHolding: boolean },
): PostEditGone {
  if (state.gone) return state.held && !now.formHolding ? { ...state, held: false } : state;
  if (now.gone) return { gone: true, hidden: false, held: now.formHolding };
  if (state.hidden) {
    if (state.held) return now.formHolding ? state : { ...state, held: false };
    return now.hidden ? state : POST_EDIT_ON_SCREEN;
  }
  return now.hidden ? { gone: false, hidden: true, held: now.formHolding } : state;
}

/**
 * Why a held form (`PostEditGone`) cannot be sent, at its top — the sentence of the save refused
 * for it: '운영 정책에 따라 숨긴 글은 고칠 수 없습니다.' for a hiding (POST_NOT_EDITABLE, #50),
 * '없거나 삭제된 글입니다.' for a deletion (NOT_FOUND).
 */
export function postEditHeldMessage(state: PostEditGone): string {
  return state.hidden ? copy.errPostNotEditable : copy.errPostGone;
}

/** 닫기 on a held form (`PostEditGone`): what the post now is, as a reload draws it. */
export function postEditClosed(state: PostEditGone): PostEditGone {
  return state.held ? { ...state, held: false } : state;
}

/** Search engines cut a description around here. */
const META_DESCRIPTION_MAX = 160;

/** An untitled post's tab title: the start of its text, this many characters. */
const META_TITLE_TEXT_MAX = 40;

/**
 * The first `max` characters of `text` by code point, as the post's own limits count: a UTF-16
 * slice could cut a writer's emoji in half and leave a lone surrogate (U+FFFD on the page).
 */
const headOf = (text: string, max: number) => Array.from(text).slice(0, max).join('');

/**
 * Every answer of a post page — the post, its placeholder, and none — is kept out of search
 * engines (owner decision 2026-10-19, ADR-0073: a post page shows its author's nickname, and is not
 * indexed, as the profiles are not, #37-1). The description stays for a link a member shares.
 */
const NOT_INDEXED: Metadata['robots'] = { index: false };

/**
 * A post page's metadata (`generateMetadata` of `/community/posts/[id]`) from the post the API
 * answered, null for none: its title (or the start of its text), the start of its text as the
 * description, and `noindex` on every answer — the placeholders' and a missing post's too.
 */
export function postPageMetadata(post: Post | null): Metadata {
  if (post === null) {
    return { title: `${copy.postNotFound} | ${copy.appName}`, robots: NOT_INDEXED };
  }
  if (post.state !== 'published') {
    return {
      title: `${postPlaceholderMessage(post.state)} | ${copy.appName}`,
      robots: NOT_INDEXED,
    };
  }
  const text = postExcerpt(readPostDocument(post.body).text).replace(/\n/g, ' ');
  return {
    title: `${post.title ?? headOf(text, META_TITLE_TEXT_MAX)} | ${copy.appName}`,
    description: headOf(text, META_DESCRIPTION_MAX),
    robots: NOT_INDEXED,
  };
}

// ---- refusals ------------------------------------------------------------------------------

/**
 * What a refused write (`POST /posts`, `PUT /posts/:id`, the delete) tells the writer. The server
 * is the judge of every rule — the editor counts the same way beforehand (lib/post-editor.ts), but
 * a hand-made or a stale screen reaches these:
 * - the cookie is another account than the screen's (`expectedAccountId`): the screen is stale;
 * - POST_NOT_EDITABLE: an operator hid the post (#45-5);
 * - NOT_FOUND naming `marketId`: the market is not a public one (a draft, or gone);
 *   any other NOT_FOUND: the post was deleted meanwhile;
 * - FORBIDDEN: another account's post;
 * - ONBOARDING_REQUIRED: a consent a revision asked for again (#57-5), say — the gate follows `['me']`
 *   (a write and an edit only: deleting one's own post asks for a session alone, owner decision
 *   2026-10-19);
 * - RESTRICTED: a writing restriction (#185, ADR-0082) keeps the writer from new posts and from
 *   editing their own — what it closes and until when (in the writer's zone, `formatDate`) or
 *   무기한 (`restrictedMessage`); the form shows the way to 조치·신고 내역 under it (`isRestricted`).
 *   The server asks it before the post, so a restricted writer reads it before any refusal about
 *   the post itself. A deletion never meets it;
 * - VALIDATION_ERROR on `title` or on `body`, the body's told apart by `postBodyRefusalOf` (the
 *   shared module that writes the server's messages reads them): no text, too long, too many
 *   images, or an image the writer cannot use — an upload no post took is removed after
 *   ORPHAN_MEDIA_HOURS, and another post may have taken it (`refusedImageIds` names which);
 * - WRITE_LIMITED (#187): the person's posts or edits reached a limit — which one, and the time
 *   it can write again in the screen's zone (`formatDate`, lib/write-limits.ts);
 * - a request that never reached the API, and anything else.
 */
export function postWriteErrorMessage(error: unknown, formatDate: (iso: string) => string): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  const restricted = restrictedMessage(error, 'writing', formatDate);
  if (restricted !== undefined) return restricted;
  const limited = writeLimitedMessage(error, formatDate);
  if (limited !== undefined) return limited;
  if (isApiError(error, 'POST_NOT_EDITABLE')) return copy.errPostNotEditable;
  if (isApiError(error, 'NOT_FOUND')) {
    return validationField(error) === 'marketId' ? copy.errPostMarketUnavailable : copy.errPostGone;
  }
  if (isApiError(error, 'FORBIDDEN')) return copy.errPostNotYours;
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return copy.errPostOnboarding;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'title') return copy.errPostTitle;
    if (field === 'body') return postBodyErrorMessage(error);
    return copy.errPostInvalid;
  }
  return isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown;
}

/**
 * What a VALIDATION_ERROR on a body the post editor wrote says — a post's (`postWriteErrorMessage`)
 * or a notice's (#138, lib/notices.ts) — told apart by `postBodyRefusalOf`: no text, too long, too
 * many images, or an image the writer cannot use; anything else is an invalid post. Never a writing
 * restriction's (#185): a notice's write never meets one (ADR-0082), so it needs no zone to say an
 * end in.
 */
export function postBodyErrorMessage(error: ApiError): string {
  switch (postBodyRefusalOf(validationMessage(error) ?? '')?.kind) {
    case 'empty':
      return copy.errPostBodyEmpty;
    case 'too_long':
      return copy.errPostBodyTooLong;
    case 'too_many_images':
      return copy.errPostTooManyImages;
    case 'image_not_usable':
      return copy.errPostImageUnusable;
    case undefined:
      return copy.errPostInvalid;
  }
}

/**
 * The images a refused write could not use, by media id: the server names each in an issue of its
 * VALIDATION_ERROR on `body` (`postImageNotUsableMessage`). The editor draws a border on them, so
 * the writer sees which of up to ten images to put in again. Empty for any other answer.
 */
export function refusedImageIds(error: unknown): string[] {
  if (!isApiError(error, 'VALIDATION_ERROR') || !Array.isArray(error.details)) return [];
  return (error.details as { message?: unknown }[]).flatMap((issue) => {
    const refusal =
      typeof issue.message === 'string' ? postBodyRefusalOf(issue.message) : undefined;
    return refusal?.kind === 'image_not_usable' ? [refusal.mediaId] : [];
  });
}

/** A list or a post page that could not be read: unreachable or not (N02 §3, as the search). */
export function postReadErrorMessage(error: unknown): string {
  return isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown;
}
