import {
  SETTLEMENT_STEP_ERROR_MAX,
  SETTLEMENT_STEPS,
  notificationEvent,
  serializeCoinAmount,
  type MarketResult,
  type MarketSettlementRetryActionPayload,
  type MarketStatusEvent,
  type SettlementStep,
  type SettlementStepStatus,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { errorMessageOf, sqlStateOf } from './error-message.js';
import { settlementAudience, settlementNotificationInputs } from './judgement-notifications.js';
import type { BalanceRow } from './ledger.js';
import {
  reconcileMarketSettlement,
  settleMarketPositions,
  type MarketSettlementResult,
} from './market-settlement.js';
import { transitionMarket } from './market-transitions.js';
import { createNotifications, notifiedUserIds } from './notifications.js';
import { marketEventKey } from './order-notifications.js';
import { adminActions, marketSettlementSteps, markets } from './schema/index.js';
import { TransactionBusyError } from './transaction-retry.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/*
 * The payout core of a SETTLING market (ADR-0046, ADR-0118; #145, ADR-0163): the step transaction
 * the worker's `finalizeMarket` ran inline until #145, moved here unchanged so the operator's 정산
 * 다시 시도 (145-7 "매 분 자동 재시도와 같은 검사를 하고, 지급액이나 검사를 바꾸지 못한다") runs the
 * SAME function — its checks hold by construction and no request field can reach them. Its
 * production callers are exactly the worker's finalize (apps/worker/src/jobs/market-finalize.ts)
 * and the API's retry service (a static pin in judgement-notifications.test.ts).
 *
 * Concurrency (ADR-0163): both callers run under the market's `pg_advisory_xact_lock` and re-read
 * the status under it, so they serialize — whichever comes second finds `settled` (the worker
 * skips `not_settling`; the operator is refused before anything is recorded). The lock order is
 * the worker's: market lock → market row FOR UPDATE → step rows FOR UPDATE → ledger accounts in
 * `lockLedgerAccounts` order; the API adds only the admin-roles shared lock between the market
 * lock and the core, as the reconciliation run does. No double payout: the status re-check and
 * the coin step's `settled = false` filter are inside the core, and a lost COMMIT acknowledgement
 * of an operator retry is told apart by its `actionId` (`recordSettlementFailure`), never by
 * running again. Failures of both go through one upsert (`attempts + 1` under the lock), so the
 * step's attempts count every attempt, the operator's included (145-6 "시도 횟수").
 */

/** The handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** One closed-out position of this run, with the person's balance and payout row when paid. */
export type SettledPosition = MarketSettlementResult['settlements'][number];

/**
 * What the caller's failure record reads after a rollback: the step whose body was running (an
 * object, so a read after the callback rejects is not narrowed away). `started` is the operator
 * retry's mark that the attempt began (its admin action written, the core entered): a throw
 * before it is no attempt (`settlementRetryErrorKind`). The core touches `running` only.
 */
export interface SettlementProgress {
  running?: SettlementStep;
  started?: boolean;
}

/**
 * What one run of the core hands back. `settled` carries what the caller publishes after COMMIT
 * (`settledMarketEvents`) — the run's fresh settlements and the members its notices reached;
 * neither may reach a stored result or a log line (ADR-0064, ADR-0159 12-12).
 */
export type SettleSettlingMarketResult =
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
      result: MarketResult;
      settlements: SettledPosition[];
      notified: string[];
    }
  /**
   * The run committed its steps but some step of SETTLEMENT_STEPS is still not `done`, so the
   * market stays `settling` (ADR-0093 decision 1 item 14). Unreachable while every step runs in
   * one transaction; the variant is where a step run on its own would land.
   */
  | { outcome: 'settling'; marketId: string; pendingSteps: SettlementStep[] }
  | { outcome: 'skipped'; marketId: string; reason: 'not_settling' };

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
  const steps = marketSettlementSteps;
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
 * settling → settled for one market, in the caller's transaction (ADR-0046, ADR-0093 decision 1
 * items 1 and 14; PLAN 5.5 정산): every step that is not `done` yet runs on the `settling` market
 * and, once all of them are, the market is settled (O-6: settled means every step finished —
 * `coin`, the only one). All rows or nothing with the caller's transaction.
 *
 *  - market advisory lock, then the row FOR UPDATE, then the status re-check under the lock:
 *    only `settling` is settled, so a duplicate job, the scan after the immediate job, an operator
 *    retry after the worker, or a run after a manual fix all find `settled` and skip;
 *  - the step rows FOR UPDATE, then each step not `done` in SETTLEMENT_STEPS order, each
 *    marked `done` in the same transaction (`completeStep`). A missing row counts as pending;
 *  - reconciliation before SETTLED even when every step was already done (ADR-0118 결정 6), so a
 *    completed coin step never bypasses the accounting checks and never pays again;
 *  - settling → settled only when every step is `done` — the one place that condition lives and
 *    the one `to: 'settled'` transition of the code base (a static pin);
 *  - the final settlement's notice last (#188, ADR-0160; 52-1, 52-12, 52-15): the transaction's
 *    one `createNotifications` call, after the `finalized` transition — one `market_settled` per
 *    watcher and per account the payout recorded (`settlementAudience`), keyed by the `finalized`
 *    event. A failure rolls the payout back with it (188-2): no savepoint.
 *
 * `progress.running` names the step whose body runs, for the caller's failure record after a
 * rollback. The `finalized` event's `actorId` is null for both callers: the operator of a retry is
 * the `market_settlement_retry` row of the same transaction (ADR-0163). Throws on an unknown id,
 * a `settling` market without a result, and every check of the payout and the reconciliation.
 */
