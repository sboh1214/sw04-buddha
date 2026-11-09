import { approvalReasonSchema } from '@buddha/shared';
import { and, eq, notInArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Db } from './client.js';
import { marketConflictDeclarations, orders, profiles } from './schema/index.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'>;
export type MarketConflictDeclarationRow = typeof marketConflictDeclarations.$inferSelect;
export class MarketConflictError extends Error {
  readonly userId: string;
  constructor(userId: string) {
    super('A market decision excludes an interested administrator');
    this.name = 'MarketConflictError';
    this.userId = userId;
  }
}
export async function assertNoMarketConflict(
  reader: Reader,
  marketId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of new Set(userIds))
    if ((await marketConflictOf(reader, marketId, userId)).conflicted)
      throw new MarketConflictError(userId);
}

/** Use SQL parameters in a SELECT projection; Drizzle strips column qualifiers there. */
export function marketConflictSql(marketId: SQLWrapper, userId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`(EXISTS (SELECT 1 FROM orders conflict_order
    WHERE conflict_order.market_id=${marketId} AND conflict_order.user_id=${userId} AND conflict_order.filled_qty>0)
    OR EXISTS (SELECT 1 FROM market_conflict_declarations declaration
    WHERE declaration.market_id=${marketId} AND declaration.user_id=${userId}))`;
}

export async function marketConflictOf(reader: Reader, marketId: string, userId: string) {
  const [declaration] = await reader
    .select()
    .from(marketConflictDeclarations)
    .where(
      and(
        eq(marketConflictDeclarations.marketId, marketId),
        eq(marketConflictDeclarations.userId, userId),
      ),
    );
  const [fill] = await reader
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(eq(orders.marketId, marketId), eq(orders.userId, userId), sql`${orders.filledQty}>0`),
    )
    .limit(1);
  return {
    hasFill: fill !== undefined,
    declaration: declaration ?? null,
    conflicted: fill !== undefined || declaration !== undefined,
  };
}

/** Caller holds the market and shared admin-role locks before relying on this eligibility. */
export async function hasUnconflictedMarketAdmin(
  reader: Reader,
  marketId: string,
  excludedUserIds: readonly string[],
) {
  const [person] = await reader
    .select({ id: profiles.userId })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, 'admin'),
        excludedUserIds.length ? notInArray(profiles.userId, [...excludedUserIds]) : undefined,
        sql`NOT ${marketConflictSql(sql`${marketId}`, profiles.userId)}`,
      ),
    )
    .limit(1);
  return person !== undefined;
}

export async function countFilledMarkets(reader: Reader, userId: string): Promise<number> {
  const [count] = await reader
    .select({ count: sql<number>`count(DISTINCT ${orders.marketId})::int` })
    .from(orders)
    .where(and(eq(orders.userId, userId), sql`${orders.filledQty}>0`));
  return count?.count ?? 0;
}

/** Caller holds market/roles locks; a repeated declaration preserves its first reason and audit. */
export async function declareMarketConflict(
  tx: Tx,
  input: {
    marketId: string;
    userId: string;
    reason: string;
    adminActionId: string;
    at: Date;
  },
): Promise<{ declaration: MarketConflictDeclarationRow; created: boolean }> {
  const existing = (await marketConflictOf(tx, input.marketId, input.userId)).declaration;
  if (existing) return { declaration: existing, created: false };
  const [declaration] = await tx
    .insert(marketConflictDeclarations)
    .values({
      marketId: input.marketId,
      userId: input.userId,
      reason: approvalReasonSchema.parse(input.reason),
      declaredAt: input.at,
      adminActionId: input.adminActionId,
    })
    .returning();
  if (!declaration) throw new Error('Conflict declaration was not recorded');
  return { declaration, created: true };
}
