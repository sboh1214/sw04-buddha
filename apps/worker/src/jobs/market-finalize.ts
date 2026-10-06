import { clockTimestamp, lockMarket, schema, type Db } from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  SETTLEMENT_STEP_ERROR_MAX,
  SETTLEMENT_STEPS,
  marketChannel,
  serializePAmount,
  settle,
  userChannel,
  type MarketStatusEvent,
  type Outcome,
  type SettlementStep,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { type Logger } from 'pino';
import { type Publish } from '../realtime.js';
import { messageOf, runScan, type ScanFailure } from './scan.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MarketRow = typeof schema.markets.$inferSelect;
type PositionRow = typeof schema.positions.$inferSelect;
type BalanceRow = typeof schema.balances.$inferSelect;

export type FinalizeSkipReason = 'not_resolved';

export type FinalizeResult =
  | {
      outcome: 'settled';
      marketId: string;
      statusEventId: number;
      settledAt: Date;
      /** Unsettled position rows closed out. */
      positions: number;
      /** Distinct accounts among them. */
      settledAccounts: number;
      /** Accounts that received a SETTLEMENT_PAYOUT (held the winning outcome with qty > 0). */
      paidAccounts: number;
      paidP: bigint;
    }
  /**
   * The run committed its steps but some step of SETTLEMENT_STEPS is still not `done`, so the
   * market stays `resolved`. Unreachable while every step runs in one transaction (the loop in
   * `finalizeMarket` finishes them all); the variant is the place #29 lands in.
   */
  | { outcome: 'resolved'; marketId: string; pendingSteps: SettlementStep[] }
  | { outcome: 'skipped'; marketId: string; reason: FinalizeSkipReason };

export interface FinalizeScanResult {
  settled: number;
  /** Examined and not settled: no longer `resolved` when its turn came (or steps pending). */
  skipped: number;
  /** Markets whose settlement rejected and rolled back; the scan went on (scan.ts). */
  failed: number;
  failures: ScanFailure[];
}

/** One closed-out row and, when it won something, the balance and ledger row of its payout. */
interface Settlement {
  position: PositionRow;
  balance?: BalanceRow;
  ledgerEntryId?: number;
}

/** What the `coin` step closed out: the `finalized` payload's counts and the publishes. */
interface CoinStep {
  positions: number;
  settledAccounts: number;
  paidAccounts: number;
  paidP: bigint;
  settlements: Settlement[];
}

/**
 * The `coin` settlement step (PLAN 5.5 정산): every unsettled position of the market is closed
 * out with the shared `settle()` accounting (PLAN 5.4 — the winning outcome is paid qty × 100P,
 * both outcomes end at qty 0, cost 0, `settled`), and each payout is one SETTLEMENT_PAYOUT
 * ledger row written with its balance change. It mirrors the void path (market-admin.service.ts
 * `void`) statement for statement so the two close-outs cannot drift:
 *
 *  - positions FOR UPDATE in (user_id, outcome) order — the same order the void takes, so a
 *    void and a finalize touching one account's balance cannot deadlock (they cannot run at
 *    once on one market anyway, but the order is what makes that mechanical);
 *  - the market's own instant read after those locks (tx-helpers.ts), and each payout's
 *    instant read after that ACCOUNT's balance lock: a trade of this account on another
 *    market may have committed while this transaction waited, and the payout's ledger row
 *    must sort after it or `/me/ledger`'s `balance_after_p` chain reads inverted (ADR-0027
 *    addendum, A-M3-14);
 *  - the ledger row and the balance UPDATE in the same transaction (PLAN 0.2), the balance
 *    UPDATE conditional on nothing — a payout only adds.
 *
 * The `settled = false` filter is the step's own idempotency guard: a row is paid at most once
 * even if the step were ever run twice. Returns the step's instant — the market's, read after
 * the position locks — which the step row's `completed_at` and the `settled` transition carry.
 */
