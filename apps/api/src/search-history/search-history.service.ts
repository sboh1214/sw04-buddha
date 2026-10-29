import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { RECENT_SEARCHES_LIMIT, type RecentSearch } from '@buddha/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { closedAccountRefusal } from '../common/errors/closed-account.js';
import { DB } from '../infra/db/db.provider.js';

/** What builds the list query: the pool or a transaction (a test EXPLAINs it in one). */
type SelectSource = Pick<Db, 'select'>;

/**
 * The recent list as a query: the account's terms at their newest search, newest first, ties in
 * one millisecond by the search's id, so the order is total — the order `DISTINCT ON (query) ...
 * ORDER BY searched_at DESC, id DESC` gives over `market_searches`. It reads the first entries of
 * the account's index on `market_search_terms` (no sort), so it costs the same for ten searches
 * or a million: there is no retention limit, and a scripted client records as many as the rate
 * limit lets it.
 */
export function recentSearchesQuery(db: SelectSource, userId: string) {
  const { marketSearchTerms } = schema;
  return db
    .select({
      id: marketSearchTerms.searchId,
      query: marketSearchTerms.query,
      searchedAt: marketSearchTerms.searchedAt,
    })
    .from(marketSearchTerms)
    .where(eq(marketSearchTerms.userId, userId))
    .orderBy(desc(marketSearchTerms.searchedAt), desc(marketSearchTerms.searchId))
    .limit(RECENT_SEARCHES_LIMIT);
}

/**
 * 최근 검색 (#15, ADR-0066): the caller's recorded searches. Every read and write is the session
 * account's own — no method takes another account, and nothing here is read by a public route.
 *
 * One `market_searches` row per submitted search (the term and the database clock); the recent
 * list is the newest row of each distinct term, the newest RECENT_SEARCHES_LIMIT terms first
 * (ADR-0061 decision 3, the #15 rows), read from `market_search_terms`, which the database keeps
 * at each term's newest search (migration 0026). Deleting an entry deletes every row of its term,
 * so the term leaves the list and no older search of it surfaces in its place; clearing deletes
 * them all. The writes answer the list as it is afterwards, the way the watch answers its state.
 */
@Injectable()
export class SearchHistoryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The recent list (`recentSearchesQuery`). */
  async list(userId: string): Promise<RecentSearch[]> {
    const rows = await recentSearchesQuery(this.db, userId);
    return rows.map((row) => ({
      id: row.id,
      query: row.query,
      searchedAt: row.searchedAt.toISOString(),
    }));
  }

  /**
   * Records one search of the caller's, at the database clock, and answers the list after it. The
   * term row follows by the insert trigger (migration 0026). A search of an account closed since
   * the request passed SessionGuard is refused by the database (migration 0043, #140) and answered
   * as the session that ended (`closedAccountRefusal`).
   */
  async record(userId: string, query: string): Promise<RecentSearch[]> {
    try {
      await this.db.insert(schema.marketSearches).values({ userId, query });
    } catch (error) {
      throw closedAccountRefusal(error) ?? error;
    }
    return this.list(userId);
  }

  /**
   * Deletes every search of the term the caller's entry `id` names, and answers the list after
   * it. An id the caller has no row for — deleted already, or somebody else's — deletes nothing:
   * the term lookup is the caller's own rows only, so another account's history is never reached;
   * and the delete itself is the caller's rows only, so another account's searches of the same term
   * stay. The term row goes with its newest search (the `search_id` FK and the delete trigger).
   */
  async delete(userId: string, id: string): Promise<RecentSearch[]> {
    const { marketSearches } = schema;
    const term = this.db
      .select({ query: marketSearches.query })
      .from(marketSearches)
      .where(and(eq(marketSearches.id, id), eq(marketSearches.userId, userId)));
    await this.db
      .delete(marketSearches)
      .where(and(eq(marketSearches.userId, userId), inArray(marketSearches.query, term)));
    return this.list(userId);
  }

  /** Deletes the caller's whole history; the list after it is empty. */
  async clear(userId: string): Promise<RecentSearch[]> {
    await this.db.delete(schema.marketSearches).where(eq(schema.marketSearches.userId, userId));
    return [];
  }
}
