import {
  clockTimestamp,
  lockMarket,
  reconcileMarketSettlement,
  settleMarketPositions,
  schema,
  transitionMarket,
  type Db,
} from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  SETTLEMENT_STEP_ERROR_MAX,
  SETTLEMENT_STEPS,
  marketChannel,
  serializeCoinAmount,
  userChannel,
  type MarketStatusEvent,
  type SettlementStep,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { type Logger } from 'pino';
import { type Publish } from '../realtime.js';
import { messageOf, runScan, type ScanFailure } from './scan.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type PositionRow = typeof schema.positions.$inferSelect;
type BalanceRow = typeof schema.balances.$inferSelect;

/**
 * The market was neither `resolved` nor `settling` when the run took the lock: settled already
 * (a duplicate job, the scan after the immediate job), or in a status nothing settles.
 */
export type FinalizeSkipReason = 'not_settling';

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
 * One closed-out row of a person's and, when it won something, that person's balance and the
 * payout's ledger row. The 운영 마켓메이커's rows are closed out too, but published nothing: no
 * client of its exists, and its payout goes to a 마켓메이커 자금, which is no one's wallet.
 */
interface Settlement {
  position: PositionRow;
  balance?: BalanceRow;
  ledgerEntryId?: number;
}

/** The coin step result; only fresh settlements are published after commit. */
interface CoinStep {
  positions: number;
  settledAccounts: number;
  paidAccounts: number;
  paidCoin: bigint;
  settlements: Settlement[];
}

/**
 * Marks one step `done` in the transaction that ran it (ADR-0046): `completed_at` is the step's
 * instant and `attempts` counts this run; `last_error` is left as it was, so the reason of an
 * earlier failed attempt stays readable after the retry succeeded. An upsert because a missing
 * row counts as pending — the confirmation writes one per step (`resolveProvisionalMarket`, #152;
 * the interim judgement before it), but a market judged before the table existed, or a row lost
 * to a bug, must not block the settlement for good.
 */
async function completeStep(
  tx: Tx,
  marketId: string,
  step: SettlementStep,
  at: Date,
): Promise<void> {
  const steps = schema.marketSettlementSteps;
  await tx
    .insert(steps)
    .values({
      marketId,
      step,
      status: 'done',
      attempts: 1,
      completedAt: at,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [steps.marketId, steps.step],
      set: { status: 'done', attempts: sql`${steps.attempts} + 1`, completedAt: at, updatedAt: at },
    });
}

/**
 * The failure half of ADR-0046 (D6): the settlement transaction rolled back, so the attempt is
 * written in a transaction of its own — `failed`, `attempts` + 1, `messageOf(err)` cut to
 * SETTLEMENT_STEP_ERROR_MAX (a database error's SQLSTATE and driver message first, so the cut
 * keeps the reason, not just the failed SQL) — on the step that was running, or, when the throw
 * came before any step started (a missing result, lock or connection error), on the first
 * unfinished step. A failed final reconciliation is recorded on `coin` even when it is done. That is what lets an operator see why a market
 * stays `settling` (ADR-0093 decision 1 item 14) without the worker's logs; the per-minute scan
 * retries it with no cap.
 *
 * Under the market lock like every writer of market state, and only for a market that is
 * `settling`: an unknown id has nowhere to record; a market still `resolved` started no payout
 * (its resolved → settling is what failed, and the next run tries it again); and a market
 * another run settled since the rollback (the lock was released with it) is done. A completed step keeps its status and completion instant when reconciliation
 * fails: its payout must never be repeated; only the error and attempt count change. Best effort: a failure here is logged and swallowed, and the caller rethrows
 * the ORIGINAL error, which is the one the BullMQ job and the scan must report.
 */
