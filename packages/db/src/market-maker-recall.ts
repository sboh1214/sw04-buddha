import { MAX_COIN_AMOUNT } from '@buddha/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { findLedgerAccount, ledgerKeys, recordLedgerEntry } from './ledger.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { checkMarketSettlementBooks } from './market-settlement.js';
import {
  balances,
  ledgerAccounts,
  marketMakerRecalls,
  markets,
  positions,
  positionSettlements,
} from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type MarketMakerRecallRow = typeof marketMakerRecalls.$inferSelect;
export type MarketMakerRecallResult =
  | { outcome: 'recalled' | 'duplicate'; recall: MarketMakerRecallRow }
  | {
      outcome: 'unavailable';
      reason:
        | 'not_found'
        | 'not_terminal'
        | 'ledger_hold'
        | 'books_inconsistent'
        | 'recall_inconsistent'
        | 'treasury_capacity';
    };

/** Read-only completed-record/ledger audit. An uncompleted terminal market is normal pending.
 * Caller holds its market lock (and market balance locks when it needs a stable snapshot).
 * The SQL helper is also the completion guard, so raw writes cannot use a weaker equation.
 */
export async function checkMarketMakerRecallBooks(tx: Tx, marketId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ issue: string }>(sql`
    SELECT issue FROM public.market_maker_recall_findings(${marketId}::uuid) AS issue`);
  return rows.map((row) => row.issue);
}

/** Internal terminal transfer only: no queue/API/approval choice, retry schedule or failure UI.
 * All market and treasury accounts are prelocked together. Failure writes no completion and
 * never repairs assets, releases an order, retires a position or changes the market's status.
 * A caller commits before publishing anything; there is no public trade/balance event here.
 */
export async function recallMarketMakerFunds(
  tx: Tx,
  { marketId }: { marketId: string },
): Promise<MarketMakerRecallResult> {
  await lockMarket(tx, marketId);
  const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
  const unavailable = (
    reason: Extract<MarketMakerRecallResult, { outcome: 'unavailable' }>['reason'],
  ): MarketMakerRecallResult => ({ outcome: 'unavailable', reason });
  if (!market) return unavailable('not_found');
  if (market.status !== 'settled' && market.status !== 'cancelled')
    return unavailable('not_terminal');
  if ((await ledgerHeldMarketIds(tx, [marketId])).has(marketId)) return unavailable('ledger_hold');
  const accounts = await tx
    .select()
    .from(ledgerAccounts)
    .where(sql`${ledgerAccounts.marketId}=${marketId} OR ${ledgerAccounts.kind}='treasury'`)
    .orderBy(asc(ledgerAccounts.id));
  // Read/lock existing rows, never ensure a missing balance/system account into an apparent zero.
  if (accounts.length)
    await tx
      .select()
      .from(balances)
      .where(
        inArray(
          balances.accountId,
          accounts.map((a) => a.id),
        ),
      )
      .orderBy(asc(balances.accountId))
      .for('update');
  const [prior] = await tx
    .select()
    .from(marketMakerRecalls)
    .where(eq(marketMakerRecalls.marketId, marketId));
  if ((await checkMarketMakerRecallBooks(tx, marketId)).length)
    return unavailable('recall_inconsistent');
  const { rows: valid } = await tx.execute<{ valid: boolean }>(
    sql`SELECT public.market_maker_recall_ready(${marketId}::uuid) AS valid`,
  );
  if (!valid[0]?.valid) return unavailable('books_inconsistent');
  if (market.status === 'settled') {
    const holdings = await tx.select().from(positions).where(eq(positions.marketId, marketId));
    const records = await tx
      .select()
      .from(positionSettlements)
      .where(eq(positionSettlements.marketId, marketId));
    try {
      await checkMarketSettlementBooks(tx, market, holdings, records, true);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith(`Market ${marketId} settlement:`))
        throw error;
      return unavailable('books_inconsistent');
    }
  }
  if (prior) return { outcome: 'duplicate', recall: prior };
  const funds = await findLedgerAccount(tx, { kind: 'market_maker_funds', marketId });
  const [balance] = funds
    ? await tx.select().from(balances).where(eq(balances.accountId, funds.id))
    : [];
  const amountCoin = balance?.availableCoin ?? 0n;
  const treasury = accounts.find((a) => a.kind === 'treasury');
  const [treasuryBalance] = treasury
    ? await tx.select().from(balances).where(eq(balances.accountId, treasury.id))
    : [];
  if (
    amountCoin > 0n &&
    (!treasuryBalance || treasuryBalance.availableCoin + amountCoin > MAX_COIN_AMOUNT)
  )
    return unavailable('treasury_capacity');
  const at = await clockTimestamp(tx);
  let ledgerEntryId: number | null = null;
  if (amountCoin > 0n) {
    const written = await recordLedgerEntry(tx, {
      type: 'BOT_RECALL',
      amountCoin,
      from: { kind: 'market_maker_funds', marketId },
      to: { kind: 'treasury' },
      marketId,
      refType: 'market',
      refId: marketId,
      idempotencyKey: ledgerKeys.marketMakerRecall(marketId),
      at,
    });
    if (written.outcome !== 'recorded')
      throw new Error('Recall ledger lacks its permanent completion');
    ledgerEntryId = written.entry.id;
  }
  const [recall] = await tx
    .insert(marketMakerRecalls)
    .values({
      marketId,
      terminalStatus: market.status,
      statusEventId: market.statusEventId,
      judgementVersion: market.judgementVersion,
      fundsAccountId: funds?.id ?? null,
      amountCoin,
      ledgerEntryId,
      appliedTxid: sql`pg_current_xact_id()::text`,
      completedAt: at,
    })
    .returning();
  return { outcome: 'recalled', recall: recall! };
}
