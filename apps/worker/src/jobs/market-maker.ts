import {
  lockMarket,
  MarketMakerCycleError,
  readMarketMakerRuntime,
  recordMarketMakerRun,
  requestMarketMakerRefresh,
  runMarketMakerCycle,
  schema,
  type Db,
  type MarketMakerCycleResult,
  type MarketMakerCycleContext,
  type PlaceOrderTouched,
} from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  marketBookEvent,
  marketChannel,
  marketTickEvent,
  marketTradeEvent,
  serializeCoinAmount,
  userChannel,
  type UserBalanceEvent,
  type UserPositionEvent,
} from '@buddha/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { EnqueueMarketMaker } from '../market-maker-jobs.js';
import type { Publish } from '../realtime.js';
import { messageOf, runScan } from './scan.js';

/** Queued generation is a hint. The DB re-reads current work and all gates under market lock. */
export async function refreshMarketMaker(
  db: Db,
  marketId: string,
  publish: Publish,
  enqueue: EnqueueMarketMaker,
  logger: Logger,
  retry: { attempt: number; maxAttempts: number } = { attempt: 1, maxAttempts: 3 },
): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(retry.attempt) ||
    !Number.isSafeInteger(retry.maxAttempts) ||
    retry.attempt < 1 ||
    retry.maxAttempts < 1
  )
    throw new RangeError('Invalid market maker retry context');
  let result: MarketMakerCycleResult;
  let commitContext: (MarketMakerCycleContext & { returnedRunId: string }) | undefined;
  try {
    result = await db.transaction(async (tx) => {
      const cycle = await runMarketMakerCycle(tx, { marketId });
      if (cycle.outcome !== 'skipped') {
        commitContext = {
          marketId: cycle.marketId,
          generation: cycle.generation,
          controlGeneration: cycle.controlGeneration,
          startedAt: cycle.startedAt,
          returnedRunId: cycle.runId,
        };
      }
      return cycle;
    });
  } catch (error) {
    // Economic work rolled back, or its COMMIT acknowledgement was lost. Preserve the transport
    // error independently and let BullMQ use its bounded attempts. Only an uncommitted final
    // failure disables this bot; a committed normal waiting result must keep its runtime state.
    // A deferred constraint can fail after the callback returned. Preserve that attempt too;
    // a lost COMMIT reply is distinguished by the exact permanent run UUID. Normal waiting
    // commits too, even though it intentionally leaves completedGeneration unchanged.
    const context = error instanceof MarketMakerCycleError ? error.context : commitContext;
    if (context) {
      try {
        const recorded = await db.transaction((tx) =>
          recordMarketMakerRun(tx, {
            ...context,
            outcome: 'error',
            reason: 'runtime_error',
            retryExhausted: retry.attempt >= retry.maxAttempts,
            error: messageOf(error instanceof MarketMakerCycleError ? error.cause : error).slice(
              0,
              2_000,
            ),
          }),
        );
        if (recorded && !recorded.stale && !recorded.runtime.desiredEnabled) {
          // Stop is durable even if this cleanup finds held/damaged assets. Intake omits this
          // bot immediately, while the scan retries only its unfinished cleanup work.
          try {
            const cleaned = await db.transaction((tx) => runMarketMakerCycle(tx, { marketId }));
            if (cleaned.outcome !== 'skipped') await publishCycle(cleaned, publish);
          } catch (cleanupError) {
            logger.error(
              { marketId, err: cleanupError },
              'stopped market maker cleanup is pending',
            );
          }
        }
      } catch (recordError) {
        logger.error(
          { marketId, err: recordError },
          'market maker failure record could not commit',
        );
      }
    }
    throw error;
  }
  if (result.outcome === 'skipped') return result;
  await publishCycle(result, publish);
  if (result.nextGeneration !== null) await enqueue(marketId, result.nextGeneration);
  return {
    outcome: result.outcome,
    marketId,
    generation: result.generation.toString(),
    reason: result.reason,
    startedAt: result.startedAt.toISOString(),
    finishedAt: result.finishedAt.toISOString(),
    placedOrders: result.orders.length,
    cancelledOrders: result.cancelledOrderIds.length,
    fills: result.orders.reduce((count, order) => count + order.fills.length, 0),
    burnedQty: result.burnedQty,
    nextGeneration: result.nextGeneration?.toString() ?? null,
  };
}

