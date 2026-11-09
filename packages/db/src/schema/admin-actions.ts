import { desc, sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';

/**
 * Append-only admin audit log (PLAN 6.2, 12). buddha_app holds INSERT/SELECT only.
 * `type`: ADMIN_ACTION_TYPES in @buddha/shared. A refund's PAYMENT_CANCEL entry is keyed by the
 * refund's `id` (`ledgerKeys.paymentCancel`, #116).
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
    /**
     * `GET /admin/admins/changes` (#171): grants and revokes together, newest first, with the
     * row-comparison cursor. Two types in one order, which the index above cannot walk as one.
     */
    index('admin_actions_role_change_created_at_id_idx')
      .on(desc(t.createdAt), desc(t.id))
      .where(sql`${t.type} IN ('admin_grant', 'admin_revoke')`),
    index('admin_actions_revocation_target_idx')
      .on(t.targetId, desc(t.createdAt), desc(t.id))
      .where(sql`${t.type} = 'admin_revoke' AND ${t.targetType} = 'user'`),
    /**
     * One market's records, oldest first (#78, ADR-0099; migration 0052). Read by the review's
     * editors lookup — every admin with a `market_update` or `market_reschedule` record on the
     * market, at any time, whom the approval and the 반려 exclude (ADR-0093 decision 2 #172 item
     * 5) — and by the seed's check for an admin edit of a seed draft. The 검수 기록 reads
     * `market_events`, not these. `target_id` is text (the market's uuid as text), as each
     * target's is.
     */
    index('admin_actions_market_target_idx')
      .on(t.targetId, t.createdAt)
      .where(sql`${t.targetType} = 'market'`),
  ],
);