async function recordStepFailure(
  db: Db,
  marketId: string,
  running: SettlementStep | undefined,
  err: unknown,
  logger: Logger,
): Promise<void> {
  const steps = schema.marketSettlementSteps;
  try {
    await db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      // A plain read: every status writer holds the advisory lock taken above.
      const [market] = await tx
        .select({ status: schema.markets.status })
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId))
        .limit(1);
      if (market?.status !== 'settling') return;
      let step = running;
      if (step === undefined) {
        const rows = await tx
          .select({ step: steps.step, status: steps.status })
          .from(steps)
          .where(eq(steps.marketId, marketId))
          .for('update');
        const done = new Set(rows.filter((row) => row.status === 'done').map((row) => row.step));
        step = SETTLEMENT_STEPS.find((candidate) => !done.has(candidate)) ?? 'coin';
      }
      const at = await clockTimestamp(tx);
      const lastError = messageOf(err).slice(0, SETTLEMENT_STEP_ERROR_MAX);
      await tx
        .insert(steps)
        .values({
          marketId,
          step,
          status: 'failed',
          attempts: 1,
          lastError,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [steps.marketId, steps.step],
          set: {
            status: sql`CASE WHEN ${steps.status} = 'done' THEN 'done' ELSE 'failed' END`,
            attempts: sql`${steps.attempts} + 1`,
            lastError,
            updatedAt: at,
          },
        });
    });
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
 * (O-6: settled means every step finished — `coin`, the only one). The step transaction is all
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
 * Every transition goes through `transitionMarket`, whose event row carries its id to the
 * market row as `statusEventId` (A-M3-19); `actorId` is null: the worker acted. Everything is
 * published after COMMIT — `settling` after its own transaction, then once settled the status
 * to the market's room, then per person its last balance (a holder of both outcomes is
 * credited once per winning row; the later ledger row is the greater key) and every closed-out
 * row.
 */
