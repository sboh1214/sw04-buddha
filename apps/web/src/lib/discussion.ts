import { type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { copy } from '@/copy';
import { type Market, type PostSummary } from './api';
import { type CountedPostPage, marketPostsKey } from './posts';
import { listSection } from './query-client';

/**
 * 토론 (#47, ADR-0075): the market detail's section of that market's 근거 글 as the screen reads it —
 * the server's seed of its first page, the rung the section is on, and the count it shows. Pure
 * functions of the query and of the API's answers, kept out of the section component
 * (`app/markets/[slug]/market-discussion.tsx`) so the node test runner reaches them (the rule
 * `market-ssr.ts` states), and free of `'use client'`, so the server page seeds the key the
 * browser's hook reads.
 *
 * Owner decisions (ADR-0069 decision 4 #47 and decision 2 #45-6, and of 2026-10-18): every post of
 * the market in the detail itself, newest first, 20 more per 더 보기, with the count shown; each as
 * the community list's preview card, which opens the post page; readable in every public status,
 * and — every public status taking posts — the write entry always there.
 */

/**
 * The detail's 토론, first page, read on the server under the key the section's own query uses
 * (`marketPostsKey`, hooks/use-posts.ts), so the page and its page params dehydrate and the cards
 * and the count are in the HTML — the same for every visitor: the read forwards no cookie. The
 * param the client's factory declares, so the seeded page is picked up rather than fetched again.
 * `readPage` is the page's server reader (`fetchMarketPostsPageServer`), passed in so this can be
 * tested without the server client.
 *
 * `retry: false`, for the reason `prefetchRelatedMarkets` (market-ssr.ts) gives: the server client
 * keeps the app's default retries (a 5xx or a network failure twice more, 1 s then 2 s apart), and
 * a prefetch turns them off only when no default names any, so a failing read of this one section
 * would hold the whole detail about 3 s to end in the same failure. A prefetch swallows its failure
 * and a failed query is not dehydrated, so the section reads its page in the browser — with the
 * client's retries — and shows its own failure there. An empty first page IS dehydrated: no post
 * yet is the section's empty state, not a failure.
 */
export function prefetchMarketPosts(
  queryClient: QueryClient,
  marketId: string,
  readPage: (marketId: string, cursor?: string) => Promise<CountedPostPage>,
): Promise<void> {
  return queryClient.prefetchInfiniteQuery({
    queryKey: marketPostsKey(marketId),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => readPage(marketId, pageParam),
    initialPageParam: undefined as string | undefined,
    retry: false,
  });
}

/** What the section draws: its rung, the cards, the count, and whether 더 보기 is offered. */
export interface DiscussionView {
  /** A refresh failed while cards are held: they stay, with a notice above them (`listSection`). */
  stale: boolean;
  body: 'pending' | 'failed' | 'empty' | 'rows';
  /** The cards of every page read, newest first, their market line on the live row (`onLiveMarket`). */
  posts: PostSummary[];
  /**
   * How many posts the market's whole list held when its first page was read — every page, not
   * only those read: the first page's count. Each 더 보기 continues below the last card held and
   * never reads the top of the list again, so a post written meanwhile is above every card the
   * walk can reach; a later page's count would promise it while no 더 보기 is left to bring it
   * (21 cards beside '글 23'), and a post deleted meanwhile would count less than the cards shown.
   * The first page's count is the one that matches the cards once the last page is in — save for a
   * post below the cards that was deleted or hidden before a 더 보기 reached it, which it still
   * counts (ADR-0075 5-4). Every page is read again from the first, and the count with it, at the next refresh of
   * the list — a refocus past `staleTime`, a remount, the reader's own write — which is when a post
   * someone else wrote meanwhile appears, at the top (5-11). Absent until a page has been read.
   */
  total: number | undefined;
  /** 더 보기: another page follows, and there are cards for it to follow. */
  more: boolean;
  /**
   * The last 더 보기 failed (after the client's retries) and is not being asked again: the cards
   * and the count stay, 더 보기 stays to try again, and the section says so beside it (ADR-0075
   * 5-14). `listSection` cannot see it — TanStack reports a failed next page as
   * `isFetchNextPageError` and leaves `isRefetchError` false — and a refresh's notice would say
   * something else (that what is shown may be old), not that nothing more came.
   */
  moreFailed: boolean;
}

/** The detail's own market as its live row holds it (`useMarket`): what the cards' market line shows. */
export type LiveMarket = Pick<Market, 'id' | 'status' | 'title'>;

/**
 * The cards with the detail's live row laid over their market line. Every card of the section is
 * this market's, and a card's `market` is the post page's snapshot of it: no market event reaches
 * the posts lists (`PostMarket` has no `statusEventId` to order one by), so a market an admin closes
 * while the page is open would keep its cards without the 거래 마감 badge its header already shows,
 * and a title edit would leave their market line on the old title, until the list is read again.
 * The detail's row is live already — seeded by the page, written by `market:status` in its order,
 * read again after an edit — so the cards take its status and title (ADR-0075 5-15). Nothing else
 * of a card changes, and a card stands as it came while the row is unknown or is another market's.
 */
export function onLiveMarket(posts: PostSummary[], live: LiveMarket | undefined): PostSummary[] {
  if (live === undefined) return posts;
  return posts.map((post) =>
    post.market.id === live.id &&
    (post.market.status !== live.status || post.market.title !== live.title)
      ? { ...post, market: { ...post.market, status: live.status, title: live.title } }
      : post,
  );
}

/**
 * The section's rung from its query: the list sections' ladder (`listSection` — loading, a first
 * read that failed, no post yet, the cards — with a failed refresh as a notice over whatever is
 * held, never a rung that hides it), plus the count, 더 보기 and a 더 보기 that failed. `live` is the
 * detail's row, which the cards' market line follows (`onLiveMarket`).
 */
export function discussionView(
  query: {
    isPending: boolean;
    isLoadingError: boolean;
    isRefetchError: boolean;
    isFetchNextPageError: boolean;
    isFetchingNextPage: boolean;
    hasNextPage: boolean;
    data: InfiniteData<CountedPostPage> | undefined;
  },
  live?: LiveMarket,
): DiscussionView {
  const pages = query.data?.pages ?? [];
  const posts = pages.flatMap((page) => page.items);
  const { stale, body } = listSection(query, posts.length);
  return {
    stale,
    body,
    posts: onLiveMarket(posts, live),
    total: pages[0]?.total,
    more: body === 'rows' && query.hasNextPage,
    moreFailed: body === 'rows' && query.isFetchNextPageError && !query.isFetchingNextPage,
  };
}

/** The count beside the section's heading: '글 N', as the post page heads its comments '댓글 N'. */
export function discussionCountText(total: number): string {
  return `${copy.marketDiscussionCount} ${String(total)}`;
}
