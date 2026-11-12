import type { BookOrder, BotBook, LiveBotOrder } from '@buddha/shared';
import { and, eq, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { marketMakerAccountId } from './account-types.js';
import { findLedgerAccount } from './ledger.js';
import { readMarketMakerConfig } from './market-liquidity.js';
import { readLiveBook } from './orders.js';
import type * as schema from './schema/index.js';
import { balances, ledgerEntries, positions } from './schema/index.js';

/** Both a pooled reader and a read-only transaction; no write/lock capability is required. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

export type MarketMakerRiskUnavailable =
  'missing_config' | 'missing_market_maker' | 'missing_funds';
export type MarketMakerRiskInconsistency =
  | 'missing_market_maker'
  | 'missing_funds'
  | 'missing_balance'
  | 'owner_mismatch'
  | 'coin_gap'
  | 'coin_lock'
  | 'contract_lock';

/** Internal facts only. Neither this snapshot nor its failure reasons belong in a public DTO. */
export type MarketMakerRiskSnapshot =
  | {
      kind: 'ready';
      marketId: string;
      /** The global MM auth-user id, not a ledger account id. */
      ownerId: string;
      fundsAccountId: number;
      configVersion: number;
      book: BotBook;
      /** Admission needs L alone; stage thresholds must never be invented here. */
      limits: { maxLoss: bigint };
      liveOrders: LiveBotOrder[];
    }
  | { kind: 'unavailable'; marketId: string; reason: MarketMakerRiskUnavailable }
  | { kind: 'inconsistent'; marketId: string; reason: MarketMakerRiskInconsistency };

/**
 * One market's actual MM assets and lifetime capital, SELECT-only (#128). Call inside the same
 * REPEATABLE READ READ ONLY transaction as a preview's book, or under the intake's market lock.
 * A supplied book must be that market's WHOLE live book from that same transaction/snapshot.
 * Cancellation intent is no release: until its transaction commits the live row still counts.
 *
 * Missing legacy configuration disables MM participation only. Concrete asset inconsistencies
 * are separate facts for the caller's #93 policy; this reader does not repair, cancel, hold or
 * pause anything, and does not reject unrelated human trading. These narrow lock/gap checks do
 * not replace the full reconciliation audit (contract supply, collateral and ledger history).
 */
export async function readMarketMakerRiskSnapshot(
  reader: Reader,
  marketId: string,
  liveBook?: readonly BookOrder[],
): Promise<MarketMakerRiskSnapshot> {
  const config = await readMarketMakerConfig(reader, marketId);
  const ownerId = await marketMakerAccountId(reader);
  const funds = await findLedgerAccount(reader, { kind: 'market_maker_funds', marketId });
  const book = liveBook ?? (await readLiveBook(reader, marketId));
  const botOrders = book.filter((order) => !order.owner.human);
  const unavailable = (reason: MarketMakerRiskUnavailable): MarketMakerRiskSnapshot => ({
    kind: 'unavailable',
    marketId,
    reason,
  });
  const inconsistent = (reason: MarketMakerRiskInconsistency): MarketMakerRiskSnapshot => ({
    kind: 'inconsistent',
    marketId,
    reason,
  });
  if (ownerId === null) {
    if (funds !== null || botOrders.length > 0) return inconsistent('missing_market_maker');
    return unavailable(config === null ? 'missing_config' : 'missing_market_maker');
  }
  if (
    botOrders.some((order) => order.owner.id !== ownerId) ||
    (funds !== null && funds.ownerId !== ownerId)
  )
    return inconsistent('owner_mismatch');
  const rows = await reader
    .select()
    .from(positions)
    .where(and(eq(positions.marketId, marketId), eq(positions.userId, ownerId)));
  // Retired quantities do not pay again, but their impossible locks must not disappear from a
  // safety check merely because the valuation only considers unsettled holdings.
  if (rows.some((row) => row.settled && row.lockedQty !== 0)) return inconsistent('contract_lock');
  const holdings = rows.filter((row) => !row.settled);
  if (funds === null) {
    if (botOrders.length > 0 || holdings.length > 0) return inconsistent('missing_funds');
    return unavailable(config === null ? 'missing_config' : 'missing_funds');
  }
  const [balance] = await reader.select().from(balances).where(eq(balances.accountId, funds.id));
  if (balance === undefined) return inconsistent('missing_balance');
  const coin = balance.availableCoin + balance.lockedCoin;
  if (coin !== balance.ledgerCoin) return inconsistent('coin_gap');
  let buyLocks = 0n;
  const sellLocks = { YES: 0n, NO: 0n };
  for (const order of botOrders) {
    if (order.side === 'buy') buyLocks += BigInt(order.priceCoin) * BigInt(order.remainingQty);
    else sellLocks[order.outcome] += BigInt(order.remainingQty);
  }
  if (balance.lockedCoin !== buyLocks) return inconsistent('coin_lock');
  const yes = holdings.find((row) => row.outcome === 'YES');
  const no = holdings.find((row) => row.outcome === 'NO');
  if (BigInt(yes?.lockedQty ?? 0) !== sellLocks.YES || BigInt(no?.lockedQty ?? 0) !== sellLocks.NO)
    return inconsistent('contract_lock');
  // Check the concrete assets first: an absent old config must not mask damaged Coin or locks.
  if (config === null) return unavailable('missing_config');

  const treasury = await findLedgerAccount(reader, { kind: 'treasury' });
  let invested = 0n;
  let recovered = 0n;
  if (treasury !== null) {
    const allocation = sql<boolean>`${ledgerEntries.fromAccountId} = ${treasury.id}
      AND ${ledgerEntries.toAccountId} = ${funds.id}
      AND ${ledgerEntries.type} IN ('BOT_ALLOCATION', 'RECONCILIATION_CORRECTION')`;
    const recall = sql<boolean>`${ledgerEntries.fromAccountId} = ${funds.id}
      AND ${ledgerEntries.toAccountId} = ${treasury.id}
      AND ${ledgerEntries.type} IN ('BOT_RECALL', 'RECONCILIATION_CORRECTION')`;
    const [capital] = await reader
      .select({
        invested: sql<string>`coalesce(sum(CASE
        WHEN ${allocation}
        THEN ${ledgerEntries.amountCoin} ELSE 0 END), 0)::text`,
        recovered: sql<string>`coalesce(sum(CASE
        WHEN ${recall}
        THEN ${ledgerEntries.amountCoin} ELSE 0 END), 0)::text`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.marketId, marketId),
          // Keep the literal partial-index predicate visible even in a generic prepared plan.
          // Neither trade volume nor a bot's trade history should enlarge this capital scan.
          sql`${ledgerEntries.type} IN ('BOT_ALLOCATION', 'BOT_RECALL', 'RECONCILIATION_CORRECTION')`,
          or(allocation, recall),
        ),
      );
    // SUM(bigint) is numeric in PostgreSQL. Lifetime gross flows can exceed one Coin input or
    // the JS safe-integer range, even when every current bucket stays small.
    invested = BigInt(capital?.invested ?? '0');
    recovered = BigInt(capital?.recovered ?? '0');
  }
  return {
    kind: 'ready',
    marketId,
    ownerId,
    fundsAccountId: funds.id,
    configVersion: config.version,
    book: { coin, yesQty: yes?.qty ?? 0, noQty: no?.qty ?? 0, invested, recovered },
    limits: { maxLoss: config.maxLossCoin },
    liveOrders: botOrders.map((order) => ({
      id: order.id,
      outcome: order.outcome,
      side: order.side,
      priceCoin: order.priceCoin,
      qty: order.remainingQty,
    })),
  };
}
