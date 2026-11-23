import {
  clockTimestamp,
  lockMarket,
  recordSettlementFailure,
  schema,
  settledMarketEvents,
  settleSettlingMarket,
  transitionMarket,
  type Db,
  type SettlementProgress,
} from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  marketChannel,
  userChannel,
  type MarketStatusEvent,
  type SettlementStep,
} from '@buddha/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import { type Logger } from 'pino';
import { type Publish } from '../realtime.js';
import { messageOf, runScan, type ScanFailure } from './scan.js';

/**
 * The market was neither `resolved` nor `settling` when the run took the lock: settled already
 * (a duplicate job, the scan after the immediate job), or in a status nothing settles.
 */
export type FinalizeSkipReason = 'not_settling';

/**
 * What a run hands back — BullMQ stores it and the handler logs it (jobs/index.ts `toLoggable`):
 * counts of the payout only, never who the `market_settled` notices reached nor how many — a
 * count with the watchers in it would tell how many watch the market (#188, ADR-0160; ADR-0064).
 */
export type FinalizeResult =
  | {
      outcome: 'settled';
      marketId: string;
      statusEventId: number;
      settledAt: Date;
      /** All reconciled position rows, including previously retired zero rows. */
      positions: number;
      /** Distinct accounts among them. */
      settledAccounts: number;
      /** Accounts that received a SETTLEMENT_PAYOUT, including either outcome for VOID. */
      paidAccounts: number;
      paidCoin: bigint;
    }
  /**
   * The run committed its steps but some step of SETTLEMENT_STEPS is still not `done`, so the
   * market stays `settling` (ADR-0093 decision 1 item 14). Unreachable while every step runs in
   * one transaction (the loop in `finalizeMarket` finishes them all); the variant is where a step
   * run on its own would land.
   */
  | { outcome: 'settling'; marketId: string; pendingSteps: SettlementStep[] }
  | { outcome: 'skipped'; marketId: string; reason: FinalizeSkipReason };

export interface FinalizeScanResult {
  settled: number;
  /** Examined and not settled: no longer `settling` when its turn came (or steps pending). */
  skipped: number;
  /** Markets whose settlement rejected and rolled back; the scan went on (scan.ts). */
  failed: number;
  failures: ScanFailure[];
}

/**
 * The failure half of ADR-0046 (D6), @buddha/db's `recordSettlementFailure` (moved there for the
 * operator retry, #145, ADR-0163): the attempt on the step that was running, in a transaction of
 * its own under the market lock, only while the market is `settling`. Best effort here: a
 * failure to record is logged and swallowed, and the caller rethrows the ORIGINAL error, which is
 * the one the BullMQ job and the scan must report.
 */
async function recordStepFailure(
  db: Db,
  marketId: string,
  running: SettlementStep | undefined,
  err: unknown,
  logger: Logger,
): Promise<void> {
  try {
    await recordSettlementFailure(db, marketId, running, err);
  } catch (recordErr) {
    logger.error(
      { err: recordErr, marketId, step: running, cause: messageOf(err) },
      'settlement step failure not recorded',
    );
  }
}

/**
 * resolved → settling (ADR-0093 decision 1 item 1: the payout starts at once, by the worker),
 * in a transaction of its own committed BEFORE the steps run, so the market reads 지급 중 while
 * they do and stays there when one fails (item 14) — a failed step's rollback cannot take the
 * status back with it. Under the market lock with the status read FOR UPDATE after it, like
 * every status writer (`transitionMarket`); `actorId` is null (the worker acted) and the payload
 * says `source: 'job'`, as the close does. The result is not checked here: a `resolved` market
 * with no result still starts its payout, and the step transaction's invariant fails it loudly in `settling`, recorded on the step like any other failure.
 *
 * Returns the `market:status` to publish after COMMIT, or undefined when the market was not
 * `resolved` (already `settling`, or any status the step transaction skips). An unknown id
 * throws, as the step transaction would.
 */