export async function finalizeMarket(
  db: Db,
  marketId: string,
  publish: Publish,
  logger: Logger,
): Promise<FinalizeResult> {
  // The step whose body is running, for the failure record: written inside the transaction
  // callback, read after it rejects (an object, so the read is not narrowed away).
  const progress: { running?: SettlementStep } = {};
  let finalized;
  try {
    const settling = await startSettling(db, marketId);
    // Before the steps, so a client sees 지급 중 whether or not they succeed.
    if (settling) await publish(marketChannel(marketId), settling);
    finalized = await db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [current] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId))
        .limit(1)
        .for('update');
      if (!current) throw new Error(`Market ${marketId} not found`);
      if (current.status !== 'settling') {
        return { outcome: 'skipped', marketId, reason: 'not_settling' } as const;
      }
      const result = current.resolvedResult;
      if (result === null) {
        throw new Error(`Market ${marketId} is settling without a result`);
      }

      const stepRows = await tx
        .select({
          step: schema.marketSettlementSteps.step,
          status: schema.marketSettlementSteps.status,
        })
        .from(schema.marketSettlementSteps)
        .where(eq(schema.marketSettlementSteps.marketId, marketId))
        .for('update');
      const done = new Set(stepRows.filter((row) => row.status === 'done').map((row) => row.step));
      // Publishes only this run's changes; the final counts come from reconciliation below.
      let coin: CoinStep = {
        positions: 0,
        settledAccounts: 0,
        paidAccounts: 0,
        paidCoin: 0n,
        settlements: [],
      };
      // The instant of the last step this run finished: the `settled` transition shares it,
      // as the settlement shared one instant before the steps were split out.
      let at: Date | undefined;
      for (const step of SETTLEMENT_STEPS) {
        if (done.has(step)) continue;
        progress.running = step;
        let stepAt: Date;
        // One case per SETTLEMENT_STEPS entry.
        switch (step) {
          case 'coin': {
            const ran = await settleMarketPositions(tx, marketId);
            coin = ran;
            stepAt = ran.at;
            break;
          }
        }
        await completeStep(tx, marketId, step, stepAt);
        done.add(step);
        at = stepAt;
        progress.running = undefined;
      }

      const pendingSteps = SETTLEMENT_STEPS.filter((step) => !done.has(step));
      if (pendingSteps.length > 0) {
        // What a run that leaves the market `settling` publishes is that later step's call.
        return { outcome: 'settling', marketId, pendingSteps } as const;
      }
      // A done coin step still has to reconcile, without repeating any payout.
      progress.running = 'coin';
      const reconciled = await reconcileMarketSettlement(tx, marketId);
      const now = at ?? reconciled.at;
      progress.running = undefined;

      const statusEventId = await transitionMarket(tx, {
        marketId,
        from: current.status,
        to: 'settled',
        type: 'finalized',
        actorId: null,
        payload: {
          result,
          settledAccounts: reconciled.settledAccounts,
          paidAccounts: reconciled.paidAccounts,
          paidCoin: serializeCoinAmount(reconciled.paidCoin),
          positions: reconciled.positions,
        },
        at: now,
        set: { settledAt: now },
      });

      return {
        outcome: 'settled',
        marketId,
        statusEventId,
        settledAt: now,
        positions: reconciled.positions,
        settledAccounts: reconciled.settledAccounts,
        paidAccounts: reconciled.paidAccounts,
        paidCoin: reconciled.paidCoin,
        result,
        settlements: coin.settlements,
      } as const;
    });
  } catch (err) {
    await recordStepFailure(db, marketId, progress.running, err, logger);
    throw err;
  }

  if (finalized.outcome !== 'settled') return finalized;

  const { settlements, result, settledAt, ...summary } = finalized;
  const ts = settledAt.toISOString();
  const status: MarketStatusEvent = {
    type: 'market:status',
    marketId,
    status: 'settled',
    resolvedResult: result,
    statusEventId: String(summary.statusEventId),
    ts,
  };
  // The last balance seen per account wins: with a payout per winning row the later ledger
  // row is the greater key, and the (user_id, outcome) order above makes "later" "last".
  const balances = new Map<string, { balance: BalanceRow; ledgerEntryId: number }>();
  for (const { position, balance, ledgerEntryId } of settlements) {
    if (balance && ledgerEntryId !== undefined) {
      balances.set(position.userId, { balance, ledgerEntryId });
    }
  }
  const events: [string, UserRealtimeEvent][] = [];
  for (const [userId, { balance, ledgerEntryId }] of balances) {
    // Stamped with the account's own payout instant (its `updated_at`), not the market's:
    // another write of this account may sit between the two. The ledger id is what a client
    // orders by (realtime.ts); the instant is for display.
    events.push([
      userId,
      {
        type: 'user:balance',
        availableCoin: serializeCoinAmount(balance.availableCoin),
        lockedCoin: serializeCoinAmount(balance.lockedCoin),
        ledgerEntryId: String(ledgerEntryId),
        ts: balance.updatedAt.toISOString(),
      },
    ]);
  }
  for (const { position } of settlements) {
    events.push([
      position.userId,
      {
        type: 'user:position',
        marketId: position.marketId,
        outcome: position.outcome,
        qty: position.qty,
        costBasisCoin: serializeCoinAmount(position.costBasisCoin),
        realizedPnlCoin: serializeCoinAmount(position.realizedPnlCoin),
        settled: position.settled,
        version: position.version,
        ts,
      },
    ]);
  }
  // Issued back to back, awaited together (realtime.ts): the status first, then each
  // account's events, in call order on the wire; a Redis that stops answering costs one
  // command timeout for the batch, not one per holder — the bound is on the publisher's own
  // connection (`createPublisherRedis`), and the backlog it leaves is dropped when that socket
  // goes rather than resent, so a settled market never republishes a payout event.
  await Promise.all([
    publish(marketChannel(marketId), status),
    ...events.map(([userId, event]) => publish(userChannel(userId), event)),
  ]);
  return { ...summary, settledAt };
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
