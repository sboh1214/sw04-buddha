import { desc } from 'drizzle-orm';
import { bigint, bigserial, index, pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';
import { ledgerEntryTypeEnum } from './enums.js';

/**
 * Append-only ledger (PLAN 5.6). buddha_app holds INSERT/SELECT only (migration
 * 0001_restrict_app_role). `amount_p` carries the sign; `balance_after_p` snapshots
 * balances.available_p after this entry, for audits.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    type: ledgerEntryTypeEnum().notNull(),
    amountP: bigint({ mode: 'bigint' }).notNull(),
    balanceAfterP: bigint({ mode: 'bigint' }).notNull(),
    /** 'payment' | 'fill' | 'market' | 'admin_action' (LEDGER_REF_TYPES in @buddha/shared). */
    refType: varchar({ length: 32 }),
    refId: text(),
    memo: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_user_id_created_at_idx').on(t.userId, desc(t.createdAt)),
    index('ledger_entries_ref_type_ref_id_idx').on(t.refType, t.refId),
  ],
);