async function startSettling(db: Db, marketId: string): Promise<MarketStatusEvent | undefined> {
  return db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const [current] = await tx
      .select({ status: schema.markets.status, resolvedResult: schema.markets.resolvedResult })
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId))
      .limit(1)
      .for('update');
    if (!current) throw new Error(`Market ${marketId} not found`);
    if (current.status !== 'resolved') return undefined;
    const at = await clockTimestamp(tx);
    const statusEventId = await transitionMarket(tx, {
      marketId,
      from: current.status,
      to: 'settling',
      type: 'settling',
      actorId: null,
      payload: { source: 'job' },
      at,
    });
    return {
      type: 'market:status',
      marketId,
      status: 'settling',
      resolvedResult: current.resolvedResult,
      statusEventId: String(statusEventId),
      ts: at.toISOString(),
    };
  });
}

/**
 * resolved → settling → settled for one market (ADR-0046, ADR-0093 decision 1 items 1 and 14;
 * PLAN 5.5 정산): the worker's confirmation at the dispute deadline (`market.resolve`, #152,
 * ADR-0103; ADR-0046's interim judgement by one admin before it) made the result final and wrote
 * one `pending` row per SETTLEMENT_STEPS step. A `resolved` market first goes to `settling` in a
 * committed transaction of its own (`startSettling`, published at once); then one transaction runs
 * every step that is not `done` yet on the `settling` market and, once all of them are, settles it
 * (O-6: settled means every step finished — `coin`, the only one). That transaction's body is
 * @buddha/db's `settleSettlingMarket` (packages/db/src/market-finalize.ts), moved there unchanged
 * so the operator's 정산 다시 시도 (#145, ADR-0163; 145-7) runs the same checks — its one other
 * caller; `startSettling` stays here (145-14). The step transaction is all
 * rows or nothing: PLAN 5.5 allows committing per hundred accounts, but at MVP scale a single
 * transaction is the simpler invariant, and whether a step added later gets a transaction of
 * its own is that step's call.
 *
 *  - market advisory lock, then the row FOR UPDATE, then the status re-check under the lock:
 *    only `settling` is settled, so a duplicate job, the scan after the immediate job, or a run
 *    after a manual fix all find `settled` and skip;
 *  - the step rows FOR UPDATE, then each step not `done` in SETTLEMENT_STEPS order, each
 *    marked `done` in the same transaction (`completeStep`). A missing row counts as pending;
 *  - settling → settled only when every step is `done` — the one place that condition lives,
 *    so a step added later widens it here and nowhere else.
 *
 * Idempotent (M5 AC 3): a second run finds `status = 'settled'` and skips before touching a
 * position or a step, and the coin step's `settled = false` filter pays a row at most once
 * regardless. A throw in the step transaction rolls it back — the market stays `settling`
 * (item 14) — and the attempt is then recorded on the step (`recordStepFailure`) and the error
 * rethrown, so the job fails and the next run (the job's retry, or the per-minute scan) does the
 * steps again from the start. The DB settlement operation pays YES/NO at 100/0 and VOID at
 * 50/50, preserves each positive holding's settlement record and checks the collateral and locks.
 * Reconciliation runs before SETTLED even when every step was already done, so a completed coin
 * step never bypasses the accounting checks and never pays again on a reconciliation retry.
 *
 * The final settlement's notice (#188, ADR-0160; 52-1, 52-12 '지급 완료 때 최종 정산', 52-15):
 * last in the step transaction, after the `finalized` transition, its one `createNotifications`
 * call — one `market_settled` per watcher and per account the payout recorded in
 * `position_settlements` (`settlementAudience`: the holders of a contract or more at the payout,
 * 지급 0 included; the 운영 마켓메이커's rows too, which the write path's gate skips), each with
 * the confirmed result and its own summed payout (null for a watcher who held nothing), keyed by
 * the `finalized` event. All or nothing with the payout (188-2, ADR-0157 결정 4의 7 — no
 * savepoint): a notice that fails to write rolls the payout back, the market stays `settling`
 * (지급 지연), the failure is recorded on `coin` with a message naming no account, and the next run
 * pays and notifies together. A run that skips (`not_settling`) writes nothing — the status guard
 * keeps a settlement to one notice per member, the key backs it — and `settling` itself is silent
 * (52-12), as is the confirmation before it (market-resolve.ts). Who was told never reaches the
 * result, the log or the `finalized` payload (ADR-0064, ADR-0159 12-12).
 *
 * Every transition goes through `transitionMarket`, whose event row carries its id to the
 * market row as `statusEventId` (A-M3-19); `actorId` is null: the worker acted. Everything is
 * published after COMMIT — `settling` after its own transaction, then once settled the status
 * to the market's room, then per person its last balance (a holder of both outcomes is
 * credited once per winning row; the later ledger row is the greater key) and every closed-out
 * row, then `user:notification` at the payout's instant to each member a notice reached.
 */