export async function settleSettlingMarket(
  tx: Tx,
  marketId: string,
  progress: SettlementProgress,
): Promise<SettleSettlingMarketResult> {
  await lockMarket(tx, marketId);
  const [current] = await tx
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
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
      step: marketSettlementSteps.step,
      status: marketSettlementSteps.status,
    })
    .from(marketSettlementSteps)
    .where(eq(marketSettlementSteps.marketId, marketId))
    .for('update');
  const done = new Set(stepRows.filter((row) => row.status === 'done').map((row) => row.step));
  // Publishes only this run's changes; the final counts come from reconciliation below.
  let settlements: SettledPosition[] = [];
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
        settlements = ran.settlements;
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

  // #188 J5 (ADR-0160; 52-1, 52-12, 52-15): the transaction's one notification call, last,
  // after the transition (ADR-0157 결정 4). The audience is the payout's own durable records
  // with the watchers now: `settlements` holds qty-0 rows and is empty on a run whose coin step
  // was done before. `current` was read `settling`; the builder gets what the transition wrote.
  // A failure rolls the payout back with it (188-2): no savepoint. The gate skips a member whose
  // 시장 is off (`category_off`, #56, ADR-0162): `notified` is the accounts something reached,
  // and the payout and its records stand whatever the settings.
  const notified = notifiedUserIds(
    await createNotifications(
      tx,
      settlementNotificationInputs(
        await settlementAudience(tx, marketId),
        { slug: current.slug, title: current.title, status: 'settled' },
        { result, eventKey: marketEventKey(statusEventId), occurredAt: now },
      ),
    ),
  );

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
    settlements,
    notified,
  } as const;
}

/** What a settled run publishes after COMMIT: the market's status, then each member's events. */
export interface SettledMarketEvents {
  status: MarketStatusEvent;
  /** In publish order: the balances, then every closed-out row, then the inbox signals. */
  user: [userId: string, event: UserRealtimeEvent][];
}

/**
 * The realtime events of a settled run (pure), each app publishing them with its own publisher
 * in this order — the status to the market's room, then per person its last balance (a holder of
 * both outcomes is credited once per winning row; the later ledger row is the greater key) and
 * every closed-out row, then `user:notification` at the payout's instant to each member a notice
 * reached (#188, ADR-0160). The 운영 마켓메이커's rows are closed out too, but published nothing:
 * the settlement leaves its rows out of `settlements` (no client of its exists).
 */
