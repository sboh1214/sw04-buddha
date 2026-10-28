import { type QueryClient } from '@tanstack/react-query';
import { type CommentPages } from './comments';

/** What a write does to the pages held: a function of them, so it can be done again over others. */
export type PagesWrite = (held: CommentPages | undefined) => CommentPages | undefined;

/**
 * The writes of each post's pages that landed while a read toward a place was on its way, by query
 * client and post — one log a read (`logWritesFrom`). The three reads that read the server's pages
 * themselves, not through the query, and then put what they read into the pages held — a new 댓글's
 * (`readOnToTheEnd`), a new 대댓글's (`readOnReplies`) and '답글 더 보기' (`readMoreReplies`,
 * hooks/use-comments.ts) — cannot be cancelled by a write as the query's reads are (`writePages`),
 * and what they bring was read before the writes that landed meanwhile: an edit, a deletion,
 * another new 대댓글 or another '답글 더 보기' on a comment those pages hold too (Codex review on PR
 * #220, round 4). Put in as read, it would bring back the old body or the deleted comment, or take
 * the new 대댓글 off again. So each read logs the writes that land from the moment it starts, and
 * does them again over its pages as it puts them in (`putReadPages`, ADR-0074 7-34).
 *
 * Here, apart from the comment hooks, so a write of the pages from elsewhere can log itself without
 * importing them (#141, ADR-0079 7-22): a profile image's faces (`storeAuthorImage`,
 * hooks/use-me.ts — the hooks every screen's header reads).
 */
const writesWhileReading = new WeakMap<QueryClient, Map<string, Set<PagesWrite[]>>>();

/** A log of the writes of `postId`'s pages from now on, until `putReadPages` (or `stopLogging`). */
export function logWritesFrom(queryClient: QueryClient, postId: string): PagesWrite[] {
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
export function stopLogging(queryClient: QueryClient, postId: string, log: PagesWrite[]) {
  const byPost = writesWhileReading.get(queryClient);
  const logs = byPost?.get(postId);
  if (logs === undefined) return;
  logs.delete(log);
  if (logs.size === 0) byPost?.delete(postId);
}

/**
 * `write` added to every log of a read of `postId`'s pages (lower-cased) still on its way — not
 * done here: its writer puts it into the pages held with nothing in between (`landWrite`, and
 * `putReadPages`'s what landed, hooks/use-comments.ts).
 */
export function logWrite(queryClient: QueryClient, postId: string, write: PagesWrite) {
  for (const log of writesWhileReading.get(queryClient)?.get(postId) ?? []) log.push(write);
}

/**
 * `write` added to every log of a read still on its way, whatever post it reads: a write that is
 * the same function of every post's pages — a member's new face (`storeAuthorImage`,
 * hooks/use-me.ts, which puts it into the pages held its own way: the data alone), which a read of
 * a post whose pages the cache no longer holds can bring too.
 */
export function logWriteForEveryPost(queryClient: QueryClient, write: PagesWrite) {
  for (const logs of writesWhileReading.get(queryClient)?.values() ?? []) {
    for (const log of logs) log.push(write);
  }
}
