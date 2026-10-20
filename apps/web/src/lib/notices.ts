import {
  type NoticeListState,
  postExcerpt,
  readPostDocument,
  type PostDocument,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, isApiUnreachable, validationField } from './api';
import { postWriteErrorMessage } from './posts';

/**
 * 운영 공지 (#138, ADR-0077) as the screens read them: the addresses of a notice and of the admin
 * screens, the cache keys, and what a refused admin write says. Pure functions, kept apart from
 * the pages and the hooks so the node test runner reaches them, and free of `'use client'` so the
 * server pages build the keys the browser's hooks read (the rule lib/posts.ts states).
 *
 * Owner decisions (ADR-0069 decision 2 #45-8 and decision 4 #138): operators write notices — a
 * required title and a body in the posts' editor — and pin at most NOTICE_PIN_LIMIT of them in the
 * fixed area above the community list, and only there; nothing unpins one but an admin, and an
 * unpinned notice stays on the admin screen to be pinned again. A notice is written by '운영팀',
 * never by an operator's nickname, shows '수정됨' once edited and takes no comments, likes or
 * reports. Every write, edit, pin and unpin records its admin and time (the API's `admin_actions`).
 */

// ---- addresses -----------------------------------------------------------------------------

/**
 * A notice page: under the community, whose fixed area links to it (this PR's choice — a page of
 * its own rather than a row that opens in place, ADR-0077). The id is the notice's uuid.
 */
export function noticePath(noticeId: string): string {
  return `/community/notices/${noticeId}`;
}

/** The admin screen: the pinned notices and the others, each to pin, unpin or edit. */
export const ADMIN_NOTICES_PATH = '/admin/notices';

/** The admin's write screen for a new notice. */
export const ADMIN_NOTICE_NEW_PATH = '/admin/notices/new';

/** The admin's edit screen of a notice, with its pin and unpin. */
export function adminNoticePath(noticeId: string): string {
  return `${ADMIN_NOTICES_PATH}/${noticeId}`;
}

// ---- cache keys ----------------------------------------------------------------------------

/**
 * Every public notice read sits under one root, so an admin write marks it stale with one call.
 * Public — the same for every visitor, no person in it — so the community page reads the pinned
 * notices on the server and dehydrates them (`dehydratePublic` keeps every root but
 * `PRIVATE_QUERY_ROOTS`, and `notices` is not one).
 */
export const NOTICES_KEY = ['notices'] as const;

/** The fixed area's notices (`GET /notices`): every pinned one, the latest pinned first. */
export const PINNED_NOTICES_KEY = [...NOTICES_KEY, 'pinned'] as const;

/**
 * The admin screens' reads, under the private `['admin']` root (never fetched on the server, never
 * dehydrated): one list per state and one notice per id, so a write invalidates both lists with
 * one call and seeds the notice it answered with.
 */
export const ADMIN_NOTICES_KEY = ['admin', 'notices'] as const;
export const adminNoticeListKey = (state: NoticeListState) =>
  [...ADMIN_NOTICES_KEY, 'list', state] as const;
export const adminNoticeKey = (noticeId: string) =>
  [...ADMIN_NOTICES_KEY, 'notice', noticeId.toLowerCase()] as const;

/**
 * One page of an admin list as the browser's `queryFn` asks for it: the state and, after the first
 * page, the cursor — the order is the API's (pinned: the latest pinned first; unpinned: the newest
 * written first) and the page size its default.
 */
export function adminNoticeListQuery(
  state: NoticeListState,
  cursor?: string,
): { state: NoticeListState; cursor?: string } {
  return cursor === undefined ? { state } : { state, cursor };
}

/** One page of an admin list as `useInfiniteQuery` holds it. */
export interface AdminNoticePage<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- how a notice is drawn -----------------------------------------------------------------

/**
 * What a notice page's metadata describes it with: the start of its text without the formatting,
 * on one line, at most `max` characters by code point (a UTF-16 slice could cut an emoji in half).
 */
