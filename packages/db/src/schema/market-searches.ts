import { desc } from 'drizzle-orm';
import { index, pgTable, primaryKey, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { MARKET_SEARCH_TERM_MAX } from '@buddha/shared';
import { user } from './auth.js';
import { timestampTz } from './columns.js';

/**
 * 최근 검색 (#15, ADR-0066): one row per search a signed-in account submitted on the market
 * search — the term and the time, nothing else (ADR-0061 decision 3, the #15 rows: no filter, no
 * result count, no signed-out search). A term searched again is a new row with its own time; the
 * recent list is the newest row of each distinct term, which `market_search_terms` below keeps
 * (SearchHistoryService). Private to the account: no public route reads it (PRIVATE_DATA
 * `search-history`).
 *
 * Deletable, not append-only: the member deletes one term (every row of it) or all of them, so
 * buddha_app keeps SELECT, INSERT and DELETE. Not UPDATE (migration 0026): a recorded search is
 * never changed in place, which is what lets `market_search_terms` follow inserts and deletes
 * alone. No retention limit (the owner, #137 writes the notice). The account FK is CASCADE like
 * `market_watches` and `profiles`: the rows are the account's own, and only the term rows below
 * reference them.
 *
 * `id` is a uuid, not a bigserial: it is what the screen deletes by, and a sequence number would
 * tell every member how many searches everybody has made.
 */
export const marketSearches = pgTable(
  'market_searches',
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** As submitted, trimmed: the `GET /markets?q=` term (marketSearchTermSchema). */
    query: varchar({ length: MARKET_SEARCH_TERM_MAX }).notNull(),
    /** The database clock of the recording request. */
    searchedAt: timestampTz().defaultNow().notNull(),
  },
  (t) => [
    /**
     * Every write is one account's, and by term: deleting a term finds its rows by (account,
     * term), the delete trigger finds the newest row a term has left in this order (migration
     * 0026), and clearing finds the account's by the leading column.
     */
    index('market_searches_user_id_query_searched_at_id_idx').on(
      t.userId,
      t.query,
      desc(t.searchedAt),
      desc(t.id),
    ),
  ],
);

/**
 * The recent list's source: one row per (account, term) the account has searched, naming the
 * term's NEWEST search (`search_id`, its `searched_at`) — what `DISTINCT ON (query)` over
 * `market_searches` would pick, by (`searched_at`, `id`), kept as a row so the list is a bounded
 * read of the index below whatever the account's history holds (ADR-0066). No retention limit
 * comes with it: every search stays in `market_searches`; this is only the newest of each term.
 *
 * Kept by the database, not by the API (migration 0026), so every writer — the API, the test
 * factories, a script — leaves it exact: an AFTER INSERT trigger on `market_searches` upserts the
 * term (a newer search moves it, an older one does not), the `search_id` FK CASCADEs the row away
 * with its search, and an AFTER DELETE statement trigger points a term whose newest search went
 * at the newest one it has left. buddha_app keeps the default DML; the trigger writes as it.
 */
export const marketSearchTerms = pgTable(
  'market_search_terms',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    query: varchar({ length: MARKET_SEARCH_TERM_MAX }).notNull(),
    /** The term's newest search: the id the recent list answers and a delete names. */
    searchId: uuid()
      .notNull()
      .references(() => marketSearches.id, { onDelete: 'cascade' }),
    /** That search's `searched_at`, copied so the index below orders the list. */
    searchedAt: timestampTz().notNull(),
  },
  (t) => [
    /** One row per term of an account: what the insert trigger's upsert lands on. */
    primaryKey({ columns: [t.userId, t.query] }),
    /**
     * `GET /me/search-history`: one account's terms, newest search first, ties by the search's id
     * (`DISTINCT ON`'s own order) — read as the first RECENT_SEARCHES_LIMIT entries, no sort.
     */
    index('market_search_terms_user_id_searched_at_search_id_idx').on(
      t.userId,
      desc(t.searchedAt),
      desc(t.searchId),
    ),
  ],
);