/** Periodic settings changes also need work even when the last inventory generation completed.
 * Dirty/blocked work retains its generation; a completed enabled market gets exactly one new
 * generation under its lock. Queue delivery is after each transaction, never while assets lock.
 */
export async function scanMarketMakers(db: Db, enqueue: EnqueueMarketMaker) {
  const { marketMakerRuntime: runtime, markets } = schema;
  const due = await db
    .select({ id: runtime.marketId })
    .from(runtime)
    .innerJoin(markets, eq(markets.id, runtime.marketId))
    .where(
      and(
        sql`(${runtime.desiredEnabled} OR ${runtime.generation} > ${runtime.completedGeneration})`,
        inArray(markets.status, ['open', 'paused']),
      ),
    )
    .orderBy(sql`${runtime.lastAttemptAt} ASC NULLS FIRST`, asc(runtime.marketId))
    .limit(MARKET_SCAN_BATCH_MAX);
  const scanned = await runScan(
    due.map((row) => row.id),
    async (marketId) => {
      const generation = await db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        const current = await readMarketMakerRuntime(tx, marketId);
        const [market] = await tx
          .select({ status: markets.status })
          .from(markets)
          .where(eq(markets.id, marketId));
        if (!current || !market || !['open', 'paused'].includes(market.status)) return null;
        if (!current.desiredEnabled)
          return current.generation > current.completedGeneration ? current.generation : null;
        return current.generation > current.completedGeneration
          ? current.generation
          : (await requestMarketMakerRefresh(tx, marketId))!.generation;
      });
      if (generation !== null) await enqueue(marketId, generation);
      return generation !== null;
    },
  );
  return {
    queued: scanned.results.filter(Boolean).length,
    skipped: scanned.results.filter((result) => !result).length,
    failed: scanned.failed,
    failures: scanned.failures,
  };
}

function balanceEvent({ balance, entry }: PlaceOrderTouched['balances'][number]): UserBalanceEvent {
  return {
    type: 'user:balance',
    availableCoin: serializeCoinAmount(balance.availableCoin),
    lockedCoin: serializeCoinAmount(balance.lockedCoin),
    ledgerEntryId: String(entry.id),
    ts: entry.createdAt.toISOString(),
  };
}

function positionEvent(row: PlaceOrderTouched['positions'][number]): UserPositionEvent {
  return {
    type: 'user:position',
    marketId: row.marketId,
    outcome: row.outcome,
    qty: row.qty,
    costBasisCoin: serializeCoinAmount(row.costBasisCoin),
    realizedPnlCoin: serializeCoinAmount(row.realizedPnlCoin),
    settled: row.settled,
    version: row.version,
    ts: row.updatedAt.toISOString(),
  };
}

/** One committed snapshot per human/position and one book signal per cycle; fills retain ids. */
async function publishCycle(
  result: Exclude<MarketMakerCycleResult, { outcome: 'skipped' }>,
  publish: Publish,
): Promise<void> {
  const balances = new Map<string, PlaceOrderTouched['balances'][number]>();
  const positions = new Map<string, PlaceOrderTouched['positions'][number]>();
  let stats = null as (typeof result.orders)[number]['stats'];
  const fills = result.orders.flatMap((order) => order.fills).sort((a, b) => a.id - b.id);
  for (const order of result.orders) {
    if (order.stats) stats = order.stats;
    for (const row of order.touched.balances) {
      if ((balances.get(row.userId)?.entry.id ?? -1) < row.entry.id) balances.set(row.userId, row);
    }
    for (const row of order.touched.positions) {
      const key = `${row.userId}:${row.outcome}`;
      if ((positions.get(key)?.version ?? -1) < row.version) positions.set(key, row);
    }
  }
  await Promise.all([
    stats && publish(marketChannel(result.marketId), marketTickEvent(result.marketId, stats)),
    ...[...balances.values()].map((row) => publish(userChannel(row.userId), balanceEvent(row))),
    ...[...positions.values()].map((row) => publish(userChannel(row.userId), positionEvent(row))),
    result.bookChanged &&
      publish(marketChannel(result.marketId), marketBookEvent(result.marketId, result.finishedAt)),
    ...fills.map((fill) =>
      publish(marketChannel(result.marketId), marketTradeEvent(result.marketId, fill)),
    ),
  ]);
}
