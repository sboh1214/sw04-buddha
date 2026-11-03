import {
  APPROVAL_REASON_MAX_LENGTH,
  DISPUTE_LINKS_MAX,
  DISPUTE_REASON_MAX,
  HOLDING_DISPUTE_STATUSES,
  MARKET_DISPUTE_DECISION_STATUSES,
  MARKET_DISPUTE_STATUSES,
  type MarketDisputeStatus,
} from '@buddha/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { marketJudgements } from './market-judgements.js';

/** A tuple of @buddha/shared as the SQL list a CHECK or an index holds a column to (quoted). */
const sqlList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

/** A constant of @buddha/shared as the SQL literal a CHECK compares with. */
const literal = (value: number) => sql.raw(String(value));

const STATUSES_SQL = sqlList(MARKET_DISPUTE_STATUSES);
/** The statuses a decision gives (`dismissed`, `accepted`): a decider, an instant, a reason. */
const DECIDED_SQL = sqlList(Object.values(MARKET_DISPUTE_DECISION_STATUSES));

/**
 * The statuses that hold a market's confirmation (`pending`, `accepted`), literally, as the hold's
 * queries spell them too (market-dispute.ts), so the planner proves they imply the index's WHERE.
 */
const HOLDING_SQL = sqlList(HOLDING_DISPUTE_STATUSES);

/**
 * When an ended dispute ended — its decision, its 철회 or its closure by a correction (#176), one of
 * them exactly — as the 처리됨 index, its reader and the purge CHECK spell it.
 */
const endedAtOf = (t: {
  decidedAt: AnyPgColumn;
  retractedAt: AnyPgColumn;
  closedAt: AnyPgColumn;
}) => sql`coalesce(${t.decidedAt}, ${t.retractedAt}, ${t.closedAt})`;

/**
 * 판정 이의 (#175, ADR-0104; ADR-0093 decision 1 #173 items 1·2·5–8·13): one row per dispute a
 * member submitted against a provisional result, written by `submitMarketDispute` (@buddha/db)
 * under the market lock while the 이의 기한 is ahead, and ended once — dismissed or accepted by an
 * admin other than the version's registrant (`decideMarketDispute`), retracted by its submitter
 * within the deadline (`retractMarketDispute`), or closed by the approval of a correction that
 * replaced its version while it was pending (`closeDisputesForCorrection`, #176, ADR-0105; #173
 * item 8 '정정으로 종결'). One move back: an accepted one returns to pending when the correction
 * registered for it is rejected or retracted (`reopenAcceptedDisputes`, owner answer 2026-11-02),
 * and is decided again. Not `disputes`: that M5 table was dropped with its flow (migration 0016),
 * and a sanction appeal (제재 이의) is email, apart (ADR-0084).
 *
 * - `market_id` + `judgement_version`: the judgement disputed (a composite foreign key to
 *   `market_judgements`), the market's current one at the submission — a correction (#176) makes
 *   a new version, and its submitters may dispute that one again (#173 item 8).
 * - `user_id`: the submitter, a member with a fill on the market (`hasMarketFill`), never an admin.
 *   One dispute per member per version, whatever became of it: a retracted one still counts, so a
 *   dispute is never edited by retracting and submitting again (#173 item 6 '고칠 수는 없다').
 * - `links` (근거 링크, 1..DISPUTE_LINKS_MAX, no null among them; each http(s), ≤ 500 characters,
 *   distinct — the body schema's) and `reason` (trimmed non-blank, ≤ DISPUTE_REASON_MAX): both
 *   required (#173 item 6), the submitter's and the operators' alone (#173 item 13).
 * - `status`: MARKET_DISPUTE_STATUSES — a varchar(20) held by a CHECK; `closed_by_correction`
 *   (정정으로 종결, exactly 20 characters) came with #176's migration 0057.
 * - `decided_by`, `decided_at`, `decision_reason` (approvalReasonSchema's 1..500): exactly for a
 *   dismissed or accepted one — the reason the submitter reads (#173 item 7) and #24 publishes
 *   without the decider (#173 item 13); cleared when a rejected or retracted correction sends an
 *   accepted one back to pending (the acceptance stays in `admin_actions` and the frozen request).
 *   `retracted_at`: exactly for a retracted one. `closed_at`: exactly for one closed by a
 *   correction — the approval's instant; who approved it and the version it made are that
 *   version's `market_judgements` row (#176). None before the submission.
 * - `purged_at`: when the retention emptied a closed account's dispute in place, once it held
 *   nothing (`retention.moderation_records`, ADR-0087 (6)) — `links` '{}' and `reason` '' from then
 *   on, the row kept so #24's count and statuses survive. Never a pending one, and never before
 *   its end.
 *
 * The hold (#173 items 1·7): a dispute of the market's current version that is `pending` or
 * `accepted` keeps its PROVISIONAL market from confirmation — `confirmationHold` and the worker's
 * scan read it here, by the partial index below; `markets.dispute_hold_count` mirrors the count
 * for the labels alone.
 *
 * Permanent facts (N04 §5) but for the retention's emptying: buddha_app has no DELETE, and a
 * trigger (migrations 0056, 0057) refuses a DELETE whoever writes and lets an UPDATE only take a
 * pending dispute to dismissed, accepted, retracted or closed_by_correction, or an accepted one
 * back to pending — with what the submission recorded unchanged — or empty an ended one's links
 * and reason, once. The judgement and the accounts RESTRICT.
 */
