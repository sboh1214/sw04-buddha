import { type InfiniteData } from '@tanstack/react-query';
import { copy } from '@/copy';
import { type PostSummary } from './api';
import { type CountedPostPage } from './posts';
import { listSection } from './query-client';

/**
 * 토론 (#47, ADR-0075): the market detail's section of that market's 근거 글 as the screen reads it —
 * the rung the section is on and the count it shows. Pure functions of the query and of the API's
 * answers, kept out of the section component (`app/markets/[slug]/market-discussion.tsx`) so the
 * node test runner reaches them (the rule `market-ssr.ts` states).
 *
 * Owner decisions (ADR-0069 decision 4 #47 and decision 2 #45-6, of 2026-10-18 and of 2026-10-20):
 * every post of the market in the detail itself, newest first, 20 more per 더 보기, with the count
 * shown; each as the community list's preview card without its market line — it is this market —
 * which opens the post page; readable in every public status, and — every public status taking
 * posts — the write entry always there. The section is read in the browser only, never by the
 * server page (owner decision 2026-10-20 1: no post in the HTML a search engine gets), so its
 * first rung on every load is `pending`.
 */

/** What the section draws: its rung, the cards, the count, and whether 더 보기 is offered. */
export interface DiscussionView {
  /** A refresh failed while cards are held: they stay, with a notice above them (`listSection`). */
  stale: boolean;
  body: 'pending' | 'failed' | 'empty' | 'rows';
  /** The cards of every page read, newest first. */
  posts: PostSummary[];
  /**
   * How many posts the market's whole list held when its first page was read — every page, not
   * only those read: the first page's count. Each 더 보기 continues below the last card held and
   * never reads the top of the list again, so a post written meanwhile is above every card the
   * walk can reach; a later page's count would promise it while no 더 보기 is left to bring it
   * (21 cards beside '글 23'), and a post deleted meanwhile would count less than the cards shown.
   * The first page's count is the one that matches the cards once the last page is in — save for a
   * post below the cards that was deleted or hidden before a 더 보기 reached it, which it still
   * counts (ADR-0075 5-4). Every page is read again from the first, and the count with it, at the
   * next refresh of the list — a refocus past `staleTime`, a remount, the reader's own write — which
   * is when a post someone else wrote meanwhile appears, at the top (5-11; owner decision 2026-10-20
   * 8). Absent until a page has been read.
   */
  total: number | undefined;
  /**
   * 더 보기: another page follows, and there are cards for it to follow. A 더 보기 that failed keeps
   * it — the button is the way to ask again — with the notice every 더 보기 list shows above it
   * (`LoadMoreFailed`, owner decision 2026-10-20 7).
   */
  more: boolean;
}

/**
 * The section's rung from its query: the list sections' ladder (`listSection` — loading, a first
 * read that failed, no post yet, the cards — with a failed refresh as a notice over whatever is
 * held, never a rung that hides it), plus the count and 더 보기. A 더 보기 that failed is neither a
 * rung nor a refresh's notice: `listSection` never sees it (TanStack reports it as
 * `isFetchNextPageError` and leaves `isRefetchError` false), so the cards and the count stay, and
 * the notice above 더 보기 is `moreFailed`'s (lib/query-client.ts).
 */
export function discussionView(query: {
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  /** Tells a refetch after a failed 더 보기 from a failed refresh (`refreshFailed`). */
  error: unknown;
  hasNextPage: boolean;
  data: InfiniteData<CountedPostPage> | undefined;
}): DiscussionView {
  const pages = query.data?.pages ?? [];
  const posts = pages.flatMap((page) => page.items);
  const { stale, body } = listSection(query, posts.length);
  return {
    stale,
    body,
    posts,
    total: pages[0]?.total,
    more: body === 'rows' && query.hasNextPage,
  };
}

/** The count beside the section's heading: '글 N', as the post page heads its comments '댓글 N'. */
export function discussionCountText(total: number): string {
  return `${copy.marketDiscussionCount} ${String(total)}`;
}
