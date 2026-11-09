import {
  CONTRACT_TERMS,
  LIVE_ORDER_STATUSES,
  settlePosition,
  settlementPayoutPerContract,
  type MarketResult,
} from '@buddha/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  findLedgerAccount,
  holderLedgerAccount,
  ledgerKeys,
  lockLedgerAccounts,
  recordLedgerEntry,
  type BalanceRow,
  type LedgerAccountRef,
} from './ledger.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { confirmationHold } from './market-dispute.js';
import {
  balances,
  ledgerEntries,
  marketJudgements,
  markets,
  orders,
  positions,
  positionSettlements,
  profiles,
} from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MarketRow = typeof markets.$inferSelect;
type PositionRow = typeof positions.$inferSelect;
type RecordRow = typeof positionSettlements.$inferSelect;

export interface MarketSettlementSummary {
  at: Date;
  /** All position rows closed, including rows already at zero before settlement. */
  positions: number;
  settledAccounts: number;
  paidAccounts: number;
  paidCoin: bigint;
}

export interface MarketSettlementResult extends MarketSettlementSummary {
  /** Only the person rows changed by this invocation; publish after the outer COMMIT. */
  settlements: {
    position: PositionRow;
    balance?: BalanceRow;
    ledgerEntryId?: number;
  }[];
}

function failed(marketId: string, reason: string): never {
  throw new Error(`Market ${marketId} settlement: ${reason}`);
}

const positionKey = (row: Pick<PositionRow, 'userId' | 'outcome'>): string =>
  JSON.stringify([row.userId, row.outcome]);

/** Re-read every authority under the market lock, including pre-version markets (NULL). */
async function settlementMarket(tx: Tx, marketId: string) {
  await lockMarket(tx, marketId);
  const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
  if (!market) failed(marketId, 'market not found');
  if (market.status !== 'settling') failed(marketId, 'market is not settling');
  if (market.resolvedResult === null) failed(marketId, 'result is missing');
  let ruleVersion = market.ruleVersion;
  if (market.judgementVersion !== null) {
    const [judgement] = await tx
      .select()
      .from(marketJudgements)
      .where(
        and(
          eq(marketJudgements.marketId, marketId),
          eq(marketJudgements.version, market.judgementVersion),
        ),
      );
    if (!judgement || judgement.result !== market.resolvedResult) {
      failed(marketId, 'approved judgement does not match the final result');
    }
    ruleVersion = judgement.ruleVersion;
    if (ruleVersion !== market.ruleVersion) {
      failed(marketId, 'approved judgement does not match the final rules');
    }
  }
  if (await confirmationHold(tx, market)) failed(marketId, 'judgement review is still held');
  if ((await ledgerHeldMarketIds(tx, [marketId])).has(marketId)) {
    failed(marketId, 'ledger recovery approval is pending');
  }
  const [live] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.marketId, marketId), inArray(orders.status, [...LIVE_ORDER_STATUSES])))
    .limit(1);
  if (live) failed(marketId, 'live orders remain');
  return { market, ruleVersion, result: market.resolvedResult };
}

async function rowsOf(tx: Tx, marketId: string) {
  const holdings = await tx
    .select()
    .from(positions)
    .where(eq(positions.marketId, marketId))
    .orderBy(asc(positions.userId), asc(positions.outcome))
    .for('update');
  const records = await tx
    .select()
    .from(positionSettlements)
    .where(eq(positionSettlements.marketId, marketId));
  return { holdings, records };
}

/**
 * Reconcile the preserved claims, live holdings and every payout, before and after the writes.
 * Pair collateral comes from the immutable mint/burn ledger, so deleting both sides of a holding
 * cannot make an empty set of records pass. No aggregate of account-wide order locks is used:
 * a person's other markets may still hold Coin while this market pays them.
 */
