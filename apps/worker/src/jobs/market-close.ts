import {
  clockTimestamp,
  endPauseAtClose,
  lockMarket,
  schema,
  transitionMarket,
  type Db,
} from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  marketChannel,
  type MarketStatus,
  type MarketStatusEvent,
} from '@buddha/shared';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { type Publish } from '../realtime.js';
import { runScan, type ScanFailure } from './scan.js';

/**
 * The statuses the close at `close_at` takes to CLOSED (ADR-0093 decision 1 #173 items 1·3): OPEN,
 * and PAUSED on schedule — never later — since #114.
 */
export const CLOSABLE_STATUSES = ['open', 'paused'] as const satisfies readonly MarketStatus[];

const isClosable = (status: MarketStatus): status is (typeof CLOSABLE_STATUSES)[number] =>
  (CLOSABLE_STATUSES as readonly MarketStatus[]).includes(status);

/**
 * Why `closeMarket` left a market as it was: `not_open_or_paused` — neither OPEN nor PAUSED (a
 * draft up to SCHEDULED, or closed already); `not_due` — its close is still ahead.
 */
export type CloseSkipReason = 'not_open_or_paused' | 'not_due';

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
 * open or paused → closed for one market at `close_at` (PLAN 5.5 마감; ADR-0093 decision 1 #173
 * items 1·3, an automatic edge — a PAUSED market too, on schedule and never later, #114): the
 * market lock, the DB clock read after it, the transition (`transitionMarket`: the event row with
 * its from/to and the market row's `statusEventId`), and no admin action (no admin acted —
 * `actorId` is null and the payload says `source: 'job'`, a PAUSED market's too). Closing a PAUSED
 * market ends its lasting pause in the same transaction (`endPauseAtClose`: `closed_at_close`, no
 * review, no approval, #114, ADR-0102); a next-path request still waiting is moot from then on.
 *
 * Every caller reaches this through the same transaction — the delayed job the API registered
 * at the approval (#21, ADR-0100: before the open, the close locked while SCHEDULED), the
 * per-minute scan, a manual script — and the transaction re-verifies BOTH the status and the
 * instant under the market lock. That is what makes a stale job harmless: a close a supplement
 * extended (#80, ADR-0101) can leave the old delayed job in the queue, since the approval's
 * cancel of it is best effort (jobs.ts), and here it finds `closeAt > now` and skips; a job that
 * fires while the market is still SCHEDULED (its close came before its open, market-open.ts) or
 * after an approved early close (#114: the approval cancels the job after COMMIT, best effort)
 * finds it neither OPEN nor PAUSED and skips; a PAUSED market keeps its job, which closes it on
 * schedule; two workers racing on one market serialise on `lockMarket` and the second sees the
 * first's status. Never 'not_found': no path deletes one market (every FK is RESTRICT); only a
 * whole-database wipe does (migrations 0017, 0048 and 0060, deploy/reset-db.sh). An unknown id is
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
    if (!isClosable(current.status)) {
      return { outcome: 'skipped', marketId, reason: 'not_open_or_paused' };
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
    if (current.status === 'paused') {
      await endPauseAtClose(tx, { marketId, now, eventId: statusEventId });
    }
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
 * The per-minute safety net (PLAN 5.5: `status='open' AND close_at <= now()`, and `paused` since
 * #114 — CLOSABLE_STATUSES; `markets_status_close_at_idx` serves the list, ADR-0100 7-7): closes
 * every due market, each in its own transaction and each failure caught
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
    .where(
      and(
        inArray(schema.markets.status, [...CLOSABLE_STATUSES]),
        lte(schema.markets.closeAt, sql`now()`),
      ),
    )
    .orderBy(asc(schema.markets.closeAt), asc(schema.markets.id))
    .limit(MARKET_SCAN_BATCH_MAX);

  const { results, failed, failures } = await runScan(
    due.map(({ id }) => id),
    (id) => closeMarket(db, id, publish),
  );
  const closed = results.filter((result) => result.outcome === 'closed').length;
  return { closed, skipped: results.length - closed, failed, failures };
}
