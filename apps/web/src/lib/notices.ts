import {
  type NoticeActionType,
  type NoticeListState,
  postExcerpt,
  readPostDocument,
  type PostDocument,
} from '@buddha/shared';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import { isApiError, isApiUnreachable, isForAnotherAccount, validationField } from './api';
import { postBodyErrorMessage } from './posts';

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
 *
 * The owner's answers of 2026-10-21 (ADR-0077): only a pinned notice is public — its page and
 * images answer like a missing one's otherwise, while the admin screens show it (its images
 * through the admin route, `adminNoticeImagePath`); the admin's notice screen shows its operation
 * records and its earlier versions; and an edit opened before a save of the notice is refused
 * ('그사이 공지가 고쳐졌습니다. 최신 내용을 불러와 주세요.' — one neutral sentence whoever saved, the
 * second answers), the typed content kept on screen.
 */

// ---- addresses -----------------------------------------------------------------------------

/**
 * A notice page: under the community, whose fixed area links to it (this PR's choice — a page of
 * its own rather than a row that opens in place, ADR-0077). The id is the notice's uuid. Only a
 * pinned notice's page is there (owner decision 2026-10-21): any other is the 404.
 */
export function noticePath(noticeId: string): string {
  return `/community/notices/${noticeId}`;
}

/** The admin screen: the pinned notices and the others, each to pin, unpin or edit. */
export const ADMIN_NOTICES_PATH = '/admin/notices';

/** The admin's write screen for a new notice. */
export const ADMIN_NOTICE_NEW_PATH = '/admin/notices/new';

/** The admin's edit screen of a notice, with its pin and unpin, its records and earlier versions. */
export function adminNoticePath(noticeId: string): string {
  return `${ADMIN_NOTICES_PATH}/${noticeId}`;
}

/** One earlier version of a notice, read-only, on the admin screens. */
export function adminNoticeRevisionPath(noticeId: string, revisionId: number): string {
  return `${adminNoticePath(noticeId)}/revisions/${String(revisionId)}`;
}

/**
 * A notice's image as the admin screens draw it (`GET /admin/notices/:noticeId/images/:mediaId`):
 * any image the notice holds, now or in an earlier version, pinned or not. The public
 * `GET /media/:mediaId` serves a pinned notice's current images only (owner decision 2026-10-21),
 * so the edit screen of a notice not pinned, and an earlier version's images, would draw nothing
 * through it.
 */