async function checkBooks(
  tx: Tx,
  market: MarketRow,
  result: MarketResult,
  ruleVersion: number | null,
  holdings: PositionRow[],
  records: RecordRow[],
  requireRetired: boolean,
): Promise<void> {
  const marketId = market.id;
  const byPosition = new Map(holdings.map((row) => [positionKey(row), row]));
  const recorded = new Map(records.map((row) => [positionKey(row), row]));
  const collateral = await findLedgerAccount(tx, { kind: 'market_collateral', marketId });
  const [balance] = collateral
    ? await tx.select().from(balances).where(eq(balances.accountId, collateral.id))
    : [];
  const funds = await findLedgerAccount(tx, { kind: 'market_maker_funds', marketId });
  if (funds) {
    const [fundsBalance] = await tx.select().from(balances).where(eq(balances.accountId, funds.id));
    if (!fundsBalance) failed(marketId, 'market maker funds balance is missing');
    if (fundsBalance.lockedCoin !== 0n) failed(marketId, 'market maker Coin locks remain');
  }
  const entries = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.marketId, marketId),
        inArray(ledgerEntries.type, [
          'PAIR_MINT_COLLATERAL',
          'PAIR_BURN_RETURN',
          'SETTLEMENT_PAYOUT',
        ]),
      ),
    );
  const payouts = entries.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT');
  const payoutById = new Map(payouts.map((entry) => [entry.id, entry]));
  const principal = entries.reduce(
    (sum, entry) =>
      sum +
      (entry.type === 'PAIR_MINT_COLLATERAL'
        ? entry.amountCoin
        : entry.type === 'PAIR_BURN_RETURN'
          ? -entry.amountCoin
          : 0n),
    0n,
  );
  let yes = 0n;
  let no = 0n;
  let owed = 0n;
  let paid = 0n;
  const countClaim = (outcome: 'YES' | 'NO', qty: number) => {
    if (outcome === 'YES') yes += BigInt(qty);
    else no += BigInt(qty);
  };
  for (const row of holdings) {
    if (row.lockedQty !== 0) failed(marketId, 'contract locks remain');
    if (row.settled) {
      if (row.qty !== 0 || row.costBasisCoin !== 0n)
        failed(marketId, 'retired holding is not empty');
    } else {
      if (requireRetired) failed(marketId, 'unsettled positions remain');
      if (recorded.has(positionKey(row))) failed(marketId, 'recorded holding is not retired');
      const after = settlePosition(row, result, row.outcome);
      countClaim(row.outcome, row.qty);
      owed += after.payoutCoin;
    }
  }
  for (const record of records) {
    const row = byPosition.get(positionKey(record));
    if (!row?.settled || row.qty !== 0 || row.costBasisCoin !== 0n || row.lockedQty !== 0) {
      failed(marketId, 'settlement record has no retired position');
    }
    const unit = settlementPayoutPerContract(result, record.outcome);
    if (
      record.judgementVersion !== market.judgementVersion ||
      record.ruleVersion !== ruleVersion ||
      record.result !== result ||
      record.qty <= 0 ||
      record.costBasisCoin < 0n ||
      record.payoutPerContractCoin !== unit ||
      record.payoutCoin !== BigInt(record.qty) * BigInt(unit) ||
      record.settlementPnlCoin !== record.payoutCoin - record.costBasisCoin ||
      row.realizedPnlCoin !== record.realizedPnlBeforeCoin + record.settlementPnlCoin
    ) {
      failed(marketId, 'settlement record does not match its position or judgement');
    }
    countClaim(record.outcome, record.qty);
    paid += record.payoutCoin;
    if (record.payoutCoin === 0n) {
      if (record.ledgerEntryId !== null) failed(marketId, 'zero payout has a ledger entry');
      continue;
    }
    const entry = record.ledgerEntryId === null ? undefined : payoutById.get(record.ledgerEntryId);
    const recipient = await findLedgerAccount(
      tx,
      await holderLedgerAccount(tx, record.userId, marketId),
    );
    if (
      !entry ||
      entry.amountCoin !== record.payoutCoin ||
      entry.fromAccountId !== collateral?.id ||
      entry.toAccountId !== recipient?.id ||
      entry.refType !== 'market' ||
      entry.refId !== marketId ||
      entry.createdAt.getTime() !== record.settledAt.getTime() ||
      entry.idempotencyKey !==
        ledgerKeys.settlement(marketId, record.judgementVersion, record.userId, record.outcome)
    ) {
      failed(marketId, 'payout ledger does not match its settlement record');
    }
    payoutById.delete(entry.id);
  }
  if (payoutById.size > 0) failed(marketId, 'payout ledger has no settlement record');
  if (yes !== no || principal !== yes * BigInt(CONTRACT_TERMS.payoutCoin)) {
    failed(marketId, 'contract supply does not match pair collateral');
  }
  if (owed + paid !== principal) failed(marketId, 'payout claims do not exhaust pair collateral');
  if (balance === undefined && collateral !== null)
    failed(marketId, 'collateral balance is missing');
  if (
    (balance?.lockedCoin ?? 0n) !== 0n ||
    (balance?.availableCoin ?? 0n) !== owed ||
    (balance?.ledgerCoin ?? 0n) !== owed
  ) {
    failed(marketId, `collateral does not match the remaining ${String(owed)} Coin payout`);
  }
  if (collateral) {
    // The balance's ledgerCoin is only a copy. A done-step retry writes no ledger or balance
    // row, so its deferred guards cannot detect a copy changed outside the normal writers.
    // The immutable chain includes corrections and every other type, not just pair/payout rows.
    const actual = await tx.execute<{ coin: string }>(
      sql`SELECT public.ledger_account_last_after(${collateral.id})::text AS coin`,
    );
    if (BigInt(actual.rows[0]!.coin) !== owed) {
      failed(marketId, 'collateral ledger does not match the remaining payout');
    }
  }
}

