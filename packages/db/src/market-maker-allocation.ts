import { and, eq, or, sql } from 'drizzle-orm';
import { marketMakerAccountId } from './account-types.js';
import type { Db } from './client.js';
import { findLedgerAccount, ledgerKeys, lockLedgerAccounts, recordLedgerEntry } from './ledger.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { readMarketMakerConfig } from './market-liquidity.js';
import {
  approvalRequests,
  balances,
  ledgerEntries,
  marketEvents,
  marketMakerAllocations,
  marketMakerRuntime,
  markets,
  positions,
} from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type InitialMarketMakerAllocationReason =
  | 'not_scheduled'
  | 'not_due'
  | 'close_passed'
  | 'ledger_hold'
  | 'liquidity_missing'
  | 'approval_missing'
  | 'treasury_missing'
  | 'treasury_insufficient'
  | 'treasury_inconsistent'
  | 'funds_inconsistent'
  | 'missing_market_maker';
export type MarketMakerAllocationRow = typeof marketMakerAllocations.$inferSelect;
export type InitialMarketMakerAllocationResult =
  | {
      outcome: 'allocated' | 'duplicate';
      allocation: MarketMakerAllocationRow;
      at: Date;
      requiredCoin: bigint;
      availableCoin: bigint;
    }
  | {
      outcome: 'unavailable';
      reason: InitialMarketMakerAllocationReason;
      requiredCoin: bigint | null;
      availableCoin: bigint | null;
    };

/** Called only by the common scheduled-open path, in the transaction that also opens it.
 * Locks the market before money. Failed funding never creates funds or invents a treasury mint.
 * Initial only: future #130 increases must have separate approval-bound records, not reuse this.
 */
