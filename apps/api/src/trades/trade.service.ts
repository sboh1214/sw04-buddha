import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { serializeCoinAmount, type Position, type PositionStatus } from '@buddha/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DB } from '../infra/db/db.provider.js';

type MarketRow = typeof schema.markets.$inferSelect;
type PositionRow = typeof schema.positions.$inferSelect;

/** What the market row carries for the position DTO. */
type MarketRef = Pick<
  MarketRow,
  'id' | 'slug' | 'title' | 'status' | 'lastPrice' | 'resolvedResult'
>;

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
 * The caller's own positions (M3 design 3.5), which the portfolio reads. The orders and fills
 * are OrderService's (#119): the direct AMM trade and its one-fill order read are gone (#125).
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
}
