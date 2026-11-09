import type {
  ReconciliationCorrectionCandidate,
  ReconciliationCorrectionMode,
} from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { approvalRequests } from './approval-requests.js';
import { auditFailures } from './audit-failures.js';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { ledgerEntries } from './ledger.js';
import { reconciliationHolds, reconciliationResults } from './reconciliation.js';

/** Only apply_reconciliation_correction may INSERT. Every role is refused UPDATE/DELETE.
 * Actual-only restoration shares the ledger sequence without inventing a ledger transfer or mint.
 * appliedTxid authorizes exactly this transaction's before/after gap change; never a GUC bypass.
 */
export const reconciliationCorrections = pgTable(
  'reconciliation_corrections',
  {
    id: uuid().primaryKey().defaultRandom(),
    eventId: bigint({ mode: 'number' }).notNull(),
    ledgerEntryId: bigint({ mode: 'number' }).references(() => ledgerEntries.id, {
      onDelete: 'restrict',
    }),
    approvalId: uuid()
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    failureResultId: bigint({ mode: 'number' })
      .notNull()
      .references(() => reconciliationResults.id, { onDelete: 'restrict' }),
    auditFailureId: bigint({ mode: 'number' })
      .notNull()
      .references(() => auditFailures.id, { onDelete: 'restrict' }),
    holdId: uuid().references(() => reconciliationHolds.id, { onDelete: 'restrict' }),
    accountId: bigint({ mode: 'number' })
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    userId: text().references(() => user.id, { onDelete: 'restrict' }),
    mode: varchar({ length: 24 }).$type<ReconciliationCorrectionMode>().notNull(),
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    balanceDeltaCoin: bigint({ mode: 'bigint' }).notNull(),
    balanceBeforeCoin: bigint({ mode: 'bigint' }).notNull(),
    balanceAfterCoin: bigint({ mode: 'bigint' }).notNull(),
    ledgerBeforeCoin: bigint({ mode: 'bigint' }).notNull(),
    ledgerAfterCoin: bigint({ mode: 'bigint' }).notNull(),
    lockedCoin: bigint({ mode: 'bigint' }).notNull(),
    candidate: jsonb().$type<ReconciliationCorrectionCandidate>().notNull(),
    userReason: text(),
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
    uniqueIndex('reconciliation_corrections_approval_unique').on(t.approvalId),
    uniqueIndex('reconciliation_corrections_event_unique').on(t.eventId),
    uniqueIndex('reconciliation_corrections_ledger_unique').on(t.ledgerEntryId),
    index('reconciliation_corrections_user_event_idx').on(t.userId, t.eventId),
    index('reconciliation_corrections_user_created_idx').on(
      t.userId,
      desc(t.createdAt),
      desc(t.id),
    ),
    index('reconciliation_corrections_account_idx').on(t.accountId, t.eventId),
    check(
      'reconciliation_corrections_mode_check',
      sql`${t.mode} IN ('restore_actual','replenish_ledger','fund_collateral','return_collateral')`,
    ),
    check(
      'reconciliation_corrections_amount_check',
      sql`${t.amountCoin}>0 AND ${t.balanceBeforeCoin}>=0 AND ${t.balanceAfterCoin}>=0 AND ${t.ledgerBeforeCoin}>=0 AND ${t.ledgerAfterCoin}>=0 AND ${t.lockedCoin}>=0`,
    ),
    check('reconciliation_corrections_admin_check', sql`${t.requestedBy}<>${t.approvedBy}`),
    check(
      'reconciliation_corrections_user_reason_check',
      sql`(${t.userId} IS NULL AND ${t.userReason} IS NULL) OR (${t.userId} IS NOT NULL AND ${t.userReason} IS NOT NULL AND length(btrim(${t.userReason})) BETWEEN 1 AND 500)`,
    ),
    check(
      'reconciliation_corrections_delta_check',
      sql`${t.balanceAfterCoin}-${t.balanceBeforeCoin}=${t.balanceDeltaCoin}`,
    ),
    check(
      'reconciliation_corrections_entry_check',
      sql`(${t.mode}='restore_actual')=(${t.ledgerEntryId} IS NULL)`,
    ),
  ],
);
