import { readMarketLiquidityHistory, schema, type Db } from '@buddha/db';
import { serializeCoinAmount, type AdminMarket } from '@buddha/shared';
import { inArray } from 'drizzle-orm';
import type { MarketRow } from './market.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Db | Tx;

/** Admin-only versions: the public market reader never calls this function. */
export async function readAdminMarketLiquidity(
  reader: Reader,
  market: Pick<MarketRow, 'id' | 'currentLiquidityVersion' | 'openedLiquidityVersion'>,
): Promise<AdminMarket['liquidity']> {
  const rows = await readMarketLiquidityHistory(reader, market.id);
  const ids = [...new Set(rows.map((row) => row.createdBy))];
  const profiles = ids.length
    ? await reader
        .select({ id: schema.profiles.userId, nickname: schema.profiles.nickname })
        .from(schema.profiles)
        .where(inArray(schema.profiles.userId, ids))
    : [];
  const names = new Map(profiles.map((profile) => [profile.id, profile.nickname]));
  const history = rows.map((row) => ({
    marketId: row.marketId,
    version: row.version,
    budgetCoin: serializeCoinAmount(row.budgetCoin),
    maxLossCoin: serializeCoinAmount(row.maxLossCoin),
    b: row.b,
    levels: row.levels,
    quantity: row.quantity,
    safetyTicks: row.safetyTicks,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.createdBy, nickname: names.get(row.createdBy) ?? null },
  }));
  return {
    current: history.find((row) => row.version === market.currentLiquidityVersion) ?? null,
    openedVersion: market.openedLiquidityVersion,
    history,
  };
}