async function runCoinStep(
  tx: Tx,
  market: MarketRow,
  result: Outcome,
): Promise<CoinStep & { at: Date }> {
  const marketId = market.id;
  // Held FOR UPDATE for the rest of the transaction; only ever written under this market's
  // lock, so the SELECT never waits, but the clock is read after it all the same (the rule
  // is "after the last lock", mechanically).
  const holders = await tx
    .select()
    .from(schema.positions)
    .where(and(eq(schema.positions.marketId, marketId), eq(schema.positions.settled, false)))
    .orderBy(asc(schema.positions.userId), asc(schema.positions.outcome))
    .for('update');
  const now = await clockTimestamp(tx);

  const settlements: Settlement[] = [];
  const settledAccounts = new Set<string>();
  const paidAccounts = new Set<string>();
  let paidP = 0n;
  for (const position of holders) {
    const after = settle(position, position.outcome === result);
    settledAccounts.add(position.userId);
    let balance: BalanceRow | undefined;
    let ledgerEntryId: number | undefined;
    if (after.payoutP > 0n) {
      const [locked] = await tx
        .select({ userId: schema.balances.userId })
        .from(schema.balances)
        .where(eq(schema.balances.userId, position.userId))
        .limit(1)
        .for('update');
      // A missing balance row is a broken account (the "user" trigger creates it at
      // sign-up). Failing the whole settlement is deliberate: paying everyone else and
      // leaving this holder's row unsettled would need a partial-settlement state nothing
      // else understands. The step is recorded `failed` with this message (`finalizeMarket`),
      // and the failed job is visible in the BullMQ failed set.
      if (!locked) throw new Error(`Balance not found for account ${position.userId}`);
      const paidAt = await clockTimestamp(tx);
      [balance] = await tx
        .update(schema.balances)
        .set({
          availableP: sql`${schema.balances.availableP} + ${after.payoutP}`,
          updatedAt: paidAt,
        })
        .where(eq(schema.balances.userId, position.userId))
        .returning();
      if (!balance) throw new Error(`Balance not found for account ${position.userId}`);
      const [entry] = await tx
        .insert(schema.ledgerEntries)
        .values({
          userId: position.userId,
          type: 'SETTLEMENT_PAYOUT',
          amountP: after.payoutP,
          balanceAfterP: balance.availableP,
          refType: 'market',
          refId: marketId,
          memo: `정산 지급: ${market.title}`,
          createdAt: paidAt,
        })
        .returning({ id: schema.ledgerEntries.id });
      if (!entry) throw new Error('Ledger insert failed');
      ledgerEntryId = entry.id;
      paidAccounts.add(position.userId);
      paidP += after.payoutP;
    }
    // `version` bumps by itself (`$onUpdate` on the column): this UPDATE goes through the
    // ORM, and the returned row carries the new value the `user:position` event needs.
    const [updated] = await tx
      .update(schema.positions)
      .set({
        qty: after.qty,
        costBasisP: after.costBasisP,
        realizedPnlP: after.realizedPnlP,
        settled: true,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.positions.userId, position.userId),
          eq(schema.positions.marketId, marketId),
          eq(schema.positions.outcome, position.outcome),
        ),
      )
      .returning();
    if (!updated) throw new Error('Position update failed');
    settlements.push({ position: updated, balance, ledgerEntryId });
  }

  return {
    at: now,
    positions: holders.length,
    settledAccounts: settledAccounts.size,
    paidAccounts: paidAccounts.size,
    paidP,
    settlements,
  };
}