function summary(holdings: PositionRow[], records: RecordRow[], at: Date): MarketSettlementSummary {
  return {
    at,
    positions: holdings.length,
    settledAccounts: new Set(holdings.map((row) => row.userId)).size,
    paidAccounts: new Set(records.filter((row) => row.payoutCoin > 0n).map((row) => row.userId))
      .size,
    paidCoin: records.reduce((sum, row) => sum + row.payoutCoin, 0n),
  };
}

/**
 * Final SETTLED gate, even when the coin step was already done. Throws on any mismatch; the worker
 * records the failure outside the rolled-back transaction. It neither pays nor repairs a row.
 */
export async function reconcileMarketSettlement(
  tx: Tx,
  marketId: string,
): Promise<MarketSettlementSummary> {
  const { market, result, ruleVersion } = await settlementMarket(tx, marketId);
  const { holdings, records } = await rowsOf(tx, marketId);
  // A done-step retry did not run the payout's account-locking phase. Hold both existing market
  // accounts through SETTLED, including funds with no remaining contracts or no winning payout.
  const marketAccounts: LedgerAccountRef[] = [];
  for (const kind of ['market_collateral', 'market_maker_funds'] as const) {
    const ref = { kind, marketId };
    if (await findLedgerAccount(tx, ref)) marketAccounts.push(ref);
  }
  await lockLedgerAccounts(tx, marketAccounts);
  await checkBooks(tx, market, result, ruleVersion, holdings, records, true);
  return summary(holdings, records, await clockTimestamp(tx));
}

/**
 * All remaining claims of one market, atomically: payout, permanent record and contract retirement.
 * Caller owns the transaction and commits its step only after this returns. A failure rolls all
 * these changes back; completed records are never updated. No state transition or publish here.
 */
