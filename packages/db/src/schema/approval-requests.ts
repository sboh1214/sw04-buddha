import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { approvalStatusEnum } from './enums.js';

/**
 * Two-person rule requests (#171; approvals.ts in @buddha/shared): one row per piece of work that
 * waits for another admin's decision. `kind` names the work (APPROVAL_KIND_PATTERN) and the
 * consumer that registers it owns `target_*` and `payload`.
 *
 * The request columns never change after the INSERT, and a decision is written once, by an
 * admin: triggers (migration 0021) refuse an INSERT that is not pending with no decision, any
 * UPDATE of a decided row, any change of a request column and a decision naming an account that
 * does not hold the admin role as it decides (read under the shared admin-roles lock, which every
 * UPDATE takes before locking a row, as ApprovalService does), and the CHECKs below tie the
 * decision columns to the status and refuse a decision by the requester — whatever the writer, in
 * every environment. buddha_app cannot DELETE a row, so the table is the record of who requested,
 * who decided, when and why. Only the API's ApprovalService writes it.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: varchar({ length: 40 }).notNull(),
    targetType: varchar({ length: 32 }),
    targetId: text(),
    payload: jsonb().$type<Record<string, unknown>>(),
    requestedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    requestReason: text().notNull(),
    /** Written explicitly, from the database clock. */
    requestedAt: timestampTz().notNull(),
    status: approvalStatusEnum().notNull().default('pending'),
    /** The deciding admin, its reason and instant: all three null exactly while `pending`. */
    decidedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    decisionReason: text(),
    decidedAt: timestampTz(),
  },
  (t) => [
    check(
      'approval_requests_decision_check',
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decisionReason} IS NULL)`,
    ),
    check(
      'approval_requests_decider_not_requester_check',
      sql`${t.decidedBy} IS DISTINCT FROM ${t.requestedBy}`,
    ),
    check(
      'approval_requests_reasons_check',
      sql`btrim(${t.requestReason}) <> '' AND btrim(${t.decisionReason}) IS DISTINCT FROM ''`,
    ),
  ],
);
