'use client';

import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  type AuthoredComment,
  type CommentDeletion,
  type MyComment,
  type MyPost,
  type PostSummary,
  api,
  isApiError,
  unwrap,
} from '@/lib/api';
import {
  AUTHORED_KEY,
  type AuthoredPage,
  type AuthoredTab,
  MY_AUTHORED_KEY,
  myAuthoredKey,
  profileAuthoredKey,
  returnsToDrawnPage,
  withoutAuthoredItem,
} from '@/lib/authored';
import { postCommentsKey, withoutComment } from '@/lib/comments';
import { POST_LIST_KEY, postKey } from '@/lib/posts';
import { useSession } from '@/lib/use-session';
import { writePages } from './use-comments';
import { afterRefusal } from './use-posts';

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

// ---- MY's 삭제 on a hidden item ----------------------------------------------------------------

/**
 * What MY's 삭제 beside a '숨김' line sends (owner decision 2026-10-22, ADR-0080): the item — a post
 * on the 글 tab, a 댓글 or 대댓글 on the 댓글 tab — the post it is or sits under, and the account the
 * screen shows (`expectedAccountId`, A-PG-24, as every owner write).
 */
export interface DeleteMyItemVariables {
  tab: AuthoredTab;
  id: string;
  postId: string;
  expectedAccountId: string;
}

/**
 * Everything a deletion from MY changes, marked stale once the answer is in: both of MY's tabs (a
 * post deleted turns the post its comments name from hidden to the deleted placeholder), the
 * profile's lists (the same), the community list's cards and the post's own page and comment
 * threads (its placeholder and count). The ones on screen — MY's — are read at once; the others
 * when next shown. A comment's deletion is in the post's comment pages held already
 * (`deleteMyItemOptions`): marked stale, they are read again for what else changed.
 */
async function afterMyDeletion(queryClient: QueryClient, postId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: MY_AUTHORED_KEY }),
    queryClient.invalidateQueries({ queryKey: AUTHORED_KEY }),
    queryClient.invalidateQueries({ queryKey: POST_LIST_KEY }),
    queryClient.invalidateQueries({ queryKey: postKey(postId), exact: true }),
    queryClient.invalidateQueries({ queryKey: postCommentsKey(postId), exact: true }),
  ]);
}

/**
 * MY's 삭제 on an item an operator hid (owner decision 2026-10-22: «MY 내 글 항목('숨김' 줄 옆,
 * 확인 후)»), through the author's own delete routes — `POST /posts/:postId/delete` for the 글 tab,
 * `POST /comments/:commentId/delete` for the 댓글 tab — which take a hidden item and no writing
 * restriction (#45-12), as on the post page. Once the server answers, the item leaves
 * the pages held at once (`withoutAuthoredItem`, after any read of them still on its way is
 * cancelled, so it cannot land with the item back) — the tab and the summary's preview share the
 * entry — and everything it touched is read again (`afterMyDeletion`).
 *
 * A comment's answer (`CommentDeletion`) also goes into the post's comment pages this tab holds,
 * as the post page's own 삭제 writes it (`writePages` with `withoutComment`, use-comments.ts): its
 * placeholder, or out — and with it out of what #48 keeps placed at the end of the pages
 * (`keepPlacedComments`, 오너 결정 2026-10-24). A comment the member wrote on the post page in this
 * tab and an operator hid since may be held there still as it was before the hiding, placed at the
 * end past the five pages read toward it; marked stale only, every read of the pages would put that
 * copy back at their end until 더 보기 read the list to its end (ADR-0081 7-28 — the item ADR-0080
 * 결과 5 left to #50). The post's count does not move: a hidden comment was out of it.
 *
 * A refusal: as another account, the session is asked for again (`afterRefusal`); NOT_FOUND — the
 * item was deleted meanwhile, on another tab — reads MY's lists again, so it leaves them too.
 */
export function deleteMyItemOptions(queryClient: QueryClient, onSessionChanged: () => void) {
  return {
    mutationFn: async ({
      tab,
      id,
      expectedAccountId,
    }: DeleteMyItemVariables): Promise<CommentDeletion | null> => {
      const body = { expectedAccountId };
      if (tab === 'posts') {
        unwrap(
          await api.POST('/api/v1/posts/{postId}/delete', {
            params: { path: { postId: id.toLowerCase() } },
            body,
          }),
        );
        return null;
      }
      return unwrap(
        await api.POST('/api/v1/comments/{commentId}/delete', {
          params: { path: { commentId: id.toLowerCase() } },
          body,
        }),
      ).data;
    },
    onSuccess: async (
      deletion: CommentDeletion | null,
      { tab, id, postId }: DeleteMyItemVariables,
    ) => {
      const key = myAuthoredKey(tab);
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<{ pages: AuthoredPage<{ id: string }>[]; pageParams: unknown[] }>(
        key,
        (data) => withoutAuthoredItem(data, id.toLowerCase()),
      );
      if (deletion !== null) {
        await writePages(queryClient, postId, (held) => withoutComment(held, deletion));
      }
      await afterMyDeletion(queryClient, postId);
    },
    onError: async (error: Error) => {
      await afterRefusal(queryClient, error, onSessionChanged);
      if (isApiError(error, 'NOT_FOUND')) {
        await queryClient.invalidateQueries({ queryKey: MY_AUTHORED_KEY });
      }
    },
  };
}

export function useDeleteMyItem(onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation(deleteMyItemOptions(queryClient, onSessionChanged));
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
