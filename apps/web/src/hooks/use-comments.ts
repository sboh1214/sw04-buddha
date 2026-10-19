'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  type CommentDeletion,
  type CreateCommentBody,
  type Post,
  type PublishedComment,
  type UpdateCommentBody,
  api,
  unwrap,
} from '@/lib/api';
import {
  type CommentPage,
  type CommentPages,
  commentPageQuery,
  isStaleThreadRefusal,
  postCommentsKey,
  withEditedComment,
  withNewComment,
  withoutComment,
} from '@/lib/comments';
import { POST_LIST_KEY, postKey } from '@/lib/posts';
import { afterRefusal } from './use-posts';

/**
 * 댓글·대댓글 (#48, ADR-0074): a post's comment threads and its readers' writes.
 *
 * Keys, requests and what a write does to the pages held live in lib/comments.ts — the post page
 * seeds the first page under that key on the server. The option factories are exported apart from
 * the hooks so the node test runner reaches them (use-comments.test.ts), as use-posts.ts does.
 *
 * A write's answer goes into the pages held: an edit in place (`withEditedComment`), a deletion
 * as its placeholder or out (`withoutComment`), a 대댓글 at the end of its 댓글 (`withNewComment`).
 * A new 댓글 is the newest of the post (#45-2: 작성 순), so its page is read rather than guessed
 * (`readOnToTheEnd`): put at the end of the pages held, it would stand before older 댓글 still
 * unread, and a later read of as many pages as were held would leave it out.
 *
 * Before an answer is written, a read of the pages still on its way is cancelled (A-M5-18, the
 * disputes' seed): it left before the write committed, and landing after the answer it would put
 * the pages back as they were — a deleted comment published again, an edit undone. A 더 보기 the
 * reader just pressed is cancelled with it: the button stops loading and is there to press again.
 * A read whose answer has already arrived but not yet been written can still land last — a window
 * of a microtask, left as the disputes' is; the next read puts it right.
 *
 * The post's count moves with the write at once (`moveCommentCount`) and the post and the
 * community list's cards are then read again, which only confirms it — or finds the post gone,
 * which the post page answers by drawing its 404 (post-screen.tsx). A refusal that says the
 * thread on screen is out of date reads the post and its comments again.
 */

/** `GET /posts/:postId/comments`, oldest first, one page of 댓글 per 더 보기. */
export function commentsInfiniteQueryOptions(postId: string) {
  const id = postId.toLowerCase();
  return {
    queryKey: postCommentsKey(id),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<CommentPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/posts/{postId}/comments', {
          params: { path: { postId: id }, query: commentPageQuery(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CommentPage) => last.nextCursor ?? undefined,
  };
}

export function useComments(postId: string) {
  return useInfiniteQuery(commentsInfiniteQueryOptions(postId));
}

/** A new 댓글 (`parentId` null) or 대댓글, its text and the account on screen. */
export type CreateCommentVariables = CreateCommentBody;

/** An edit: the comment, its new text and the account on screen. */
export interface UpdateCommentVariables extends UpdateCommentBody {
  commentId: string;
}

/** A deletion: the comment and the account on screen. */
export interface DeleteCommentVariables {
  commentId: string;
  expectedAccountId: string;
}

/** The post's own page (its count) and every list's cards, after a write changed the count. */
async function afterCountChange(queryClient: QueryClient, postId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: postKey(postId), exact: true }),
    queryClient.invalidateQueries({ queryKey: POST_LIST_KEY }),
  ]);
}

/**
 * The post's count ('댓글 N', #45-7) moved by a write the server answered, before the read that
 * confirms it: the heading never says more comments than the thread holds. One each way is right
 * for every write the page offers — a new comment counts; a deleted one stops counting while what
 * hangs under it still counts; a hidden comment, which the count leaves out, has no 삭제 on screen.
 */
function moveCommentCount(queryClient: QueryClient, postId: string, by: 1 | -1) {
  queryClient.setQueryData<Post>(
    postKey(postId),
    (post) => post && { ...post, commentCount: Math.max(0, post.commentCount + by) },
  );
}

/** Writes into the pages held, once no read of them is on its way to undo it (see above). */
async function writePages(
  queryClient: QueryClient,
  postId: string,
  write: (held: CommentPages | undefined) => CommentPages | undefined,
) {
  const key = postCommentsKey(postId);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  queryClient.setQueryData<CommentPages>(key, write);
}

/**
 * A new 댓글 where 작성 순 puts it (#45-2): the last page held is read again, and every page after
 * it, so the 댓글 arrives in the page the server keeps it in — after every older 댓글, read or
 * not, and kept by any later read of as many pages. Costs a read of the last page, and on a post
 * whose older 댓글 the reader had not all opened, the reads 더 보기 would have made. Nothing held
 * (the first read failed, or is on its way and may have left before the write): the pages are read
 * afresh. A read that fails puts the answer at the end of the pages held instead — the 댓글 is
 * written, and saying otherwise would invite a second.
 */
