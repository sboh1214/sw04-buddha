import { copy } from '@/copy';
import type { CommentedPost, HiddenNotice, ReportReason } from './api';
import { postFirstLine } from './posts';

/**
 * 작성자별 글·댓글 목록 (#51, ADR-0080): what a member wrote, on their public profile
 * (`/u/<publicId>`) and on their own MY '내 글' (`/my/posts`). The owner's part (ADR-0069):
 *
 * - two tabs, 글 (근거 글) and 댓글 (댓글 and 대댓글 together), newest first, nothing else to pick
 *   (decision 3 #37-14 for the profile, decision 4 #51 for MY: «필터 없음, 글·댓글 탭과 최신순만»);
 * - the profile leaves out what was deleted or hidden; MY leaves out what was deleted and keeps
 *   what was hidden, marked '숨김' with its reason, for the member alone (decision 2 #45-5), who
 *   deletes it from beside that line (owner decision 2026-10-22);
 * - each item leads to its post page and its market, an ended market too (N04 §2, N05 §3).
 *
 * Pure functions and keys, in a module with no directive so the node test runner reaches them
 * (authored.test.ts), as lib/watchlist.ts is for 관심 시장.
 */

// ---- the two tabs ------------------------------------------------------------------------------

export type AuthoredTab = 'posts' | 'comments';

/** The tabs in the owner's order (#37-14: «글과 댓글(대댓글 포함)»), 글 first and the default. */
export const AUTHORED_TABS: readonly { key: AuthoredTab; label: string }[] = [
  { key: 'posts', label: copy.authoredTabPosts },
  { key: 'comments', label: copy.authoredTabComments },
];

/**
 * The query parameter that keeps the tab picked, so Back from a post page lands on the tab it was
 * opened from and a link can name a tab. 글 is the page without it.
 */
export const AUTHORED_TAB_PARAM = 'tab';

/** The tab a URL's `?tab=` names: 댓글 for `comments` alone, 글 for anything else or nothing. */
export function authoredTabOf(param: string | null | undefined): AuthoredTab {
  return param === 'comments' ? 'comments' : 'posts';
}

/**
 * The query string (with its `?`, or empty) once `tab` is picked: `search` with `?tab=` set to the
 * tab, or taken out for 글, the default — every other parameter kept as it was.
 */
export function authoredTabSearch(search: string, tab: AuthoredTab): string {
  const params = new URLSearchParams(search);
  if (tab === 'posts') params.delete(AUTHORED_TAB_PARAM);
  else params.set(AUTHORED_TAB_PARAM, tab);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

// ---- cache keys --------------------------------------------------------------------------------

/**
 * A profile's two lists (`GET /profiles/:publicId/posts`, `/comments`): public — the same answer
 * for every reader — but read in the browser only (the per-address bucket applies to whoever
 * reads), as the owner decided for a post's comments (2026-10-21, which #48's follow-up records in
 * ADR-0074) and for #47's discussion (ADR-0075) — ADR-0080 7-10 — so nothing of them is ever
 * dehydrated. Keyed on the lower-cased public id, the one the API finds (a public id typed in
 * capitals is the same member).
 */
export const AUTHORED_KEY = ['authored'] as const;
export const profileAuthoredKey = (publicId: string, tab: AuthoredTab) =>
  [...AUTHORED_KEY, publicId.toLowerCase(), tab] as const;

/**
 * MY '내 글''s two lists (`GET /me/posts`, `/me/comments`): the member's own, read with their
 * cookie, so the root is in `PRIVATE_QUERY_ROOTS` (market-keys.ts) — never fetched on the server,
 * never dehydrated, and reset with every other personal entry when the session changes
 * (SessionCacheGuard). No key under it says whose it is. The tab and the summary's preview share
 * each entry.
 */
export const MY_AUTHORED_KEY = ['my-authored'] as const;
export const myAuthoredKey = (tab: AuthoredTab) => [...MY_AUTHORED_KEY, tab] as const;

/** One page of a list as `useInfiniteQuery` holds it (the community list's page shape). */
export interface AuthoredPage<Row> {
  items: Row[];
  nextCursor: string | null;
}

// ---- what a list draws -------------------------------------------------------------------------

/**
 * What a list body draws from the pages it has: every row with 더 보기 while there is a next page,
 * or — for MY's summary (`limit`, MY_PREVIEW_ROWS) — the newest `limit` rows and no 더 보기: the
 * preview's way to the rest is its 전체 보기 to the tab (ADR-0054 decision 2), as 관심 시장's is.
 */
export function authoredRows<Row>(
  pages: readonly { items: readonly Row[] }[] | undefined,
  hasNextPage: boolean,
  limit: number | undefined,
): { rows: Row[]; more: boolean } {
  const rows = (pages ?? []).flatMap((page) => page.items).slice(0, limit);
  return { rows, more: limit === undefined && hasNextPage };
}

/** What a tab says with nothing in it — the same words on the profile and in MY. */
export function authoredEmptyMessage(tab: AuthoredTab): string {
  return tab === 'posts' ? copy.authoredPostsEmpty : copy.authoredCommentsEmpty;
}

/**
 * A listed comment's kind as the post page names it: a 댓글, or a 대댓글 — '답글' on screen, the
 * comment area's own word for one (copy.commentReply, ADR-0074).
 */
export function commentKindLabel(parentId: string | null): string {
  return parentId === null ? copy.authoredCommentKind : copy.authoredReplyKind;
}

/**
 * The post a listed comment sits under, as the public sees it: a published post by its title, or
 * by the first line of its text when it has none (the card's rule, `postFirstLine`), and the two
 * placeholders by the words their page shows (#45-5) — no word of a deleted or hidden post, which
 * the answer does not carry either.
 */
export function commentedPostText(post: CommentedPost): string {
  switch (post.state) {
    case 'published':
      return post.title ?? postFirstLine(post.excerpt);
    case 'deleted':
      return copy.postDeletedPlaceholder;
    case 'hidden':
      return copy.postHiddenPlaceholder;
  }
}

/** The words of each report reason (#45-10), in the owner's order — a hiding's reason is one. */
const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  spam: copy.reportReasonSpam,
  harassment: copy.reportReasonHarassment,
  personal_info: copy.reportReasonPersonalInfo,
  impersonation: copy.reportReasonImpersonation,
  collusion_manipulation: copy.reportReasonCollusionManipulation,
  off_topic: copy.reportReasonOffTopic,
  rights_infringement: copy.reportReasonRightsInfringement,
  other: copy.reportReasonOther,
};

