'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { type PostImagePurpose } from '@buddha/shared';
import { ME_QUERY_KEY, useMe } from '@/hooks/use-me';
import {
  type CreatePostBody,
  type Post,
  type PostDeletion,
  type UpdatePostBody,
  type UploadedImage,
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import { postDraftLanded } from '@/lib/post-drafts';
import { uploadContentType } from '@/lib/post-editor';
import {
  type CommunityFilters,
  type CountedPostPage,
  POST_LIST_KEY,
  type PostPage,
  communityPostsKey,
  marketPostsKey,
  marketPostsQuery,
  postKey,
  postListQuery,
} from '@/lib/posts';
import { afterRestricted } from '@/lib/query-client';

/**
 * 근거 글 (#46, ADR-0073): the community list, a post page, the writes and the image upload — and a
 * market detail's 토론 (#47, ADR-0075), the same cards narrowed to the market, under the lists' root
 * so the writes below mark it stale with the community list.
 *
 * Keys and requests live in lib/posts.ts — the server pages seed the cache under those keys, and a
 * server component cannot take a key from a `'use client'` module (the rule use-markets.ts states).
 * The option factories are exported apart from the hooks so the node test runner reaches them
 * (use-posts.test.ts), as use-watchlist.ts does.
 */

/**
 * `GET /posts` with the filters, newest first, one page per 더 보기, in the page shape the server
 * page dehydrates (`fetchPostsPageServer`, the same request through `postListQuery`), so the first
 * page is picked up rather than fetched again. `keepPreviousData` keeps the cards on screen while a
 * new filter's first page loads, as the home's list does.
 */
export function communityPostsInfiniteQueryOptions(filters: CommunityFilters) {
  return {
    queryKey: communityPostsKey(filters),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<PostPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/posts', { params: { query: postListQuery(filters, pageParam) } }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: PostPage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  };
}

export function useCommunityPosts(filters: CommunityFilters) {
  return useInfiniteQuery(communityPostsInfiniteQueryOptions(filters));
}

/**
 * A market detail's 토론 (#47, ADR-0075): `GET /markets/:id/posts`, the market's posts newest first,
 * 20 a page per 더 보기 (ADR-0069 decision 4 #47), each page with the count of the whole list. Read
 * in the browser only — the detail's server page does not seed it, so no post reaches the HTML a
 * search engine gets (owner decision 2026-10-20 1). No `keepPreviousData`: the key never changes
 * under a mounted section (one market per page).
 */
export function marketPostsInfiniteQueryOptions(marketId: string) {
  const id = marketId.toLowerCase();
  return {
    queryKey: marketPostsKey(id),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<CountedPostPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/markets/{id}/posts', {
          params: { path: { id }, query: marketPostsQuery(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor, total: meta.total };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CountedPostPage) => last.nextCursor ?? undefined,
  };
}

export function useMarketPosts(marketId: string) {
  return useInfiniteQuery(marketPostsInfiniteQueryOptions(marketId));
}

/** One post page (`GET /posts/:postId`), keyed and requested by the lower-cased uuid. */
export function postQueryOptions(postId: string) {
  const id = postId.toLowerCase();
  return {
    queryKey: postKey(id),
    queryFn: async (): Promise<Post> =>
      unwrap(await api.GET('/api/v1/posts/{postId}', { params: { path: { postId: id } } })).data,
  };
}

export function usePost(postId: string) {
  return useQuery(postQueryOptions(postId));
}

/**
 * Who is writing: the account the screen shows (`expectedAccountId` on every write, A-PG-24) and
 * its public id, which tells the viewer's own posts apart (`isOwnPost`). Both come from `GET /me`,
 * so they are undefined until it has answered — and for a visitor, who writes nothing.
 */
export function usePostWriter() {
  const me = useMe();
  return {
    pending: me.isPending,
    signedIn: me.isLoggedIn,
    /**
     * Signed in, and `GET /me` failed without ever answering: who is writing is unknown, so
     * nothing is offered. A read again that fails (a refused write's, a window's focus) keeps what
     * the last one said — the form and its draft stay, as the onboarding gate does — rather than
     * taking the form, and what was written in it, away; the server checks the account of every
     * write besides (`expectedAccountId`).
     */
    failed: me.isLoggedIn && me.isError && me.data === undefined,
    accountId: me.data?.id,
    publicId: me.data?.profile.publicId,
  };
}

/** What a write sends: a new post's market, title and body, and the account on screen. */
export type CreatePostVariables = CreatePostBody;

/** An edit: the post, its new title and body, and the account on screen. */
export interface UpdatePostVariables extends UpdatePostBody {
  postId: string;
}

/** A deletion: the post and the account on screen. */
export interface DeletePostVariables {
  postId: string;
  expectedAccountId: string;
}

/**
 * A refused write's side effects, shared by the post writes, the image upload (`postImageUploader`)
 * and the comment writes (use-comments.ts): the cookie as another account asks for the session
 * again (`onSessionChanged`, SessionCacheGuard then shows who is signed in), and a refusal for the
 * onboarding reads `['me']` again, so the onboarding gate takes the account to its step — and a
 * post form, going, keeps its draft in this tab (hooks/use-post-draft.ts, 오너 결정 2026-10-20).
 */
export async function afterRefusal(
  queryClient: QueryClient,
  error: Error,
  onSessionChanged: () => void,
) {
  if (isForAnotherAccount(error)) onSessionChanged();
  if (isApiError(error, 'ONBOARDING_REQUIRED')) {
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
  }
}

/**
 * `POST /posts` as mutation options. The answer is the post as its page shows it, so it is written
 * under its key before the screen goes there (no second read), and every list is marked stale —
 * the new post is the newest of each it belongs to. A draft of that market's write screen the
 * onboarding gate kept in this tab is the post now and is removed (lib/post-drafts.ts) — here, not
 * on the screen, as the gate may have taken the screen away while the write was in flight — and
 * the landing is recorded first (`postDraftLanded`): the mutation counts as succeeded, and the form
 * renders `saved`, only after this has run, and a form the gate takes away meanwhile must not keep
 * the draft again. Both for the account that sent it (`expectedAccountId`) only: the tab may be
 * another's by the time it lands.
 */
export function createPostOptions(queryClient: QueryClient, onSessionChanged: () => void) {
  return {
    // Documented as a `Post` (the route shares the page's schema); a new post is always published.
    mutationFn: async (body: CreatePostVariables): Promise<Post> =>
      unwrap(await api.POST('/api/v1/posts', { body })).data,
    onSuccess: async (post: Post, { marketId, expectedAccountId }: CreatePostVariables) => {
      postDraftLanded({ kind: 'new', marketId }, expectedAccountId);
      queryClient.setQueryData<Post>(postKey(post.id), post);
      await queryClient.invalidateQueries({ queryKey: POST_LIST_KEY });
    },
    onError: (error: Error) => afterRefusal(queryClient, error, onSessionChanged),
  };
}

/**
 * `PUT /posts/:postId`: the edited post replaces the held one; the lists' cards follow it, and a
 * kept draft of its edit screen by the account that sent it goes, as a new post's does.
 *
 * A read of the post still on its way is cancelled before the answer goes in (ADR-0073 9-49,
 * Codex review of #219, round 5): one that left before the edit was saved — a window's focus — and
 * answered after it would otherwise put the earlier version back over the saved one, and the post
 * page the screen goes to would show it. A cancelled read's answer is dropped when it comes
 * (query-core's retryer), and the write follows the cancel with nothing in between, so the next
 * read is one that left after the save. Unconditional (`exact`, not `cancelFirstFetch`): this is a
 * seed over held data, the case lib/query-client.ts says to cancel for itself.
 */
export function updatePostOptions(queryClient: QueryClient, onSessionChanged: () => void) {
  return {
    mutationFn: async ({ postId, ...body }: UpdatePostVariables): Promise<Post> =>
      unwrap(
        await api.PUT('/api/v1/posts/{postId}', {
          params: { path: { postId: postId.toLowerCase() } },
          body,
        }),
      ).data,
    onSuccess: async (post: Post, { postId, expectedAccountId }: UpdatePostVariables) => {
      postDraftLanded({ kind: 'edit', postId }, expectedAccountId);
      await queryClient.cancelQueries({ queryKey: postKey(post.id), exact: true });
      queryClient.setQueryData<Post>(postKey(post.id), post);
      await queryClient.invalidateQueries({ queryKey: POST_LIST_KEY });
    },
    onError: async (error: Error, { postId }: UpdatePostVariables) => {
      await afterRefusal(queryClient, error, onSessionChanged);
      // Hidden or deleted meanwhile: the page is read again so it shows what the post is now.
      if (isApiError(error, 'POST_NOT_EDITABLE') || isApiError(error, 'NOT_FOUND')) {
        await queryClient.invalidateQueries({ queryKey: postKey(postId), exact: true });
      }
    },
  };
}

/**
 * `POST /posts/:postId/delete`. The held page is dropped rather than kept: the post is gone from
 * every view, or — once replies exist (#48) — a placeholder the next read answers. The lists are
 * marked stale, so the card leaves them.
 */
export function deletePostOptions(queryClient: QueryClient, onSessionChanged: () => void) {
  return {
    mutationFn: async ({ postId, expectedAccountId }: DeletePostVariables): Promise<PostDeletion> =>
      unwrap(
        await api.POST('/api/v1/posts/{postId}/delete', {
          params: { path: { postId: postId.toLowerCase() } },
          body: { expectedAccountId },
        }),
      ).data,
    onSuccess: async (_deletion: PostDeletion, { postId }: DeletePostVariables) => {
      queryClient.removeQueries({ queryKey: postKey(postId), exact: true });
      await queryClient.invalidateQueries({ queryKey: POST_LIST_KEY });
    },
    onError: (error: Error) => afterRefusal(queryClient, error, onSessionChanged),
  };
}

export function useCreatePost(onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation(createPostOptions(queryClient, onSessionChanged));
}

export function useUpdatePost(onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation(updatePostOptions(queryClient, onSessionChanged));
}

export function useDeletePost(onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation(deletePostOptions(queryClient, onSessionChanged));
}

/**
 * `POST /media/images`: the file itself as the body (no multipart, no field names), under its own
 * type or `application/octet-stream` (`uploadContentType`), with the account on screen in the
 * query — the body is the file, so it cannot ride there. The server checks the bytes, strips the
 * metadata and stores the result; the answer's id goes into the editor's image node.
 *
 * `purpose` is what the image is for: a post's (the default, said by saying nothing — the query
 * of every post's upload is what it was), or an admin's notice's (#138), said as `purpose=notice`,
 * which a writing restriction does not refuse (owner decision 2026-10-23 answer 13, ADR-0082) and
 * the server takes from an admin's upload alone.
 */
export async function uploadPostImage(
  file: Blob & { type: string },
  expectedAccountId: string,
  purpose: PostImagePurpose = 'post',
): Promise<UploadedImage> {
  return unwrap(
    await api.POST('/api/v1/media/images', {
      params: {
        query: purpose === 'post' ? { expectedAccountId } : { expectedAccountId, purpose },
      },
      // openapi-fetch would JSON-encode the body: the file goes as it is.
      body: file as unknown as string,
      bodySerializer: (body: unknown) => body as BodyInit,
      headers: { 'Content-Type': uploadContentType(file) },
    }),
  ).data;
}

/**
 * `uploadPostImage` as the editor sends it: a refusal runs the writes' side effects first
 * (`afterRefusal`) — an upload refused for the onboarding (a revision asked for consent again) or
 * as another account (the cookie changed in another tab) puts the account's real state on screen,
 * as a refused send does, rather than leaving the form up with every later upload and the send
 * refused the same way; a writing restriction's (RESTRICTED, #185 — the server refuses a post's
 * image before converting it) reads the member's restriction and actions again, so the write
 * page's banner says it (`afterRestricted`, query-client.ts — what the app's MutationCache does for
 * every mutation's refusal; the upload is a plain call, so it asks here) — and is then the editor's
 * to show. Each call is one attempt: the editor sends a 429's file again around it (`sendRetrying`,
 * lib/post-editor.ts), and each attempt refused runs these. A notice's editor (#138) uploads with
 * `purpose` `notice`, which no writing restriction refuses (owner decision 2026-10-23 answer 13).
 */
export function postImageUploader(queryClient: QueryClient, onSessionChanged: () => void) {
  return async (
    file: Blob & { type: string },
    expectedAccountId: string,
    purpose: PostImagePurpose = 'post',
  ) => {
    try {
      return await uploadPostImage(file, expectedAccountId, purpose);
    } catch (error) {
      afterRestricted(queryClient, error);
      await afterRefusal(queryClient, error as Error, onSessionChanged);
      throw error;
    }
  };
}

export function useUploadPostImage(onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return postImageUploader(queryClient, onSessionChanged);
}