export function settledMarketEvents(
  settled: Extract<SettleSettlingMarketResult, { outcome: 'settled' }>,
): SettledMarketEvents {
  const { marketId, settlements, result, settledAt, notified, statusEventId } = settled;
  const ts = settledAt.toISOString();
  const status: MarketStatusEvent = {
    type: 'market:status',
    marketId,
    status: 'settled',
    resolvedResult: result,
    statusEventId: String(statusEventId),
    ts,
  };
  // The last balance seen per account wins: with a payout per winning row the later ledger
  // row is the greater key, and the (user_id, outcome) order makes "later" "last".
  const balances = new Map<string, { balance: BalanceRow; ledgerEntryId: number }>();
  for (const { position, balance, ledgerEntryId } of settlements) {
    if (balance && ledgerEntryId !== undefined) {
      balances.set(position.userId, { balance, ledgerEntryId });
    }
  }
  const user: [string, UserRealtimeEvent][] = [];
  for (const [userId, { balance, ledgerEntryId }] of balances) {
    // Stamped with the account's own payout instant (its `updated_at`), not the market's:
    // another write of this account may sit between the two. The ledger id is what a client
    // orders by (realtime.ts); the instant is for display.
    user.push([
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
    user.push([
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
  // #188 (ADR-0160): one per member the `market_settled` notices reached, at the payout.
  for (const userId of notified) user.push([userId, notificationEvent(settledAt)]);
  return { status, user };
}

// ---- failure record ---------------------------------------------------------------------
/** The operator retry a failure record also writes (145-7): who, why, and the request's row id. */
export interface SettlementRetryRecord {
  adminId: string;
  reason: string;
  /**
   * The id of the request's `market_settlement_retry` row, drawn once per request: the settled
   * branch inserts it with the payout, the failure record `ON CONFLICT (id) DO NOTHING`.
   */
  actionId: string;
}

/** The step as the failure record left it. */
export interface RecordedSettlementStep {
  status: SettlementStepStatus;
  attempts: number;
  lastError: string | null;
}

/**
 * What a failure record did: `failed` with the step it wrote (null when the market was no longer
 * `settling` — nothing to record on, or another run settled it in between); or, for an operator
 * retry only, `settled` — the request's own settled row was there already, so the payout's COMMIT
 * landed and only its acknowledgement was lost (Q-C), with the market's status event.
 */
export type SettlementFailureRecord =
  | { outcome: 'failed'; step: RecordedSettlementStep | null }
  | { outcome: 'settled'; statusEventId: number | null };

/**
 * The failure half of ADR-0046 (D6): the settlement transaction rolled back, so the attempt is
 * written in a transaction of its own — `failed`, `attempts` + 1, `errorMessageOf(err)` cut to
 * SETTLEMENT_STEP_ERROR_MAX (a database error's SQLSTATE and driver message first, so the cut
 * keeps the reason, not just the failed SQL) — on the step that was running, or, when the throw
 * came before any step started (a missing result, lock or connection error), on the first
 * unfinished step. A failed final reconciliation is recorded on `coin` even when it is done. That
 * is what lets an operator see why a market stays `settling` (ADR-0093 decision 1 item 14); the
 * per-minute scan retries it with no cap.
 *
 * Under the market lock like every writer of market state, and only for a market that is
 * `settling`: an unknown id has nowhere to record; a market still `resolved` started no payout;
 * and a market another run settled since the rollback (the lock was released with it) is done. A
 * completed step keeps its status and completion instant when reconciliation fails: its payout
 * must never be repeated; only the error and attempt count change (ADR-0118 결정 8).
 *
 * With `retry` (the operator's 정산 다시 시도, #145, ADR-0163): one `at` for both rows, and first
 * `market_settlement_retry` `{reason, outcome: 'failed', error}` keyed by the request's
 * `actionId` `ON CONFLICT (id) DO NOTHING` — no row back means the settled row of the same request
 * committed (a lost COMMIT acknowledgement): nothing more is written and the answer is `settled`.
 * Otherwise the step as the worker's, so the operator's attempt counts in `attempts` (145-6); on a
 * market no longer `settling` the admin action alone records the attempt.
 *
 * Throws when it cannot record: the worker logs and swallows that and rethrows the ORIGINAL
 * error; the API answers 500 with nothing of the attempt recorded (one transaction).
 */
export async function recordSettlementFailure(
  db: Db,
  marketId: string,
  running: SettlementStep | undefined,
  err: unknown,
  retry?: SettlementRetryRecord,
): Promise<SettlementFailureRecord> {
  const steps = marketSettlementSteps;
  return db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    let at: Date | undefined;
    if (retry !== undefined) {
      at = await clockTimestamp(tx);
      const payload: MarketSettlementRetryActionPayload = {
        reason: retry.reason,
        outcome: 'failed',
        error: errorMessageOf(err).slice(0, SETTLEMENT_STEP_ERROR_MAX),
      };
      const inserted = await tx
        .insert(adminActions)
        .values({
          id: retry.actionId,
          adminId: retry.adminId,
          type: 'market_settlement_retry',
          targetType: 'market',
          targetId: marketId,
          payload,
          createdAt: at,
        })
        .onConflictDoNothing({ target: adminActions.id })
        .returning({ id: adminActions.id });
      if (inserted.length === 0) {
        const [market] = await tx
          .select({ statusEventId: markets.statusEventId })
          .from(markets)
          .where(eq(markets.id, marketId))
          .limit(1);
        return { outcome: 'settled', statusEventId: market?.statusEventId ?? null } as const;
      }
    }
    // A plain read: every status writer holds the advisory lock taken above.
    const [market] = await tx
      .select({ status: markets.status })
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);
    if (market?.status !== 'settling') return { outcome: 'failed', step: null } as const;
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
    at ??= await clockTimestamp(tx);
    const lastError = errorMessageOf(err).slice(0, SETTLEMENT_STEP_ERROR_MAX);
    const [written] = await tx
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
      })
      .returning({ status: steps.status, attempts: steps.attempts, lastError: steps.lastError });
    return {
      outcome: 'failed',
      step: written
        ? {
            status: written.status as SettlementStepStatus,
            attempts: written.attempts,
            lastError: written.lastError,
          }
        : null,
    } as const;
  });
}

