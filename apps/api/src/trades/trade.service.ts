import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  decodeTupleCursor,
  encodeTupleCursor,
  serializeCoinAmount,
  type MySettlement,
  type MySettlementsQuery,
  type Position,
  type PositionStatus,
} from '@buddha/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { tupleKeysetPredicate } from '../common/keyset.js';
import { recentPeriodPredicate } from '../common/period.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

type MarketRow = typeof schema.markets.$inferSelect;
type PositionRow = typeof schema.positions.$inferSelect;

/** What the market row carries for the position DTO. */
type MarketRef = Pick<
  MarketRow,
  | 'id'
  | 'slug'
  | 'title'
  | 'status'
  | 'lastPrice'
  | 'lastFillAt'
  | 'tradeCount'
  | 'statusEventId'
  | 'resolvedResult'
>;

export function toPosition(row: PositionRow, market: MarketRef): Position {
  return {
    marketId: row.marketId,
    marketSlug: market.slug,
    marketTitle: market.title,
    marketStatus: market.status,
    marketLastPrice: market.lastPrice,
    // Public market values beside the price (#67, ADR-0142): its time and the two ordering keys.
    marketLastFillAt: market.lastFillAt === null ? null : market.lastFillAt.toISOString(),
    marketTradeCount: market.tradeCount,
    marketStatusEventId: market.statusEventId === null ? null : String(market.statusEventId),
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
 * The caller's own positions (M3 design 3.5), which the portfolio reads, and its settlement
 * records (#124). The orders and fills are OrderService's (#119): the direct AMM trade and its
 * one-fill order read are gone (#125).
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
          lastFillAt: schema.markets.lastFillAt,
          tradeCount: schema.markets.tradeCount,
          statusEventId: schema.markets.statusEventId,
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

  /**
   * `GET /me/settlements` (#124, ADR-0143): the account's permanent settlement records
   * (`position_settlements`, #126), the most recently paid first — a losing contract's zero
   * payout among them, and none for a holding sold out before settlement (no record is written
   * for it). Every figure is the record's column: the result, the quantity, the remaining cost,
   * the payout per contract, the payout and the settlement P&L are never worked out again nor
   * read from the market row, so a line stays what it was whatever happens to the market
   * afterwards. The market gives its slug and title — a settled market is public and stays so —
   * and `resolved_at`, the one value from outside the record. Neither the ledger nor any
   * notification setting is read: a start grant or a regrant is in no figure (N04 §3), and the
   * list is there whatever the account chose to be told (N05 §4).
   *
   * Order `settled_at DESC, market_id DESC`, then YES before NO (the index
   * `position_settlements_user_id_settled_at_idx`): a market's two records share one
   * `settled_at`, and two markets may. The cursor is `<settledMs>_<0|1>_<marketId>` — the id
   * last, as every tuple cursor is written — but the predicate compares in the ORDER of the sort
   * `(settled_at, market_id, contract key)`: in the cursor's order, two markets settled at one
   * instant would lose or repeat a line. `settled_at` is `timestamp(3)`, so the millisecond
   * cursor is exact. `period` filters by `settled_at`, a predicate beside the cursor.
   */
  async listMySettlements(userId: string, query: MySettlementsQuery): Promise<Page<MySettlement>> {
    const records = schema.positionSettlements;
    const cursor = decodeTupleCursor(query.cursor, ['millis', 'group'], 'uuid');
    /** 1 for YES, 0 for NO: YES first under DESC, and the cursor's `group` value. */
    const contractKey = sql<number>`CASE WHEN ${records.outcome} = 'YES' THEN 1 ELSE 0 END`;
    const rows = await this.db
      .select({
        marketId: records.marketId,
        marketSlug: schema.markets.slug,
        marketTitle: schema.markets.title,
        outcome: records.outcome,
        result: records.result,
        qty: records.qty,
        costBasisCoin: records.costBasisCoin,
        payoutPerContractCoin: records.payoutPerContractCoin,
        payoutCoin: records.payoutCoin,
        settlementPnlCoin: records.settlementPnlCoin,
        resolvedAt: schema.markets.resolvedAt,
        settledAt: records.settledAt,
      })
      .from(records)
      .innerJoin(schema.markets, eq(schema.markets.id, records.marketId))
      .where(
        and(
          eq(records.userId, userId),
          query.marketId === undefined ? undefined : eq(records.marketId, query.marketId),
          recentPeriodPredicate(records.settledAt, query.period),
          cursor === undefined
            ? undefined
            : tupleKeysetPredicate([
                {
                  key: records.settledAt,
                  value: new Date(Number(cursor.values[0])).toISOString(),
                  cast: 'timestamptz',
                },
                { key: records.marketId, value: cursor.id, cast: 'uuid' },
                { key: contractKey, value: cursor.values[1]!, cast: 'bigint' },
              ]),
        ),
      )
      .orderBy(desc(records.settledAt), desc(records.marketId), desc(contractKey))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => ({
        marketId: row.marketId,
        marketSlug: row.marketSlug,
        marketTitle: row.marketTitle,
        outcome: row.outcome,
        result: row.result,
        qty: row.qty,
        costBasisCoin: serializeCoinAmount(row.costBasisCoin),
        payoutPerContractCoin: row.payoutPerContractCoin,
        payoutCoin: serializeCoinAmount(row.payoutCoin),
        settlementPnlCoin: serializeCoinAmount(row.settlementPnlCoin),
        resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
        settledAt: row.settledAt.toISOString(),
      })),
      nextCursor:
        hasMore && last
          ? encodeTupleCursor(
              [String(last.settledAt.getTime()), last.outcome === 'YES' ? '1' : '0'],
              last.marketId,
            )
          : null,
    };
  }
}
