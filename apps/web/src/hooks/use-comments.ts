'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  type CommentDeletion,
  type CommentThread,
  type CreateCommentBody,
  type Post,
  type PublishedComment,
  type UpdateCommentBody,
  api,
  isApiError,
  unwrap,
} from '@/lib/api';
import { commentDraftLanded } from '@/lib/comment-drafts';
import {
  type CommentPage,
  type CommentPages,
  type ReplyPage,
  commentPageQuery,
  commentThreadsOf,
  isStaleThreadRefusal,
  postCommentsKey,
  threadReadsOn,
  threadWithReplies,
  withEditedComment,
  withMoreReplies,
  withNewComment,
  withoutComment,
} from '@/lib/comments';
import { POST_LIST_KEY, postKey } from '@/lib/posts';
import { afterRefusal } from './use-posts';

/**
 * 댓글·대댓글 (#48, ADR-0074): a post's comment threads and its readers' writes.
 *
 * Keys, requests and what a write does to the pages held live in lib/comments.ts. The pages are
 * read in the browser only (오너 결정 2026-10-21: the post page does not seed them on the server).
 * The option factories are exported apart from the hooks so the node test runner reaches them
 * (use-comments.test.ts), as use-posts.ts does.
 *
 * A page carries each 댓글 with its first 50 대댓글; '답글 더 보기' reads 50 more at a time into the
 * thread held (`readMoreReplies`, 오너 결정 2026-10-21), and every later read of the pages reads a
 * thread on as far as the screen had it (`threadsReadOn`) — so a refresh never takes away 대댓글
 * on screen, nor a box open on one.
 *
 * A write's answer goes into the pages held: an edit in place (`withEditedComment`), a deletion
 * as its placeholder or out (`withoutComment`), a 대댓글 at the end of its 댓글 (`withNewComment`).
 * A new 댓글 is the newest of the post (#45-2: 작성 순), so its page is read rather than guessed
 * (`readOnToTheEnd`): put at the end of the pages held, it would stand before older 댓글 still
 * unread, and a later read of as many pages as were held would leave it out. A new 대댓글 is the
 * newest of its thread: while 대댓글 of the thread are unread, they are read to the end first
 * (`readOnReplies`), for the same reason.
 *
 * Before an answer is written — a write's, or the page of 대댓글 '답글 더 보기' read — a read of the
 * pages still on its way is cancelled (`writePages`, A-M5-18, the disputes' seed): it left before,
 * and landing after the answer it would put the pages back as they were — a deleted comment
 * published again, an edit undone, the 대댓글 just read taken off again with any box open on them.
 * A 더 보기 the reader just pressed is cancelled with it: the button stops loading and is there to
 * press again (for a draft taken back, the section presses it again itself). A read cancelled, or
 * left by a page that went, stops where it is: the query's signal reaches its requests and its
 * reads on through the 대댓글 (`threadsReadOn`), so none is sent after — each would count in the
 * reader's address limit (ADR-0074 7-28). A read whose answer has already arrived but not yet been
 * written can still land last — a window of a microtask, left as the disputes' is; the next read
 * puts it right.
 *
 * The post's count moves with the write at once (`moveCommentCount`) and the post and the
 * community list's cards are then read again, which only confirms it — or finds the post gone,
 * which the post page answers by drawing its 404 once no text is held apart (post-screen.tsx,
 * 오너 결정 2026-10-21 답 1). A refusal that says the
 * thread on screen is out of date reads the post and its comments again, and so does a '답글 더
 * 보기' answered NOT_FOUND (`readThreadsAgain`).
 */

/**
 * `GET /posts/:postId/comments`, oldest first, one page of 댓글 per 더 보기. Given the client
 * (the query's own context hands it over), a page read again keeps each thread as far as the
 * screen read it (`threadsReadOn`). Given the query's signal, a read cancelled or left stops: its
 * request is aborted and no reply page is asked for after.
 */
