import {
  clockTimestamp,
  beginMarketMakerOpenAttempt,
  recordMarketMakerOpenFailure,
  lockMarket,
  openScheduledMarket,
  schema,
  type Db,
  type OpenSkipReason,
  type MarketMakerOpenAttemptContext,
} from '@buddha/db';
import { MARKET_SCAN_BATCH_MAX, marketChannel, type MarketStatusEvent } from '@buddha/shared';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { type Publish } from '../realtime.js';
import { type EnqueueMarketMaker } from '../market-maker-jobs.js';
import { runScan, type ScanFailure } from './scan.js';

export type OpenResult =
  | { outcome: 'opened'; marketId: string; statusEventId: number; openedAt: Date }
  | { outcome: 'skipped'; marketId: string; reason: OpenSkipReason };

export interface OpenScanResult {
  /** Markets the scan found due; `opened + skipped + failed` is the number examined. */
  opened: number;
  skipped: number;
  /** Markets whose open rejected; the scan went on to the next one (scan.ts). */
  failed: number;
  failures: ScanFailure[];
}

/**
 * SCHEDULED → OPEN for one market at its `scheduled_open_at` (#21, ADR-0100; ADR-0093 decision 1
 * #173 item 1, an automatic edge): the worker's caller of `openScheduledMarket` (@buddha/db), the
 * one open the approval and the reschedule that find the scheduled open already come call too.
 * Status, time, hold and funding/configuration readiness are judged in that common helper.
 * Here: the same lock and DB clock read after it as `closeMarket`, the
 * worker as the actor (`actorId` null, payload `source: 'job'`) and no admin action (no admin
 * acted).
 *
 * Every caller reaches this through the same transaction — the delayed job the API registered when
 * an approval or a reschedule left the market SCHEDULED, the per-minute scan, a manual script —
 * and it re-verifies the status and both instants under the market lock. That is what makes a
 * stale job harmless: a scheduled open moved later leaves the old delayed job in the queue
 * (jobs.ts), and here it finds `not_due`; one that fires after the approval, a reschedule or the
 * scan opened the market, or after an admin sent it back to a draft, finds `not_scheduled`; two
 * workers racing on one market serialise on `lockMarket` and the second sees the first's status.
 * A market whose close came before it opened is `close_passed`: it stays SCHEDULED, public as
 * 개장 예정, until an admin sends it back to a draft to fix its times (ADR-0093 decision 2 #172
 * item 6) — a skip, not a failure, since no retry would change it. An unknown id throws, as it
 * does for the close (market-close.ts): a job left over from a whole-database wipe or a broken
 * producer fails loudly rather than being retried into silence.
 *
 * The open enqueues its allocated maker after commit. The API registered `market.close` at the approval (the
 * close is locked while SCHEDULED, and the close job acts on `open` only, so a job registered
 * before the open is harmless). Published after COMMIT, as the close is: the lock is released at
 * COMMIT, so an event published from inside the transaction could reach a client before the row
 * it describes is visible. `statusEventId` is the `opened` event's, the ordering key of
 * `market:status` (A-M3-19).
 */
