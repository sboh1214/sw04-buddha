import {
  postBodyRefusalOf,
  postExcerpt,
  postListQuerySchema,
  readPostDocument,
  type PostState,
} from '@buddha/shared';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import {
  type Post,
  type PostAuthor,
  type PostSummary,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { firstValue } from './market-ssr';

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
 * decision 2026-10-18); the comment and like counts come with #48 and #49 and are not drawn
 * before them.
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

/** One post page, by the canonical lower-cased uuid (the id the API answers with). */
export const postKey = (postId: string) => [...POSTS_KEY, 'post', postId.toLowerCase()] as const;

/** One page of the list as `useInfiniteQuery` holds it (the home list's page shape). */
export interface PostPage {
  items: PostSummary[];
  nextCursor: string | null;
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
 * beside a small round image — the nickname's first letter while there is no image (#141 brings
 * uploads) — and '운영자' for an account with the admin role (#45-9: operating rights only, never a
 * forecasting credential). A withdrawn author (#140) is '탈퇴한 사용자' with nothing else and no
 * link (#37-16). No author is a link yet: the public profile (#41, `/u/<publicId>`) does not exist,
 * and a link to a page that answers 404 is worse than none.
 */
export type AuthorView =
  | {
      kind: 'member';
      name: string;
      initial: string;
      imageUrl: string | null;
      isAdmin: boolean;
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
  };
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
 * What a post page shows instead of a post (#45-5): '삭제된 글입니다' for a deleted post replies
 * still hang under (none before #48) and '운영 정책에 따라 숨긴 글입니다' for a hidden one — never
 * the author or a word of the post, only its market.
 */
export function postPlaceholderMessage(state: Exclude<PostState, 'published'>): string {
  return state === 'deleted' ? copy.postDeletedPlaceholder : copy.postHiddenPlaceholder;
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
 * - VALIDATION_ERROR on `title` or on `body`, the body's told apart by `postBodyRefusalOf` (the
 *   shared module that writes the server's messages reads them): no text, too long, too many
 *   images, or an image the writer cannot use — an upload no post took is removed after
 *   ORPHAN_MEDIA_HOURS, and another post may have taken it (`refusedImageIds` names which);
 * - a request that never reached the API, and anything else.
 */
export function postWriteErrorMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'POST_NOT_EDITABLE')) return copy.errPostNotEditable;
  if (isApiError(error, 'NOT_FOUND')) {
    return validationField(error) === 'marketId' ? copy.errPostMarketUnavailable : copy.errPostGone;
  }
  if (isApiError(error, 'FORBIDDEN')) return copy.errPostNotYours;
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return copy.errPostOnboarding;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'title') return copy.errPostTitle;
    if (field === 'body') {
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
          break;
      }
    }
    return copy.errPostInvalid;
  }
  return isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown;
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