export function commentsInfiniteQueryOptions(postId: string) {
  const id = postId.toLowerCase();
  return {
    queryKey: postCommentsKey(id),
    queryFn: async ({
      pageParam,
      client,
      signal,
    }: {
      pageParam: string | undefined;
      client?: QueryClient;
      signal?: AbortSignal;
    }): Promise<CommentPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/posts/{postId}/comments', {
          params: { path: { postId: id }, query: commentPageQuery(pageParam) },
          signal,
        }),
      );
      const page = { items: data, nextCursor: meta.nextCursor };
      return client === undefined ? page : threadsReadOn(client, id, page, signal);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CommentPage) => last.nextCursor ?? undefined,
  };
}

/**
 * `GET /comments/:commentId/replies`: the 50 대댓글 of the 댓글 `threadId` after `cursor` — the
 * request aborted with `signal`, when given.
 */
export async function fetchReplyPage(
  threadId: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<ReplyPage> {
  const { data, meta } = unwrap(
    await api.GET('/api/v1/comments/{commentId}/replies', {
      params: { path: { commentId: threadId.toLowerCase() }, query: { cursor } },
      signal,
    }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/**
 * A page of the post's comments as read, each thread read on through its 대댓글 until it holds as
 * many as the pages held now do (`threadReadsOn`): what '답글 더 보기' brought stays on screen — and
 * an edit or a reply box open on it, which would otherwise go as its comment left the pages. A
 * reply page that fails fails the page, so the read keeps what is held; a read cancelled (`signal`)
 * asks for no reply page after. Costs, per thread read on, the reply pages the reader had opened —
 * all of a thread once a new 대댓글 read it to the end (`readOnReplies`), one request per 50 대댓글
 * on every later read of the pages (ADR-0074 7-28).
 */
async function threadsReadOn(
  client: QueryClient,
  postId: string,
  page: CommentPage,
  signal: AbortSignal | undefined,
): Promise<CommentPage> {
  const held = new Map(
    commentThreadsOf(client.getQueryData<CommentPages>(postCommentsKey(postId))).map((thread) => [
      thread.comment.id,
      thread,
    ]),
  );
  const items: CommentThread[] = [];
  for (const fresh of page.items) {
    let thread = fresh;
    const before = held.get(thread.comment.id);
    while (threadReadsOn(thread, before) && thread.repliesNextCursor !== null) {
      signal?.throwIfAborted();
      const more = await fetchReplyPage(thread.comment.id, thread.repliesNextCursor, signal);
      if (more.items.length === 0) break;
      thread = threadWithReplies(thread, more);
    }
    items.push(thread);
  }
  return { ...page, items };
}

/** The post and its comments read again: a refusal or an answer said the thread on screen is old. */
async function readThreadsAgain(queryClient: QueryClient, postId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: postCommentsKey(postId), exact: true }),
    queryClient.invalidateQueries({ queryKey: postKey(postId), exact: true }),
  ]);
}

/**
 * '답글 더 보기' (오너 결정 2026-10-21, ADR-0074): the next 50 대댓글 of the thread `threadId`,
 * read from the cursor the thread holds and written after its replies (`withMoreReplies` — unless
 * the thread was read again meanwhile, when its own cursor reads on). Nothing to read, nothing
 * asked. Written through `writePages`, as a write's answer is: a read of the pages on its way is
 * cancelled first — a 더 보기 the reader pressed among them, its button there to press again —
 * since it carries the pages from before and, landing after, would take these 대댓글 off again.
 * NOT_FOUND says the 댓글 left every view (deleted with nothing under it any more, or its post
 * gone): the thread on screen is old, so the post and its comments are read again — the thread
 * goes, and a box or a draft on it with it, by the rules of a place gone — rather than a button
 * that can only be answered the same. Throws when the read fails otherwise, for the button to say
 * so and be pressed again.
 */
export async function readMoreReplies(
  queryClient: QueryClient,
  postId: string,
  threadId: string,
): Promise<void> {
  const id = postId.toLowerCase();
  const thread = commentThreadsOf(queryClient.getQueryData<CommentPages>(postCommentsKey(id))).find(
    (held) => held.comment.id === threadId,
  );
  const from = thread?.repliesNextCursor ?? null;
  if (from === null) return;
  let page: ReplyPage;
  try {
    page = await fetchReplyPage(threadId, from);
  } catch (error) {
    if (!isApiError(error, 'NOT_FOUND')) throw error;
    await readThreadsAgain(queryClient, id);
    return;
  }
  await writePages(queryClient, id, (held) => withMoreReplies(held, threadId, from, page));
}

