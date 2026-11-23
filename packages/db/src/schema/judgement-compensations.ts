import { APPROVAL_REASON_MAX_LENGTH } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { approvalRequests } from './approval-requests.js';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { ledgerEntries } from './ledger.js';
import { marketJudgementIncidents } from './market-judgement-incidents.js';
import { markets } from './markets.js';

/** A constant of @buddha/shared as the SQL literal a CHECK compares with. */
const literal = (value: number) => sql.raw(String(value));

/**
 * What became of one listed account at the approval (`judgement_compensations.outcome`, 144-7):
 * `paid` — its JUDGEMENT_COMPENSATION entry was written; `closed` — its member had closed it, so
 * no ledger event could be written for it ('탈퇴로 지급 못 함'). Never `withdrawn` (an excluded
 * token: the cash-out).
 */
export const JUDGEMENT_COMPENSATION_OUTCOMES = ['paid', 'closed'] as const;
export type JudgementCompensationOutcome = (typeof JUDGEMENT_COMPENSATION_OUTCOMES)[number];

/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-1·144-2·144-4·144-7·144-12·144-16; ADR-0107
 * 결정 2 #73 3·8항): one row per account a confirmed 판정 오류 사건's approved compensation request
 * listed — written by `payJudgementCompensation` (@buddha/db) in the transaction that approves the
 * `market_judgement_compensation` request, at the decision's instant, and never changed.
 *
 * - `incident_id` / `market_id`: the confirmed incident (`market_judgement_incidents`) and its
 *   market (the incident's, denormalised for the wallet's and the recap's joins); UNIQUE
 *   (`incident_id`, `user_id`): an account is compensated once per incident — one incident per
 *   market (144-14), so once per market — whatever happens to the requests (144-2).
 * - `user_id` / `amount_coin`: the account and what the correction owes it — Σ qty × the corrected
 *   result's per-contract payout − Σ the paid payouts over its settlement records of the market,
 *   above 0 (144-1). Migration 0081's trigger recomputes it (`judgement_compensation_owed`), so no
 *   one writes an amount the settlement records do not support ("관리자는 금액을 고치지 않는다").
 * - `outcome` (`JUDGEMENT_COMPENSATION_OUTCOMES`) and `ledger_entry_id`: a `paid` row names its
 *   JUDGEMENT_COMPENSATION entry (UNIQUE: one entry backs one row), a `closed` one none (144-7).
 * - `user_reason`: 회원에게 보일 사유 (144-12), the request's, copied into each row — the wallet reads
 *   it beside the entry. Never the internal reasons, never an admin.
 * - `approval_id` / `requested_by` / `approved_by`: the approved request, its requester and its
 *   approver (#171: never the same; 144-4: never the paid judgement version's registrant). Admins
 *   only: no member-facing read names them.
 * - `applied_txid` / `created_at`: the approving transaction (`pg_current_xact_id()`) and the
 *   decision's instant (the request's `decided_at`, every entry's `created_at`).
 *
 * Permanent facts (N04 §5): buddha_app may INSERT and SELECT only, and a trigger refuses an UPDATE
 * or a DELETE whoever writes. Migration 0081's triggers hold a row to its approved request (kind,
 * target, requester, approver, instant, the frozen recipient and amount, the members' reason), its
 * confirmed incident, the recomputed amount, a person's account, the closure read under the lock,
 * a market not ledger-held (#93), and a `paid` row to its own entry; an entry of the type to its
 * row; and an approved request to exactly its listed rows, all written by the approving
 * transaction.
 */
export const judgementCompensations = pgTable(
  'judgement_compensations',
  {
    /** The compensation event id: the JUDGEMENT_COMPENSATION entry's `ref_id`. */
    id: uuid().primaryKey().defaultRandom(),
    incidentId: uuid().notNull(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    approvalId: uuid()
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    /** What the correction owes the account, above 0 (144-1). */
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    /** `paid` or `closed` (JUDGEMENT_COMPENSATION_OUTCOMES, 144-7). */
    outcome: varchar({ length: 16 }).$type<JudgementCompensationOutcome>().notNull(),
    /** The entry that paid it; null for a `closed` row. */
    ledgerEntryId: bigint({ mode: 'number' })
      .unique('judgement_compensations_ledger_entry_id_unique')
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    /** 회원에게 보일 사유 (144-12). */
    userReason: text().notNull(),
    requestedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    approvedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** The approving transaction's id (`pg_current_xact_id()::text`). */
    appliedTxid: text().notNull(),
    /** The decision's instant: the request's `decided_at`, the entry's `created_at`. */
    createdAt: timestampTz().notNull(),
  },
  (t) => [
    /** The confirmed incident (named: the generated name passes Postgres' 63 bytes). */
    foreignKey({
      name: 'judgement_compensations_incident_fk',
      columns: [t.incidentId],
      foreignColumns: [marketJudgementIncidents.id],
    }).onDelete('restrict'),
    /** Once per account per incident (144-2). */
    unique('judgement_compensations_incident_id_user_id_unique').on(t.incidentId, t.userId),
    check('judgement_compensations_amount_check', sql`${t.amountCoin} > 0`),
    /** `paid` exactly when an entry backs the row (144-7: a closed account takes none). */
    check(
      'judgement_compensations_outcome_check',
      sql`${t.outcome} IN ('paid', 'closed') AND (${t.outcome} = 'paid') = (${t.ledgerEntryId} IS NOT NULL)`,
    ),
    /** The members' reason as a request's reason (trimmed non-blank, ≤ 500). */
    check(
      'judgement_compensations_user_reason_check',
      sql`btrim(${t.userReason}) <> '' AND char_length(${t.userReason}) <= ${literal(APPROVAL_REASON_MAX_LENGTH)}`,
    ),
    /** Two people (#171). */
    check('judgement_compensations_approver_check', sql`${t.approvedBy} <> ${t.requestedBy}`),
    /** An account's compensation in a market: the recap's and the wallet's reads. */
    index('judgement_compensations_market_id_user_id_idx').on(t.marketId, t.userId),
    /** An approval's rows: the completeness check at COMMIT and the admin's list. */
    index('judgement_compensations_approval_id_idx').on(t.approvalId),
  ],
);