// ---- the operator retry (145-7, 145-14) ----------------------------------------------------
/** The operator's attempt: the market and who asked why, under the request's `actionId`. */
export interface SettlementRetryInput extends SettlementRetryRecord {
  marketId: string;
}

/**
 * What the retry's transaction body did: `not_settling` — refused, nothing written (a refused
 * click is no attempt; the caller throws so the transaction rolls back); or `settled` with the
 * core's run, the request's settled row in the same transaction.
 */
export type SettlementRetryAttempt =
  | { outcome: 'not_settling' }
  | { outcome: 'settled'; settled: Extract<SettleSettlingMarketResult, { outcome: 'settled' }> };

/**
 * The operator's 정산 다시 시도 inside the caller's transaction (#145, ADR-0163; 145-7, 145-14):
 * the caller has taken the market lock, found the market and re-checked the admin role under the
 * admin-roles lock; this re-checks the status under the lock — `settling` only (145-14), else
 * `not_settling` with nothing written — then, in this order, writes the request's
 * `market_settlement_retry` `{reason, outcome: 'settled'}` at the database clock, marks
 * `progress.started` and runs `settleSettlingMarket`, the worker's own core (145-7 "같은 검사").
 * The row goes BEFORE the core so the core's `createNotifications` stays the transaction's last
 * call, as in every API producer (Q-A); it commits only with the payout — a core result other
 * than `settled` throws here, rolling both back. An unknown market reads `not_settling`.
 */
