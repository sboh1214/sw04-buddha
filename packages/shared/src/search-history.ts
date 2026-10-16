import * as z from 'zod';
import { marketSearchTermSchema } from './market.js';

/**
 * 최근 검색 (#15, ADR-0066): the searches a signed-in account submitted, kept with the account and
 * the time, and the search screen's recent list. Owner decisions (ADR-0061 decision 3, the #15
 * rows): a signed-in user's search term is recorded with account and time — never a signed-out
 * one, never the filters picked or how many results came back; with no term, the screen shows the
 * member's own recent searches, distinct, the newest 10, each removable and all at once; nothing
 * is kept for a fixed time only (the privacy notice is #137's). That the member sees them is the
 * owner's; that no public answer carries them (the `search-history` item of PRIVATE_DATA) is
 * ADR-0066's choice drawn from it, not an owner rule about who else may see them — what an
 * operator may see is #37 item 11.
 */

/** The recent list holds this many distinct terms, newest first (ADR-0061 decision 3, #15). */
export const RECENT_SEARCHES_LIMIT = 10;

/**
 * One term of the recent list. `id` is the newest recorded search of that term, and what a delete
 * names: deleting it deletes every recorded search of the term (the list is distinct, so a term
 * searched three times is one entry and goes as one). `searchedAt` is that newest search's time.
 */
export const recentSearchSchema = z
  .object({
    id: z.uuid(),
    query: z.string(),
    searchedAt: z.iso.datetime(),
  })
  .meta({ id: 'RecentSearch' });
export type RecentSearch = z.infer<typeof recentSearchSchema>;

/** The account the screen shows (better-auth `user.id`, text), as every owner write carries. */
const expectedAccountIdSchema = z.string().min(1).max(255);

/**
 * `POST /me/search-history`: the term submitted — the `GET /markets?q=` term, trimmed and bounded
 * the same way — and the account the screen shows (`expectedAccountId`, as on the time-zone and
 * watch bodies, ADR-0063·0064). The cookie decides whose history is written, and a window still
 * showing account A after another one signed in as B would otherwise put A's search into B's
 * history. The server refuses the mismatch (403 FORBIDDEN naming the field) before it writes.
 */
export const recordSearchBodySchema = z
  .object({
    query: marketSearchTermSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RecordSearchBody' });
export type RecordSearchBody = z.infer<typeof recordSearchBodySchema>;

/**
 * `POST /me/search-history/:id/delete` and `POST /me/search-history/clear`: the account the screen
 * shows, and nothing else. A body rather than a DELETE's query or header: the account id kept out
 * of the address (an access log keeps addresses), and OpenAPI 3.0 leaves a DELETE's body undefined
 * (ADR-0064 found the same for the watch).
 */
export const searchHistoryWriteBodySchema = z
  .object({ expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'SearchHistoryWriteBody' });
export type SearchHistoryWriteBody = z.infer<typeof searchHistoryWriteBodySchema>;
