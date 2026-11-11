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
  /** Captured independently of inventory refreshes; a late failure cannot undo a restart. */
  controlGeneration?: bigint;
  /** Only the worker's final bounded attempt can request a system stop. */
  retryExhausted?: boolean;
  outcome: 'ready' | 'waiting' | 'error';
  reason?: string | null;
  error?: string | null;
  configVersion?: number;
  startedAt: Date;
  detail?: Record<string, unknown>;
}

/** Append the attempt and observation together. Failed economic work has already rolled back.
 * Final retry exhaustion disables only this bot; cancellation is a separate safe cleanup, so
 * a damaged balance or active hold cannot roll back the stop. Restart belongs to #130 approval.
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
  if (input.retryExhausted && (input.outcome !== 'error' || input.controlGeneration === undefined))
    throw new RangeError('Retry exhaustion requires an error and its captured control generation');
  const controlGeneration = input.controlGeneration ?? current.controlGeneration;
  const reason = input.retryExhausted ? 'retry_exhausted' : (input.reason ?? null);
  const now = await clockTimestamp(tx);
  const finishedAt = new Date(Math.max(now.getTime(), input.startedAt.getTime()));
  const [run] = await tx
    .insert(marketMakerRuns)
    .values({
      marketId: input.marketId,
      generation: input.generation,
      controlGeneration,
      outcome: input.outcome,
      reason,
      error: input.error ?? null,
      detail: input.detail ?? {},
      startedAt: input.startedAt,
      finishedAt,
    })
    .returning();
  // A failed attempt may report after a newer worker already committed success. Retain the
  // attempt as evidence, but never overwrite the newer successful observation with that error.
  if (
    input.generation <= current.completedGeneration ||
    controlGeneration !== current.controlGeneration
  )
    return { runtime: current, run: run!, stale: true };
  const stopping = input.retryExhausted === true && current.desiredEnabled;
  const cleanedStop =
    !current.desiredEnabled && input.outcome === 'waiting' && input.reason === 'stopped';
  const [runtime] = await tx
    .update(marketMakerRuntime)
    .set({
      state: stopping || !current.desiredEnabled ? 'stopped' : input.outcome,
      reason: !current.desiredEnabled ? current.reason : reason,
      lastAttemptAt: finishedAt,
      updatedAt: finishedAt,
      lastConfigVersion: input.configVersion ?? current.lastConfigVersion,
      ...(stopping
        ? {
            desiredEnabled: false,
            generation: current.generation + 1n,
            controlGeneration: current.controlGeneration + 1n,
          }
        : {}),
      ...(cleanedStop ? { completedGeneration: input.generation } : {}),
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
