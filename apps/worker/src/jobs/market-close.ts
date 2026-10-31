import { clockTimestamp, lockMarket, schema, transitionMarket, type Db } from '@buddha/db';
import { MARKET_SCAN_BATCH_MAX, marketChannel, type MarketStatusEvent } from '@buddha/shared';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { type Publish } from '../realtime.js';
import { runScan, type ScanFailure } from './scan.js';

export type CloseSkipReason = 'not_open' | 'not_due';

export type CloseResult =
  | { outcome: 'closed'; marketId: string; statusEventId: number; closedAt: Date }
  | { outcome: 'skipped'; marketId: string; reason: CloseSkipReason };

export interface CloseScanResult {
  /** Markets the scan found due; `closed + skipped + failed` is the number examined. */
  closed: number;
  skipped: number;
  /** Markets whose close rejected; the scan went on to the next one (scan.ts). */
  failed: number;
  failures: ScanFailure[];
}

/**
 * open → closed for one market at `close_at` (PLAN 5.5 마감; ADR-0093 decision 1 item 1, an
 * automatic edge), the automatic form of the admin's manual close (market-admin.service.ts
 * `close`): the same lock, the same DB clock read after it, the same transition
 * (`transitionMarket`: the event row with its from/to and the market row's `statusEventId`),
 * minus the admin action (no admin acted — `actorId` is null and the payload says
 * `source: 'job'`). Only `open` is closed: PAUSED → CLOSED on schedule (decision 1 item 3) is
 * #114's, which widens this guard and the scan's WHERE together when PAUSED becomes reachable.
 *
 * Every caller reaches this through the same transaction — the delayed job the API registered
 * at open, the per-minute scan, a manual script — and the transaction re-verifies BOTH the
 * status and the instant under the market lock. That is what makes a stale job harmless: a
 * `closeAt` PATCHed later leaves the old delayed job in the queue (jobs.ts), and here it finds
 * `closeAt > now` and skips; a job that fires after the admin closed by hand finds `closed`
 * and skips; two workers racing on one market serialise on `lockMarket` and the second sees
 * the first's status. Never 'not_found': no path deletes one market (every FK is RESTRICT); only
 * a whole-database wipe does (migrations 0017 and 0048, deploy/reset-db.sh). An unknown id is
 * therefore a job left over from before such a wipe — expected, it runs out of attempts
 * (docs/RESET.md) — or a broken producer, and either way the job fails loudly rather than being
 * retried into silence.
 *
 * `transitionMarket` inserts the event row FIRST so the market UPDATE can carry its id as
 * `statusEventId`, the ordering key of `market:status` (A-M3-19, realtime.ts). Published after
 * COMMIT: the lock is released at COMMIT, so an event published from inside the transaction
 * could reach a client before the row it describes is visible.
 */
export async function closeMarket(
  db: Db,
  marketId: string,
  publish: Publish,
): Promise<CloseResult> {
  const result = await db.transaction(async (tx): Promise<CloseResult> => {
    await lockMarket(tx, marketId);
    const [current] = await tx
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId))
      .limit(1)
      .for('update');
    if (!current) throw new Error(`Market ${marketId} not found`);
    // `open` only until #114 adds PAUSED → CLOSED at `close_at` (ADR-0093 decision 1 item 3).
    if (current.status !== 'open') {
      return { outcome: 'skipped', marketId, reason: 'not_open' };
    }
    // The database clock after the lock (tx-helpers.ts): an admin edit or transition may have
    // committed while this transaction queued, and the close must be judged and stamped
    // after it.
    const now = await clockTimestamp(tx);
    if (current.closeAt > now) {
      return { outcome: 'skipped', marketId, reason: 'not_due' };
    }

    const statusEventId = await transitionMarket(tx, {
      marketId,
      from: current.status,
      to: 'closed',
      type: 'closed',
      actorId: null,
      payload: { closedAt: now.toISOString(), source: 'job' },
      at: now,
    });
    return { outcome: 'closed', marketId, statusEventId, closedAt: now };
  });

  if (result.outcome === 'closed') {
    const event: MarketStatusEvent = {
      type: 'market:status',
      marketId,
      status: 'closed',
      resolvedResult: null,
      statusEventId: String(result.statusEventId),
      ts: result.closedAt.toISOString(),
    };
    await publish(marketChannel(marketId), event);
  }
  return result;
}

/**
 * The per-minute safety net (PLAN 5.5: `status='open' AND close_at <= now()`; `paused` joins
 * it with #114): closes every due market, each in its own transaction and each failure caught
 * (`runScan`), so one market's rejection rolls back that market alone and the rest of the batch
 * still runs. A long lock wait is not isolated the same way — the loop is sequential, so it
 * delays the markets after it, but only for that run. Oldest deadline first, at most
 * MARKET_SCAN_BATCH_MAX per run — the next run a minute later drains what is left, which bounds
 * how long a single job holds the queue; a market that fails every run keeps its slot at the
 * head of the batch and is reported again each minute. The candidate list is a plain read;
 * `closeMarket` re-checks everything under the lock, so a market that closed between the read
 * and its turn counts as skipped.
 */
export async function closeDueMarkets(db: Db, publish: Publish): Promise<CloseScanResult> {
  const due = await db
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(and(eq(schema.markets.status, 'open'), lte(schema.markets.closeAt, sql`now()`)))
    .orderBy(asc(schema.markets.closeAt), asc(schema.markets.id))
    .limit(MARKET_SCAN_BATCH_MAX);

  const { results, failed, failures } = await runScan(
    due.map(({ id }) => id),
    (id) => closeMarket(db, id, publish),
  );
  const closed = results.filter((result) => result.outcome === 'closed').length;
  return { closed, skipped: results.length - closed, failed, failures };
}