export function adminNoticeImagePath(noticeId: string, mediaId: string): string {
  return `/api/v1/admin/notices/${noticeId}/images/${mediaId}`;
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
 * A notice's operation records and its earlier versions (owner decision 2026-10-21), under the
 * notice's own key: a write marks both stale with the notice it answered.
 */
export const adminNoticeActionsKey = (noticeId: string) =>
  [...adminNoticeKey(noticeId), 'actions'] as const;
export const adminNoticeRevisionsKey = (noticeId: string) =>
  [...adminNoticeKey(noticeId), 'revisions'] as const;
/**
 * One earlier version, whole: it never changes once written. By the id as the address names it
 * (a string: the API, not the key, judges whether it is a version's).
 */
export const adminNoticeRevisionKey = (noticeId: string, revisionId: string | number) =>
  [...adminNoticeRevisionsKey(noticeId), String(revisionId)] as const;

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

/**
 * One page of a notice's records or earlier versions as the browser's `queryFn` asks for it: the
 * cursor after the first page, the API's default page size and order (newest first).
 */
export function adminNoticePageQuery(cursor?: string): { cursor?: string } {
  return cursor === undefined ? {} : { cursor };
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
 * Whether an admin notice screen was opened at nothing to show: an unknown id (NOT_FOUND), or a
 * segment that is not an id, which the API refuses as a VALIDATION_ERROR — a wrong address all the
 * same. The edit screen then says '공지를 찾을 수 없습니다.'; an earlier version's screen says '이전
 * 판을 찾을 수 없습니다.' for either segment, the notice's or the version's (an unknown notice has
 * no versions). Any other failure is the screen's generic one.
 */
export function adminNoticeMissing(error: unknown): boolean {
  return isApiError(error, 'NOT_FOUND') || isApiError(error, 'VALIDATION_ERROR');
}

/**
 * What an admin notice screen draws from its read — the edit screen's notice (`useAdminNotice`),
 * an earlier version's screen's version (`useAdminNoticeRevision`):
 * - `pending` while there is nothing to draw yet: a skeleton;
 * - `missing` when the read found nothing at that address (`adminNoticeMissing`);
 * - `failed` when it failed otherwise: the screen's generic failure;
 * - `ready` once something read is there to draw — and still after a later refresh fails: the
 *   rows read are kept (the edit screen says the refresh failed above them, and an earlier version
 *   never changes), never swapped for an error.
 *
 * `openedAt` is the edit screen's: when it opened (`Date.now()`, the clock `dataUpdatedAt` is on).
 * The form saves against the version it opens on (`expectedEditedAt`, owner decisions 2026-10-21 7
 * and (2차) 1: a save is refused when the notice was saved «연 뒤» — after the screen opened —
 * whoever saved it), so it opens only on a read that landed since: a copy the cache held from
 * before — an earlier visit's, or a pin's answer on the list, read before a later save perhaps — is
 * `pending` until the read the screen asks for on opening lands (`refetchOnMount: 'always'`,
 * `adminNoticeQueryOptions`), and should that read fail, `failed`, as a first read that failed is
 * (ADR-0077 decision 8-19).
 */
export type AdminNoticeReadView = 'pending' | 'missing' | 'failed' | 'ready';

export function adminNoticeReadView(
  query: {
    isPending: boolean;
    isError: boolean;
    isLoadingError: boolean;
    error: unknown;
    fetchStatus: 'fetching' | 'paused' | 'idle';
    dataUpdatedAt: number;
  },
  openedAt?: number,
): AdminNoticeReadView {
  if (query.isPending) return 'pending';
  const failed = adminNoticeMissing(query.error) ? 'missing' : 'failed';
  if (query.isLoadingError) return failed;
  if (openedAt !== undefined && query.dataUpdatedAt < openedAt) {
    // Only the copy from before the screen opened: wait for the read it asked for.
    return query.isError && query.fetchStatus === 'idle' ? failed : 'pending';
  }
  return 'ready';
}

/**
 * The toast after an admin's save, from what the API says the save did (`changed`): '공지를
 * 고쳤습니다.' for a change, '바뀐 내용이 없습니다.' for the same content — the server's own word,
 * never a guess from a comparison of times.
 */
export function noticeSaveToast(result: { changed: boolean }): {
  type: 'success' | 'info';
  title: string;
} {
  return result.changed
    ? { type: 'success', title: copy.adminNoticeSaved }
    : { type: 'info', title: copy.adminNoticeUnchanged };
}

/** What an operation record says was done (#138: «작성·수정·고정·해제»). */
export function noticeActionLabel(type: NoticeActionType): string {
  switch (type) {
    case 'notice_create':
      return copy.adminNoticeActionCreate;
    case 'notice_update':
      return copy.adminNoticeActionUpdate;
    case 'notice_pin':
      return copy.adminNoticeActionPin;
    case 'notice_unpin':
      return copy.adminNoticeActionUnpin;
  }
}

/**
 * The operator a record or an earlier version names, by nickname; '기록 없음' where no record
 * names one (a row written past the API), and '탈퇴한 사용자' for an operator who closed the account
 * since (#140, after the admin role was revoked: the nickname went with the closure, ADR-0086).
 */
export function noticeActorName(actor: { nickname: string | null } | null): string {
  return actor === null || actor.nickname === ''
    ? copy.adminNoticeActorUnknown
    : nicknameShown(actor.nickname);
}

// ---- refusals ------------------------------------------------------------------------------

/**
 * Whether a save was refused because the notice was saved since the edit screen opened it — by
 * another admin, or by the same one in another tab (NOTICE_EDIT_CONFLICT, owner decisions
 * 2026-10-21): the screen then keeps what is typed and offers the latest version.
 */
export function noticeEditConflict(error: unknown): boolean {
  return isApiError(error, 'NOTICE_EDIT_CONFLICT');
}

/**
 * What a refused admin write (`POST /admin/notices`, the edit, the pin and the unpin) tells the
 * admin. The server is the judge of every rule:
 * - NOTICE_PIN_LIMIT_REACHED: NOTICE_PIN_LIMIT notices are pinned already — one is unpinned first
 *   (#45-8: nothing unpins automatically);
 * - NOTICE_EDIT_CONFLICT: the notice was saved after this screen opened it — '그사이 공지가
 *   고쳐졌습니다. 최신 내용을 불러와 주세요.', whoever saved it (owner decision 2026-10-21, second
 *   answers);
 * - VALIDATION_ERROR on `title`: blank, more than one line or too long (the form counts the same);
 * - VALIDATION_ERROR on `body`: told apart as a post's body is (`postBodyErrorMessage` — no text,
 *   too long, too many images, an image the admin cannot use);
 * - NOT_FOUND: no such notice (there is no deletion; a hand-made address);
 * - FORBIDDEN naming `expectedAccountId`: the cookie is another account's (another tab signed in
 *   — every write names the admin on screen, ADR-0092): `copy.sessionChanged`, and the session is
 *   asked again;
 * - FORBIDDEN: the account is no admin any more (a revoke while the screen was open);
 * - ONBOARDING_REQUIRED: a consent a revision asked for again, say — the gate follows `['me']`;
 * - a request that never reached the API, and anything else.
 */
export function noticeWriteErrorMessage(error: unknown): string {
  if (isApiError(error, 'NOTICE_PIN_LIMIT_REACHED')) return copy.errNoticePinLimit;
  if (noticeEditConflict(error)) return copy.errNoticeEditConflict;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'title') return copy.errNoticeTitle;
    if (field === 'body') return postBodyErrorMessage(error);
    return copy.errPostInvalid;
  }
  if (isApiError(error, 'NOT_FOUND')) return copy.adminNoticeNotFound;
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'FORBIDDEN')) return copy.adminOnly;
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return copy.errPostOnboarding;
  return isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown;
}
