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
 * The toast of a delete that failed; the list is back to what it held by then. A refusal as
 * another account (the cookie is somebody else's now, A-PG-24) says so instead, as the watch and
 * the time zone do; the hook has asked for the session again.
 */
export function searchHistoryFailureMessage(error: unknown): string {
  return isForAnotherAccount(error) ? copy.sessionChanged : copy.recentSearchDeleteFailed;
}