export async function settleMarketPositions(
  tx: Tx,
  marketId: string,
): Promise<MarketSettlementResult> {
  const { market, result, ruleVersion } = await settlementMarket(tx, marketId);
  const { holdings, records } = await rowsOf(tx, marketId);
  const pending = holdings.filter((row) => !row.settled);
  const recipients = new Map<string, LedgerAccountRef>();
  for (const row of pending) {
    if (row.qty > 0)
      recipients.set(row.userId, await holderLedgerAccount(tx, row.userId, marketId));
  }
  // Check closed people even when their contracts lose and therefore write no ledger entry.
  const people = [...recipients].filter(([, ref]) => ref.kind === 'user').map(([id]) => id);
  if (people.length > 0) {
    const closed = await tx
      .select({ id: profiles.userId, closedAt: profiles.closedAt })
      .from(profiles)
      .where(inArray(profiles.userId, people));
    if (closed.length !== people.length || closed.some((row) => row.closedAt !== null)) {
      failed(marketId, 'a closed account still holds contracts');
    }
  }
  const collateral: LedgerAccountRef = { kind: 'market_collateral', marketId };
  const collateralExists = await findLedgerAccount(tx, collateral);
  const funds: LedgerAccountRef = { kind: 'market_maker_funds', marketId };
  const fundsExist = await findLedgerAccount(tx, funds);
  const paying = pending.filter((row) => settlePosition(row, result, row.outcome).payoutCoin > 0n);
  // Every Coin account before the first payment, in the shared ascending-id lock order.
  await lockLedgerAccounts(tx, [
    ...(collateralExists || paying.length > 0 ? [collateral] : []),
    ...(fundsExist ? [funds] : []),
    ...new Map(paying.map((row) => [row.userId, recipients.get(row.userId)!])).values(),
  ]);
  await checkBooks(tx, market, result, ruleVersion, holdings, records, false);
  const at = await clockTimestamp(tx);
  const settlements: MarketSettlementResult['settlements'] = [];
  for (const row of pending) {
    const after = settlePosition(row, result, row.outcome);
    let balance: BalanceRow | undefined;
    let ledgerEntryId: number | undefined;
    if (after.payoutCoin > 0n) {
      const paid = await recordLedgerEntry(tx, {
        type: 'SETTLEMENT_PAYOUT',
        from: collateral,
        to: recipients.get(row.userId)!,
        amountCoin: after.payoutCoin,
        refType: 'market',
        refId: marketId,
        idempotencyKey: ledgerKeys.settlement(
          marketId,
          market.judgementVersion,
          row.userId,
          row.outcome,
        ),
        memo: `정산 지급: ${market.title}`,
        at,
      });
      if (paid.outcome !== 'recorded') failed(marketId, 'unrecorded holding already has a payout');
      balance = paid.to!;
      ledgerEntryId = paid.entry.id;
    }
    if (row.qty > 0) {
      await tx.insert(positionSettlements).values({
        marketId,
        userId: row.userId,
        outcome: row.outcome,
        judgementVersion: market.judgementVersion,
        ruleVersion,
        result,
        qty: row.qty,
        costBasisCoin: row.costBasisCoin,
        realizedPnlBeforeCoin: row.realizedPnlCoin,
        payoutPerContractCoin: after.payoutPerContractCoin,
        payoutCoin: after.payoutCoin,
        settlementPnlCoin: after.settlementPnlCoin,
        ledgerEntryId: ledgerEntryId ?? null,
        settledAt: at,
      });
    }
    const [updated] = await tx
      .update(positions)
      .set({
        qty: 0,
        costBasisCoin: 0n,
        realizedPnlCoin: after.realizedPnlCoin,
        settled: true,
        updatedAt: at,
      })
      .where(
        and(
          eq(positions.marketId, marketId),
          eq(positions.userId, row.userId),
          eq(positions.outcome, row.outcome),
        ),
      )
      .returning();
    if (!updated) failed(marketId, 'position disappeared during retirement');
    const recipient =
      recipients.get(row.userId) ?? (await holderLedgerAccount(tx, row.userId, marketId));
    if (recipient.kind === 'user') settlements.push({ position: updated, balance, ledgerEntryId });
  }
  const checked = await reconcileMarketSettlement(tx, marketId);
  return { ...checked, at, settlements };
}
