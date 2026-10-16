import { copy } from '@/copy';
import { type RecentSearch, isForAnotherAccount } from './api';

/**
 * 최근 검색 (#15, ADR-0066): the decisions of the recent list's writes, kept out of the hook so the
 * node test runner reaches them. Which term a submit records is `searchToRecord`
 * (lib/market-search.ts); this is what a delete does to the list on screen and what its failure
 * says.
 */

/** A delete of the recent list: one entry (every search of its term) or all of them. */
export type SearchHistoryWrite =
  | { kind: 'delete'; id: string; expectedAccountId: string }
  | { kind: 'clear'; expectedAccountId: string };

/**
 * The list as it is once the write is done, for the screen to show at the press: the entry gone,
 * or nothing left. The server deletes every search of the entry's term, and the list holds each
 * term once, so dropping the one entry is the whole of it.
 */
export function afterSearchHistoryWrite(
  held: readonly RecentSearch[],
  write: SearchHistoryWrite,
): RecentSearch[] {
  return write.kind === 'clear' ? [] : held.filter((entry) => entry.id !== write.id);
}

/**
 * The list once a FAILED write is undone: the entries that write hid (`removed`) put back into the
 * list the screen holds NOW (`current`).
 *
 * Not the list as it was before the press: two deletes can be in flight at once, and each would
 * then restore its own snapshot. Deleting `a` then `b` keeps `[a, b]` and `[b]`; if the first
 * failure lands before the second, the second's snapshot puts `[b]` back and `a` stays hidden
 * though neither delete happened — and during the outage that failed them, the read after them
 * fails too, so the wrong list stays (Codex on #212). Undoing only its own change, each failure
 * leaves the other's optimistic change alone.
 *
 * Where the entries go back: while `current` is still made only of entries the list held at the
 * press (`before`), at their old places — the list is then exactly `before` minus whatever other
 * write still hides. If a read answered meanwhile and brought entries `before` did not have, the
 * entries go in by the server's order (`searchedAt`, then the larger `id`). An entry already back,
 * or a term on screen again under a newer search, is not added twice.
 */
export function undoSearchHistoryWrite(
  current: readonly RecentSearch[],
  removed: readonly RecentSearch[],
  before: readonly RecentSearch[],
): RecentSearch[] {
  const ids = new Set(current.map((entry) => entry.id));
  const terms = new Set(current.map((entry) => entry.query));
  const back = removed.filter((entry) => !ids.has(entry.id) && !terms.has(entry.query));
  const beforeIds = new Set(before.map((entry) => entry.id));
  if (current.every((entry) => beforeIds.has(entry.id))) {
    const kept = new Set([...ids, ...back.map((entry) => entry.id)]);
    return before.filter((entry) => kept.has(entry.id));
  }
  return [...current, ...back].sort(newestFirst);
}

/** The server's order of the recent list: the newest search first, then the larger id. */
function newestFirst(a: RecentSearch, b: RecentSearch): number {
  if (a.searchedAt !== b.searchedAt) return a.searchedAt < b.searchedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * The toast of a delete that failed; the list is back to what it held by then. A refusal as
 * another account (the cookie is somebody else's now, A-PG-24) says so instead, as the watch and
 * the time zone do; the hook has asked for the session again.
 */
export function searchHistoryFailureMessage(error: unknown): string {
  return isForAnotherAccount(error) ? copy.sessionChanged : copy.recentSearchDeleteFailed;
}