async function readOnToTheEnd(queryClient: QueryClient, postId: string, comment: PublishedComment) {
  const key = postCommentsKey(postId);
  const held = queryClient.getQueryData<CommentPages>(key);
  if (held === undefined || held.pages.length === 0) {
    await queryClient.invalidateQueries({ queryKey: key, exact: true });
    return;
  }
  const { queryFn } = commentsInfiniteQueryOptions(postId);
  const from = held.pages.length - 1;
  const pages: CommentPage[] = [];
  const pageParams: unknown[] = [];
  let cursor = held.pageParams[from] as string | undefined;
  try {
    for (;;) {
      const page = await queryFn({ pageParam: cursor });
      pages.push(page);
      pageParams.push(cursor);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  } catch {
    await writePages(queryClient, postId, (current) => withNewComment(current, comment));
    return;
  }
  await writePages(
    queryClient,
    postId,
    (current) =>
      current && {
        pages: [...current.pages.slice(0, from), ...pages],
        pageParams: [...current.pageParams.slice(0, from), ...pageParams],
      },
  );
}

/** A refusal's side effects: the session or `['me']` (use-posts.ts), and a stale thread read again. */
async function afterCommentRefusal(
  queryClient: QueryClient,
  postId: string,
  error: Error,
  onSessionChanged: () => void,
) {
  await afterRefusal(queryClient, error, onSessionChanged);
  if (isStaleThreadRefusal(error)) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: postCommentsKey(postId), exact: true }),
      queryClient.invalidateQueries({ queryKey: postKey(postId), exact: true }),
    ]);
  }
}

/**
 * `POST /posts/:postId/comments` as mutation options for the post `postId`: a 대댓글 goes under its
 * 댓글 in the pages held, a 댓글 arrives with its page (`readOnToTheEnd`); the count goes up by one.
 */
export function createCommentOptions(
  queryClient: QueryClient,
  postId: string,
  onSessionChanged: () => void,
) {
  const id = postId.toLowerCase();
  return {
    mutationFn: async (body: CreateCommentVariables): Promise<PublishedComment> =>
      unwrap(
        await api.POST('/api/v1/posts/{postId}/comments', {
          params: { path: { postId: id } },
          body,
        }),
      ).data,
    onSuccess: async (comment: PublishedComment) => {
      if (comment.parentId === null) await readOnToTheEnd(queryClient, id, comment);
      else await writePages(queryClient, id, (held) => withNewComment(held, comment));
      moveCommentCount(queryClient, id, 1);
      await afterCountChange(queryClient, id);
    },
    onError: (error: Error) => afterCommentRefusal(queryClient, id, error, onSessionChanged),
  };
}

/** `PUT /comments/:commentId`: the edited comment replaces the held one; no count changes. */
export function updateCommentOptions(
  queryClient: QueryClient,
  postId: string,
  onSessionChanged: () => void,
) {
  const id = postId.toLowerCase();
  return {
    mutationFn: async ({ commentId, ...body }: UpdateCommentVariables): Promise<PublishedComment> =>
      unwrap(
        await api.PUT('/api/v1/comments/{commentId}', {
          params: { path: { commentId: commentId.toLowerCase() } },
          body,
        }),
      ).data,
    onSuccess: (comment: PublishedComment) =>
      writePages(queryClient, id, (held) => withEditedComment(held, comment)),
    onError: (error: Error) => afterCommentRefusal(queryClient, id, error, onSessionChanged),
  };
}

/**
 * `POST /comments/:commentId/delete`: the comment becomes its placeholder or leaves the pages, as
 * the answer says (`withoutComment`), and the count goes down by one and is read again.
 */
export function deleteCommentOptions(
  queryClient: QueryClient,
  postId: string,
  onSessionChanged: () => void,
) {
  const id = postId.toLowerCase();
  return {
    mutationFn: async ({
      commentId,
      expectedAccountId,
    }: DeleteCommentVariables): Promise<CommentDeletion> =>
      unwrap(
        await api.POST('/api/v1/comments/{commentId}/delete', {
          params: { path: { commentId: commentId.toLowerCase() } },
          body: { expectedAccountId },
        }),
      ).data,
    onSuccess: async (deletion: CommentDeletion) => {
      await writePages(queryClient, id, (held) => withoutComment(held, deletion));
      moveCommentCount(queryClient, id, -1);
      await afterCountChange(queryClient, id);
    },
    onError: (error: Error) => afterCommentRefusal(queryClient, id, error, onSessionChanged),
  };
}

export function useCreateComment(postId: string, onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation(createCommentOptions(queryClient, postId, onSessionChanged));
}

export function useUpdateComment(postId: string, onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation(updateCommentOptions(queryClient, postId, onSessionChanged));
}

export function useDeleteComment(postId: string, onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation(deleteCommentOptions(queryClient, postId, onSessionChanged));
}
