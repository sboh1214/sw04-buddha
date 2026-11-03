import {
  APPROVAL_REASON_MAX_LENGTH,
  DISPUTE_WINDOW_MAX_MINUTES,
  DISPUTE_WINDOW_MIN_MINUTES,
  JUDGEMENT_EVIDENCE_LINKS_MAX,
  MARKET_FALLBACK_SOURCES_MAX,
  MARKET_SOURCE_MAX,
  MARKET_SOURCE_URL_MAX,
} from '@buddha/shared';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { approvalRequests } from './approval-requests.js';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { marketResultEnum } from './enums.js';
import { marketEvents } from './market-events.js';
import { markets } from './markets.js';

/** A constant of @buddha/shared as the SQL literal a CHECK compares with. */
const literal = (value: number) => sql.raw(String(value));

/** A reason or a description as the approval requests hold one: trimmed non-blank, ≤ 500. */
const reasonText = (column: AnyPgColumn): SQL =>
  sql`btrim(${column}) <> '' AND char_length(${column}) <= ${literal(APPROVAL_REASON_MAX_LENGTH)}`;

/**
 * 판정 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·5·9·13, decision 3 the #152 rows): every
 * approved judgement of a market, numbered from 1 — v1 is the first approved one, and only
 * approved ones take a number (#176's corrections add v2 on). Written by `approveMarketJudgement`
 * (@buddha/db) in the transaction of its CLOSED → PROVISIONAL `provisional` event, when an admin
 * other than the registrant approves a `market_judgement` approval request (#171): the
 * registration is that request's frozen payload and reason, copied here; a rejected or retracted
 * registration stays in `approval_requests` alone. `markets.judgement_version` names the current
 * one and `markets.dispute_deadline` mirrors its deadline.
 *
 * - `result`: YES, NO or VOID — VOID is chosen here and nowhere before the close (#173 item 4).
 * - The source (decision 3 '판정 출처'): `source_priority` (0 the 1차 출처, 1..3 the 대체 출처 in
 *   order, `market_sources.priority`, ADR-0097) with its `source_name` and `source_url` copied from
 *   the rules at the registration — all three or none, and none only for a VOID (a source outside
 *   the rules is 판정 불가·VOID; a market opened before #23 has none). `fallback_reason`: why the
 *   primary could not be used, exactly for a fallback source. `void_reason`: exactly for a VOID,
 *   public with the record (#173 item 13, #24).
 * - The evidence (decision 3 '증거'): `evidence_links` (1..JUDGEMENT_EVIDENCE_LINKS_MAX, no null
 *   among them; no files), `evidence_description` (what was confirmed: the request's reason) and
 *   `collected_at` (never after the publication).
 * - `rule_version`: the rule version the judgement followed (ADR-0101 결과 5), the market's at the
 *   registration — null for a market opened before #80.
 * - `event_deadline_confirmed`: whether the approver confirmed the NO condition's event deadline —
 *   required before the scheduled judgement (decision 3 '등록 시점', the API's), false otherwise.
 * - 이의 기한 (#173 item 5): `dispute_window_minutes`, the release setting `market.dispute_window` as
 *   the approval read it, `published_at`, the approval's instant (the `provisional` event's), and
 *   `dispute_deadline`, exactly the one plus the other — fixed then, never moved by a later change
 *   of the setting; #176 reuses the length for a correction's deadline.
 * - `approval_id` (one judgement per request), `registered_by` (its requester — never a decider of
 *   its 판정 이의, `decideMarketDispute`, #175), `approved_by` (never the registrant, ADR-0056 1-1) and
 *   `provisional_event_id`. Admins only, with every reason, until #24 publishes the record without
 *   the two accounts.
 *
 * Permanent facts (N04 §5): no retention, nothing rewrites or deletes one. buddha_app may INSERT
 * and SELECT only, and a trigger refuses an UPDATE or a DELETE whoever writes (migration 0055).
 * The market, the request, the event and the accounts RESTRICT.
 */
