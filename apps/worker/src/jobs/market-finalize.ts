import { clockTimestamp, lockMarket, schema, type Db } from '@buddha/db';
import {
  MARKET_SCAN_BATCH_MAX,
  marketChannel,
  serializePAmount,
  settle,
  userChannel,
  type MarketStatusEvent,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { type Publish } from '../realtime.js';
import { runScan, type ScanFailure } from './scan.js';

type PositionRow = typeof schema.positions.$inferSelect;
type BalanceRow = typeof schema.balances.$inferSelect;

export type FinalizeSkipReason = 'not_resolving' | 'not_due';

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
  | { outcome: 'skipped'; marketId: string; reason: FinalizeSkipReason };

export interface FinalizeScanResult {
  settled: number;
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

/**
 * resolving → settled for one market (PLAN 5.5 확정): every unsettled position is closed out
 * with the shared `settle()` accounting (PLAN 5.4 — the winning outcome is paid qty × 100P,
 * both outcomes end at qty 0, cost 0, `settled`), each payout is one SETTLEMENT_PAYOUT ledger
 * row written with its balance change, and the market becomes `settled`. One transaction, all
 * rows or nothing: PLAN 5.5 allows committing per hundred accounts, but at MVP scale a single
 * transaction is the simpler invariant, and the void path (market-admin.service.ts `void`)
 * already settled on it — this function mirrors that path statement for statement so the two
 * close-outs cannot drift:
 *
 *  - market advisory lock, then the row FOR UPDATE, then the status re-check (PLAN 5.5:
 *    `status='resolving' AND dispute_until <= now()` under the lock — a `result_changed` that
 *    committed while this job queued moved `dispute_until` forward, and this run must see it
 *    and skip rather than pay out the previous result);
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
 * Idempotent (PLAN 5.5, M5 AC 3): the `settled = false` filter means a row is paid at most
 * once, and a second run finds `status = 'settled'` and skips before touching a position; a
 * crash mid-way rolls everything back and the next run (the delayed job's retry, or the
 * per-minute scan) does it all again from the start. A `resolving` market with no result is an
 * invariant the API guarantees (`resolve` writes both columns in one UPDATE); it throws so the
 * job fails loudly instead of settling every holder as a loser.
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
): Promise<FinalizeResult> {
  const finalized = await db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const [current] = await tx
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId))
      .limit(1)
      .for('update');
    if (!current) throw new Error(`Market ${marketId} not found`);
    if (current.status !== 'resolving') {
      return { outcome: 'skipped', marketId, reason: 'not_resolving' } as const;
    }
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
    if (current.disputeUntil === null || current.disputeUntil > now) {
      return { outcome: 'skipped', marketId, reason: 'not_due' } as const;
    }
    const result = current.resolvedResult;
    if (result === null) {
      throw new Error(`Market ${marketId} is resolving without a result`);
    }

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
        // else understands, and the failed job is visible in the BullMQ failed set.
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
            memo: `정산 지급: ${current.title}`,
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

    const [event] = await tx
      .insert(schema.marketEvents)
      .values({
        marketId,
        type: 'finalized',
        actorId: null,
        payload: {
          result,
          settledAccounts: settledAccounts.size,
          paidAccounts: paidAccounts.size,
          paidP: serializePAmount(paidP),
          positions: holders.length,
        },
        createdAt: now,
      })
      .returning({ id: schema.marketEvents.id });
    if (!event) throw new Error('Market event insert failed');
    const [row] = await tx
      .update(schema.markets)
      .set({ status: 'settled', settledAt: now, statusEventId: event.id, updatedAt: now })
      .where(eq(schema.markets.id, marketId))
      .returning({ disputeUntil: schema.markets.disputeUntil });
    if (!row) throw new Error('Market update failed');

    return {
      outcome: 'settled',
      marketId,
      statusEventId: event.id,
      settledAt: now,
      positions: holders.length,
      settledAccounts: settledAccounts.size,
      paidAccounts: paidAccounts.size,
      paidP,
      result,
      disputeUntil: row.disputeUntil,
      settlements,
    } as const;
  });

  if (finalized.outcome === 'skipped') return finalized;

  const { settlements, result, disputeUntil, settledAt, ...summary } = finalized;
  const ts = settledAt.toISOString();
  const status: MarketStatusEvent = {
    type: 'market:status',
    marketId,
    status: 'settled',
    resolvedResult: result,
    disputeUntil: disputeUntil?.toISOString() ?? null,
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
  // command timeout, not one per holder.
  await Promise.all([
    publish(marketChannel(marketId), status),
    ...events.map(([userId, event]) => publish(userChannel(userId), event)),
  ]);
  return { ...summary, settledAt };
}

/**
 * The per-minute safety net for settlement (PLAN 5.5: `status='resolving' AND
 * dispute_until <= now()`): one transaction per market and each rejection caught (`runScan`),
 * so a settlement that fails — the "no balance row" and "no result" throws above, a transient
 * DB error — rolls back that market alone and the markets due after it are still settled
 * this run. Without the catch the failing market, first by deadline, would stop every later
 * scan at itself. See `closeDueMarkets` for the batch bound and the re-check.
 */
export async function finalizeDueMarkets(db: Db, publish: Publish): Promise<FinalizeScanResult> {
  const due = await db
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(
      and(eq(schema.markets.status, 'resolving'), lte(schema.markets.disputeUntil, sql`now()`)),
    )
    .orderBy(asc(schema.markets.disputeUntil), asc(schema.markets.id))
    .limit(MARKET_SCAN_BATCH_MAX);

  const { results, failed, failures } = await runScan(
    due.map(({ id }) => id),
    (id) => finalizeMarket(db, id, publish),
  );
  const settled = results.filter((result) => result.outcome === 'settled').length;
  return { settled, skipped: results.length - settled, failed, failures };
}
