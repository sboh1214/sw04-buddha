import {
  clockTimestamp,
  dueProvisionalMarkets,
  lockMarket,
  resolveProvisionalMarket,
  type Db,
  type ResolveSkipReason,
} from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  marketChannel,
  type MarketResult,
  type MarketStatusEvent,
} from '@buddha/shared';
import { type EnqueueFinalize } from '../market-jobs.js';
import { type Publish } from '../realtime.js';
import { runScan, type ScanFailure } from './scan.js';

export type ResolveResult =
  | {
      outcome: 'resolved';
      marketId: string;
      statusEventId: number;
      /** The confirmation's instant: `resolved_at`, and the finalize job's id. */
      resolvedAt: Date;
      resolvedResult: MarketResult;
    }
  | { outcome: 'skipped'; marketId: string; reason: Exclude<ResolveSkipReason, 'not_found'> };

export interface ResolveScanResult {
  /** Markets the scan found due; `resolved + skipped + failed` is the number examined. */
  resolved: number;
  skipped: number;
  /** Markets whose confirmation rejected; the scan went on to the next one (scan.ts). */
  failed: number;
  failures: ScanFailure[];
}

/**
 * PROVISIONAL → RESOLVED for one market once its 이의 기한 has passed with nothing held (#152,
 * ADR-0103; ADR-0093 decision 1 #173 item 1, an automatic edge): the only caller of
 * `resolveProvisionalMarket` (@buddha/db), which judges the status, the deadline and the hold — a
 * 판정 이의 of the current version pending or accepted (#175, ADR-0104), `held` — under the lock
 * and writes the `resolved` event (actor null, payload `{version, result, source: 'deadline'}`),
 * `resolved_at` and the pending settlement steps. Here: the market lock, the DB clock read after
 * it, and no admin action (no admin acted).
 *
 * Every caller reaches this through the same transaction — the delayed job the API registered at
 * the approval (`marketResolveJobId`, at the deadline), the same job the API registers again with
 * no delay after the last holding dispute's dismissal past the deadline (#173 item 7 '모두 기각되면
 * 바로 확정'; the first run completed as `held` and was removed), the per-minute scan, a manual
 * script — and it re-verifies the status, the deadline and the hold under the market lock. That
 * is what makes a stale job harmless: one that fires before the deadline (the API's delay read on
 * its clock) finds `not_due` and the scan confirms the market within the minute after it; one
 * that finds a dispute still holding the market finds `held`, and the next dismissal's job or the
 * scan confirms it; a duplicate, or the job after the scan, finds `not_provisional`; two workers
 * racing on one market serialise on `lockMarket` and the second sees the first's status. An
 * unknown id throws, as the close does (market-close.ts): a job left over from a whole-database
 * wipe or a broken producer fails loudly.
 *
 * After COMMIT, `market:status` (`resolved`, the result, the `resolved` event's id as the ordering
 * key, A-M3-19) is published, then `market.finalize` registered at once (`enqueueFinalize`, under
 * `marketFinalizeJobId(marketId, resolvedAt)`): RESOLVED → SETTLING is the finalize's own first
 * transaction (ADR-0095 8-5), so RESOLVED is visible, and its per-minute scan settles a market
 * whose job was lost. A VOID result is confirmed too, and its payout fails in SETTLING until #126.
 */
export async function resolveMarket(
  db: Db,
  marketId: string,
  publish: Publish,
  enqueueFinalize: EnqueueFinalize,
): Promise<ResolveResult> {
  const result = await db.transaction(async (tx): Promise<ResolveResult> => {
    await lockMarket(tx, marketId);
    // The database clock after the lock (tx-helpers.ts): an approval or a correction may have
    // committed while this transaction queued, and the confirmation must be judged and stamped
    // after it.
    const now = await clockTimestamp(tx);
    const confirmed = await resolveProvisionalMarket(tx, { marketId, now });
    if (!confirmed.resolved) {
      if (confirmed.reason === 'not_found') throw new Error(`Market ${marketId} not found`);
      return { outcome: 'skipped', marketId, reason: confirmed.reason };
    }
    return {
      outcome: 'resolved',
      marketId,
      statusEventId: confirmed.eventId,
      resolvedAt: now,
      resolvedResult: confirmed.result,
    };
  });

  if (result.outcome === 'resolved') {
    const event: MarketStatusEvent = {
      type: 'market:status',
      marketId,
      status: 'resolved',
      resolvedResult: result.resolvedResult,
      statusEventId: String(result.statusEventId),
      ts: result.resolvedAt.toISOString(),
    };
    await publish(marketChannel(marketId), event);
    await enqueueFinalize(marketId, result.resolvedAt);
  }
  return result;
}

/**
 * The per-minute safety net (`market-resolve-scan`, #152), the close scan's pattern
 * (market-close.ts): confirms every PROVISIONAL market whose dispute deadline has passed with
 * nothing held, each in its own transaction and each failure caught (`runScan`), so one market's
 * rejection rolls back that market alone and the rest of the batch still runs. It confirms a
 * market whose delayed job was lost — Redis restarted, the API's best-effort add failed after
 * COMMIT — within a minute, and one whose hold (#175's disputes; #176's correction) cleared after
 * its deadline and whose job after the last dismissal was lost. The hold is in the candidate query
 * (`dueProvisionalMarkets`' NOT EXISTS) as well as in the re-check, as the open scan keeps the
 * close there, so a held market never takes a slot of the batch.
 *
 * Earliest deadline first, at most MARKET_SCAN_BATCH_MAX per run; the next run a minute later
 * drains what is left. `markets_provisional_dispute_deadline_idx` (migration 0055) serves the list
 * — the PROVISIONAL markets by deadline — and `market_disputes_holding_idx` (0056) each one's hold;
 * the schema test reads this query's plan. The candidate list is a plain read; `resolveMarket`
 * re-checks everything under the lock, so a market confirmed or held between the read and its turn
 * counts as skipped.
 */
export async function resolveDueMarkets(
  db: Db,
  publish: Publish,
  enqueueFinalize: EnqueueFinalize,
): Promise<ResolveScanResult> {
  const due = await dueProvisionalMarkets(db, MARKET_SCAN_BATCH_MAX);

  const { results, failed, failures } = await runScan(
    due.map(({ id }) => id),
    (id) => resolveMarket(db, id, publish, enqueueFinalize),
  );
  const resolved = results.filter((result) => result.outcome === 'resolved').length;
  return { resolved, skipped: results.length - resolved, failed, failures };
}