export async function finalizeMarket(
  db: Db,
  marketId: string,
  publish: Publish,
  logger: Logger,
): Promise<FinalizeResult> {
  // The step whose body is running, for the failure record: written inside the transaction
  // callback, read after it rejects (an object, so the read is not narrowed away).
  const progress: SettlementProgress = {};
  let finalized;
  try {
    const settling = await startSettling(db, marketId);
    // Before the steps, so a client sees 지급 중 whether or not they succeed.
    if (settling) await publish(marketChannel(marketId), settling);
    // The step transaction is @buddha/db's core, shared with the operator retry (#145).
    finalized = await db.transaction((tx) => settleSettlingMarket(tx, marketId, progress));
  } catch (err) {
    await recordStepFailure(db, marketId, progress.running, err, logger);
    throw err;
  }

  if (finalized.outcome !== 'settled') return finalized;

  // `notified` stays here: the result BullMQ stores and the log line name no member and count
  // no watcher (ADR-0064, ADR-0159 12-12).
  const events = settledMarketEvents(finalized);
  const { statusEventId, settledAt, positions, settledAccounts, paidAccounts, paidCoin } =
    finalized;
  // Issued back to back, awaited together (realtime.ts): the status first, then each
  // account's events, then the inbox signals, in call order on the wire; a Redis that stops
  // answering costs one command timeout for the batch, not one per holder — the bound is on the
  // publisher's own connection (`createPublisherRedis`), and the backlog it leaves is dropped
  // when that socket goes rather than resent, so a settled market never republishes a payout
  // event.
  await Promise.all([
    publish(marketChannel(marketId), events.status),
    ...events.user.map(([userId, event]) => publish(userChannel(userId), event)),
  ]);
  return {
    outcome: 'settled',
    marketId,
    statusEventId,
    positions,
    settledAccounts,
    paidAccounts,
    paidCoin,
    settledAt,
  };
}

/**
 * The per-minute safety net for settlement (ADR-0046: every `resolved` or `settling` market,
 * confirmed longest ago first): the confirmation registers the job the moment it commits
 * (`market.resolve`, #152), so this picks up a market whose job was lost or failed — one still
 * `resolved` (its resolved → settling never committed) as well as one left `settling` by a failed
 * step (ADR-0093 decision 1 item 14).
 * One market at a time and each rejection caught (`runScan`), so a settlement that fails — the
 * collateral, lock and missing-result checks above, a transient DB error — rolls back that
 * market's steps alone (its step recorded `failed`) and the markets after it are still settled
 * this run. Without the catch the failing market, first by judgement time, would stop every
 * later scan at itself. See `closeDueMarkets` for the batch bound and the re-check.
 */
export async function finalizeDueMarkets(
  db: Db,
  publish: Publish,
  logger: Logger,
): Promise<FinalizeScanResult> {
  const due = await db
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(inArray(schema.markets.status, ['resolved', 'settling']))
    .orderBy(asc(schema.markets.resolvedAt), asc(schema.markets.id))
    .limit(MARKET_SCAN_BATCH_MAX);

  const { results, failed, failures } = await runScan(
    due.map(({ id }) => id),
    (id) => finalizeMarket(db, id, publish, logger),
  );
  const settled = results.filter((result) => result.outcome === 'settled').length;
  return { settled, skipped: results.length - settled, failed, failures };
}
