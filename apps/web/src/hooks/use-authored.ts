'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  type AuthoredComment,
  type MyComment,
  type MyPost,
  type PostSummary,
  api,
  unwrap,
} from '@/lib/api';
import {
  type AuthoredPage,
  myAuthoredKey,
  profileAuthoredKey,
  returnsToDrawnPage,
} from '@/lib/authored';
import { useSession } from '@/lib/use-session';

/**
 * 작성자별 글·댓글 (#51, ADR-0080): a profile's 글 and 댓글 tabs and MY '내 글''s, each a cursor list
 * newest first, one page per 더 보기 — the community list's idiom (use-posts.ts).
 *
 * Every one is read again whenever a screen that shows it mounts (`refetchOnMount: 'always'`),
 * whatever its age: these lists change by what the member does on OTHER screens — a post or a
 * comment written, edited or deleted on its post page, a like — and the writes there mark the
 * community list stale, not these. The rows held are drawn meanwhile and replaced by the answer,
 * as an invalidated list's are, so a post deleted a moment ago never stays on MY or the profile.
 * The profile's counts are the server's, drawn with the page, so a profile page Back or Forward
 * brings back is drawn again too (`useRedrawOnReturn`, ADR-0080 7-16).
 *
 * The option factories are exported apart from the hooks so the node test runner reaches them
 * (use-authored.test.ts), as use-watchlist.ts does.
 */

/** Just enough of better-auth's session to say whether anybody is signed in (use-watchlist.ts). */
type SessionLike = { user: unknown } | null;

const cursorQuery = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

/** The page shape and the paging every list here shares. */
function pages<Row>(
  queryKey: readonly unknown[],
  read: (cursor: string | undefined) => Promise<AuthoredPage<Row>>,
) {
  return {
    queryKey,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => read(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuthoredPage<Row>) => last.nextCursor ?? undefined,
    refetchOnMount: 'always' as const,
  };
}

/**
 * A profile's 글 tab (`GET /profiles/:publicId/posts`): the community list's cards. Public — no
 * session to wait for, and the same answer for every reader. The public id goes as the address
 * has it lower-cased, the one the key holds.
 */
export function profilePostsInfiniteQueryOptions(publicId: string) {
  const id = publicId.toLowerCase();
  return pages<PostSummary>(profileAuthoredKey(id, 'posts'), async (cursor) => {
    const { data, meta } = unwrap(
      await api.GET('/api/v1/profiles/{publicId}/posts', {
        params: { path: { publicId: id }, query: cursorQuery(cursor) },
      }),
    );
    return { items: data, nextCursor: meta.nextCursor };
  });
}

/** A profile's 댓글 tab (`GET /profiles/:publicId/comments`): 댓글 and 대댓글 together. */
export function profileCommentsInfiniteQueryOptions(publicId: string) {
  const id = publicId.toLowerCase();
  return pages<AuthoredComment>(profileAuthoredKey(id, 'comments'), async (cursor) => {
    const { data, meta } = unwrap(
      await api.GET('/api/v1/profiles/{publicId}/comments', {
        params: { path: { publicId: id }, query: cursorQuery(cursor) },
      }),
    );
    return { items: data, nextCursor: meta.nextCursor };
  });
}

/**
 * MY '내 글''s 글 tab (`GET /me/posts`): the member's posts with `hidden` on one an operator hid.
 * Waits for the session like `useWatchlist`: the route needs the cookie, and a signed-out request
 * would take a 401 the retry rule refuses to retry.
 */
export function myPostsInfiniteQueryOptions(session?: SessionLike) {
  return {
    ...pages<MyPost>(myAuthoredKey('posts'), async (cursor) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/posts', { params: { query: cursorQuery(cursor) } }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    }),
    enabled: session != null,
  };
}

/** MY '내 글''s 댓글 tab (`GET /me/comments`). */
export function myCommentsInfiniteQueryOptions(session?: SessionLike) {
  return {
    ...pages<MyComment>(myAuthoredKey('comments'), async (cursor) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/comments', { params: { query: cursorQuery(cursor) } }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    }),
    enabled: session != null,
  };
}

export function useProfilePosts(publicId: string) {
  return useInfiniteQuery(profilePostsInfiniteQueryOptions(publicId));
}

export function useProfileComments(publicId: string) {
  return useInfiniteQuery(profileCommentsInfiniteQueryOptions(publicId));
}

/**
 * `isPending` covers the session lookup too, as `useWatchlist` does: until better-auth has said
 * who is signed in, the list is loading, never empty.
 */
export function useMyPosts() {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(myPostsInfiniteQueryOptions(session));
  return { ...query, isPending: sessionPending || (session != null && query.isPending) };
}

export function useMyComments() {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(myCommentsInfiniteQueryOptions(session));
  return { ...query, isPending: sessionPending || (session != null && query.isPending) };
}

/** The profile pages (`useRouter().bfcacheId`) drawn in this document so far. */
const drawnProfilePages = new Set<string>();

/**
 * Draws the profile page again from the server (`router.refresh()`) when Back or Forward brought it
 * back (`returnsToDrawnPage`), so the counts the server drew agree with the lists, which are read
 * again on every mount — a write on another screen, then Back, would otherwise leave the old counts
 * over the new lists (ADR-0080 7-16). The tabs and the lists keep their state through the refresh.
 *
 * Once per page instance: React's development double effect runs this twice on one mount, and the
 * ref keeps the second run from taking the first's record for a return.
 */
export function useRedrawOnReturn() {
  const router = useRouter();
  const { bfcacheId } = router;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (handled.current === bfcacheId) return;
    handled.current = bfcacheId;
    if (returnsToDrawnPage(drawnProfilePages, bfcacheId)) router.refresh();
  }, [bfcacheId, router]);
}
