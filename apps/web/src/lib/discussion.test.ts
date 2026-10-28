import { readFileSync } from 'node:fs';
import path from 'node:path';
import { InfiniteQueryObserver, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type PostSummary } from './api';
import { discussionCountText, discussionView } from './discussion';
import { type CountedPostPage, marketPostsKey } from './posts';
import { getQueryClient, moreFailed } from './query-client';

/**
 * The market detail's 토론 (#47, ADR-0075) as the section reads it: the rung it is on — loading, a
 * first read that failed, no post yet, the cards, 더 보기, a 더 보기 that failed — and the count
 * beside its heading; and, from the sources, that the server page reads none of it and the cards
 * draw no market line (owner decisions 2026-10-20 1 and 6). The section component only draws these
 * (no DOM here: vitest runs under node), so the states are driven through a real QueryClient
 * (`getQueryClient()` answers a fresh one per call under node) and an observer, as the section's
 * `useInfiniteQuery` holds them.
 */

const SRC = path.resolve(import.meta.dirname, '..');

const MARKET = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';

const card = (n: number): PostSummary => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `근거 ${String(n)}`,
  excerpt: '본문',
  thumbnailUrl: null,
  author: {
    kind: 'member',
    publicId: 'k7m2p9qx4z',
    nickname: '근거왕',
    imageUrl: null,
    isAdmin: false,
  },
  market: {
    id: MARKET.toLowerCase(),
    slug: 'rate-cut',
    title: '금리 인하?',
    status: 'closed',
    category: { slug: 'economy', nameKo: '경제' },
  },
  createdAt: '2026-10-18T00:00:00.000Z',
  editedAt: null,
  commentCount: 0,
});

/** `count` cards, newest first, numbered from `from` down. */
const cards = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => card(from - i));

type Pages = InfiniteData<CountedPostPage>;

/**
 * A market's list as the API pages it: newest first, 20 a page, each page after the first starting
 * below the cursor of the card before it (a keyset, as `GET /markets/:id/posts` reads), and each
 * page counting the whole list as it is when that page is read. Posts are numbered, newest highest;
 * `write` adds newer ones and `remove` deletes some.
 */
function keysetServer(count: number) {
  let numbers = Array.from({ length: count }, (_, i) => count - i);
  return {
    read: (cursor: string | undefined): Promise<CountedPostPage> => {
      const below = cursor === undefined ? numbers : numbers.filter((n) => n < Number(cursor));
      const page = below.slice(0, 20);
      const last = page.at(-1);
      return Promise.resolve({
        items: page.map(card),
        nextCursor: below.length > 20 && last !== undefined ? String(last) : null,
        total: numbers.length,
      });
    },
    write: (more: number) => {
      const top = numbers[0] ?? 0;
      numbers = [...Array.from({ length: more }, (_, i) => top + more - i), ...numbers];
    },
    remove: (gone: number[]) => {
      numbers = numbers.filter((n) => !gone.includes(n));
    },
  };
}

