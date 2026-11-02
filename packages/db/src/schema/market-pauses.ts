import {
  APPROVAL_REASON_MAX_LENGTH,
  MARKET_PAUSE_END_KINDS,
  MARKET_PAUSE_PATH_END_KINDS,
  MARKET_PAUSE_REASONS,
  MARKET_PAUSE_REVIEW_RESULTS,
  type MarketPauseEndKind,
  type MarketPauseReason,
  type MarketPauseReviewResult,
} from '@buddha/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { approvalRequests } from './approval-requests.js';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { marketEvents } from './market-events.js';
import { markets } from './markets.js';

/** A tuple of @buddha/shared as the SQL list a CHECK holds a column to (constants, quoted). */
const sqlList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

const REASONS_SQL = sqlList(MARKET_PAUSE_REASONS);
const REVIEW_RESULTS_SQL = sqlList(MARKET_PAUSE_REVIEW_RESULTS);
const END_KINDS_SQL = sqlList(MARKET_PAUSE_END_KINDS);
/** The ends an approved next path gives (`resumed`, `early_closed`): an approver and a request. */
const APPROVED_END_KINDS_SQL = sqlList(Object.values(MARKET_PAUSE_PATH_END_KINDS));

/**
 * 거래 일시 중단 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4·13, decision 3 '#114 조기 결과의
 * 공개 시각'): one row per pause of a market, written by `pauseMarket` (@buddha/db) in the
 * transaction of its OPEN → PAUSED `paused` event, and ended once, by `endMarketPause` (재개 or 조기
 * 마감, approved by an admin other than the requester) or by the worker's close at `close_at`
 * (`endPauseAtClose`). A market may pause again after a resume, so it may have several; at most one
 * lasts (no end) at a time — the partial unique index below — and it is the current pause of a
 * PAUSED market.
 *
 * - `reason`: MARKET_PAUSE_REASONS, these three only (#173 item 3). `note`: what happened, as the
 *   pausing admin wrote it (approvalReasonSchema's 1–500, trimmed); admins only for now.
 * - `result_published_at`: for `early_result` alone, the instant the operator confirmed the result
 *   was published (decision 3, UTC), never after the pause.
 * - `paused_at`, `paused_by`, `pause_event_id`: the pause's instant (the DB clock after the market
 *   lock), the admin and its `paused` event.
 * - `review_result`: MARKET_PAUSE_REVIEW_RESULTS — the review a `basis_change` pause's approved
 *   next path carried (owner answer Q1, 2026-11-02), and only then; `not_judgeable` ends only in an
 *   early close (#173 item 4: no reopening on rules that cannot judge it, VOID only after the
 *   close, #152).
 * - The end, all null while the pause lasts: `end_kind` (MARKET_PAUSE_END_KINDS), `ended_at` (never
 *   before the pause), `end_event_id` (the `resumed` or `closed` event); for `resumed` and
 *   `early_closed` also `ended_by` (the approver) and `end_approval_id` (the approved
 *   `market_pause_decision` request, one pause each); neither for `closed_at_close`, the worker's.
 *
 * Permanent facts (N04 §5): no retention, nothing deletes one. A trigger (migration 0054) refuses
 * a DELETE whoever writes and lets an UPDATE only end a lasting pause — its end columns and the
 * review result, once, with every other column as the pause wrote it; buddha_app has no DELETE
 * either. The market, the events, the request and the accounts RESTRICT. #24 reads the reason and
 * the pause and end times for the public judging record (#173 item 13).
 */
export const marketPauses = pgTable(
  'market_pauses',
  {
    id: uuid().primaryKey().defaultRandom(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    reason: varchar({ length: 40 }).$type<MarketPauseReason>().notNull(),
    note: text().notNull(),
    resultPublishedAt: timestampTz(),
    pausedAt: timestampTz().notNull(),
    pausedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    pauseEventId: bigint({ mode: 'number' })
      .notNull()
      .references(() => marketEvents.id, { onDelete: 'restrict' }),
    reviewResult: varchar({ length: 40 }).$type<MarketPauseReviewResult>(),
    endKind: varchar({ length: 40 }).$type<MarketPauseEndKind>(),
    endedAt: timestampTz(),
    /** The approving admin; null for the worker's close at `close_at`. */
    endedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    endEventId: bigint({ mode: 'number' }).references(() => marketEvents.id, {
      onDelete: 'restrict',
    }),
    endApprovalId: uuid()
      .unique('market_pauses_end_approval_id_unique')
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
  },
  (t) => [
    check('market_pauses_reason_check', sql`${t.reason} IN (${REASONS_SQL})`),
    check(
      'market_pauses_note_check',
      sql`btrim(${t.note}) <> '' AND char_length(${t.note}) <= ${sql.raw(String(APPROVAL_REASON_MAX_LENGTH))}`,
    ),
    /** The publication instant: exactly an `early_result` pause has one, never after the pause. */
    check(
      'market_pauses_result_published_at_check',
      sql`(${t.resultPublishedAt} IS NOT NULL) = (${t.reason} = 'early_result') AND (${t.resultPublishedAt} IS NULL OR ${t.resultPublishedAt} <= ${t.pausedAt})`,
    ),
    check('market_pauses_review_result_check', sql`${t.reviewResult} IN (${REVIEW_RESULTS_SQL})`),
    check('market_pauses_end_kind_check', sql`${t.endKind} IN (${END_KINDS_SQL})`),
    /**
     * The end: kind, instant and event together or none, never before the pause; an approver and an
     * approved request exactly for an approved path's end.
     */
    check(
      'market_pauses_end_check',
      sql`(${t.endKind} IS NULL) = (${t.endedAt} IS NULL) AND (${t.endKind} IS NULL) = (${t.endEventId} IS NULL) AND (${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.pausedAt}) AND (coalesce(${t.endKind}, '') IN (${APPROVED_END_KINDS_SQL})) = (${t.endApprovalId} IS NOT NULL) AND (coalesce(${t.endKind}, '') IN (${APPROVED_END_KINDS_SQL})) = (${t.endedBy} IS NOT NULL)`,
    ),
    /**
     * The review result: exactly a `basis_change` pause ended by an approved path has one, and
     * `not_judgeable` only by an early close.
     */
    check(
      'market_pauses_review_check',
      sql`(${t.reviewResult} IS NOT NULL) = (${t.reason} = 'basis_change' AND coalesce(${t.endKind}, '') IN (${APPROVED_END_KINDS_SQL})) AND (${t.reviewResult} IS DISTINCT FROM 'not_judgeable' OR ${t.endKind} = 'early_closed')`,
    ),
    /** One lasting pause per market: the current one of a PAUSED market. */
    uniqueIndex('market_pauses_market_id_lasting_unique')
      .on(t.marketId)
      .where(sql`${t.endedAt} IS NULL`),
    /** A market's pauses, the newest first (`readMarketPauses`, the admin detail). */
    index('market_pauses_market_id_paused_at_idx').on(t.marketId, t.pausedAt),
  ],
);