export async function allocateMarketMakerInitial(
  tx: Tx,
  input: { marketId: string; liquidityVersion: number },
): Promise<InitialMarketMakerAllocationResult> {
  await lockMarket(tx, input.marketId);
  const [market] = await tx
    .select()
    .from(markets)
    .where(eq(markets.id, input.marketId))
    .for('update');
  const [prior] = await tx
    .select()
    .from(marketMakerAllocations)
    .where(eq(marketMakerAllocations.marketId, input.marketId));
  if (prior) {
    const [entry] = await tx
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, prior.ledgerEntryId));
    if (!entry || entry.fromBalanceAfterCoin === null)
      throw new Error('Initial allocation ledger disappeared');
    return {
      outcome: 'duplicate',
      allocation: prior,
      at: prior.createdAt,
      requiredCoin: prior.amountCoin,
      availableCoin: entry.fromBalanceAfterCoin + prior.amountCoin,
    };
  }
  let requiredCoin: bigint | null = null;
  let availableCoin: bigint | null = null;
  const unavailable = (
    reason: InitialMarketMakerAllocationReason,
  ): InitialMarketMakerAllocationResult => ({
    outcome: 'unavailable',
    reason,
    requiredCoin,
    availableCoin,
  });
  if (!market || market.status !== 'scheduled') return unavailable('not_scheduled');
  if ((await ledgerHeldMarketIds(tx, [market.id])).has(market.id))
    return unavailable('ledger_hold');
  const config = await readMarketMakerConfig(tx, market.id);
  if (!config || config.version !== input.liquidityVersion) return unavailable('liquidity_missing');
  requiredCoin = config.budgetCoin;
  const [event] =
    market.statusEventId === null
      ? []
      : await tx.select().from(marketEvents).where(eq(marketEvents.id, market.statusEventId));
  const approvalId = event?.payload?.['approvalId'];
  if (
    !event ||
    event.marketId !== market.id ||
    event.type !== 'approved' ||
    event.fromStatus !== 'review' ||
    event.toStatus !== 'scheduled' ||
    typeof approvalId !== 'string'
  )
    return unavailable('approval_missing');
  const [approval] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId));
  if (
    !approval ||
    approval.kind !== 'market_review' ||
    approval.status !== 'approved' ||
    approval.targetType !== 'market' ||
    approval.targetId !== market.id ||
    !approval.decidedBy ||
    !approval.decidedAt ||
    approval.decidedBy === approval.requestedBy ||
    config.createdAt.getTime() > approval.decidedAt.getTime()
  )
    return unavailable('approval_missing');
  // REVIEW/SCHEDULED config immutability (0067) binds the currently approved version even for
  // older approval payloads containing only title. An explicit newer pin must agree as well.
  if (
    approval.payload?.['liquidityVersion'] !== undefined &&
    approval.payload['liquidityVersion'] !== config.version
  )
    return unavailable('approval_missing');
  const owner = await marketMakerAccountId(tx);
  if (!owner) return unavailable('missing_market_maker');
  const treasury = await findLedgerAccount(tx, { kind: 'treasury' });
  if (!treasury) return unavailable('treasury_missing');
  const funds = await findLedgerAccount(tx, { kind: 'market_maker_funds', marketId: market.id });
  if (funds && funds.ownerId !== owner) return unavailable('funds_inconsistent');
  for (const account of [treasury, ...(funds ? [funds] : [])]) {
    const [existing] = await tx
      .select({ id: balances.accountId })
      .from(balances)
      .where(eq(balances.accountId, account.id));
    if (!existing)
      return unavailable(
        account.id === treasury.id ? 'treasury_inconsistent' : 'funds_inconsistent',
      );
  }
  await lockLedgerAccounts(tx, [
    { kind: 'treasury' },
    ...(funds ? [{ kind: 'market_maker_funds' as const, marketId: market.id }] : []),
  ]);
  const at = await clockTimestamp(tx);
  if (!market.scheduledOpenAt || market.scheduledOpenAt.getTime() > at.getTime())
    return unavailable('not_due');
  if (market.closeAt.getTime() <= at.getTime()) return unavailable('close_passed');
  const [balance] = await tx.select().from(balances).where(eq(balances.accountId, treasury.id));
  if (!balance) return unavailable('treasury_inconsistent');
  availableCoin = balance.availableCoin;
  const { rows } = await tx.execute<{ actual: string; sum: string }>(
    sql`SELECT public.ledger_account_last_after(${treasury.id})::text AS actual,
      (SELECT coalesce(sum(CASE WHEN to_account_id=${treasury.id} THEN amount_coin ELSE -amount_coin END),0)::text
       FROM ledger_entries WHERE from_account_id=${treasury.id} OR to_account_id=${treasury.id}) AS sum`,
  );
  if (
    balance.lockedCoin !== 0n ||
    balance.availableCoin !== balance.ledgerCoin ||
    balance.ledgerCoin !== BigInt(rows[0]!.actual) ||
    balance.ledgerCoin !== BigInt(rows[0]!.sum)
  )
    return unavailable('treasury_inconsistent');
  if (balance.availableCoin < config.budgetCoin) return unavailable('treasury_insufficient');
  if (funds) {
    const [held] = await tx.select().from(balances).where(eq(balances.accountId, funds.id));
    const [history] = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(or(eq(ledgerEntries.fromAccountId, funds.id), eq(ledgerEntries.toAccountId, funds.id)))
      .limit(1);
    if (
      !held ||
      held.availableCoin !== 0n ||
      held.lockedCoin !== 0n ||
      held.ledgerCoin !== 0n ||
      history
    )
      return unavailable('funds_inconsistent');
  }
  const [position] = await tx
    .select({ userId: positions.userId })
    .from(positions)
    .where(and(eq(positions.marketId, market.id), eq(positions.userId, owner)))
    .limit(1);
  if (position) return unavailable('funds_inconsistent');
  const result = await recordLedgerEntry(tx, {
    type: 'BOT_ALLOCATION',
    amountCoin: config.budgetCoin,
    from: { kind: 'treasury' },
    to: { kind: 'market_maker_funds', marketId: market.id },
    marketId: market.id,
    refType: 'approval_request',
    refId: approval.id,
    idempotencyKey: ledgerKeys.approvalRequest(approval.id),
    at,
  });
  if (result.outcome !== 'recorded')
    throw new Error('An initial allocation lacks its permanent binding');
  const [allocation] = await tx
    .insert(marketMakerAllocations)
    .values({
      marketId: market.id,
      approvalId: approval.id,
      approvedEventId: event.id,
      liquidityVersion: config.version,
      amountCoin: config.budgetCoin,
      ledgerEntryId: result.entry.id,
      appliedTxid: sql`pg_current_xact_id()::text`,
      createdAt: at,
    })
    .returning();
  await tx.insert(marketMakerRuntime).values({
    marketId: market.id,
    desiredEnabled: true,
    generation: 1n,
    completedGeneration: 0n,
    state: 'waiting',
    reason: null,
    lastConfigVersion: config.version,
    createdAt: at,
    updatedAt: at,
  });
  return {
    outcome: 'allocated',
    allocation: allocation!,
    at,
    requiredCoin: config.budgetCoin,
    availableCoin: balance.availableCoin,
  };
}