/** '답글 더 보기' of one thread: pressed, pending and failed as a mutation. */
export function useMoreReplies(postId: string, threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: () => readMoreReplies(queryClient, postId, threadId) });
}

/**
 * A new 대댓글 where 작성 순 puts it (#45-2): the last of its thread. While the thread has 대댓글
 * still unread, they are read to the end first and the answer is then in place among them (the last
 * page holds it) — otherwise it would stand before older 대댓글 the reader had not opened. Costs the
 * reads '답글 더 보기' would have made, one after another — one per 50 대댓글 unread, with no cap,
 * in the reader's address limit (100 a minute) with every other request of the page; and every
 * later read of the pages reads the whole thread again (`threadsReadOn`). ADR-0074 7-28 has the
 * numbers and the owner's open question. A read that fails — the limit's 429 among them — or a
 * thread read again meanwhile, puts the answer at the end of the replies held instead
 * (`withNewComment`) — it is written, and saying otherwise would invite a second. The pages read
 * before the failure are dropped, not kept: held, each later read of the pages would ask for them
 * all again.
 */
async function readOnReplies(queryClient: QueryClient, postId: string, reply: PublishedComment) {
  const threadId = reply.parentId;
  if (threadId === null) return;
  const thread = commentThreadsOf(
    queryClient.getQueryData<CommentPages>(postCommentsKey(postId)),
  ).find((held) => held.comment.id === threadId);
  const from = thread?.repliesNextCursor ?? null;
  const pages: ReplyPage[] = [];
  if (from !== null) {
    try {
      for (let cursor: string | null = from; cursor !== null;) {
        const page = await fetchReplyPage(threadId, cursor);
        pages.push(page);
        cursor = page.items.length === 0 ? null : page.nextCursor;
      }
    } catch {
      pages.length = 0;
    }
  }
  await writePages(queryClient, postId, (held) => {
    let next = held;
    let cursor = from;
    for (const page of pages) {
      if (cursor === null) break;
      next = withMoreReplies(next, threadId, cursor, page);
      cursor = page.nextCursor;
    }
    return withNewComment(next, reply);
  });
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
 * whose older 댓글 the reader had not all opened, the reads 더 보기 would have made — one per 20
 * 댓글, with no cap, in the reader's address limit, each with the reply pages of the threads read
 * on (`threadsReadOn`; ADR-0074 7-14). Nothing held
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
      const page = await queryFn({ pageParam: cursor, client: queryClient });
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
  if (isStaleThreadRefusal(error)) await readThreadsAgain(queryClient, postId);
}

/**
 * `POST /posts/:postId/comments` as mutation options for the post `postId`: a 대댓글 goes last of
 * its thread, its unread 대댓글 read first (`readOnReplies`), a 댓글 arrives with its page
 * (`readOnToTheEnd`); the count goes up by one.
 * A draft of that box an onboarding step kept in this tab is the comment now and is removed, and
 * the landing recorded first (`commentDraftLanded`, lib/comment-drafts.ts) — here, as the post
 * writes do it (use-posts.ts), since the page may have gone to the step with the write in flight,
 * and a box going before it hears of the success must not keep it again.
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
    onSuccess: async (comment: PublishedComment, { parentId }: CreateCommentVariables) => {
      commentDraftLanded(
        parentId === null || parentId === undefined
          ? { kind: 'comment', postId: id }
          : { kind: 'reply', postId: id, parentId: parentId.toLowerCase() },
      );
      if (comment.parentId === null) await readOnToTheEnd(queryClient, id, comment);
      else await readOnReplies(queryClient, id, comment);
      moveCommentCount(queryClient, id, 1);
      await afterCountChange(queryClient, id);
    },
    onError: (error: Error) => afterCommentRefusal(queryClient, id, error, onSessionChanged),
  };
}

/**
 * `PUT /comments/:commentId`: the edited comment replaces the held one; no count changes. A kept
 * draft of that edit goes, as a new comment's does.
 */
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
    onSuccess: (comment: PublishedComment, { commentId }: UpdateCommentVariables) => {
      commentDraftLanded({ kind: 'edit', postId: id, commentId: commentId.toLowerCase() });
      return writePages(queryClient, id, (held) => withEditedComment(held, comment));
    },
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
