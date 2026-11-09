import {
  CLOSABLE_STATUSES,
  closeMarketAtClose,
  schema,
  type CloseSkipReason,
  type Db,
} from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  marketBookEvent,
  marketChannel,
  type MarketStatusEvent,
} from '@buddha/shared';
import { and, asc, inArray, lte, sql } from 'drizzle-orm';
import { type Publish } from '../realtime.js';
import { runScan, type ScanFailure } from './scan.js';

/**
 * The statuses the close ends — to CLOSED, or to CANCELLED with no fill a person's account is on
 * (#20) — and why it skips a market: the db module's, where the close lives (`closeMarketAtClose`,
 * #120), re-exported for the scan and its tests.
 */
export { CLOSABLE_STATUSES, type CloseSkipReason };

export type CloseResult =
  | {
      /**
       * Where the close took the market: `closed`, or `cancelled` when no fill a person's account
       * is on happened (#20, ADR-0117) — result type empty, no judgement follows.
       */
      outcome: 'closed' | 'cancelled';
      marketId: string;
      statusEventId: number;
      closedAt: Date;
      /** Orders the close ended 만료 (#120). Counts only: BullMQ stores the result as JSON. */
      expiredOrders: number;
      /** A ledger-held market's live orders the close left live and locked, #93's to end. */
      heldOrders: number;
    }
  | { outcome: 'skipped'; marketId: string; reason: CloseSkipReason };

export interface CloseScanResult {
  /**
   * Markets the scan found due; `closed + cancelled + skipped + failed` is the number examined.
   */
  closed: number;
  /** Markets the close cancelled: no fill a person's account is on (#20). */
  cancelled: number;
  skipped: number;
  /** Markets whose close rejected; the scan went on to the next one (scan.ts). */
  failed: number;
  failures: ScanFailure[];
}

/**
 * open or paused → closed for one market at `close_at`, and the end of its remaining orders (PLAN
 * 5.5 마감; ADR-0093 decision 1 #173 items 1·3, an automatic edge — a PAUSED market too, on schedule
 * and never later, #114; #120, ADR-0115) — or → cancelled when no fill a person's account is on
 * happened (#20, ADR-0117; ADR-0107 결정 5 '#20·#120 거래가 전혀 없던과 자동 CANCELLED'): one
 * transaction of `closeMarketAtClose` (@buddha/db market-close.ts) — the market lock, the status
 * and the due check by the DB clock (`close_at` and the server's time only, never the expected
 * judgement time), every live order's owner's Coin account, the close's instant, '사용자 체결
 * 0건' read from the fills under the lock (`marketHasHumanFill`), the transition
 * (`transitionMarket`: actor null, payload `source: 'job'`, a PAUSED market's too; a `cancelled`
 * event carries the system sentence and leaves the result type empty), a PAUSED market's lasting
 * pause ended
 * `closed_at_close` (`endPauseAtClose`: no review, no approval, ADR-0102 — a next-path request
 * still waiting is moot from then on), then every live order of every account type (people and
 * the 운영 마켓메이커) ended 만료 at that instant with its lock given back once, filled quantity kept
 * (ADR-0107 결정 4 '#120·#20', 결정 5 '#20·#120·#177 7항'). A market held for a ledger failure
 * closes on schedule too but keeps its orders live and locked for #93's recovery (결정 4 #178).
 *
 * Every caller reaches this through the same transaction — the delayed job the API registered
 * at the approval (#21, ADR-0100: before the open, the close locked while SCHEDULED), the
 * per-minute scan, a manual script — and the transaction re-verifies BOTH the status and the
 * instant under the market lock. That is what makes a stale job harmless: a close a supplement
 * extended (#80, ADR-0101) can leave the old delayed job in the queue, since the approval's
 * cancel of it is best effort (jobs.ts), and here it finds `closeAt > now` and skips before it
 * takes anyone's balance row; a job that fires while the market is still SCHEDULED (its close
 * came before its open, market-open.ts) or after an approved early close (#114: the approval
 * cancels the job after COMMIT, best effort) finds it neither OPEN nor PAUSED and skips; a
 * PAUSED market keeps its job, which closes it on schedule; two workers racing on one market
 * serialise on `lockMarket` and the second sees the first's status, so each order ends once.
 * Never 'not_found': no path deletes one market (every FK is RESTRICT); only a whole-database
 * wipe does (migrations 0017, 0048 and 0060, deploy/reset-db.sh). An unknown id is therefore a
 * job left over from before such a wipe — expected, it runs out of attempts (docs/RESET.md) — or
 * a broken producer, and either way the job fails loudly rather than being retried into silence.
 * So does a lock that does not hold what an order's remainder names: the whole close rolls back
 * and the scan reports the market every minute (a ledger inconsistency, #93's).
 *
 * Published after COMMIT, best effort (`Publish` never throws): `market:status` with the status
 * the close wrote, `closed` or `cancelled` — its ordering key `statusEventId` is the event
 * `transitionMarket` inserted FIRST (A-M3-19, realtime.ts) — then, when an order expired, one
 * `market:book` at the close's instant (#179, ADR-0114 결과 5 '#120': the public book emptied; the
 * worker cannot use the API's MarketPublisher, so it builds the same event). The lock is released
 * at COMMIT, so an event published from inside the transaction could reach a client before the row
 * it describes is visible. No `user:` event: the expiry only moves locks and follows #178's batch
 * cancels (ADR-0113 12-11) — an owner's sell cancel publishes `user:position`, the batches and the
 * expiry do not; the db result keeps whom it touched for #134. Nothing at `close_at` itself
 * before the close runs (#122's), nothing on a skip.
 */
export async function closeMarket(
  db: Db,
  marketId: string,
  publish: Publish,
): Promise<CloseResult> {
  const done = await db.transaction((tx) => closeMarketAtClose(tx, marketId));
  if (!done.closed) return { outcome: 'skipped', marketId, reason: done.reason };

  const event: MarketStatusEvent = {
    type: 'market:status',
    marketId,
    status: done.status,
    resolvedResult: null,
    statusEventId: String(done.statusEventId),
    ts: done.closedAt.toISOString(),
  };
  await publish(marketChannel(marketId), event);
  if (done.expired.expired.length > 0) {
    await publish(marketChannel(marketId), marketBookEvent(marketId, done.closedAt));
  }
  return {
    outcome: done.status,
    marketId,
    statusEventId: done.statusEventId,
    closedAt: done.closedAt,
    expiredOrders: done.expired.expired.length,
    heldOrders: done.expired.held.length,
  };
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
 * and its turn counts as skipped. A market the close cancelled (#20) counts as `cancelled`, apart
 * from `closed`; no id is reported either way.
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
  const cancelled = results.filter((result) => result.outcome === 'cancelled').length;
  return { closed, cancelled, skipped: results.length - closed - cancelled, failed, failures };
}
