import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
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
 *
 * A request may instead be retracted by its requester before any decision, where its consumer
 * allows that (#139, migration 0042): `retracted`, with its instant (`retracted_at`) and no
 * decision — decided by no one, and as final as a decision (the triggers above refuse any change
 * of a row no longer pending). Who retracted it is its requester: ApprovalService lets no one else.
 *
 * Consumers: the account restriction (#139, ADR-0085) — `kind` `account_restriction` (target
 * `user`, the member), `account_restriction_shorten`, `account_restriction_lift` and
 * `account_restriction_cancel` (target `moderation_action`, the restriction); the action rows its
 * approvals bring in name them (`moderation_actions.approval_id`, `cancel_approval_id`,
 * `restriction_end_changes.approval_id`, migration 0042). Its requests may be retracted.
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
    /**
     * The deciding admin, its reason and instant: all three null exactly while `pending` and once
     * `retracted` (no one decided it).
     */
    decidedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    decisionReason: text(),
    decidedAt: timestampTz(),
    /**
     * When its requester retracted it (#139, migration 0042): set exactly when `retracted`, from
     * the database clock.
     */
    retractedAt: timestampTz(),
  },
  (t) => [
    /**
     * `status` compared as text: migration 0042 adds `retracted` to the enum in the batch that
     * replaces this CHECK, which cannot name the new value as the enum (55P04, migration 0014).
     */
    check(
      'approval_requests_decision_check',
      sql`(${t.status}::text IN ('pending', 'retracted')) = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decisionReason} IS NULL) AND (${t.status}::text = 'retracted') = (${t.retractedAt} IS NOT NULL)`,
    ),
    check(
      'approval_requests_decider_not_requester_check',
      sql`${t.decidedBy} IS DISTINCT FROM ${t.requestedBy}`,
    ),
    check(
      'approval_requests_reasons_check',
      sql`btrim(${t.requestReason}) <> '' AND btrim(${t.decisionReason}) IS DISTINCT FROM ''`,
    ),
    /**
     * A target's requests (#139, migration 0042): a member's account restriction requests on their
     * moderation page, and a restriction's own — `target_id` is text, the member's account id or
     * the action's uuid.
     */
    index('approval_requests_target_idx').on(t.targetType, t.targetId),
    /** The requests waiting for a decision, the oldest first (#139's queue of requests). */
    index('approval_requests_pending_requested_at_idx')
      .on(t.requestedAt, t.id)
      .where(sql`${t.status} = 'pending'`),
  ],
);