/**
 * Marks one step `done` in the transaction that ran it (ADR-0046): `completed_at` is the step's
 * instant and `attempts` counts this run; `last_error` is left as it was, so the reason of an
 * earlier failed attempt stays readable after the retry succeeded. An upsert because a missing
 * row counts as pending — the judgement writes one per step, but a market judged before the
 * table existed, or a row lost to a bug, must not block the settlement for good.
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
 * written in a transaction of its own — `failed`, `attempts` + 1, the message cut to
 * SETTLEMENT_STEP_ERROR_MAX — on the step that was running, or, when the throw came before any
 * step started (the "no result" invariant, a lock or connection error), on the first step that
 * is not `done`. That is what lets an operator see why a market stays `resolved` without the
 * worker's logs; the per-minute scan retries it with no cap.
 *
 * Under the market lock like every writer of market state, and only for a market that is still
 * `resolved`: an unknown id has nowhere to record, and a market another run settled since the
 * rollback (the lock was released with it) is done — so is the `status <> 'done'` guard, which
 * also keeps a finished step finished if a row ever disagrees with the market. Best effort: a
 * failure here is logged and swallowed, and the caller rethrows the ORIGINAL error, which is the
 * one the BullMQ job and the scan must report.
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
      if (market?.status !== 'resolved') return;
      let step = running;
      if (step === undefined) {
        const rows = await tx
          .select({ step: steps.step, status: steps.status })
          .from(steps)
          .where(eq(steps.marketId, marketId))
          .for('update');
        const done = new Set(rows.filter((row) => row.status === 'done').map((row) => row.step));
        step = SETTLEMENT_STEPS.find((candidate) => !done.has(candidate));
        if (step === undefined) return;
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
          set: { status: 'failed', attempts: sql`${steps.attempts} + 1`, lastError, updatedAt: at },
          setWhere: sql`${steps.status} <> 'done'`,
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
 * resolved → settled for one market (ADR-0046; PLAN 5.5 정산): the admin's judgement made the
 * result final and wrote one `pending` row per SETTLEMENT_STEPS step; this runs every step that
 * is not `done` yet and, once all of them are, settles the market (O-6: settled means every
 * step finished — `coin` today, #29 appends `score`). One transaction, all rows or nothing:
 * PLAN 5.5 allows committing per hundred accounts, but at MVP scale a single transaction is the
 * simpler invariant, and whether #29's step gets a transaction of its own is #29's call.
 *
 *  - market advisory lock, then the row FOR UPDATE, then the status re-check under the lock:
 *    only `resolved` is settled, so a duplicate job, the scan after the immediate job, or a run
 *    after a manual fix all find `settled` and skip;
 *  - the step rows FOR UPDATE, then each step not `done` in SETTLEMENT_STEPS order, each
 *    marked `done` in the same transaction (`completeStep`). A missing row counts as pending;
 *  - the `settled` transition only when every step is `done` — the one place that condition
 *    lives, so #29 widens it here and nowhere else.
 *
 * Idempotent (M5 AC 3): a second run finds `status = 'settled'` and skips before touching a
 * position or a step, and the coin step's `settled = false` filter pays a row at most once
 * regardless. A throw anywhere rolls the whole run back; the attempt is then recorded on the
 * step (`recordStepFailure`) and the error rethrown, so the job fails and the next run (the
 * job's retry, or the per-minute scan) does it all again from the start. A `resolved` market
 * with no result is an invariant the API guarantees (`resolve` writes both columns in one
 * UPDATE); it throws so the job fails loudly instead of settling every holder as a loser.
 *
 * The `finalized` event row is inserted before the market UPDATE so the row can carry its id as
 * `statusEventId` (A-M3-19). `actorId` is null: the worker acted. Everything is published after
 * COMMIT — the status to the market's room, then per account its last balance (a holder of both
 * outcomes is credited once per winning row; the later ledger row is the greater key) and every
 * closed-out row.
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
    finalized = await db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [current] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId))
        .limit(1)
        .for('update');
      if (!current) throw new Error(`Market ${marketId} not found`);
      if (current.status !== 'resolved') {
        return { outcome: 'skipped', marketId, reason: 'not_resolved' } as const;
      }
      const result = current.resolvedResult;
      if (result === null) {
        throw new Error(`Market ${marketId} is resolved without a result`);
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
      // This run's coin step; all zero when the step was done before this run (only possible
      // once #29 lets a step finish in a run of its own — the payload then counts this run).
      let coin: CoinStep = {
        positions: 0,
        settledAccounts: 0,
        paidAccounts: 0,
        paidP: 0n,
        settlements: [],
      };
      // The instant of the last step this run finished: the `settled` transition shares it,
      // as the settlement shared one instant before the steps were split out.
      let at: Date | undefined;
      for (const step of SETTLEMENT_STEPS) {
        if (done.has(step)) continue;
        progress.running = step;
        let stepAt: Date;
        // One case per SETTLEMENT_STEPS entry; #29 adds `score`.
        switch (step) {
          case 'coin': {
            const ran = await runCoinStep(tx, current, result);
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
        // #29: what a run that leaves the market `resolved` publishes is that issue's call.
        return { outcome: 'resolved', marketId, pendingSteps } as const;
      }
      // Every step was done before this run (a row written by hand): nothing locked after the
      // step rows, so the clock is read now.
      const now = at ?? (await clockTimestamp(tx));

      const [event] = await tx
        .insert(schema.marketEvents)
        .values({
          marketId,
          type: 'finalized',
          actorId: null,
          payload: {
            result,
            settledAccounts: coin.settledAccounts,
            paidAccounts: coin.paidAccounts,
            paidP: serializePAmount(coin.paidP),
            positions: coin.positions,
          },
          createdAt: now,
        })
        .returning({ id: schema.marketEvents.id });
      if (!event) throw new Error('Market event insert failed');
      const [row] = await tx
        .update(schema.markets)
        .set({ status: 'settled', settledAt: now, statusEventId: event.id, updatedAt: now })
        .where(eq(schema.markets.id, marketId))
        .returning({ id: schema.markets.id });
      if (!row) throw new Error('Market update failed');

      return {
        outcome: 'settled',
        marketId,
        statusEventId: event.id,
        settledAt: now,
        positions: coin.positions,
        settledAccounts: coin.settledAccounts,
        paidAccounts: coin.paidAccounts,
        paidP: coin.paidP,
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
    // Stamped with the account's own payout instant (its `updated_at`), not the market's: a
    // trade of this account elsewhere may sit between the two. The ledger id is what a client
    // orders by (realtime.ts); the instant is for display.
    events.push([
      userId,
      {
        type: 'user:balance',
        availableP: serializePAmount(balance.availableP),
        lockedP: serializePAmount(balance.lockedP),
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
        costBasisP: serializePAmount(position.costBasisP),
        realizedPnlP: serializePAmount(position.realizedPnlP),
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
 * The per-minute safety net for settlement (ADR-0046: every `resolved` market, judged longest
 * ago first): the API runs the job the moment it judges, so this picks up a market whose job
 * was lost or failed. One transaction per market and each rejection caught (`runScan`), so a
 * settlement that fails — the "no balance row" and "no result" throws above, a transient DB
 * error — rolls back that market alone (its step recorded `failed`) and the markets after it
 * are still settled this run. Without the catch the failing market, first by judgement time,
 * would stop every later scan at itself. See `closeDueMarkets` for the batch bound and the
 * re-check.
 */
export async function finalizeDueMarkets(
  db: Db,
  publish: Publish,
  logger: Logger,
): Promise<FinalizeScanResult> {
  const due = await db
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(eq(schema.markets.status, 'resolved'))
    .orderBy(asc(schema.markets.resolvedAt), asc(schema.markets.id))
    .limit(MARKET_SCAN_BATCH_MAX);

  const { results, failed, failures } = await runScan(
    due.map(({ id }) => id),
    (id) => finalizeMarket(db, id, publish, logger),
  );
  const settled = results.filter((result) => result.outcome === 'settled').length;
  return { settled, skipped: results.length - settled, failed, failures };
}
