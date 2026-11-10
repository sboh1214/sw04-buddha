import {
  marketLiquiditySettingsInputSchema,
  type MarketLiquidityRefusal,
  type MarketLiquiditySettingsInput,
} from '@buddha/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';
import { marketLiquidityVersions, markets, profiles } from './schema/index.js';
import {
  clockTimestamp,
  lockAdminRoles,
  lockMarket,
  type StatementExecutor,
} from './tx-helpers.js';

type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;
type Writer = Pick<NodePgDatabase<typeof schema>, 'select' | 'insert' | 'update'> &
  StatementExecutor;
export type MarketLiquidityVersionRow = typeof marketLiquidityVersions.$inferSelect;

export class MarketLiquidityError extends Error {
  readonly code: MarketLiquidityRefusal;
  constructor(code: MarketLiquidityRefusal) {
    super(`Market liquidity change refused: ${code}`);
    this.name = 'MarketLiquidityError';
    this.code = code;
  }
}

/** SELECT-only current settings, also usable in a REPEATABLE READ / READ ONLY preview. */
export async function readMarketMakerConfig(
  reader: Reader,
  marketId: string,
): Promise<MarketLiquidityVersionRow | null> {
  const [row] = await reader
    .select({ config: marketLiquidityVersions })
    .from(markets)
    .innerJoin(
      marketLiquidityVersions,
      and(
        eq(marketLiquidityVersions.marketId, markets.id),
        eq(marketLiquidityVersions.version, markets.currentLiquidityVersion),
      ),
    )
    .where(eq(markets.id, marketId));
  return row?.config ?? null;
}

export async function readMarketLiquidityHistory(
  reader: Reader,
  marketId: string,
): Promise<MarketLiquidityVersionRow[]> {
  return reader
    .select()
    .from(marketLiquidityVersions)
    .where(eq(marketLiquidityVersions.marketId, marketId))
    .orderBy(desc(marketLiquidityVersions.version));
}

/** Market → roles; no asset locks or Coin transfers. Caller owns the transaction and audit. */
export async function setMarketLiquidity(
  tx: Writer,
  input: {
    marketId: string;
    actorId: string;
    settings: MarketLiquiditySettingsInput;
    baseVersion: number | null;
    reason: string;
  },
): Promise<MarketLiquidityVersionRow> {
  const settings = marketLiquiditySettingsInputSchema.parse({
    ...input.settings,
    budgetCoin: input.settings.budgetCoin.toString(),
    maxLossCoin: input.settings.maxLossCoin.toString(),
  });
  await lockMarket(tx, input.marketId);
  const [market] = await tx
    .select()
    .from(markets)
    .where(eq(markets.id, input.marketId))
    .for('update');
  if (!market) throw new MarketLiquidityError('not_found');
  await lockAdminRoles(tx, 'shared');
  const [actor] = await tx
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, input.actorId));
  if (actor?.role !== 'admin') throw new MarketLiquidityError('forbidden');
  if (market.status !== 'draft' || market.openedLiquidityVersion !== null)
    throw new MarketLiquidityError('non_draft');
  if (market.currentLiquidityVersion !== input.baseVersion) throw new MarketLiquidityError('stale');
  const current = await readMarketMakerConfig(tx, input.marketId);
  if (
    current &&
    (Object.keys(settings) as (keyof typeof settings)[]).every(
      (key) => current[key] === settings[key],
    )
  )
    throw new MarketLiquidityError('unchanged');
  const now = await clockTimestamp(tx);
  const [row] = await tx
    .insert(marketLiquidityVersions)
    .values({
      marketId: input.marketId,
      version: (market.currentLiquidityVersion ?? 0) + 1,
      ...settings,
      reason: input.reason,
      createdBy: input.actorId,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error('Liquidity version insert returned no row');
  await tx
    .update(markets)
    .set({ currentLiquidityVersion: row.version, updatedAt: now })
    .where(eq(markets.id, market.id));
  return row;
}
