import type {
  ReconciliationFinding,
  ReconciliationScope,
  ReconciliationSource,
} from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
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
import { ledgerAccounts } from './ledger-accounts.js';
import { marketPauses } from './market-pauses.js';
import { markets } from './markets.js';

/** Immutable observations. A pass is evidence; it never releases a hold by itself. */
export const reconciliationResults = pgTable(
  'reconciliation_results',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    scope: varchar({ length: 20 }).$type<ReconciliationScope>().notNull(),
    targetKey: text().notNull(),
    marketId: uuid().references(() => markets.id, { onDelete: 'restrict' }),
    accountId: bigint({ mode: 'number' }).references(() => ledgerAccounts.id, {
      onDelete: 'restrict',
    }),
    userId: text().references(() => user.id, { onDelete: 'restrict' }),
    source: varchar({ length: 20 }).$type<ReconciliationSource>().notNull(),
    actorId: text().references(() => user.id, { onDelete: 'restrict' }),
    version: integer().notNull().default(1),
    passed: boolean().notNull(),
    checkedAt: timestampTz().notNull(),
    ledgerCursor: bigint({ mode: 'number' }).notNull(),
    findings: jsonb().$type<ReconciliationFinding[]>().notNull(),
    facts: jsonb().$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('reconciliation_results_target_latest_idx').on(t.targetKey, desc(t.id)),
    index('reconciliation_results_checked_idx').on(desc(t.checkedAt), desc(t.id)),
    check('reconciliation_results_scope_check', sql`${t.scope} IN ('market','account','supply')`),
    check(
      'reconciliation_results_target_check',
      sql`(${t.scope}='market' AND ${t.marketId} IS NOT NULL AND ${t.accountId} IS NULL AND ${t.userId} IS NULL AND ${t.targetKey}='market:'||${t.marketId}::text) OR (${t.scope}='account' AND ${t.marketId} IS NULL AND ((${t.userId} IS NOT NULL AND ${t.targetKey}='user:'||${t.userId}) OR (${t.userId} IS NULL AND ${t.accountId} IS NOT NULL AND ${t.targetKey}='account:'||${t.accountId}::text))) OR (${t.scope}='supply' AND ${t.marketId} IS NULL AND ${t.accountId} IS NULL AND ${t.userId} IS NULL AND ${t.targetKey}='supply')`,
    ),
    check(
      'reconciliation_results_source_check',
      sql`${t.source} IN ('scheduled','manual','recovery')`,
    ),
    check(
      'reconciliation_results_findings_check',
      sql`jsonb_typeof(${t.findings}) = 'array' AND ${t.passed} = (jsonb_array_length(${t.findings}) = 0)`,
    ),
  ],
);

/** One active hold per target. Repeated failures update only its last failed observation. */
export const reconciliationHolds = pgTable(
  'reconciliation_holds',
  {
    id: uuid().primaryKey().defaultRandom(),
    scope: varchar({ length: 20 }).$type<'market' | 'account'>().notNull(),
    targetKey: text().notNull(),
    marketId: uuid().references(() => markets.id, { onDelete: 'restrict' }),
    userId: text().references(() => user.id, { onDelete: 'restrict' }),
    failureResultId: bigint({ mode: 'number' }).references(() => reconciliationResults.id, {
      onDelete: 'restrict',
    }),
    legacyPauseId: uuid().references(() => marketPauses.id, { onDelete: 'restrict' }),
    startedAt: timestampTz().notNull(),
    recoveredAt: timestampTz(),
  },
  (t) => [
    uniqueIndex('reconciliation_holds_target_active_uidx')
      .on(t.targetKey)
      .where(sql`${t.recoveredAt} IS NULL`),
    check(
      'reconciliation_holds_target_check',
      sql`(${t.scope} = 'market' AND ${t.marketId} IS NOT NULL AND ${t.userId} IS NULL) OR (${t.scope} = 'account' AND ${t.marketId} IS NULL AND ${t.userId} IS NOT NULL)`,
    ),
    check(
      'reconciliation_holds_evidence_check',
      sql`${t.failureResultId} IS NOT NULL OR ${t.legacyPauseId} IS NOT NULL`,
    ),
  ],
);

/** A recovery binds a fresh pass and another administrator's approval to exactly one hold. */
export const reconciliationRecoveries = pgTable(
  'reconciliation_recoveries',
  {
    id: uuid().primaryKey().defaultRandom(),
    holdId: uuid()
      .notNull()
      .unique('reconciliation_recoveries_hold_unique')
      .references(() => reconciliationHolds.id, { onDelete: 'restrict' }),
    resultId: bigint({ mode: 'number' })
      .notNull()
      .references(() => reconciliationResults.id, { onDelete: 'restrict' }),
    approvalId: uuid()
      .notNull()
      .unique('reconciliation_recoveries_approval_unique')
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    legacyPauseId: uuid()
      .unique('reconciliation_recoveries_pause_unique')
      .references(() => marketPauses.id, { onDelete: 'restrict' }),
    requestedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    approvedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    recoveredAt: timestampTz().notNull(),
  },
  (t) => [
    check('reconciliation_recoveries_other_admin_check', sql`${t.requestedBy} <> ${t.approvedBy}`),
  ],
);
