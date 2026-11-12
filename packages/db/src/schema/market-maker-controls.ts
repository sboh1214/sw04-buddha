import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
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
import { markets } from './markets.js';

/** One completed, approval-bound control. Pending work lives only in approval_requests. */
export const marketMakerControls = pgTable(
  'market_maker_controls',
  {
    approvalId: uuid()
      .primaryKey()
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    action: varchar({ length: 16 }).$type<'stop' | 'resume' | 'settings' | 'increase'>().notNull(),
    requestedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    approvedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    beforeVersion: integer().notNull(),
    afterVersion: integer().notNull(),
    beforeControlGeneration: bigint({ mode: 'bigint' }).notNull(),
    afterControlGeneration: bigint({ mode: 'bigint' }).notNull(),
    beforeGeneration: bigint({ mode: 'bigint' }).notNull(),
    afterGeneration: bigint({ mode: 'bigint' }).notNull(),
    beforeDesiredEnabled: boolean().notNull(),
    afterDesiredEnabled: boolean().notNull(),
    additionalCoin: bigint({ mode: 'bigint' }),
    ledgerEntryId: bigint({ mode: 'number' }).references(() => ledgerEntries.id, {
      onDelete: 'restrict',
    }),
    appliedTxid: text().notNull(),
    performedAt: timestampTz().notNull(),
  },
  (t) => [
    uniqueIndex('market_maker_controls_generation_unique').on(t.marketId, t.afterControlGeneration),
    uniqueIndex('market_maker_controls_ledger_unique').on(t.ledgerEntryId),
    index('market_maker_controls_history_idx').on(t.marketId, t.performedAt, t.approvalId),
    check(
      'market_maker_controls_action_check',
      sql`${t.action} IN ('stop','resume','settings','increase')`,
    ),
    check('market_maker_controls_admin_check', sql`${t.requestedBy} <> ${t.approvedBy}`),
    check(
      'market_maker_controls_generations_check',
      sql`${t.beforeGeneration}>=1 AND ${t.afterGeneration}=${t.beforeGeneration}+1 AND ${t.beforeControlGeneration}>=1 AND ${t.afterControlGeneration}=${t.beforeControlGeneration}+1`,
    ),
    check(
      'market_maker_controls_version_check',
      sql`${t.beforeVersion}>=1 AND ${t.afterVersion}=${t.beforeVersion}+CASE WHEN ${t.action} IN ('settings','increase') THEN 1 ELSE 0 END`,
    ),
    check(
      'market_maker_controls_coin_check',
      sql`CASE WHEN ${t.action}='increase' THEN ${t.additionalCoin} IS NOT NULL AND ${t.additionalCoin}>0 AND ${t.additionalCoin}<=1000000000000000 AND ${t.ledgerEntryId} IS NOT NULL ELSE ${t.additionalCoin} IS NULL AND ${t.ledgerEntryId} IS NULL END`,
    ),
  ],
);
