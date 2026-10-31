import { clockTimestamp, lockMarket, schema, transitionMarket, type Db } from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  SETTLEMENT_STEP_ERROR_MAX,
  SETTLEMENT_STEPS,
  marketChannel,
  serializeCoinAmount,
  settle,
  userChannel,
  type MarketStatusEvent,
  type Outcome,
  type SettlementStep,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type Logger } from 'pino';
import { type Publish } from '../realtime.js';
import { messageOf, runScan, type ScanFailure } from './scan.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MarketRow = typeof schema.markets.$inferSelect;
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
      /** Unsettled position rows closed out. */
      positions: number;
      /** Distinct accounts among them. */
      settledAccounts: number;
      /** Accounts that received a SETTLEMENT_PAYOUT (held the winning outcome with qty > 0). */
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
  paidCoin: bigint;
  settlements: Settlement[];
}

/**
 * The `coin` settlement step (PLAN 5.5 정산): every unsettled position of the market is closed
 * out with the shared `settle()` accounting (PLAN 5.4 — the winning outcome is paid qty × 100 Coin,
 * both outcomes end at qty 0, cost 0, `settled`), and each payout is one SETTLEMENT_PAYOUT
 * ledger row written with its balance change:
 *
 *  - positions FOR UPDATE in (user_id, outcome) order — one fixed order, so two close-outs
 *    touching one account's balance cannot deadlock (they cannot run at once on one market
 *    anyway, but the order is what makes that mechanical);
 *  - the market's own instant read after those locks (tx-helpers.ts), and each payout's
 *    instant read after that ACCOUNT's balance lock: another write of this account (a charge,
 *    a payout on another market) may have committed while this transaction waited, and the
 *    payout's ledger row must sort after it or `/me/ledger`'s `balance_after_coin` chain reads
 *    inverted (ADR-0027 addendum, A-M3-14);
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
  let paidCoin = 0n;
  for (const position of holders) {
    const after = settle(position, position.outcome === result);
    settledAccounts.add(position.userId);
    let balance: BalanceRow | undefined;
    let ledgerEntryId: number | undefined;
    if (after.payoutCoin > 0n) {
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
          availableCoin: sql`${schema.balances.availableCoin} + ${after.payoutCoin}`,
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
          amountCoin: after.payoutCoin,
          balanceAfterCoin: balance.availableCoin,
          refType: 'market',
          refId: marketId,
          memo: `정산 지급: ${market.title}`,
          createdAt: paidAt,
        })
        .returning({ id: schema.ledgerEntries.id });
      if (!entry) throw new Error('Ledger insert failed');
      ledgerEntryId = entry.id;
      paidAccounts.add(position.userId);
      paidCoin += after.payoutCoin;
    }
    // `version` bumps by itself (`$onUpdate` on the column): this UPDATE goes through the
    // ORM, and the returned row carries the new value the `user:position` event needs.
    const [updated] = await tx
      .update(schema.positions)
      .set({
        qty: after.qty,
        costBasisCoin: after.costBasisCoin,
        realizedPnlCoin: after.realizedPnlCoin,
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
    paidCoin,
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
 * written in a transaction of its own — `failed`, `attempts` + 1, `messageOf(err)` cut to
 * SETTLEMENT_STEP_ERROR_MAX (a database error's SQLSTATE and driver message first, so the cut
 * keeps the reason, not just the failed SQL) — on the step that was running, or, when the throw
 * came before any step started (the "no result" and VOID invariants, a lock or connection
 * error), on the first step that is not `done`. That is what lets an operator see why a market
 * stays `settling` (ADR-0093 decision 1 item 14) without the worker's logs; the per-minute scan
 * retries it with no cap.
 *
 * Under the market lock like every writer of market state, and only for a market that is
 * `settling`: an unknown id has nowhere to record; a market still `resolved` started no payout
 * (its resolved → settling is what failed, and the next run tries it again); and a market
 * another run settled since the rollback (the lock was released with it) is done — so is the
 * `status <> 'done'` guard, which also keeps a finished step finished if a row ever disagrees
 * with the market. Best effort: a failure here is logged and swallowed, and the caller rethrows
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
 * resolved → settling (ADR-0093 decision 1 item 1: the payout starts at once, by the worker),
 * in a transaction of its own committed BEFORE the steps run, so the market reads 지급 중 while
 * they do and stays there when one fails (item 14) — a failed step's rollback cannot take the
 * status back with it. Under the market lock with the status read FOR UPDATE after it, like
 * every status writer (`transitionMarket`); `actorId` is null (the worker acted) and the payload
 * says `source: 'job'`, as the close does. The result is not checked here: a `resolved` market
 * with no result or a VOID one still starts its payout, and the step transaction's invariants
 * fail it loudly in `settling`, recorded on the step like any other failure.
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
 * PLAN 5.5 정산): the admin's judgement made the result final and wrote one `pending` row per
 * SETTLEMENT_STEPS step. A `resolved` market first goes to `settling` in a committed
 * transaction of its own (`startSettling`, published at once); then one transaction runs every
 * step that is not `done` yet on the `settling` market and, once all of them are, settles it
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
 * steps again from the start. Two results throw before any step runs, so the job fails loudly
 * instead of settling every holder as a loser: none (the API's judgement writes the result with
 * the status), and VOID — its 50/50 payout (ADR-0093 decision 1 item 9) is not `settle(won)`'s
 * and belongs to #126; the interim judgement takes YES or NO only.
 *
 * Every transition goes through `transitionMarket`, whose event row carries its id to the
 * market row as `statusEventId` (A-M3-19); `actorId` is null: the worker acted. Everything is
 * published after COMMIT — `settling` after its own transaction, then once settled the status
 * to the market's room, then per account its last balance (a holder of both outcomes is
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
      // VOID pays every contract 50/50 (ADR-0093 decision 1 item 9): `settle(won)` pays winners
      // only and would close every holder out as a loser. #126 adds that payout; until then a
      // VOID result must stop here, before anything is paid.
      if (result === 'VOID') {
        throw new Error(`Market ${marketId} is settling a VOID result, which only #126 can pay`);
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
      // once a step added later finishes in a run of its own — the payload then counts this run).
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
        // What a run that leaves the market `settling` publishes is that later step's call.
        return { outcome: 'settling', marketId, pendingSteps } as const;
      }
      // Every step was done before this run (a row written by hand): nothing locked after the
      // step rows, so the clock is read now.
      const now = at ?? (await clockTimestamp(tx));

      const statusEventId = await transitionMarket(tx, {
        marketId,
        from: current.status,
        to: 'settled',
        type: 'finalized',
        actorId: null,
        payload: {
          result,
          settledAccounts: coin.settledAccounts,
          paidAccounts: coin.paidAccounts,
          paidCoin: serializeCoinAmount(coin.paidCoin),
          positions: coin.positions,
        },
        at: now,
        set: { settledAt: now },
      });

      return {
        outcome: 'settled',
        marketId,
        statusEventId,
        settledAt: now,
        positions: coin.positions,
        settledAccounts: coin.settledAccounts,
        paidAccounts: coin.paidAccounts,
        paidCoin: coin.paidCoin,
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
 * judged longest ago first): the API runs the job the moment it judges, so this picks up a
 * market whose job was lost or failed — one still `resolved` (its resolved → settling never
 * committed) as well as one left `settling` by a failed step (ADR-0093 decision 1 item 14).
 * One market at a time and each rejection caught (`runScan`), so a settlement that fails — the
 * "no balance row", "no result" and VOID throws above, a transient DB error — rolls back that
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
