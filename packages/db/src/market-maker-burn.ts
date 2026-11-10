import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { marketMakerAccountId } from './account-types.js';
import { burnMarketMakerPairs } from './contracts.js';
import { positions } from './schema/index.js';
import { lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Only unlocked pairs, through the existing collateral/close/hold/idempotency checks. */
export async function burnAvailableMarketMakerPairs(tx: Tx, marketId: string, burnId: string) {
  await lockMarket(tx, marketId);
  const owner = await marketMakerAccountId(tx);
  if (owner === null) return 0;
  const rows = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.marketId, marketId),
        eq(positions.userId, owner),
        eq(positions.settled, false),
      ),
    );
  const unlocked = (outcome: 'YES' | 'NO') => {
    const row = rows.find((p) => p.outcome === outcome);
    return row ? row.qty - row.lockedQty : 0;
  };
  const qty = Math.min(unlocked('YES'), unlocked('NO'));
  if (qty === 0) return 0;
  const result = await burnMarketMakerPairs(tx, { marketId, burnId, qty });
  if (result.outcome === 'burned') return qty;
  if (
    result.outcome === 'refused' &&
    result.reason !== 'close_passed' &&
    result.reason !== 'not_trading' &&
    result.reason !== 'ledger_failure'
  )
    throw new Error(`An available MM pair could not burn: ${result.reason}`);
  return 0;
}