export function noticeDescription(body: PostDocument, max: number): string {
  const text = postExcerpt(readPostDocument(body).text).replace(/\n/g, ' ');
  return Array.from(text).slice(0, max).join('');
}

/**
 * What the fixed area above the community list draws (`PinnedNotices`, ADR-0077 decision 8-10),
 * from its query's state:
 * - `none` while a read the server could not make is pending (the list below has its own
 *   skeleton), and when nothing is pinned — no area at all, nothing to say;
 * - `error` when the first read failed in the browser too, with 다시 시도;
 * - `rows` otherwise, and still after a later refresh fails (`refreshFailed`): they are the last
 *   ones read, and an operator's notice rarely moves.
 */
export type PinnedNoticesView<T> =
  { kind: 'none' } | { kind: 'error' } | { kind: 'rows'; rows: T[]; refreshFailed: boolean };

export function pinnedNoticesView<T>(query: {
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  data: T[] | undefined;
}): PinnedNoticesView<T> {
  if (query.isPending) return { kind: 'none' };
  if (query.isLoadingError) return { kind: 'error' };
  const rows = query.data ?? [];
  if (rows.length === 0) return { kind: 'none' };
  return { kind: 'rows', rows, refreshFailed: query.isRefetchError };
}

/**
 * Whether the admin's edit screen was opened at no notice: an unknown id (NOT_FOUND), or a segment
 * that is not a uuid, which the API refuses as a VALIDATION_ERROR — a wrong address all the same.
 * Both say '공지를 찾을 수 없습니다.'; any other failure is the screen's generic one.
 */
export function adminNoticeMissing(error: unknown): boolean {
  return isApiError(error, 'NOT_FOUND') || isApiError(error, 'VALIDATION_ERROR');
}

/**
 * The toast after an admin's save, from what the API says the save did (`changed`): '공지를
 * 고쳤습니다.' for a change, '바뀐 내용이 없습니다.' for the same content. Never from comparing
 * `editedAt` with the one the screen holds — another admin's edit the screen has not read yet moves
 * that too, so a save of what that edit already says would read as a change.
 */
export function noticeSaveToast(result: { changed: boolean }): {
  type: 'success' | 'info';
  title: string;
} {
  return result.changed
    ? { type: 'success', title: copy.adminNoticeSaved }
    : { type: 'info', title: copy.adminNoticeUnchanged };
}

// ---- refusals ------------------------------------------------------------------------------

/**
 * What a refused admin write (`POST /admin/notices`, the edit, the pin and the unpin) tells the
 * admin. The server is the judge of every rule:
 * - NOTICE_PIN_LIMIT_REACHED: NOTICE_PIN_LIMIT notices are pinned already — one is unpinned first
 *   (#45-8: nothing unpins automatically);
 * - VALIDATION_ERROR on `title`: blank, more than one line or too long (the form counts the same);
 * - VALIDATION_ERROR on `body`: told apart as a post's body is (`postWriteErrorMessage` — no text,
 *   too long, too many images, an image the admin cannot use);
 * - NOT_FOUND: no such notice (there is no deletion; a hand-made address);
 * - FORBIDDEN: the account is no admin any more (a revoke while the screen was open);
 * - ONBOARDING_REQUIRED: a consent a revision asked for again, say — the gate follows `['me']`;
 * - a request that never reached the API, and anything else.
 */
export function noticeWriteErrorMessage(error: unknown): string {
  if (isApiError(error, 'NOTICE_PIN_LIMIT_REACHED')) return copy.errNoticePinLimit;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'title') return copy.errNoticeTitle;
    if (field === 'body') return postWriteErrorMessage(error);
    return copy.errPostInvalid;
  }
  if (isApiError(error, 'NOT_FOUND')) return copy.adminNoticeNotFound;
  if (isApiError(error, 'FORBIDDEN')) return copy.adminOnly;
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return copy.errPostOnboarding;
  return isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown;
}
