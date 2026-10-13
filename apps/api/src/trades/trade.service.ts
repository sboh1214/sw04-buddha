import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  serializeCoinAmount,
  type Order,
  type Position,
  type PositionStatus,
} from '@buddha/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

type MarketRow = typeof schema.markets.$inferSelect;
type OrderRow = typeof schema.orders.$inferSelect;
type FillRow = typeof schema.fills.$inferSelect;
type PositionRow = typeof schema.positions.$inferSelect;

/** What the market row carries for the order and position DTOs. */
type MarketRef = Pick<
  MarketRow,
  'id' | 'slug' | 'title' | 'status' | 'lastPrice' | 'resolvedResult'
>;

export function toOrder(
  row: OrderRow,
  fill: Pick<FillRow, 'amountCoin' | 'priceAvgBp'> | null,
  market: Pick<MarketRow, 'slug' | 'title'>,
): Order {
  return {
    id: row.id,
    marketId: row.marketId,
    marketSlug: market.slug,
    marketTitle: market.title,
    outcome: row.outcome,
    side: row.side,
    type: row.type,
    qty: row.qty,
    filledQty: row.filledQty,
    status: row.status,
    amountCoin: fill ? serializeCoinAmount(fill.amountCoin) : null,
    priceAvgBp: fill ? fill.priceAvgBp : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPosition(row: PositionRow, market: MarketRef): Position {
  return {
    marketId: row.marketId,
    marketSlug: market.slug,
    marketTitle: market.title,
    marketStatus: market.status,
    marketLastPrice: market.lastPrice,
    resolvedResult: market.resolvedResult,
    outcome: row.outcome,
    qty: row.qty,
    costBasisCoin: serializeCoinAmount(row.costBasisCoin),
    realizedPnlCoin: serializeCoinAmount(row.realizedPnlCoin),
    settled: row.settled,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The caller's own positions and orders (M3 design 3.5), which the portfolio reads. Nothing
 * places an order here: the direct AMM trade is gone (#125) and the CLOB brings order entry
 * (#119).
 */
@Injectable()
export class TradeService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Every position row of the account (design 3.5): `open` = not yet settled (qty may be 0,
   * the row still carries realised PnL), `settled` = settled, omitted = all. No cursor: the
   * set is bounded by the markets one account has touched (MVP).
   */
  async listPositions(userId: string, status: PositionStatus | undefined): Promise<Position[]> {
    const rows = await this.db
      .select({
        position: schema.positions,
        market: {
          id: schema.markets.id,
          slug: schema.markets.slug,
          title: schema.markets.title,
          status: schema.markets.status,
          lastPrice: schema.markets.lastPrice,
          resolvedResult: schema.markets.resolvedResult,
        },
      })
      .from(schema.positions)
      .innerJoin(schema.markets, eq(schema.markets.id, schema.positions.marketId))
      .where(
        and(
          eq(schema.positions.userId, userId),
          status === undefined ? undefined : eq(schema.positions.settled, status === 'settled'),
        ),
      )
      .orderBy(
        desc(schema.positions.updatedAt),
        asc(schema.positions.marketId),
        asc(schema.positions.outcome),
      );
    return rows.map((row) => toPosition(row.position, row.market));
  }

  /** Newest first, keyset-paginated over (created_at, id) like the wallet lists. */
  async listOrders(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<Order>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select({
        order: schema.orders,
        // Read as one fill per order, the shape the direct AMM wrote; the CLOB, whose orders
        // fill in parts, reshapes this read (#119). Null while nothing filled.
        fill: { amountCoin: schema.fills.amountCoin, priceAvgBp: schema.fills.priceAvgBp },
        market: { slug: schema.markets.slug, title: schema.markets.title },
      })
      .from(schema.orders)
      .leftJoin(schema.fills, eq(schema.fills.orderId, schema.orders.id))
      .innerJoin(schema.markets, eq(schema.markets.id, schema.orders.marketId))
      .where(
        and(
          eq(schema.orders.userId, userId),
          keyset
            ? keysetPredicate(schema.orders.createdAt, schema.orders.id, keyset, 'uuid')
            : undefined,
        ),
      )
      .orderBy(desc(schema.orders.createdAt), desc(schema.orders.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toOrder(row.order, row.fill, row.market)),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: last.order.createdAt, id: last.order.id })
          : null,
    };
  }
}