export const marketDisputes = pgTable(
  'market_disputes',
  {
    id: uuid().primaryKey().defaultRandom(),
    marketId: uuid().notNull(),
    judgementVersion: integer().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    links: text().array().notNull(),
    reason: text().notNull(),
    status: varchar({ length: 20 }).$type<MarketDisputeStatus>().notNull().default('pending'),
    /** The database clock after the market lock (`now < dispute_deadline`). */
    submittedAt: timestampTz().notNull(),
    decidedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    decidedAt: timestampTz(),
    decisionReason: text(),
    retractedAt: timestampTz(),
    /** 정정으로 종결 (#176): the approval of the correction that replaced its version. */
    closedAt: timestampTz(),
    purgedAt: timestampTz(),
  },
  (t) => [
    foreignKey({
      name: 'market_disputes_judgement_fk',
      columns: [t.marketId, t.judgementVersion],
      foreignColumns: [marketJudgements.marketId, marketJudgements.version],
    }).onDelete('restrict'),
    /** One per member per judgement version, a retracted one included (#173 item 6). */
    unique('market_disputes_market_id_judgement_version_user_id_unique').on(
      t.marketId,
      t.judgementVersion,
      t.userId,
    ),
    check('market_disputes_status_check', sql`${t.status} IN (${STATUSES_SQL})`),
    /**
     * 근거 링크: 1..DISPUTE_LINKS_MAX in one dimension with no null among them — or none at all once
     * the retention emptied them.
     */
    check(
      'market_disputes_links_check',
      sql`(${t.purgedAt} IS NULL AND array_ndims(${t.links}) = 1 AND cardinality(${t.links}) BETWEEN 1 AND ${literal(DISPUTE_LINKS_MAX)} AND array_position(${t.links}, NULL) IS NULL) OR (${t.purgedAt} IS NOT NULL AND ${t.links} = '{}')`,
    ),
    /** 사유: trimmed non-blank, ≤ DISPUTE_REASON_MAX — or '' once the retention emptied it. */
    check(
      'market_disputes_reason_check',
      sql`(${t.purgedAt} IS NULL AND btrim(${t.reason}) <> '' AND char_length(${t.reason}) <= ${literal(DISPUTE_REASON_MAX)}) OR (${t.purgedAt} IS NOT NULL AND ${t.reason} = '')`,
    ),
    /**
     * The decision: decider, instant and reason exactly for a dismissed or accepted dispute, the
     * reason as an approval's (1..500, trimmed non-blank), never before the submission.
     */
    check(
      'market_disputes_decision_check',
      sql`(${t.status} IN (${DECIDED_SQL})) = (${t.decidedBy} IS NOT NULL) AND (${t.status} IN (${DECIDED_SQL})) = (${t.decidedAt} IS NOT NULL) AND (${t.status} IN (${DECIDED_SQL})) = (${t.decisionReason} IS NOT NULL) AND (${t.decisionReason} IS NULL OR (btrim(${t.decisionReason}) <> '' AND char_length(${t.decisionReason}) <= ${literal(APPROVAL_REASON_MAX_LENGTH)})) AND (${t.decidedAt} IS NULL OR ${t.decidedAt} >= ${t.submittedAt})`,
    ),
    /** The retraction: its instant exactly for a retracted dispute, never before the submission. */
    check(
      'market_disputes_retracted_check',
      sql`(${t.status} = 'retracted') = (${t.retractedAt} IS NOT NULL) AND (${t.retractedAt} IS NULL OR ${t.retractedAt} >= ${t.submittedAt})`,
    ),
    /**
     * 정정으로 종결 (#176): its instant exactly for a dispute a correction closed, never before the
     * submission.
     */
    check(
      'market_disputes_closed_check',
      sql`(${t.status} = 'closed_by_correction') = (${t.closedAt} IS NOT NULL) AND (${t.closedAt} IS NULL OR ${t.closedAt} >= ${t.submittedAt})`,
    ),
    /** Emptied only once it ended — decided, retracted or closed — and not before that. */
    check(
      'market_disputes_purged_check',
      sql`${t.purgedAt} IS NULL OR (${t.status} <> 'pending' AND ${t.purgedAt} >= ${endedAtOf(t)})`,
    ),
    /**
     * The hold (`confirmationHold`, the worker's confirmation scan): a version's disputes that
     * keep its market PROVISIONAL. Partial: most disputes end dismissed or retracted.
     */
    index('market_disputes_holding_idx')
      .on(t.marketId, t.judgementVersion)
      .where(sql`${t.status} IN (${HOLDING_SQL})`),
    /** 이의 접수's 검토 대기 (`GET /admin/market-disputes?status=pending`): the oldest first. */
    index('market_disputes_pending_submitted_at_idx')
      .on(t.submittedAt, t.id)
      .where(sql`${t.status} = 'pending'`),
    /**
     * 이의 접수's 처리됨 (`?status=decided`): the latest decision, retraction or closure first, as
     * the reader spells the key (`coalesce(decided_at, retracted_at, closed_at)`, then the id).
     */
    index('market_disputes_ended_at_idx')
      .on(endedAtOf(t), t.id)
      .where(sql`${t.status} <> 'pending'`),
    /** MY 판정 이의 (`GET /me/disputes`): a member's, the newest first; the retention's join. */
    index('market_disputes_user_id_submitted_at_idx').on(t.userId, t.submittedAt, t.id),
  ],
);
