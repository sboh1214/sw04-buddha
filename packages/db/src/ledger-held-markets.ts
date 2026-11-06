import { and, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';
import { marketPauses, markets } from './schema/index.js';

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 원장 장애로 묶인 시장 (#178, ADR-0113; ADR-0107 결정 4 #178 rows, 결정 6 owner answer 2026-11-06):
 * a market whose order locks and ledger writes wait for a recovery approval. Its live orders keep
 * their locks — a member's cancel is refused 일시 중단, an account's batch cancel skips them, a
 * closure is refused while one is there — until the transaction that ends the hold ends them:
 * the pause end's approval (재개 or 조기 마감, `endMarketPause`), or #93's recovery of a closed
 * market (#73 10항). A leaf of this package (schema only), so contracts.ts and order-cancel.ts
 * both ask it without an import cycle. Read it under the market's `lockMarket` to act on it:
 * `market_pauses` is written only under that lock.
 *
 * Held: the market's lasting pause is for `ledger_failure`, or a `ledger_failure` pause ended
 * `closed_at_close` — the close came on schedule before the recovery (결정 4 '복구 전에 마감이
 * 오면'). A closed market never pauses again, so such a row stays held until #93's recovery
 * expires its orders, and after that no live order is left to ask. A `ledger_failure` pause that
 * ended `resumed` or `early_closed` was recovered (its approval ended the orders). #93 extends the
 * rule for a failure it records on a market paused for another reason, and for its recovery
 * record of a closed market.
 */

/**
 * SQL: market `marketId` holds its order locks and ledger writes until a recovery approval — a
 * `ledger_failure` pause lasting, or one ended `closed_at_close`. A per-row filter too
 * (`orders.market_id`).
 */
export function ledgerHeldMarketSql(marketId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${marketPauses} AS held_pause
    WHERE held_pause.market_id = ${marketId} AND held_pause.reason = 'ledger_failure'
      AND (held_pause.ended_at IS NULL OR held_pause.end_kind = 'closed_at_close'))`;
}

/** The markets of `marketIds` that are held (`ledgerHeldMarketSql`), in one read. */
export async function ledgerHeldMarketIds(
  reader: Reader,
  marketIds: readonly string[],
): Promise<Set<string>> {
  if (marketIds.length === 0) return new Set();
  const rows = await reader
    .select({ id: markets.id })
    .from(markets)
    .where(and(inArray(markets.id, [...new Set(marketIds)]), ledgerHeldMarketSql(markets.id)));
  return new Set(rows.map((row) => row.id));
}
