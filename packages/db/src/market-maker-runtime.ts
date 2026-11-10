import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { marketMakerRuntime, marketMakerRuns, marketMakerOpenAttempts } from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'>;
export type MarketMakerRuntimeRow = typeof marketMakerRuntime.$inferSelect;
export type MarketMakerRunRow = typeof marketMakerRuns.$inferSelect;
export type MarketMakerOpenAttemptRow = typeof marketMakerOpenAttempts.$inferSelect;

export async function readMarketMakerOpenAttempt(
  reader: Reader,
  marketId: string,
): Promise<MarketMakerOpenAttemptRow | null> {
  const [row] = await reader
    .select()
    .from(marketMakerOpenAttempts)
    .where(eq(marketMakerOpenAttempts.marketId, marketId));
  return row ?? null;
}

export async function recordMarketMakerOpenAttempt(
  tx: Tx,
  input: {
    marketId: string;
    reason: string | null;
    requiredCoin: bigint | null;
    availableCoin: bigint | null;
    liquidityVersion: number | null;
    at?: Date;
  },
): Promise<MarketMakerOpenAttemptRow> {
  await lockMarket(tx, input.marketId);
  const at = input.at ?? (await clockTimestamp(tx));
  const values = {
    marketId: input.marketId,
    reason: input.reason,
    requiredCoin: input.requiredCoin,
    availableCoin: input.availableCoin,
    liquidityVersion: input.liquidityVersion,
    lastAttemptAt: at,
    ...(input.reason === null ? { succeededAt: at } : {}),
  };
  const [row] = await tx
    .insert(marketMakerOpenAttempts)
    .values(values)
    .onConflictDoUpdate({ target: marketMakerOpenAttempts.marketId, set: values })
    .returning();
  return row!;
}

export async function readMarketMakerRuntime(
  reader: Reader,
  marketId: string,
): Promise<MarketMakerRuntimeRow | null> {
  const [row] = await reader
    .select()
    .from(marketMakerRuntime)
    .where(eq(marketMakerRuntime.marketId, marketId));
  return row ?? null;
}

/** Dirty work is durable before the producer enqueues after COMMIT. No runtime backfill. */
export async function requestMarketMakerRefresh(
  tx: Tx,
  marketId: string,
): Promise<MarketMakerRuntimeRow | null> {
  await lockMarket(tx, marketId);
  const now = await clockTimestamp(tx);
  const [row] = await tx
    .update(marketMakerRuntime)
    .set({ generation: sql`${marketMakerRuntime.generation}+1`, updatedAt: now })
    .where(eq(marketMakerRuntime.marketId, marketId))
    .returning();
  return row ?? null;
}

export interface RecordMarketMakerRunInput {
  marketId: string;
  /** Captured under the market lock before this run; never complete a later dirty generation. */
  generation: bigint;
  outcome: 'ready' | 'waiting' | 'error';
  reason?: string | null;
  error?: string | null;
  configVersion?: number;
  startedAt: Date;
  detail?: Record<string, unknown>;
}

/** Append the completed attempt and update observation in one transaction. A failed execution
 * calls this from a NEW transaction after its economic writes rolled back. Failure-stop policy
 * is pending: recording an error never flips desiredEnabled or presumes an automatic restart.
 */
export async function recordMarketMakerRun(tx: Tx, input: RecordMarketMakerRunInput) {
  await lockMarket(tx, input.marketId);
  const current = await readMarketMakerRuntime(tx, input.marketId);
  if (!current) return null;
  if (input.generation < 1n || input.generation > current.generation)
    throw new RangeError('Invalid runtime generation');
  if (!Number.isFinite(input.startedAt.getTime())) throw new RangeError('Invalid run start');
  if ((input.outcome === 'error') !== (typeof input.error === 'string' && input.error.length > 0))
    throw new RangeError('Only an error observation carries an error');
  const now = await clockTimestamp(tx);
  const finishedAt = new Date(Math.max(now.getTime(), input.startedAt.getTime()));
  const [run] = await tx
    .insert(marketMakerRuns)
    .values({
      marketId: input.marketId,
      generation: input.generation,
      outcome: input.outcome,
      reason: input.reason ?? null,
      error: input.error ?? null,
      detail: input.detail ?? {},
      startedAt: input.startedAt,
      finishedAt,
    })
    .returning();
  // A failed attempt may report after a newer worker already committed success. Retain the
  // attempt as evidence, but never overwrite the newer successful observation with that error.
  if (input.generation <= current.completedGeneration)
    return { runtime: current, run: run!, stale: true };
  const [runtime] = await tx
    .update(marketMakerRuntime)
    .set({
      state: input.outcome,
      reason: input.reason ?? null,
      lastAttemptAt: finishedAt,
      updatedAt: finishedAt,
      lastConfigVersion: input.configVersion ?? current.lastConfigVersion,
      ...(input.outcome === 'ready'
        ? {
            completedGeneration:
              input.generation > current.completedGeneration
                ? input.generation
                : current.completedGeneration,
            lastSuccessAt: finishedAt,
            lastError: null,
            consecutiveFailures: 0,
          }
        : input.outcome === 'error'
          ? {
              lastFailureAt: finishedAt,
              lastError: input.error!,
              consecutiveFailures: current.consecutiveFailures + 1,
            }
          : {}),
    })
    .where(eq(marketMakerRuntime.marketId, input.marketId))
    .returning();
  return { runtime: runtime!, run: run!, stale: false };
}
