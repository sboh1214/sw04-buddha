import { APPROVAL_REASON_MAX_LENGTH, JUDGEMENT_EVIDENCE_LINKS_MAX } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { approvalRequests } from './approval-requests.js';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { marketResultEnum } from './enums.js';
import { marketJudgements } from './market-judgements.js';
import { markets } from './markets.js';

/** A constant of @buddha/shared as the SQL literal a CHECK compares with. */
const literal = (value: number) => sql.raw(String(value));

/**
 * 판정 오류 사건 (#144 part 1, ADR-0165; owner answers 144-3·144-4·144-5·144-13·144-14): one row
 * per market whose paid result another admin confirmed wrong — written by
 * `recordMarketJudgementIncident` (@buddha/db) in the transaction that approves a
 * `market_judgement_incident` approval request (#171), at the decision's instant, and never
 * changed. A waiting, dismissed or retracted incident stays in `approval_requests` alone, like a
 * judgement's registration (only approved ones get a `market_judgements` row).
 *
 * The corrected result lives here and nowhere else: `markets.resolved_result`,
 * `judgement_version`, `status_event_id` and the settlement records keep the paid result (the
 * settlement books, the #93 reconciliation and the recall check all compare them with each other),
 * and readers show `coalesce(corrected_result, resolved_result)` (`effectiveResultSql`).
 *
 * - `market_id`: UNIQUE — one confirmed incident per market (144-14), the key every reader's LEFT
 *   JOIN takes.
 * - `judgement_version` / `original_result`: the paid version and its result, the market's own at
 *   the confirmation (composite FK to `market_judgements`); `corrected_result` differs from it.
 * - `description` (오류 내용, the request's reason), `evidence_links` (1..JUDGEMENT_EVIDENCE_LINKS_MAX)
 *   and `evidence_collected_at` — the request's, public with the record (#173 item 13).
 * - `approval_id` (one incident per request), `registered_by` (its requester) and `registered_at`
 *   (its `requested_at`), `confirmed_by` and `confirmed_at` (its decider and `decided_at`), and
 *   `paid_registered_by` — the paid version's `market_judgements.registered_by`, whom 144-4 bars
 *   from the review as the CHECK holds. Admins only: the public record names no one.
 * - `applied_txid`: the confirming transaction (`pg_current_xact_id()`), so a row written later
 *   than its approval is refused (migration 0080's triggers).
 *
 * Permanent facts (N04 §5): buddha_app may INSERT and SELECT only, and a trigger refuses an UPDATE
 * or a DELETE whoever writes. Migration 0080's BEFORE INSERT trigger holds a row to its SETTLED
 * market (144-13), the market's paid version and result, the paid version's registrant and its
 * approved request (kind, target, requester, decider, instants, reason and frozen payload); its
 * triggers on `approval_requests` refuse the paid version's registrant as the decider of an
 * incident, on a confirmation and a dismissal alike, and an approved incident request that
 * commits without its row.
 */
export const marketJudgementIncidents = pgTable(
  'market_judgement_incidents',
  {
    id: uuid().primaryKey().defaultRandom(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    /** The confirming transaction's id (`pg_current_xact_id()::text`). */
    appliedTxid: text().notNull(),
    /** The paid judgement version: the market's current one, which stays current. */
    judgementVersion: integer().notNull(),
    /** The paid result, `markets.resolved_result`. */
    originalResult: marketResultEnum().notNull(),
    /** 정정된 결과. */
    correctedResult: marketResultEnum().notNull(),
    /** 오류 내용: the request's reason. */
    description: text().notNull(),
    evidenceLinks: text().array().notNull(),
    evidenceCollectedAt: timestampTz().notNull(),
    approvalId: uuid()
      .notNull()
      .unique('market_judgement_incidents_approval_id_unique')
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    registeredBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** The paid version's registrant (144-4: never the confirmer). */
    paidRegisteredBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    confirmedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** The request's `requested_at`. */
    registeredAt: timestampTz().notNull(),
    /** The request's `decided_at`: the decision's instant. */
    confirmedAt: timestampTz().notNull(),
  },
  (t) => [
    /** One confirmed incident per market (144-14). */
    unique('market_judgement_incidents_market_id_unique').on(t.marketId),
    foreignKey({
      name: 'market_judgement_incidents_judgement_fk',
      columns: [t.marketId, t.judgementVersion],
      foreignColumns: [marketJudgements.marketId, marketJudgements.version],
    }).onDelete('restrict'),
    check(
      'market_judgement_incidents_result_check',
      sql`${t.correctedResult} <> ${t.originalResult} AND ${t.judgementVersion} >= 1`,
    ),
    /** Two people (#171), neither of them the paid version's registrant (144-4). */
    check(
      'market_judgement_incidents_confirmer_check',
      sql`${t.confirmedBy} <> ${t.registeredBy} AND ${t.confirmedBy} <> ${t.paidRegisteredBy} AND ${t.confirmedAt} > ${t.registeredAt}`,
    ),
    /**
     * The evidence as a judgement's: 1..JUDGEMENT_EVIDENCE_LINKS_MAX links in one dimension with no
     * null among them, collected no later than the registration; the description as a request's
     * reason (trimmed non-blank, ≤ 500).
     */
    check(
      'market_judgement_incidents_evidence_check',
      sql`array_ndims(${t.evidenceLinks}) = 1 AND cardinality(${t.evidenceLinks}) BETWEEN 1 AND ${literal(JUDGEMENT_EVIDENCE_LINKS_MAX)} AND array_position(${t.evidenceLinks}, NULL) IS NULL AND ${t.evidenceCollectedAt} <= ${t.registeredAt} AND btrim(${t.description}) <> '' AND char_length(${t.description}) <= ${literal(APPROVAL_REASON_MAX_LENGTH)}`,
    ),
  ],
);
