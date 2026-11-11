import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { approvalRequests } from './approval-requests.js';
import { fills } from './fills.js';
import { markets } from './markets.js';
import { user } from './auth.js';
import { timestampTz } from './columns.js';

/** Append-only decisions; clear is a new record rather than deletion of the old mark. */
export const fillClassifications = pgTable(
  'fill_classifications',
  {
    revision: bigint({ mode: 'bigint' }).primaryKey(),
    approvalId: uuid()
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    fillId: bigint({ mode: 'number' })
      .notNull()
      .references(() => fills.id, { onDelete: 'restrict' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    action: varchar({ length: 8 }).$type<'mark' | 'clear'>().notNull(),
    baseRevision: bigint({ mode: 'bigint' }).notNull(),
    beforeStatsRevision: bigint({ mode: 'bigint' }).notNull(),
    afterStatsRevision: bigint({ mode: 'bigint' }).notNull(),
    requestedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    approvedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    performedAt: timestampTz().notNull(),
    appliedTxid: text().notNull(),
  },
  (t) => [
    uniqueIndex('fill_classifications_approval_unique').on(t.approvalId),
    index('fill_classifications_fill_revision_idx').on(t.fillId, desc(t.revision)),
    index('fill_classifications_market_revision_idx').on(t.marketId, desc(t.revision)),
    check('fill_classifications_action_check', sql`${t.action} IN ('mark','clear')`),
    check(
      'fill_classifications_revision_check',
      sql`${t.revision}>0 AND ${t.baseRevision}>=0 AND ${t.baseRevision}<${t.revision}`,
    ),
    check(
      'fill_classifications_stats_check',
      sql`${t.beforeStatsRevision}>=0 AND ${t.afterStatsRevision}=${t.beforeStatsRevision}+1`,
    ),
    check('fill_classifications_admin_check', sql`${t.requestedBy}<>${t.approvedBy}`),
  ],
);
