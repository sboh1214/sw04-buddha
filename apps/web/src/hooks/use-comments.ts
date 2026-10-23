'use client';

import {
  notifyManager,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  type CommentDeletion,
  type CommentThread,
  type CreateCommentBody,
  type Me,
  type Post,
  type PublishedComment,
  type UpdateCommentBody,
  api,
  isApiError,
  unwrap,
} from '@/lib/api';
import { commentDraftLanded } from '@/lib/comment-drafts';
import {
  COMMENT_READ_ON_PAGES,
  REPLY_READ_ON_PAGES,
  type CommentPage,
  type CommentPages,
  type ReplyPage,
  type ReplyReadOnBudget,
  commentPageQuery,
  commentPageRead,
  commentThreadsOf,
  isCursorRefusal,
  isStaleThreadRefusal,
  placedReplyIds,
  postCommentsKey,
  replyReadOnBudget,
  threadOf,
  threadReadsOn,
  threadWithReplies,
  withEditedComment,
  withHeldLikeCounts,
  withMoreReplies,
  withNewComment,
  withoutComment,
} from '@/lib/comments';
import { POST_LIST_KEY, postKey } from '@/lib/posts';
import { ME_QUERY_KEY } from './use-me';
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
 * thread on as far as the screen had it (`threadsReadOn`) — so a refresh does not take away 대댓글
 * on screen, nor a box open on one — five reply pages at most (REPLY_READ_ON_PAGES, 오너 결정
 * 2026-10-21 (2차) 답 1), and 30 for the read in all, the threads at the top first
 * (REPLY_READ_ON_PAGES_IN_ALL, 오너 결정 2026-10-23).
 *
 * A write's answer goes into the pages held: an edit in place (`withEditedComment`), a deletion
 * as its placeholder or out (`withoutComment`), a 대댓글 at the end of its 댓글 (`withNewComment`).
 * A new 댓글 is the newest of the post (#45-2: 작성 순), so its page is read rather than guessed
 * (`readOnToTheEnd`): put at the end of the pages held, it would stand before older 댓글 still
 * unread, and a later read of as many pages as were held would leave it out — five comment pages
 * at most (COMMENT_READ_ON_PAGES, 오너 결정 2026-10-23 (2차)); past them it stands at the end of
 * the pages held until 더 보기 brings it into place. A new 대댓글 is the newest of its thread: while
 * 대댓글 of the thread are unread, they are read to the end first (`readOnReplies`), for the same
 * reason — five reply pages at most; past them it stands at the end of the 대댓글 held until '답글
 * 더 보기' brings it into place. Until then, either is put back there by every read of the pages
 * (or of its thread), a box on it staying, and dropped once a read ends the list (or the thread)
 * without it — deleted meanwhile, in another tab (`keepPlacedComments`, lib/comments.ts, through
 * the query client: 오너 결정 2026-10-24).
 *
 * Before an answer is written — a write's, or the page of 대댓글 '답글 더 보기' read — a read of the
 * pages still on its way is cancelled (`writePages`, A-M5-18, the disputes' seed): it left before,
 * and landing after the answer it would put the pages back as they were — a deleted comment
 * published again, an edit undone, the 대댓글 just read taken off again with any box open on them.
 * A read of every page held cancelled so is made again once the answer is in (ADR-0076 7-28): it
 * was asked for, and leaving after the answer it reads it. A 더 보기 the reader just pressed is
 * cancelled with it and not made again: the button stops loading and is there to press again (for
 * a draft taken back, the section presses it again itself). A read cancelled, or left by a page
 * that went, stops where it is: the query's signal reaches its requests and its reads on through
 * the 대댓글 (`threadsReadOn`), so none is sent after — each would count in the reader's address
 * limit (ADR-0074 7-28). A read whose answer has already arrived but not yet been written can
 * still land last — a window of a microtask, left as the disputes' is; the next read puts it right
 * (for a read of every page held, the one made again: the query still says it is on its way).
 *
 * The three reads that read pages themselves and put them in after — a new 댓글's, a new 대댓글's
 * and '답글 더 보기' — are not the query's, and no write cancels them. What they read can be older
 * than a write that lands while they read: an edit or a deletion of a comment on those pages, a
 * new 대댓글 or '답글 더 보기' of a thread on them. Each logs the writes from the moment it starts
 * reading and does them again over its pages as it puts them in (`putReadPages`, Codex review on PR
 * #220, round 4 — ADR-0074 7-34), so the pages keep every write that landed before them.
 *
 * The post's count moves with the write at once (`moveCommentCount`) and the post and the
 * community list's cards are then read again, which only confirms it — or finds the post gone,
 * which the post page answers by drawing its 404 once no text is held apart (post-screen.tsx,
 * 오너 결정 2026-10-21 답 1). A refusal that says the
 * thread on screen is out of date reads the post and its comments again, and so does a '답글 더
 * 보기' answered NOT_FOUND (`readThreadsAgain`). A 더 보기 whose cursor no longer opens (the key it
 * was sealed with changed, ADR-0074 7-29) reads the pages again from the first for fresh cursors,
 * and its page then (`readMoreReplies`, `readMoreComments`).
 */

/**
 * What each read of the comment pages has left to read on through their threads
 * (REPLY_READ_ON_PAGES_IN_ALL, 오너 결정 2026-10-23), by the signal TanStack Query hands every page
 * of that read: a refetch reads the pages held one after another, the first first, under one
 * signal — its retries too (a 5xx or a lost connection, query-client.ts) — so its threads spend
 * one budget in the order they are on screen, and a retry has what its failed attempts left.
 */
const readOnBudgets = new WeakMap<AbortSignal, ReplyReadOnBudget>();

function readOnBudgetOf(signal: AbortSignal | undefined): ReplyReadOnBudget {
  if (signal === undefined) return replyReadOnBudget();
  let budget = readOnBudgets.get(signal);
  if (budget === undefined) {
    budget = replyReadOnBudget();
    readOnBudgets.set(signal, budget);
  }
  return budget;
}

/**
 * `GET /posts/:postId/comments`, oldest first, one page of 댓글 per 더 보기. Given the client
 * (the query's own context hands it over), a page read again keeps each thread as far as the
 * screen read it (`threadsReadOn`), out of the read's budget (`budget`, or the one of its signal —
 * `readOnBudgetOf`). Given the query's signal, a read cancelled or left stops: its request is
 * aborted and no reply page is asked for after.
 */
export function commentsInfiniteQueryOptions(postId: string) {
  const id = postId.toLowerCase();
  return {
    queryKey: postCommentsKey(id),
    queryFn: async ({
      pageParam,
      client,
      signal,
      budget,
    }: {
      pageParam: string | undefined;
      client?: QueryClient;
      signal?: AbortSignal;
      /** The read's REPLY_READ_ON_PAGES_IN_ALL, when one read reads pages without a signal. */
      budget?: ReplyReadOnBudget;
    }): Promise<CommentPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/posts/{postId}/comments', {
          params: { path: { postId: id }, query: commentPageQuery(pageParam) },
          signal,
        }),
      );
      const page = { items: data, nextCursor: meta.nextCursor };
      // The server's word on these 댓글, for the writer's own placed at the end (`keepPlacedComments`).
      return commentPageRead(
        client === undefined
          ? page
          : await threadsReadOn(client, id, page, signal, budget ?? readOnBudgetOf(signal)),
      );
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
 * an edit or a reply box open on it, which would otherwise go as its comment left the pages — up
 * to REPLY_READ_ON_PAGES reply pages a thread (오너 결정 2026-10-21 (2차) 답 1): a thread opened further
 * than its first 50 and 250 more comes back to that, the rest behind '답글 더 보기' again. And out
 * of `budget`, the read's REPLY_READ_ON_PAGES_IN_ALL for all its pages (오너 결정 2026-10-23): the
 * threads spend it in their order, a page's top first and the pages in theirs; once it is spent,
 * the thread it ran out in keeps the pages it read and every thread after comes back to its first
 * 50, the rest behind '답글 더 보기'. A reply page that fails fails the page, so the read keeps
 * what is held; a read cancelled (`signal`) asks for no reply page after. Costs, per thread read
 * on, the reply pages the reader had opened, five at most, and 30 for the read — one request per 50
 * 대댓글 on every later read of the pages (ADR-0074 7-28).
 */
async function threadsReadOn(
  client: QueryClient,
  postId: string,
  page: CommentPage,
  signal: AbortSignal | undefined,
  budget: ReplyReadOnBudget,
): Promise<CommentPage> {
  const pages = client.getQueryData<CommentPages>(postCommentsKey(postId));
  // The writer's own 대댓글 placed at the end of a thread are put back after the read, not read
  // for (오너 결정 2026-10-24: 요청은 늘지 않음): the thread is read on as far as the rest of it.
  const placed = placedReplyIds(pages);
  const held = new Map(
    commentThreadsOf(pages).map((thread) => [
      thread.comment.id,
      placed.size === 0
        ? thread
        : { ...thread, replies: thread.replies.filter((reply) => !placed.has(reply.id)) },
    ]),
  );
  const items: CommentThread[] = [];
  for (const fresh of page.items) {
    let thread = fresh;
    const before = held.get(thread.comment.id);
    for (
      let pagesRead = 0;
      budget.left > 0 && threadReadsOn(thread, before, pagesRead);
      pagesRead += 1
    ) {
      const cursor = thread.repliesNextCursor;
      if (cursor === null) break;
      signal?.throwIfAborted();
      // Spent when asked: a page that fails was a request all the same.
      budget.left -= 1;
      const more = await fetchReplyPage(thread.comment.id, cursor, signal);
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
 * asked. Written as a write's answer is: a read of the pages on its way is cancelled first — a
 * 더 보기 the reader pressed among them, its button there to press again — since it carries the
 * pages from before and, landing after, would take these 대댓글 off again; and the writes that
 * landed while the page was read are done again over it (`putReadPages`, 7-34) — an edit or a
 * deletion of the writer's own 대댓글 placed at the end of the thread, which the page may bring as
 * it was.
 * NOT_FOUND says the 댓글 left every view (deleted with nothing under it any more, or its post
 * gone): the thread on screen is old, so the post and its comments are read again — the thread
 * goes, and a box or a draft on it with it, by the rules of a place gone — rather than a button
 * that can only be answered the same. A cursor the server no longer opens (`isCursorRefusal`: the
 * key it was sealed with changed, ADR-0074 7-29) would be refused on every press too: the pages are
 * read again from the first — fresh cursors, the thread read on as far as it was — and the next
 * page then read once from the thread's fresh cursor; should that read again not bring one, the
 * refusal is thrown, and the next press reads again. Throws when the read fails otherwise, for the
 * button to say so and be pressed again. What the 대댓글 it brings do to the edit texts held apart
 * for them is the comment section's, as for every read that brings 대댓글 onto the screen
 * (`heldEditsBrought`, 오너 결정 2026-10-22 (3차) 답 1).
 */
export async function readMoreReplies(
  queryClient: QueryClient,
  postId: string,
  threadId: string,
): Promise<void> {
  return readMoreRepliesOnce(queryClient, postId.toLowerCase(), threadId, false);
}

/** The cursor of the thread `threadId` as the pages of `postId` hold it; null: nothing more. */
function heldRepliesCursor(queryClient: QueryClient, postId: string, threadId: string) {
  const thread = threadOf(
    queryClient.getQueryData<CommentPages>(postCommentsKey(postId)),
    threadId,
  );
  return thread?.repliesNextCursor ?? null;
}

async function readMoreRepliesOnce(
  queryClient: QueryClient,
  postId: string,
  threadId: string,
  readAgain: boolean,
): Promise<void> {
  const from = heldRepliesCursor(queryClient, postId, threadId);
  if (from === null) return;
  let page: ReplyPage;
  // The reader's writes that land while this reads, done again over what it read (7-34).
  const log = logWritesFrom(queryClient, postId);
  try {
    page = await fetchReplyPage(threadId, from);
  } catch (error) {
    stopLogging(queryClient, postId, log);
    if (isApiError(error, 'NOT_FOUND')) {
      await readThreadsAgain(queryClient, postId);
      return;
    }
    if (!isCursorRefusal(error) || readAgain) throw error;
    await queryClient.invalidateQueries({ queryKey: postCommentsKey(postId), exact: true });
    // The read again failed (the thread holds the same cursor): the refusal says so.
    if (heldRepliesCursor(queryClient, postId, threadId) === from) throw error;
    return readMoreRepliesOnce(queryClient, postId, threadId, true);
  }
  await putReadPages(
    queryClient,
    postId,
    log,
    (held) => withMoreReplies(held, threadId, from, page),
    true,
  );
}

/**
 * The two reads of the comment list's 더 보기 (`useInfiniteQuery`'s, or its observer's): the next
 * page, and every page read again from the first.
 */
export interface CommentListReads {
  fetchNextPage: () => Promise<{ isFetchNextPageError: boolean; error: unknown }>;
  refetch: () => Promise<{ isError: boolean }>;
}

/**
 * The comment list's 더 보기: the next page of 댓글 from the cursor the last page held. A cursor the
 * server no longer opens (`isCursorRefusal`, ADR-0074 7-29) would be refused on every press: the
 * pages are read again from the first, with fresh cursors, and the next page then once. Any other
 * failure is the query's to show (#47 brings the list its notice).
 */
export async function readMoreComments(comments: CommentListReads): Promise<void> {
  const read = await comments.fetchNextPage();
  if (!read.isFetchNextPageError || !isCursorRefusal(read.error)) return;
  // Read again, the pages end where they end: with no page after them, 더 보기 asks for nothing.
  if (!(await comments.refetch()).isError) await comments.fetchNextPage();
}

/** '답글 더 보기' of one thread: pressed, pending and failed as a mutation. */
export function useMoreReplies(postId: string, threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: () => readMoreReplies(queryClient, postId, threadId) });
}

/**
 * A new 대댓글 where 작성 순 puts it (#45-2): the last of its thread. While the thread has 대댓글
 * still unread, they are read up to the page that holds the answer first and the answer is then in
 * place among them — otherwise it would stand before older 대댓글 the reader had not opened. That
 * page is usually the last; when others answered meanwhile it is not, and the reading stops there all
 * the same: what came after the answer stays behind the thread's cursor ('답글 더 보기'). Costs the
 * reads '답글 더 보기' would have made, one after another — one per 50 대댓글 unread, at most
 * REPLY_READ_ON_PAGES (오너 결정 2026-10-21 (2차) 답 1), in the reader's address limit (100 a minute) with
 * every other request of the page. A thread whose answer is not within that many pages, a read that
 * fails — the limit's 429 among them — or a thread read again meanwhile, puts the answer at the end
 * of the replies held instead (`withNewComment`) — it is written, and saying otherwise would invite
 * a second — and '답글 더 보기' brings it into its place with the page that holds it; until then
 * every read of the thread puts it back there, a box on it staying — placed for `accountId`, the
 * account that wrote it, while it is the one on screen as the answer is put in, the read done
 * (오너 결정 2026-10-24, `keepPlacedComments`, `writerOnScreen`).
 * The pages read are dropped then, not kept: the screen stays as the reader left it, with the new
 * 대댓글 under what they were reading, and a later read of the pages has less to read on
 * (`threadsReadOn`). A read that goes through the thread to its end without meeting the answer is
 * the server's word, not a fallback: the 대댓글 was deleted meanwhile — by its author in another tab
 * — so the pages read are written as they are and the answer is not put back (Codex review on PR
 * #220): put back, it would show again, with an edit and a deletion the server can only answer
 * NOT_FOUND, until a later read. Whatever is put in, the writes that landed while the thread was
 * read are done again over it (`putReadPages`, 7-34): the pages read can hold the writer's own
 * 대댓글 placed at the end of the thread as it was before an edit or a deletion of it.
 */
async function readOnReplies(
  queryClient: QueryClient,
  postId: string,
  reply: PublishedComment,
  accountId: string,
) {
  const threadId = reply.parentId;
  if (threadId === null) return;
  const thread = commentThreadsOf(
    queryClient.getQueryData<CommentPages>(postCommentsKey(postId)),
  ).find((held) => held.comment.id === threadId);
  const from = thread?.repliesNextCursor ?? null;
  const pages: ReplyPage[] = [];
  // The thread read to its end, the answer on none of its pages: gone since it was written.
  let gone = false;
  // The reader's writes that land while this reads, done again over what it read (7-34).
  const log = logWritesFrom(queryClient, postId);
  if (from !== null) {
    try {
      let cursor: string | null = from;
      let reached = false;
      while (cursor !== null && pages.length < REPLY_READ_ON_PAGES) {
        const page: ReplyPage = await fetchReplyPage(threadId, cursor);
        pages.push(page);
        // Reached: the answer is in its place, and what came after it stays behind the cursor.
        reached = page.items.some((item) => item.id === reply.id);
        cursor = page.items.length === 0 || reached ? null : page.nextCursor;
      }
      // Five pages read and the answer not among them: as a read that failed.
      if (cursor !== null) pages.length = 0;
      else gone = !reached;
    } catch {
      pages.length = 0;
    }
  }
  await putReadPages(
    queryClient,
    postId,
    log,
    (held) => {
      let next = held;
      let cursor = from;
      for (const page of pages) {
        if (cursor === null) break;
        next = withMoreReplies(next, threadId, cursor, page);
        cursor = page.nextCursor;
      }
      return gone ? next : withNewComment(next, reply, writerOnScreen(queryClient, accountId));
    },
    true,
  );
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

/** What a write does to the pages held: a function of them, so it can be done again over others. */
type PagesWrite = (held: CommentPages | undefined) => CommentPages | undefined;

/**
 * The writes of each post's pages that landed while a read toward a place was on its way, by query
 * client and post — one log a read (`logWritesFrom`). The three reads that read the server's pages
 * themselves, not through the query, and then put what they read into the pages held — a new 댓글's
 * (`readOnToTheEnd`), a new 대댓글's (`readOnReplies`) and '답글 더 보기' (`readMoreReplies`) —
 * cannot be cancelled by a write as the query's reads are (`writePages`), and what they bring was
 * read before the writes that landed meanwhile: an edit, a deletion, another new 대댓글 or another
 * '답글 더 보기' on a comment those pages hold too (Codex review on PR #220, round 4). Put in as
 * read, it would bring back the old body or the deleted comment, or take the new 대댓글 off again.
 * So each read logs the writes that land from the moment it starts, and does them again over its
 * pages as it puts them in (`putReadPages`, ADR-0074 7-34).
 */
const writesWhileReading = new WeakMap<QueryClient, Map<string, Set<PagesWrite[]>>>();

/** A log of the writes of `postId`'s pages from now on, until `putReadPages` (or `stopLogging`). */
function logWritesFrom(queryClient: QueryClient, postId: string): PagesWrite[] {
  let byPost = writesWhileReading.get(queryClient);
  if (byPost === undefined) {
    byPost = new Map();
    writesWhileReading.set(queryClient, byPost);
  }
  let logs = byPost.get(postId);
  if (logs === undefined) {
    logs = new Set();
    byPost.set(postId, logs);
  }
  const log: PagesWrite[] = [];
  logs.add(log);
  return log;
}

/** `log` closed: no write is added to it any more (again, harmlessly). */
function stopLogging(queryClient: QueryClient, postId: string, log: PagesWrite[]) {
  const byPost = writesWhileReading.get(queryClient);
  const logs = byPost?.get(postId);
  if (logs === undefined) return;
  logs.delete(log);
  if (logs.size === 0) byPost?.delete(postId);
}

/** `write` added to every log of a read of `postId`'s pages still on its way (not done here). */
function logWrite(queryClient: QueryClient, postId: string, write: PagesWrite) {
  for (const log of writesWhileReading.get(queryClient)?.get(postId) ?? []) log.push(write);
}

/** `write` done on the pages held, and added to every log of a read of them still on its way. */
function landWrite(queryClient: QueryClient, postId: string, write: PagesWrite) {
  queryClient.setQueryData<CommentPages>(postCommentsKey(postId), write);
  logWrite(queryClient, postId, write);
}

/**
 * Whether a read of every page held is on its way for `key` — fetching, or paused until the
 * browser is back online — rather than none, or a 더 보기 (`fetchNextPage`'s `fetchMore` meta).
 */
function readingEveryPage(queryClient: QueryClient, key: readonly unknown[]): boolean {
  const state = queryClient.getQueryState(key);
  return (
    state !== undefined && state.fetchStatus !== 'idle' && state.fetchMeta?.fetchMore === undefined
  );
}

/**
 * Writes into the pages held, once no read of them is on its way to undo it (see above) — and into
 * the log of every read toward a place still on its way, done again over what it reads (7-34) —
 * and makes again a read of every page held that it cancelled for that (#49, ADR-0076 7-28): the
 * read was asked for (a focus, the 30 seconds, a write's read again, a like's failure reading the
 * pages for the server's word on a press whose answer was lost after it committed), its
 * cancellation put the pages back as they were before it, and this write makes them fresh — no
 * longer marked stale — so nothing would read them until the next focus or 30 seconds. Made again
 * after the write, it reads it with them, as a like makes again a read it cancelled
 * (use-likes.ts). Not waited for: the write is done once its answer is in the pages. A 더 보기
 * cancelled is not made again — its button is there to press again — and, with nothing watching
 * the pages, the read made again only marks them stale, for the next screen that shows them to
 * read.
 */
async function writePages(queryClient: QueryClient, postId: string, write: PagesWrite) {
  const key = postCommentsKey(postId);
  const readAgain = readingEveryPage(queryClient, key);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  landWrite(queryClient, postId, write);
  if (readAgain) void queryClient.invalidateQueries({ queryKey: key, exact: true });
}

/**
 * What a read toward a place read (`put`) into the pages held, and then every write that landed
 * while it read (`log`, from `logWritesFrom`) done again over them, in the order they landed: each
 * is a function of the pages held — an edit's answer in place of its comment, a deletion's, a new
 * 대댓글 at the end of its thread, a reply page after the cursor it was read from — so it does to
 * what the read brought what it did to the pages it landed on, and does nothing again to what
 * already has it (a page read after it landed; one the read did not touch). An edit's answer goes
 * in only over the comment as published and edited no later (`withEditedComment`): a read since
 * may know it deleted, hidden or edited again. Two writes, one notification: what the read brought
 * goes in first, as a read's pages (`keepPlacedComments` settles the writer's own comments placed
 * at the end against them), and the writes after it, as writes. `logged`: whether `put` itself
 * goes into the logs of the other reads still on their way — a new 대댓글 and the reply page of
 * '답글 더 보기' are writes of a thread over the pages held, and done again over another read's
 * pages as any write is; a new 댓글's pages are what the server held when it read them, and done
 * again over another read's, they would put that read's back as they were. What goes into them is
 * what landed: `put` with this log's writes done again over it. `put` alone carries what it read
 * as it was read — the writer's own 대댓글 placed at the end of its thread, which the reply page
 * brings into place, as it was before an edit or a deletion that landed while it read — and, done
 * again over another read's pages after that write (which that read's log holds before it), would
 * bring it back as it was (the review of the Codex round-4 fix, 2026-10-24 — ADR-0074 7-34). A
 * read of every page held that it cancels to put them in is made again after, as `writePages`
 * makes it (7-28).
 */
async function putReadPages(
  queryClient: QueryClient,
  postId: string,
  log: PagesWrite[],
  put: PagesWrite,
  logged: boolean,
) {
  const key = postCommentsKey(postId);
  const readAgain = readingEveryPage(queryClient, key);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  // From here to the end nothing else runs: a write after this lands on what is put in below.
  stopLogging(queryClient, postId, log);
  const again: PagesWrite = (held) =>
    log.reduce<CommentPages | undefined>((pages, write) => write(pages), held);
  notifyManager.batch(() => {
    queryClient.setQueryData<CommentPages>(key, put);
    if (logged) logWrite(queryClient, postId, (held) => again(put(held)));
    if (log.length > 0) queryClient.setQueryData<CommentPages>(key, again);
  });
  if (readAgain) void queryClient.invalidateQueries({ queryKey: key, exact: true });
}

/**
 * A new 댓글 where 작성 순 puts it (#45-2): the last page held is read again, and the pages after
 * it up to the one that holds the 댓글, so it arrives in the page the server keeps it in — after
 * every older 댓글, read or not, and kept by any later read of as many pages. That page is usually
 * the last; when others wrote meanwhile it is not, and the reading stops there all the same: what
 * came after stays behind 더 보기. Costs a read of the last page, and on a post whose older 댓글
 * the reader had not all opened, the reads 더 보기 would have made — one per 20 댓글, in the
 * reader's address limit — COMMENT_READ_ON_PAGES at most, the last page held among them (오너 결정
 * 2026-10-23 (2차)), with the reply pages of the threads read on (`threadsReadOn`), 30 at most for
 * them all: one read of the pages, one budget (REPLY_READ_ON_PAGES_IN_ALL, 오너 결정 2026-10-23;
 * ADR-0074 7-14·7-28). Nothing held (the first read failed, or is on its way and may have left
 * before the write): the pages are read afresh. A read that fails — the limit's 429 among them —
 * or reads COMMENT_READ_ON_PAGES without reaching the 댓글 puts the answer at the end of the pages
 * held instead (`withNewComment`) — the 댓글 is written, and saying otherwise would invite a second
 * — and 더 보기 brings it into its place with the page that holds it; the pages read are dropped
 * then, the screen left as the reader had it, save the last page held read again (when that read
 * came back): its cursor goes on where the read did, while the one held may say there is nothing
 * after it — read when the reader had the whole list open, before others wrote past the five
 * pages — and leave no 더 보기 to bring the 댓글 into place (Codex review on PR #220). Until 더 보기
 * brings it, every read of the pages (a focus 30 seconds on, a reconnect, a stale thread's read
 * again) puts it back at the end of them, and a box open on it stays — placed for `accountId`, the
 * account that wrote it, while it is the one on screen as the 댓글 is put in, the read done (오너
 * 결정 2026-10-24, `keepPlacedComments`, `writerOnScreen`; ADR-0074 7-14). A read that reaches the
 * end without it — the 댓글 deleted meanwhile, in another tab — is the server's word: the pages
 * read are written as they are, and the answer is not put back. The pages read take the place of
 * the held ones from the last on — the last page held read again alone, when the read failed or
 * stopped — each comment held at the like count held (`withHeldLikeCounts`, #49, ADR-0076 7-27):
 * this read calls the query's function itself, so a like pressed while it is out sees no read of
 * the pages on its way and reads none after it — the count it wrote stays. A count held can be one
 * a failed press put back while its read again of the pages, for the server's word, is on its way;
 * putting the pages in cancels that read and makes it again (`putReadPages`, as `writePages`,
 * 7-28), so the screen still ends on the server's count. Either way — the pages read, or the last
 * page held read again — the reader's writes that landed while this read are done again over them
 * as they go in (`putReadPages`, Codex review on PR #220, round 4 — ADR-0074 7-34): an edit or a
 * deletion of a comment on them, a new 대댓글 or '답글 더 보기' of a thread on them, which the
 * pages, read before, would otherwise undo.
 */
async function readOnToTheEnd(
  queryClient: QueryClient,
  postId: string,
  comment: PublishedComment,
  accountId: string,
) {
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
  const budget = replyReadOnBudget();
  let cursor = held.pageParams[from] as string | undefined;
  // Whether the read came to the 댓글's page, or to the end of the 댓글: either is the server's.
  let done = false;
  // The reader's writes that land while this reads, done again over what it read (7-34).
  const log = logWritesFrom(queryClient, postId);
  try {
    while (!done && pages.length < COMMENT_READ_ON_PAGES) {
      const page: CommentPage = await queryFn({ pageParam: cursor, client: queryClient, budget });
      pages.push(page);
      pageParams.push(cursor);
      done =
        page.nextCursor === null || page.items.some((thread) => thread.comment.id === comment.id);
      cursor = page.nextCursor ?? undefined;
    }
  } catch {
    done = false;
  }
  if (!done) {
    // Failed, or COMMENT_READ_ON_PAGES read and the 댓글 not among them: as a read that failed,
    // save the last page held as read again — its cursor leaves 더 보기 there (see above) — at the
    // like counts held, as the pages of a read that reached the 댓글 (#49, ADR-0076 7-27).
    const [lastReadAgain] = pages;
    await putReadPages(
      queryClient,
      postId,
      log,
      (current) =>
        withNewComment(
          current !== undefined && lastReadAgain !== undefined
            ? {
                ...current,
                pages: [
                  ...current.pages.slice(0, from),
                  ...withHeldLikeCounts([lastReadAgain], current),
                ],
                pageParams: [...current.pageParams.slice(0, from), pageParams[0]],
              }
            : current,
          comment,
          writerOnScreen(queryClient, accountId),
        ),
      false,
    );
    return;
  }
  await putReadPages(
    queryClient,
    postId,
    log,
    (current) =>
      current && {
        ...current,
        pages: [...current.pages.slice(0, from), ...withHeldLikeCounts(pages, current)],
        pageParams: [...current.pageParams.slice(0, from), ...pageParams],
      },
    false,
  );
}

/**
 * The account that sent a write (`expectedAccountId`) while `GET /me` in this tab still names it —
 * the one its new comment is placed for (`withNewComment`) — or nothing: the tab changed hands
 * while the write or the read on after it was on its way (SessionCacheGuard reset the cache,
 * `['me']` reads the other account or nothing yet), and another account's screen keeps nothing
 * placed for it. Asked as the comment is put into the pages held, inside the write
 * (`readOnToTheEnd`, `readOnReplies`), not as the answer lands: the read on before it is up to five
 * comment pages and their reply pages, or five reply pages, and the tab may change hands during
 * it — asked once before it, the old account's comment stood placed on the new one's screen, put
 * back by every read (the review of the commit of 오너 결정 2026-10-24).
 */
function writerOnScreen(queryClient: QueryClient, accountId: string): string | undefined {
  return queryClient.getQueryData<Me>(ME_QUERY_KEY)?.id === accountId ? accountId : undefined;
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
 * and a box going before it hears of the success must not keep it again. Both for the account
 * that sent it (`expectedAccountId`) only: the tab may be another's by the time it lands — and so
 * is a comment put at the end of what is held, placed there for every later read (`withNewComment`,
 * 오너 결정 2026-10-24) only while `GET /me` in this tab still names that account as it is put in,
 * after the read on (`writerOnScreen`).
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
    onSuccess: async (
      comment: PublishedComment,
      { parentId, expectedAccountId }: CreateCommentVariables,
    ) => {
      commentDraftLanded(
        parentId === null || parentId === undefined
          ? { kind: 'comment', postId: id }
          : { kind: 'reply', postId: id, parentId: parentId.toLowerCase() },
        expectedAccountId,
      );
      const readOn = comment.parentId === null ? readOnToTheEnd : readOnReplies;
      await readOn(queryClient, id, comment, expectedAccountId);
      moveCommentCount(queryClient, id, 1);
      await afterCountChange(queryClient, id);
    },
    onError: (error: Error) => afterCommentRefusal(queryClient, id, error, onSessionChanged),
  };
}

/**
 * `PUT /comments/:commentId`: the edited comment replaces the held one; no count changes. A kept
 * draft of that edit by the account that sent it goes, as a new comment's does.
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
    onSuccess: (
      comment: PublishedComment,
      { commentId, expectedAccountId }: UpdateCommentVariables,
    ) => {
      commentDraftLanded(
        { kind: 'edit', postId: id, commentId: commentId.toLowerCase() },
        expectedAccountId,
      );
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
