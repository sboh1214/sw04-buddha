import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  type MarketSummary,
  type WatchState,
  type WatchlistQuery,
} from '@buddha/shared';
import { and, desc, eq, ne } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { closedAccountRefusal } from '../common/errors/closed-account.js';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import {
  NO_ORDER_FIELDS,
  marketOrder,
  type MarketOrder,
  type MarketOrderRow,
} from '../markets/market-order.js';
import { inCategory, marketWithCategory, toMarketSummary } from '../markets/market.service.js';
import { type Page } from '../wallet/wallet.service.js';

/** A watchlist row: the market and its order fields, and when the caller watched it. */
type WatchRow = MarketOrderRow & { watchedAt: Date };

/**
 * 최근 관심 등록 순: `(watched_at DESC, market_id DESC)`, which only a watchlist has, in the shape
 * of the market orders so one query serves all four. Reads nothing beside the row.
 */
function watchedOrder(cursor: string | undefined): MarketOrder<WatchRow> {
  const { marketWatches } = schema;
  const keyset = decodeKeyset(cursor, 'uuid');
  return {
    lateral: undefined,
    fields: NO_ORDER_FIELDS,
    after: keyset
      ? keysetPredicate(marketWatches.watchedAt, marketWatches.marketId, keyset, 'uuid')
      : undefined,
    orderBy: [desc(marketWatches.watchedAt), desc(marketWatches.marketId)],
    cursorOf: (row) => encodeKeyset({ createdAt: row.watchedAt, id: row.market.id }),
  };
}

/**
 * 관심 시장 (#89, ADR-0064): the caller's watches. Every read and write is the session account's
 * own — no method takes another account, and nothing here counts a market's watchers (#37).
 *
 * The current state is `market_watches` and its history `market_watch_events` (#95). A watch or
 * an unwatch that changes the state writes exactly one event in the same transaction, at the same
 * `now()`; one that changes nothing (a repeated watch, an unwatch of nothing) writes none. Two
 * requests racing for one (account, market) are ordered by the primary key: the second insert
 * waits for the first and then conflicts, the second delete waits and then finds nothing, so the
 * history never records a change the state did not make.
 *
 * A market no public route serves — an unknown id or a draft — is NOT_FOUND on both routes that
 * name one market (the state read and the write), as on the public detail. A draft can never be watched and no market goes back to draft, so a
 * watched market is always public; the list says so again in its query.
 */
@Injectable()
export class WatchlistService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The caller's watched markets in the order asked for (ADR-0061 decision 3; ADR-0065):
   * `watched` (최근 관심 등록 순, the default — MY's order and the home view's first), keyset-
   * paginated over `(watched_at DESC, market_id DESC)` with the `<millis>_<uuid>` cursor every list
   * uses, or one of the public orders, from the same `marketOrder` as `GET /markets` so a watched
   * market sits where it sits on the home. Items are the `GET /markets` row, so the same card draws
   * them; an ended market stays with its status until the member unwatches it. The status filter
   * goes to `marketOrder` too: without `status=open` (MY lists every status) 마감 임박 puts the
   * 진행 중 markets first and the ended ones after them, most recently closed first, as the search
   * does (ADR-0066, owner decision 2026-10-16). A cursor that does not decode for the order serves
   * the first page.
   */
  async list(userId: string, query: WatchlistQuery): Promise<Page<MarketSummary>> {
    const { markets, categories, marketWatches } = schema;
    const order: MarketOrder<WatchRow> =
      query.sort === 'watched'
        ? watchedOrder(query.cursor)
        : marketOrder(this.db, query.sort, query.cursor, query.status);
    let select = this.db
      .select({ ...marketWithCategory, watchedAt: marketWatches.watchedAt, order: order.fields })
      .from(marketWatches)
      .innerJoin(markets, eq(markets.id, marketWatches.marketId))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .$dynamic();
    if (order.lateral) select = select.crossJoinLateral(order.lateral);
    const rows = await select
      .where(
        and(
          eq(marketWatches.userId, userId),
          ne(markets.status, 'draft'),
          query.status ? eq(markets.status, query.status) : undefined,
          query.category ? inCategory(this.db, query.category) : undefined,
          order.after,
        ),
      )
      .orderBy(...order.orderBy)
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toMarketSummary(row.market, row.category)),
      nextCursor: hasMore && last ? order.cursorOf(last) : null,
    };
  }

  /** Whether the caller watches one public market: one read, the market and the caller's row. */
  async state(userId: string, marketId: string): Promise<WatchState> {
    const { markets, marketWatches } = schema;
    const [row] = await this.db
      .select({ watcher: marketWatches.userId })
      .from(markets)
      .leftJoin(
        marketWatches,
        and(eq(marketWatches.marketId, markets.id), eq(marketWatches.userId, userId)),
      )
      .where(and(eq(markets.id, marketId), ne(markets.status, 'draft')))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
    return { watched: row.watcher !== null };
  }

  /**
   * Sets the caller's watch of one public market and answers the state it is in now. Idempotent
   * both ways; only a change writes its event (`watch` or `unwatch`). Nothing else is touched:
   * no order, position, balance or market statistic (#89 AC). A watch of an account closed since
   * the request passed SessionGuard is refused by the database (migration 0043, #140) and answered
   * as the session that ended (`closedAccountRefusal`).
   */
  async set(userId: string, marketId: string, watched: boolean): Promise<WatchState> {
    const { markets, marketWatches, marketWatchEvents } = schema;
    const write = this.db.transaction(async (tx) => {
      const [market] = await tx
        .select({ id: markets.id })
        .from(markets)
        .where(and(eq(markets.id, marketId), ne(markets.status, 'draft')))
        .limit(1);
      if (!market) throw new AppError('NOT_FOUND', { message: 'Market not found' });

      const changed = watched
        ? await tx
            .insert(marketWatches)
            .values({ userId, marketId })
            .onConflictDoNothing()
            .returning({ marketId: marketWatches.marketId })
        : await tx
            .delete(marketWatches)
            .where(and(eq(marketWatches.userId, userId), eq(marketWatches.marketId, marketId)))
            .returning({ marketId: marketWatches.marketId });
      if (changed.length > 0) {
        await tx
          .insert(marketWatchEvents)
          .values({ userId, marketId, action: watched ? 'watch' : 'unwatch' });
      }
      return { watched };
    });
    return write.catch((error: unknown) => {
      throw closedAccountRefusal(error) ?? error;
    });
  }
}