/** A report reason as the screen names it ('스팸', '시장과 무관', …). */
export function reportReasonLabel(code: ReportReason): string {
  return REPORT_REASON_LABELS[code];
}

/**
 * What MY '내 글' says beside an item an operator hid (#45-5: '숨김' and the reason, to the member
 * alone): the mark always; once the hiding carries a reason, its line — the report reason the
 * operator picked (owner decision 2026-10-22: «사유 목록 중 하나 + 운영자 설명») — and the
 * operator's explanation on a line of its own when they wrote one. The reason comes with #50's
 * moderation records; until then no hiding records one (`reason: null`), and the mark stands alone
 * rather than a line that says nothing.
 */
export function hiddenNoticeView(hidden: HiddenNotice): {
  mark: string;
  reason: string | null;
  note: string | null;
} {
  const mark = copy.authoredHidden;
  if (hidden.reason === null) return { mark, reason: null, note: null };
  const note = hidden.reason.note?.trim() ?? '';
  return {
    mark,
    reason: `${copy.authoredHiddenReason}: ${reportReasonLabel(hidden.reason.code)}`,
    note: note === '' ? null : `${copy.authoredHiddenNote}: ${note}`,
  };
}

/** A hidden item MY offers to delete: a post on the 글 tab, a 댓글 or 대댓글 on the 댓글 tab. */
export type HiddenItem =
  { tab: 'posts'; title: string | null; excerpt: string } | { tab: 'comments'; body: string };

/**
 * What names a hidden item where MY's 삭제 has to say which it deletes — its confirm dialog and the
 * button's accessible name (owner decision 2026-10-22, 3rd: «MY 내 글의 숨긴 항목 삭제 확인창 →
 * 항목을 말함(글 제목/첫 줄·댓글 첫 줄, 단추 이름에도)»). A post as its card's heading names it —
 * its title, or the first line of its text when it has none (post-card.tsx) — and a 댓글 or 대댓글
 * by the first line of its own text: its post's would name every hidden comment under one post
 * alike. Either is at most POST_EXCERPT_MAX_LENGTH (300) characters, as a card's preview is:
 * `postFirstLine` takes the first line of `postExcerpt`, which cuts the text there (a post's
 * `excerpt` comes so cut from the server), so a longer first line — a comment's can be 1,000
 * characters on one line — is named by its first 300 code points, cut where they end.
 */
export function hiddenItemName(item: HiddenItem): string {
  return item.tab === 'posts'
    ? (item.title ?? postFirstLine(item.excerpt))
    : postFirstLine(item.body);
}

/**
 * The accessible name of MY's 삭제 beside a hidden item's '숨김' line (ADR-0080 7-19): the item it
 * deletes (`hiddenItemName`), then the button's own word, as every repeated per-item button here
 * is named (market-search.tsx's 삭제, market-picker.tsx's 고르기). A list can hold several hidden
 * items, and the button stands before its card, so '삭제' alone would read alike for each and
 * before the item it acts on. The words on screen stay '삭제' (the post page's and the comment
 * area's), which the name ends with.
 */
export function hiddenDeleteName(item: HiddenItem): string {
  return `${hiddenItemName(item)} ${item.tab === 'posts' ? copy.postDelete : copy.commentDelete}`;
}

/**
 * MY's pages of a list once the member deleted one of its items (`id`) from beside its '숨김' line
 * (owner decision 2026-10-22): the item out of whichever page held it, every other row and every
 * cursor as they were — the read that follows confirms it. Nothing held, nothing to change.
 */
export function withoutAuthoredItem<Page extends { items: readonly { id: string }[] }>(
  data: { pages: Page[]; pageParams: unknown[] } | undefined,
  id: string,
): { pages: Page[]; pageParams: unknown[] } | undefined {
  if (data === undefined) return undefined;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((item) => item.id !== id),
    })),
  };
}

// ---- a profile returned to -------------------------------------------------------------------

/**
 * Whether a profile page drawn in `instance` — Next's `useRouter().bfcacheId`, new for every page
 * opened by an address or a link, the same again when Back or Forward brings that page back — is
 * one already drawn in this document (so it came back from history), recording it otherwise.
 *
 * Next brings a page back from history without asking the server, `force-dynamic` or not, so the
 * counts the server drew are the ones of when the reader left, while the lists beside them are read
 * again (`refetchOnMount: 'always'`): a post deleted on its page, then Back, left '글 1' over an
 * empty 글 tab. A page that came back is drawn again (`useRedrawOnReturn`); a page just opened was
 * just drawn and is not (ADR-0080 7-16).
 */
export function returnsToDrawnPage(drawn: Set<string>, instance: string): boolean {
  if (drawn.has(instance)) return true;
  drawn.add(instance);
  return false;
}
