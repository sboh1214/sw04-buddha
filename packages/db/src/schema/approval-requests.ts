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
 *
 * The market review (#78, ADR-0099) — `kind` `market_review` (target `market`, the market's id as
 * text; payload `{title}`): the submission's request, pending exactly while the market is in
 * REVIEW. The approval (→ SCHEDULED) approves it and a 반려 (→ DRAFT) rejects it, each by an admin
 * other than the creator, the market's editors and the submitter (ADR-0093 decision 2 #172 item 5;
 * the CHECK below holds the last); a 되돌리기 in REVIEW retracts it when its requester sends the
 * market back, and rejects it with the 되돌리기's reason when another admin does. The market's
 * `market_events` rows name the request (`approvalId`); nothing references it by a foreign key.
 *
 * The rule supplement (#80, ADR-0101; ADR-0093 decision 2 #172 item 15) — `kind`
 * `market_supplement` (target `market`, the market's id as text; payload `{baseVersion, changes,
 * settlementImpact}`, the supplement's reason the request's): at most one waits per market, which
 * the API holds under the market lock. An admin other than its requester approves it — the
 * market's next rule version, whose row references it (`market_rule_versions.approval_id`,
 * migration 0053) — or rejects it, and its requester may retract it, in any status.
 *
 * The next path of a paused market (#114, ADR-0102; ADR-0093 decision 1 #173 items 2·4) — `kind`
 * `market_pause_decision` (target `market`, the market's id as text; payload `{pauseId, path,
 * reviewResult}`, the request's reason the requester's): 재개 or 조기 마감 of the pause it names, at
 * most one waiting per market, which the API holds under the market lock. An admin other than its
 * requester approves it — the pause's end, whose row references it
 * (`market_pauses.end_approval_id`, migration 0054) — or rejects it, and its requester may retract
 * it, in any status; once the market left that pause (closed at its close) its approval is refused.
 *
 * A CLOSED market's judgement (#152, ADR-0103; ADR-0093 decision 1 #173 item 1, decision 3 the
 * #152 rows), or a PROVISIONAL one's 판정 정정 (#176, ADR-0105; #173 items 2·8) — `kind`
 * `market_judgement` (target `market`, the market's id as text; payload `{result, source,
 * fallbackReason, voidReason, evidence, ruleVersion, correction}`, the registration with the
 * source's name and address copied from the rules, `correction` null for a first judgement and
 * `{baseVersion, reason, disputeIds}` for a correction — a row before #176 has no key; the
 * request's reason the description of what was confirmed): at most one waiting per market, which
 * the API holds under the market lock, and while one waits the market's confirmation is held
 * (`confirmationHold`, by the two indexes below). An admin other than its registrant
 * approves it — CLOSED → PROVISIONAL, or the next version of a PROVISIONAL market, and the
 * market's next judgement, whose row references it (`market_judgements.approval_id`, migration
 * 0055) — or rejects it, and its registrant may retract it, in any status; a market that left the
 * status it needs refuses its approval.
 *
 * #184's retention deletes none of the market kinds (migration 0044 names the account
 * restriction's kinds alone).
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
     * `retracted` (no one decided it). A request about a member who closed their account while it
     * waited is `rejected` by no admin (#140, owner decision 2026-10-23, ADR-0085 결과 5): the
     * reason '탈퇴' and the instant of the closure, and `decided_by` null — the one rejection without
     * a decider, which migration 0043's trigger allows for such a request only.
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
     * Migration 0043 lets a rejection go without a decider (#140: the closure's); every other
     * decision names its admin.
     */
    check(
      'approval_requests_decision_check',
      sql`(${t.status}::text IN ('pending', 'retracted')) = (${t.decidedAt} IS NULL) AND (${t.decidedAt} IS NULL) = (${t.decisionReason} IS NULL) AND (${t.decidedBy} IS NULL OR ${t.decidedAt} IS NOT NULL) AND (${t.decidedBy} IS NOT NULL OR ${t.status}::text <> 'approved') AND (${t.status}::text = 'retracted') = (${t.retractedAt} IS NOT NULL)`,
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
     * the action's uuid — and a market's waiting `market_judgement` request, the confirmation's
     * hold (#176, `marketConfirmationHeld`).
     */
    index('approval_requests_target_idx').on(t.targetType, t.targetId),
    /**
     * The requests waiting for a decision, the oldest first (#139's queue of requests) — and the
     * waiting `market_judgement` ones the worker's confirmation scan hashes (#176).
     */
    index('approval_requests_pending_requested_at_idx')
      .on(t.requestedAt, t.id)
      .where(sql`${t.status} = 'pending'`),
  ],
);