export async function retrySettlingMarket(
  tx: Tx,
  input: SettlementRetryInput,
  progress: SettlementProgress,
): Promise<SettlementRetryAttempt> {
  await lockMarket(tx, input.marketId);
  // A plain read: every status writer holds the advisory lock taken above.
  const [market] = await tx
    .select({ status: markets.status })
    .from(markets)
    .where(eq(markets.id, input.marketId))
    .limit(1);
  if (market?.status !== 'settling') return { outcome: 'not_settling' };
  const at = await clockTimestamp(tx);
  const payload: MarketSettlementRetryActionPayload = { reason: input.reason, outcome: 'settled' };
  await tx.insert(adminActions).values({
    id: input.actionId,
    adminId: input.adminId,
    type: 'market_settlement_retry',
    targetType: 'market',
    targetId: input.marketId,
    payload,
    createdAt: at,
  });
  progress.started = true;
  const settled = await settleSettlingMarket(tx, input.marketId, progress);
  if (settled.outcome !== 'settled') {
    // `skipped` cannot follow the check above under the same lock; `settling` is unreachable
    // while SETTLEMENT_STEPS is ['coin']. Either way the settled row must not commit.
    throw new Error(`Market ${input.marketId} settlement retry ended ${settled.outcome}`);
  }
  return { outcome: 'settled', settled };
}

/**
 * SQLSTATEs of a wait that gave up or a busy resource: a statement timeout (57014 — the 30 s
 * `statement_timeout` while the worker's run holds the market lock), a lock not available (55P03),
 * a deadlock (40P01); and every connection exception (class 08) and shutdown (57P01–57P03).
 */
const BUSY_SQLSTATES = new Set(['57014', '55P03', '40P01', '57P01', '57P02', '57P03']);

/** Node's codes of a socket that failed under the pool's connection. */
const CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

/**
 * The driver's own code-less errors of a wait that gave up or a lost connection: node-postgres's
 * client-side `query_timeout` ('Query read timeout' — createDb gives it the same 30 s as the
 * server's `statement_timeout`, and its timer starts first, so a wait on the market lock while the
 * worker's run holds it ends with this, not 57014), pg-pool's checkout timeout, and a socket the
 * server closed.
 */
const BUSY_DRIVER_MESSAGES = [
  /^Query read timeout$/,
  /^timeout exceeded when trying to connect$/,
  /^Connection terminated/,
];

function isConnectionFailure(err: unknown): boolean {
  let link = err;
  for (let depth = 0; depth < 4 && typeof link === 'object' && link !== null; depth += 1) {
    const { code, message } = link as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
    if (typeof message === 'string' && BUSY_DRIVER_MESSAGES.some((re) => re.test(message))) {
      return true;
    }
    link = 'cause' in link ? link.cause : undefined;
  }
  return false;
}

/**
 * How the API answers a throw of the retry (Q-B, ADR-0163):
 * - `attempted`: `progress.started` — the attempt ran and rolled back; record it
 *   (`recordSettlementFailure` with the retry) and answer its outcome;
 * - `busy`: before the attempt, a lock wait or statement timeout (the server's 57014 or the
 *   client's read timeout), a busy resource, a pool checkout timeout or a lost connection —
 *   TRANSACTION_BUSY, nothing recorded (the run that held the lock records its own);
 * - `other`: before the attempt, anything else — the caller rethrows (an AppError answers as
 *   itself, the rest 500), nothing recorded.
 */
export function settlementRetryErrorKind(
  err: unknown,
  progress: SettlementProgress,
): 'attempted' | 'busy' | 'other' {
  if (progress.started === true) return 'attempted';
  if (err instanceof TransactionBusyError) return 'busy';
  const state = sqlStateOf(err);
  if (state !== undefined && (BUSY_SQLSTATES.has(state) || state.startsWith('08'))) return 'busy';
  return isConnectionFailure(err) ? 'busy' : 'other';
}
