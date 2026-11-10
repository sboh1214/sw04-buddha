import { MAX_COIN_AMOUNT } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { approvalRequests } from './approval-requests.js';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { ledgerEntries } from './ledger.js';
import { marketLiquidityVersions } from './market-liquidity-versions.js';
import { marketEvents } from './market-events.js';
import { markets } from './markets.js';

/** Immutable authorization binding for a production treasury mint. */
export const treasuryIssuances = pgTable(
  'treasury_issuances',
  {
    approvalId: uuid()
      .primaryKey()
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    ledgerEntryId: bigint({ mode: 'number' })
      .notNull()
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    requestedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    approvedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    appliedTxid: text().notNull(),
    createdAt: timestampTz().notNull(),
  },
  (t) => [
    uniqueIndex('treasury_issuances_ledger_unique').on(t.ledgerEntryId),
    index('treasury_issuances_created_idx').on(t.createdAt, t.approvalId),
    check(
      'treasury_issuances_amount_check',
      sql`${t.amountCoin} BETWEEN 1 AND ${sql.raw(String(MAX_COIN_AMOUNT))}`,
    ),
    check('treasury_issuances_admin_check', sql`${t.requestedBy} <> ${t.approvedBy}`),
  ],
);

/** Initial allocation only. #130 increases will have their own approval-bound records. */
export const marketMakerAllocations = pgTable(
  'market_maker_allocations',
  {
    marketId: uuid()
      .primaryKey()
      .references(() => markets.id, { onDelete: 'restrict' }),
    approvalId: uuid()
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    approvedEventId: bigint({ mode: 'number' })
      .notNull()
      .references(() => marketEvents.id, { onDelete: 'restrict' }),
    liquidityVersion: integer().notNull(),
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    ledgerEntryId: bigint({ mode: 'number' })
      .notNull()
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    appliedTxid: text().notNull(),
    createdAt: timestampTz().notNull(),
  },
  (t) => [
    uniqueIndex('market_maker_allocations_approval_unique').on(t.approvalId),
    uniqueIndex('market_maker_allocations_ledger_unique').on(t.ledgerEntryId),
    foreignKey({
      columns: [t.marketId, t.liquidityVersion],
      foreignColumns: [marketLiquidityVersions.marketId, marketLiquidityVersions.version],
    }).onDelete('restrict'),
    check(
      'market_maker_allocations_amount_check',
      sql`${t.amountCoin} BETWEEN 1 AND ${sql.raw(String(MAX_COIN_AMOUNT))}`,
    ),
  ],
);

export type MarketMakerOperationalState = 'ready' | 'waiting' | 'stopped' | 'error';

/** Last opening observation, separate from economic records and never an implicit allocation. */
export const marketMakerOpenAttempts = pgTable(
  'market_maker_open_attempts',
  {
    marketId: uuid()
      .primaryKey()
      .references(() => markets.id, { onDelete: 'restrict' }),
    lastAttemptAt: timestampTz().notNull(),
    reason: text(),
    requiredCoin: bigint({ mode: 'bigint' }),
    availableCoin: bigint({ mode: 'bigint' }),
    liquidityVersion: integer(),
    succeededAt: timestampTz(),
  },
  (t) => [
    check(
      'market_maker_open_attempts_coin_check',
      sql`(${t.requiredCoin} IS NULL OR ${t.requiredCoin} > 0) AND (${t.availableCoin} IS NULL OR ${t.availableCoin} >= 0)`,
    ),
  ],
);

/** Operational observations, never a second copy of Coin or contract holdings. No backfill. */
export const marketMakerRuntime = pgTable(
  'market_maker_runtime',
  {
    marketId: uuid()
      .primaryKey()
      .references(() => marketMakerAllocations.marketId, { onDelete: 'restrict' }),
    desiredEnabled: boolean().notNull(),
    generation: bigint({ mode: 'bigint' }).notNull(),
    completedGeneration: bigint({ mode: 'bigint' }).notNull(),
    state: varchar({ length: 16 }).$type<MarketMakerOperationalState>().notNull(),
    reason: text(),
    lastConfigVersion: integer().notNull(),
    lastAttemptAt: timestampTz(),
    lastSuccessAt: timestampTz(),
    lastFailureAt: timestampTz(),
    lastError: text(),
    consecutiveFailures: integer().notNull().default(0),
    createdAt: timestampTz().notNull(),
    updatedAt: timestampTz().notNull(),
  },
  (t) => [
    check(
      'market_maker_runtime_generation_check',
      sql`${t.generation} >= 1 AND ${t.completedGeneration} BETWEEN 0 AND ${t.generation}`,
    ),
    check(
      'market_maker_runtime_state_check',
      sql`${t.state} IN ('ready','waiting','stopped','error')`,
    ),
    check('market_maker_runtime_failures_check', sql`${t.consecutiveFailures} >= 0`),
    foreignKey({
      columns: [t.marketId, t.lastConfigVersion],
      foreignColumns: [marketLiquidityVersions.marketId, marketLiquidityVersions.version],
    }).onDelete('restrict'),
    index('market_maker_runtime_due_idx').on(t.lastAttemptAt, t.marketId),
  ],
);

export const marketMakerRuns = pgTable(
  'market_maker_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    marketId: uuid()
      .notNull()
      .references(() => marketMakerRuntime.marketId, { onDelete: 'restrict' }),
    generation: bigint({ mode: 'bigint' }).notNull(),
    outcome: varchar({ length: 16 }).$type<'ready' | 'waiting' | 'error'>().notNull(),
    reason: text(),
    error: text(),
    detail: jsonb().$type<Record<string, unknown>>().notNull(),
    startedAt: timestampTz().notNull(),
    finishedAt: timestampTz().notNull(),
  },
  (t) => [
    index('market_maker_runs_market_created_idx').on(t.marketId, t.finishedAt, t.id),
    check('market_maker_runs_generation_check', sql`${t.generation} >= 1`),
    check(
      'market_maker_runs_outcome_check',
      sql`${t.outcome} IN ('ready','waiting','error') AND (${t.outcome}='error')=(${t.error} IS NOT NULL)`,
    ),
  ],
);
