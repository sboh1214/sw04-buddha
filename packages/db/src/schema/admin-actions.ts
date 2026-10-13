import { desc } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';

/**
 * Append-only admin audit log (PLAN 6.2, 12). buddha_app holds INSERT/SELECT only.
 * `type`: ADMIN_ACTION_TYPES in @buddha/shared. ADMIN_ADJUST ledger entries reference `id`.
 */
export const adminActions = pgTable(
  'admin_actions',
  {
    id: uuid().primaryKey().defaultRandom(),
    adminId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    type: varchar({ length: 40 }).notNull(),
    targetType: varchar({ length: 32 }),
    targetId: text(),
    payload: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * One type's records, newest first, with the row-comparison cursor (`keysetPredicate`):
     * `GET /admin/release-settings/changes` (#170), and the release_settings constraint trigger
     * that looks up a change's row by type and instant (migration 0020).
     */
    index('admin_actions_type_created_at_id_idx').on(t.type, desc(t.createdAt), desc(t.id)),
  ],
);