/** An observer of the section's query with `readPage` as its reader and no retry. */
function observe(readPage: (cursor: string | undefined) => Promise<CountedPostPage>) {
  const queryClient = getQueryClient();
  const observer = new InfiniteQueryObserver<
    CountedPostPage,
    Error,
    Pages,
    readonly unknown[],
    string | undefined
  >(queryClient, {
    queryKey: marketPostsKey(MARKET),
    queryFn: ({ pageParam }) => readPage(pageParam),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    observer,
    view: () => discussionView(observer.getCurrentResult()),
    /** The notice above 더 보기 (`LoadMoreFailed`), as the section's own query drives it. */
    failedMore: () => moreFailed(observer.getCurrentResult()),
    done: () => {
      unsubscribe();
      queryClient.clear();
    },
  };
}

/** Waits until the observer's result satisfies `ready`. */
async function settled(
  observer: InfiniteQueryObserver<
    CountedPostPage,
    Error,
    Pages,
    readonly unknown[],
    string | undefined
  >,
  ready: (result: ReturnType<typeof observer.getCurrentResult>) => boolean,
): Promise<void> {
  for (let i = 0; i < 100 && !ready(observer.getCurrentResult()); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(ready(observer.getCurrentResult())).toBe(true);
}

describe('the 토론 section’s rungs (#47)', () => {
  it('is loading, with no count and no 더 보기, until the first page answers', () => {
    const { view, done } = observe(() => new Promise<CountedPostPage>(() => undefined));
    try {
      expect(view()).toEqual({
        stale: false,
        body: 'pending',
        posts: [],
        total: undefined,
        more: false,
      });
    } finally {
      done();
    }
  });

  it('says a first read failed, with no count to show', async () => {
    const { observer, view, done } = observe(() => Promise.reject(new ApiError(500, undefined)));
    try {
      await settled(observer, (result) => result.isLoadingError);
      expect(view()).toEqual({
        stale: false,
        body: 'failed',
        posts: [],
        total: undefined,
        more: false,
      });
    } finally {
      done();
    }
  });

  it('is its empty state, counting 0, for a market with no post yet', async () => {
    const { observer, view, done } = observe(() =>
      Promise.resolve({ items: [], nextCursor: null, total: 0 }),
    );
    try {
      await settled(observer, (result) => result.isSuccess);
      expect(view()).toEqual({
        stale: false,
        body: 'empty',
        posts: [],
        total: 0,
        more: false,
      });
    } finally {
      done();
    }
  });

  it('holds every page read, newest first, with 더 보기 while a page follows (20 at a time)', async () => {
    // 21 posts: the first page is the newest 20 and offers 더 보기; the second is the last one.
    const { observer, view, done } = observe((cursor) =>
      Promise.resolve(
        cursor === undefined
          ? { items: cards(21, 20), nextCursor: 'c2', total: 21 }
          : { items: cards(1, 1), nextCursor: null, total: 21 },
      ),
    );
    try {
      await settled(observer, (result) => result.isSuccess);
      const first = view();
      expect(first.body).toBe('rows');
      expect(first.posts.map((post) => post.title)).toEqual(
        cards(21, 20).map((post) => post.title),
      );
      expect(first.total).toBe(21);
      expect(first.more).toBe(true);

      await observer.fetchNextPage();
      const all = view();
      expect(all.posts).toHaveLength(21);
      expect(all.posts.at(-1)?.title).toBe('근거 1');
      expect(all.total).toBe(21);
      // The last page: nothing follows, so no 더 보기.
      expect(all.more).toBe(false);
    } finally {
      done();
    }
  });

  it('counts by the first page read, so the count matches the cards a 더 보기 walk can reach', async () => {
    // Review on #47: a 더 보기 continues below the last card held and never reads the top again.
    // Two posts written between the reads are above every card it can reach; counting by the
    // later page said '글 23' beside 21 cards with no 더 보기 left to bring the two.
    const server = keysetServer(21);
    const { observer, view, done } = observe(server.read);
    try {
      await settled(observer, (result) => result.isSuccess);
      server.write(2);
      await observer.fetchNextPage();
      expect(view()).toMatchObject({ body: 'rows', total: 21, more: false });
      expect(view().posts).toHaveLength(21);

      // The next refresh reads every page again from the first: the two new posts at the top,
      // and the count with them.
      await observer.refetch();
      expect(view().posts.map((post) => post.title)).toEqual(
        cards(23, 23).map((post) => post.title),
      );
      expect(view()).toMatchObject({ total: 23, more: false });
    } finally {
      done();
    }
  });

  it('keeps counting the cards it shows when posts were deleted between two reads', async () => {
    // Five of the first page's posts deleted before 더 보기: the later page counts 16, while the
    // section holds the 20 it read and the one 더 보기 brings (the deleted ones go at the next
    // refresh, the count with them).
    const server = keysetServer(21);
    const { observer, view, done } = observe(server.read);
    try {
      await settled(observer, (result) => result.isSuccess);
      server.remove([21, 20, 19, 18, 17]);
      await observer.fetchNextPage();
      expect(view()).toMatchObject({ body: 'rows', total: 21, more: false });
      expect(view().posts).toHaveLength(21);

      await observer.refetch();
      expect(view()).toMatchObject({ total: 16, more: false });
      expect(view().posts).toHaveLength(16);
    } finally {
      done();
    }
  });

  it('still counts a post below the cards deleted before 더 보기 reached it, until the next refresh', async () => {
    // The one way the first page's count and the cards part (ADR-0075 5-4): the oldest post,
    // not yet read, is deleted before 더 보기, which then brings nothing.
    const server = keysetServer(21);
    const { observer, view, done } = observe(server.read);
    try {
      await settled(observer, (result) => result.isSuccess);
      server.remove([1]);
      await observer.fetchNextPage();
      expect(view()).toMatchObject({ body: 'rows', total: 21, more: false });
      expect(view().posts).toHaveLength(20);

      await observer.refetch();
      expect(view()).toMatchObject({ total: 20, more: false });
      expect(view().posts).toHaveLength(20);
    } finally {
      done();
    }
  });

  it('keeps the cards, the count and 더 보기 when a 더 보기 fails, with the notice above it until asked again', async () => {
    // Review on #47: TanStack reports a failed next page as `isFetchNextPageError`, not as a
    // refresh's `isRefetchError`, so the section said nothing and looked as it did before the
    // press. The notice is every 더 보기 list's (`LoadMoreFailed` on `moreFailed`, owner decision
    // 2026-10-20 7); the section keeps its rung and its 더 보기.
    let down = true;
    const { observer, view, failedMore, done } = observe((cursor) =>
      cursor === undefined
        ? Promise.resolve({ items: cards(21, 20), nextCursor: 'c2', total: 21 })
        : down
          ? Promise.reject(new ApiError(500, undefined))
          : Promise.resolve({ items: cards(1, 1), nextCursor: null, total: 21 }),
    );
    try {
      await settled(observer, (result) => result.isSuccess);
      expect(failedMore()).toBe(false);
      await observer.fetchNextPage();
      expect(observer.getCurrentResult()).toMatchObject({
        isFetchNextPageError: true,
        isRefetchError: false,
      });
      expect(view()).toMatchObject({ stale: false, body: 'rows', total: 21, more: true });
      expect(failedMore()).toBe(true);
      expect(view().posts).toHaveLength(20);

      // Asked again: not said while it is being asked, and gone once the page came.
      down = false;
      const again = observer.fetchNextPage();
      expect(observer.getCurrentResult().isFetchingNextPage).toBe(true);
      expect(failedMore()).toBe(false);
      await again;
      expect(view()).toMatchObject({ body: 'rows', more: false });
      expect(failedMore()).toBe(false);
      expect(view().posts).toHaveLength(21);
    } finally {
      done();
    }
  });

  it('keeps the cards and the count when a refresh fails, and says so above them', async () => {
    let fail = false;
    const { observer, view, done } = observe(() =>
      fail
        ? Promise.reject(new ApiError(500, undefined))
        : Promise.resolve({ items: cards(2, 2), nextCursor: null, total: 2 }),
    );
    try {
      await settled(observer, (result) => result.isSuccess);
      fail = true;
      await observer.refetch();
      expect(observer.getCurrentResult().isRefetchError).toBe(true);
      expect(view()).toMatchObject({
        stale: true,
        body: 'rows',
        total: 2,
        more: false,
      });
      expect(view().posts).toHaveLength(2);
    } finally {
      done();
    }
  });

  it('offers no 더 보기 — and so no notice above it — over a pending, failed or empty list, whatever the flags say', () => {
    // The notice is drawn inside 더 보기's condition (market-discussion.tsx), so `more` false
    // leaves no place for it.
    const flags = { isPending: false, isLoadingError: false, isRefetchError: false, error: null };
    expect(
      discussionView({ ...flags, isPending: true, hasNextPage: true, data: undefined }),
    ).toMatchObject({ more: false });
    expect(
      discussionView({ ...flags, isLoadingError: true, hasNextPage: true, data: undefined }),
    ).toMatchObject({ more: false });
    expect(
      discussionView({
        ...flags,
        hasNextPage: true,
        data: { pages: [{ items: [], nextCursor: 'c', total: 0 }], pageParams: [undefined] },
      }),
    ).toMatchObject({ body: 'empty', more: false });
  });
});

describe('the 토론 cards (#47, owner decision 2026-10-20 6)', () => {
  it('draw no market line — every card is this market’s — while the community list’s keep it', () => {
    // `PostCard`'s `showMarket` (no DOM under node, so the two callers are read): the section
    // turns the line off, the community list leaves the default on. The live-row overlay that
    // kept the line's status and title current is gone with it.
    const section = readFileSync(
      path.join(SRC, 'app/markets/[slug]/market-discussion.tsx'),
      'utf8',
    );
    expect(section).toContain(
      '<PostCard key={post.id} post={post} titleAs="h3" showMarket={false} />',
    );
    expect(section).not.toContain('useMarket(');
    const community = readFileSync(path.join(SRC, 'app/community/community-screen.tsx'), 'utf8');
    expect(community).toContain('<PostCard key={post.id} post={post} />');
    const card = readFileSync(path.join(SRC, 'components/post/post-card.tsx'), 'utf8');
    expect(card).toContain('showMarket = true');
    expect(card).toMatch(/\{showMarket && \(\s*<HStack[\s\S]*?data-testid="post-card-market"/);
  });
});

describe('the 토론 count', () => {
  it('is 글 N beside the heading, as the post page heads its comments 댓글 N', () => {
    expect(copy.marketDiscussionCount).toBe('글');
    expect(discussionCountText(0)).toBe('글 0');
    expect(discussionCountText(21)).toBe('글 21');
  });
});

describe('the 토론 and the server page (#47, owner decision 2026-10-20 1)', () => {
  it('is never read by the detail’s server page, so no post reaches its HTML or dehydrated state', () => {
    // The page reads the row, the ticks and 관련 시장 — nothing of the posts: no reader of
    // `GET /markets/:id/posts` on the server and no seed under the section's key. The e2e reads
    // the HTML itself (discussion.spec.ts).
    const page = readFileSync(path.join(SRC, 'app/markets/[slug]/page.tsx'), 'utf8');
    const server = readFileSync(path.join(SRC, 'lib/api.server.ts'), 'utf8');
    expect(page).not.toMatch(/marketPostsKey|MarketPosts|lib\/discussion/);
    expect(server).not.toContain("'/api/v1/markets/{id}/posts'");
  });
});
