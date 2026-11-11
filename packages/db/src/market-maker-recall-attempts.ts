import { asc, eq, sql } from 'drizzle-orm';
import { MARKET_SCAN_BATCH_MAX } from '@buddha/shared';
import type { Db } from './client.js';
import { marketMakerRecallAttempts, marketMakerRecalls, markets } from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Attempt = typeof marketMakerRecallAttempts.$inferInsert;

/** Missing jobs and old terminal markets are both recoverable. Rotate past held/failed markets. */
export async function selectPendingMarketMakerRecallIds(
  db: Db,
  limit = MARKET_SCAN_BATCH_MAX,
): Promise<string[]> {
  const rows = await db
    .select({ id: markets.id })
    .from(markets)
    .leftJoin(marketMakerRecalls, eq(marketMakerRecalls.marketId, markets.id))
    .leftJoin(marketMakerRecallAttempts, eq(marketMakerRecallAttempts.marketId, markets.id))
    .where(
      sql`${markets.status} IN ('settled','cancelled') AND ${marketMakerRecalls.marketId} IS NULL`,
    )
    .orderBy(sql`${marketMakerRecallAttempts.lastAttemptAt} ASC NULLS FIRST`, asc(markets.id))
    .limit(limit);
  return rows.map(({ id }) => id);
}

/** Re-lock on failure after rollback. A delayed failure cannot replace a newer attempt or completion. */
export async function recordMarketMakerRecallAttempt(
  tx: Tx,
  input: Pick<Attempt, 'marketId' | 'state' | 'reason' | 'lastAttemptAt'>,
): Promise<void> {
  await lockMarket(tx, input.marketId);
  const [market] = await tx
    .select({ status: markets.status })
    .from(markets)
    .where(eq(markets.id, input.marketId));
  if (!market || !['settled', 'cancelled'].includes(market.status)) return;
  const [done] = await tx
    .select({ id: marketMakerRecalls.marketId })
    .from(marketMakerRecalls)
    .where(eq(marketMakerRecalls.marketId, input.marketId));
  if ((input.state === 'completed') !== Boolean(done)) return;
  const [prior] = await tx
    .select()
    .from(marketMakerRecallAttempts)
    .where(eq(marketMakerRecallAttempts.marketId, input.marketId));
  if (prior && (prior.lastAttemptAt >= input.lastAttemptAt || prior.state === 'completed')) return;
  await tx
    .insert(marketMakerRecallAttempts)
    .values({
      ...input,
      attempts: 1,
      lastFailureAt: input.state === 'failed' ? input.lastAttemptAt : null,
      lastFailureReason: input.state === 'failed' ? input.reason : null,
    })
    .onConflictDoUpdate({
      target: marketMakerRecallAttempts.marketId,
      set: {
        ...input,
        attempts: sql`${marketMakerRecallAttempts.attempts}+1`,
        lastFailureAt:
          input.state === 'failed' ? input.lastAttemptAt : marketMakerRecallAttempts.lastFailureAt,
        lastFailureReason:
          input.state === 'failed' ? input.reason : marketMakerRecallAttempts.lastFailureReason,
      },
    });
}

/** Millisecond columns need a strictly increasing attempt token under the market lock. */
export async function beginMarketMakerRecallAttempt(tx: Tx, marketId: string): Promise<Date> {
  await lockMarket(tx, marketId);
  const now = await clockTimestamp(tx);
  const [prior] = await tx
    .select({ at: marketMakerRecallAttempts.lastAttemptAt })
    .from(marketMakerRecallAttempts)
    .where(eq(marketMakerRecallAttempts.marketId, marketId));
  return new Date(Math.max(now.getTime(), (prior?.at.getTime() ?? 0) + 1));
}