export async function openMarket(
  db: Db,
  marketId: string,
  publish: Publish,
  enqueueMarketMaker?: EnqueueMarketMaker,
): Promise<OpenResult> {
  let attempt: MarketMakerOpenAttemptContext | null = null;
  let result: OpenResult;
  try {
    result = await db.transaction(async (tx): Promise<OpenResult> => {
      await lockMarket(tx, marketId);
      const [current] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId))
        .limit(1)
        .for('update');
      if (!current) throw new Error(`Market ${marketId} not found`);
      // The database clock after the lock (tx-helpers.ts): an approval, a reschedule or a revert may
      // have committed while this transaction queued, and the open must be judged and stamped after
      // it.
      const now = await clockTimestamp(tx);
      attempt = await beginMarketMakerOpenAttempt(tx, current, now);
      const opened = await openScheduledMarket(tx, {
        market: current,
        now,
        actorId: null,
        source: 'job',
      });
      if (!opened.opened) return { outcome: 'skipped', marketId, reason: opened.reason };
      return {
        outcome: 'opened',
        marketId,
        statusEventId: opened.statusEventId,
        openedAt: opened.row.openAt!,
      };
    });
  } catch (error) {
    if (attempt) {
      const observationFailures: unknown[] = [];
      try {
        await db.transaction((tx) => recordMarketMakerOpenFailure(tx, attempt!));
      } catch (observationError) {
        observationFailures.push(observationError);
      }
      if (observationFailures.length > 0) {
        throw new AggregateError(
          [error, ...observationFailures],
          'Opening and its failure observation failed',
          { cause: error },
        );
      }
    }
    throw error;
  }

  if (result.outcome === 'opened') {
    const event: MarketStatusEvent = {
      type: 'market:status',
      marketId,
      status: 'open',
      resolvedResult: null,
      statusEventId: String(result.statusEventId),
      ts: result.openedAt.toISOString(),
    };
    await publish(marketChannel(marketId), event);
    // Allocation creates generation 1 atomically with OPEN. A later fill may already advance it;
    // the consumer always reads the current generation under its market lock.
    await enqueueMarketMaker?.(marketId, 1n);
  }
  return result;
}

/**
 * The per-minute safety net (#21, ADR-0100), the close scan's pattern (market-close.ts): opens
 * every SCHEDULED market with a current liquidity version whose scheduled open has come and whose
 * close is still ahead, each in its own transaction and each failure caught (`runScan`), so one
 * market's rejection rolls back that market alone and the rest of the batch still runs. It opens
 * a market whose delayed job was lost —
 * Redis restarted, the API's best-effort add failed after COMMIT, or a job that reached a worker
 * without this handler and failed — on a subsequent bounded scan.
 *
 * Unattempted markets first, then the oldest observed attempt, with scheduled open/id as ties:
 * at most MARKET_SCAN_BATCH_MAX per run. Funding waits, holds and economic failures rotate to
 * the back instead of permanently occupying the prefix. Every eligible market is reconsidered
 * without inventing funding; overlapping scans still re-check under the per-market lock.
 * The close is in the WHERE, not only in the re-check: a SCHEDULED
 * market whose close has passed waits for an admin indefinitely (`close_passed`), and read here it
 * would be locked and skipped every minute while holding a slot at the head of the batch ahead of
 * the markets actually due. The current liquidity version is also joined before the limit:
 * unconfigured legacy markets must wait for an admin without starving configured markets behind
 * them. The exact market/version join uses the version table's primary key, not any historical
 * setting. No index of its own (no migration, ADR-0100): the SCHEDULED set is the approved markets
 * waiting to open, small, and `markets_status_close_at_idx` serves the status and
 * close prefix. The candidate list is a plain read; `openMarket` re-checks everything under the
 * lock, so a market that opened or moved between the read and its turn counts as skipped.
 */
export async function openDueMarkets(
  db: Db,
  publish: Publish,
  enqueueMarketMaker?: EnqueueMarketMaker,
): Promise<OpenScanResult> {
  const due = await db
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .innerJoin(
      schema.marketLiquidityVersions,
      and(
        eq(schema.marketLiquidityVersions.marketId, schema.markets.id),
        eq(schema.marketLiquidityVersions.version, schema.markets.currentLiquidityVersion),
      ),
    )
    .leftJoin(
      schema.marketMakerOpenAttempts,
      eq(schema.marketMakerOpenAttempts.marketId, schema.markets.id),
    )
    .where(
      and(
        eq(schema.markets.status, 'scheduled'),
        lte(schema.markets.scheduledOpenAt, sql`now()`),
        gt(schema.markets.closeAt, sql`now()`),
      ),
    )
    .orderBy(
      sql`${schema.marketMakerOpenAttempts.lastAttemptAt} ASC NULLS FIRST`,
      asc(schema.markets.scheduledOpenAt),
      asc(schema.markets.id),
    )
    .limit(MARKET_SCAN_BATCH_MAX);

  const { results, failed, failures } = await runScan(
    due.map(({ id }) => id),
    (id) => openMarket(db, id, publish, enqueueMarketMaker),
  );
  const opened = results.filter((result) => result.outcome === 'opened').length;
  return { opened, skipped: results.length - opened, failed, failures };
}