export const marketJudgements = pgTable(
  'market_judgements',
  {
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    /** 1 for the first approved judgement, then one more per correction (#176). */
    version: integer().notNull(),
    result: marketResultEnum().notNull(),
    sourcePriority: smallint(),
    sourceName: varchar({ length: MARKET_SOURCE_MAX }),
    sourceUrl: varchar({ length: MARKET_SOURCE_URL_MAX }),
    fallbackReason: text(),
    voidReason: text(),
    evidenceLinks: text().array().notNull(),
    evidenceDescription: text().notNull(),
    collectedAt: timestampTz().notNull(),
    ruleVersion: integer(),
    eventDeadlineConfirmed: boolean().notNull(),
    disputeWindowMinutes: integer().notNull(),
    publishedAt: timestampTz().notNull(),
    disputeDeadline: timestampTz().notNull(),
    approvalId: uuid()
      .notNull()
      .unique('market_judgements_approval_id_unique')
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    registeredBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    approvedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    provisionalEventId: bigint({ mode: 'number' })
      .notNull()
      .references(() => marketEvents.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.version] }),
    check('market_judgements_version_check', sql`${t.version} >= 1 AND ${t.ruleVersion} >= 1`),
    /**
     * The source: priority, name and address together or none; a priority of the rules
     * (0..MARKET_FALLBACK_SOURCES_MAX); none only for a VOID.
     */
    check(
      'market_judgements_source_check',
      sql`(${t.sourcePriority} IS NULL) = (${t.sourceName} IS NULL) AND (${t.sourcePriority} IS NULL) = (${t.sourceUrl} IS NULL) AND ${t.sourcePriority} BETWEEN 0 AND ${literal(MARKET_FALLBACK_SOURCES_MAX)} AND (${t.sourcePriority} IS NOT NULL OR ${t.result} = 'VOID')`,
    ),
    /** The reason the primary could not be used: exactly for a fallback source (priority ≥ 1). */
    check(
      'market_judgements_fallback_reason_check',
      sql`(${t.fallbackReason} IS NOT NULL) = (coalesce(${t.sourcePriority}, 0) >= 1) AND (${t.fallbackReason} IS NULL OR (${reasonText(t.fallbackReason)}))`,
    ),
    /** A VOID's reason: exactly for a VOID. */
    check(
      'market_judgements_void_reason_check',
      sql`(${t.voidReason} IS NOT NULL) = (${t.result} = 'VOID') AND (${t.voidReason} IS NULL OR (${reasonText(t.voidReason)}))`,
    ),
    /**
     * The evidence: 1..JUDGEMENT_EVIDENCE_LINKS_MAX links in one dimension with no null among them,
     * the description as a request's reason, collected no later than the publication.
     */
    check(
      'market_judgements_evidence_check',
      sql`array_ndims(${t.evidenceLinks}) = 1 AND cardinality(${t.evidenceLinks}) BETWEEN 1 AND ${literal(JUDGEMENT_EVIDENCE_LINKS_MAX)} AND array_position(${t.evidenceLinks}, NULL) IS NULL AND ${reasonText(t.evidenceDescription)} AND ${t.collectedAt} <= ${t.publishedAt}`,
    ),
    /** The window as the setting allows it, and the deadline exactly the publication plus it. */
    check(
      'market_judgements_dispute_check',
      sql`${t.disputeWindowMinutes} BETWEEN ${literal(DISPUTE_WINDOW_MIN_MINUTES)} AND ${literal(DISPUTE_WINDOW_MAX_MINUTES)} AND ${t.disputeDeadline} = ${t.publishedAt} + make_interval(mins => ${t.disputeWindowMinutes})`,
    ),
    /** The two-person rule its request's CHECK holds too (ADR-0056 1-1, decision 3 '역할'). */
    check('market_judgements_approver_check', sql`${t.approvedBy} <> ${t.registeredBy}`),
  ],
);
