import {
  CURSOR_NULL,
  MARKET_JUDGEMENT_APPROVAL_KIND,
  OPERATIONS_CLOSING_WINDOW_HOURS,
  OPERATIONS_FAILURE_KINDS,
  OPERATIONS_STUCK_AFTER_MINUTES,
  SETTLEMENT_STEPS,
  adminOperationsClosingQuerySchema,
  adminOperationsFailuresQuerySchema,
  adminOperationsJudgementsQuerySchema,
  decodeTupleCursor,
  encodeTupleCursor,
  type AdminAwaitingJudgementMarket,
  type AdminAwaitingJudgementMarketPage,
  type AdminClosingMarketPage,
  type AdminOperationsClosingQuery,
  type AdminOperationsFailure,
  type AdminOperationsFailurePage,
  type AdminOperationsFailuresQuery,
  type AdminOperationsJudgementsQuery,
  type OperationsFailureKind,
  type OperationsRecallFailureReason,
  type OperationsStuckStage,
  type SettlementStepStatus,
} from '@buddha/shared';
import { and, asc, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Db } from './client.js';
import { ledgerHeldMarketSql, payoutDelayedSql } from './ledger-held-markets.js';
import {
  holdingDisputesOf,
  marketConfirmationHeld,
  waitingJudgementsOf,
} from './market-dispute.js';
import {
  approvalRequests,
  marketDisputes,
  marketEvents,
  marketJudgementDelays,
  marketMakerRecallAttempts,
  marketMakerRecalls,
  markets,
  marketSettlementSteps,
} from './schema/index.js';

/*
 * 운영 대기열의 세 목록 (#145, ADR-0163): 마감 예정 (145-1), 판정 대기·지연 (145-2, 145-11, 145-17)
 * and 정산 실패 with 처리 멈춤 and 봇 자금 회수 실패 (145-4, 145-8, 145-15). Each list is one statement
 * in its own REPEATABLE READ, READ ONLY transaction: one snapshot, and a structural proof that a
 * GET writes nothing (AC 3 — reaching a scheduled judgement, a next review or a long-delay
 * deadline changes no status and no result). Every comparison with the present reads the
 * transaction's `now()` (tests pass `asOf` to pin it). A malformed cursor reads the first page.
 *
 * Keyset pages are row comparisons whose keys and values are cast from closed unions, every
 * value a bound parameter (apps/api `tupleKeysetPredicate`'s rule): a millis value goes in as ISO
 * with `timestamptz`, `CURSOR_NULL` as `'infinity'`, the failures' kind order as `bigint`.
 */

/** Anything with a transaction (the pooled `Db`). */
type Transactional = Pick<Db, 'transaction'>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Test-only: the instant the lists compare with, instead of the transaction's `now()`. */
export interface OperationsReadOptions {
  asOf?: Date;
}

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

const nowOf = (options: OperationsReadOptions): SQL =>
  options.asOf === undefined ? sql`now()` : sql`${options.asOf.toISOString()}::timestamptz`;

/** A cursor key's cast — a closed union of literals this file writes (rendered with `sql.raw`). */
type KeyCast = 'bigint' | 'timestamptz' | 'uuid';

interface CursorKey {
  key: SQLWrapper;
  value: string;
  cast: KeyCast;
}

/** `(keys…) > (values…)`: the page after the cursor of an ascending order. */
function rowAfter(keys: readonly CursorKey[]): SQL {
  const row = sql.join(
    keys.map(({ key }) => sql`${key}`),
    sql`, `,
  );
  const values = sql.join(
    keys.map(({ value, cast }) => sql`${value}::${sql.raw(cast)}`),
    sql`, `,
  );
  return sql`(${row}) > (${values})`;
}

/** A cursor's millis as the ISO string `::timestamptz` takes. */
const isoOf = (millis: string): string => new Date(Number(millis)).toISOString();

/** An instant as epoch millis text, so a raw row reads it without the driver's parsers. */
const millisOf = (column: SQLWrapper): SQL =>
  sql`(extract(epoch FROM ${column}) * 1000)::bigint::text`;

const instant = (millis: string | null): string | null =>
  millis === null ? null : new Date(Number(millis)).toISOString();

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

// ---- 마감 예정 (145-1) ----------------------------------------------------------------
/**
 * `GET /admin/operations/closing`: OPEN and PAUSED markets whose scheduled close is at most the
 * window ahead — no lower bound, so a market whose close time passed before the close ran stays
 * listed as `overdue` ('마감 시각 지남', 145-18) and after 30 minutes is 처리 멈춤 too — nearest
 * close first (`ORDER BY close_at, id`, `markets_status_close_at_idx`).
 */
export async function readOperationsClosingMarkets(
  db: Transactional,
  input: Partial<AdminOperationsClosingQuery> = {},
  options: OperationsReadOptions = {},
): Promise<AdminClosingMarketPage> {
  const query = adminOperationsClosingQuerySchema.parse(input);
  const cursor = decodeTupleCursor(query.cursor, ['millis'], 'uuid');
  const now = nowOf(options);
  const hours = OPERATIONS_CLOSING_WINDOW_HOURS[query.within];
  const rows = await db.transaction(
    (tx) =>
      tx
        .select({
          id: markets.id,
          slug: markets.slug,
          title: markets.title,
          status: markets.status,
          closeAt: markets.closeAt,
          scheduledJudgementAt: markets.scheduledJudgementAt,
          overdue: sql<boolean>`${markets.closeAt} <= ${now}`,
        })
        .from(markets)
        .where(
          and(
            inArray(markets.status, ['open', 'paused']),
            sql`${markets.closeAt} <= ${now} + make_interval(hours => ${hours}::int)`,
            cursor
              ? rowAfter([
                  { key: markets.closeAt, value: isoOf(cursor.values[0]!), cast: 'timestamptz' },
                  { key: markets.id, value: cursor.id, cast: 'uuid' },
                ])
              : undefined,
          ),
        )
        .orderBy(asc(markets.closeAt), asc(markets.id))
        .limit(query.limit + 1),
    READ_ONLY,
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status as 'open' | 'paused',
      closeAt: row.closeAt.toISOString(),
      scheduledJudgementAt: row.scheduledJudgementAt?.toISOString() ?? null,
      overdue: row.overdue,
    })),
    meta: {
      nextCursor:
        rows.length > query.limit && last
          ? encodeTupleCursor([String(last.closeAt.getTime())], last.id)
          : null,
    },
  };
}

// ---- 판정 대기·지연 (145-2, 145-11, 145-17) ---------------------------------------------
interface JudgementRow {
  id: string;
  slug: string;
  title: string;
  status: 'closed' | 'provisional';
  close_ms: string;
  judgement_ms: string | null;
  dispute_deadline_ms: string | null;
  request_id: string | null;
  holding: number;
  delay_reason: string | null;
  delay_next_review_ms: string | null;
  delay_recorded_ms: string | null;
  review_overdue: boolean;
  long_delay_ms: string | null;
  long_delay_reached: boolean;
  delayed: boolean;
}

/**
 * The '지연만' predicate as SQL over the `markets` row (145-2): a CLOSED market past its scheduled
 * judgement (none: never), or a listed PROVISIONAL one — `isJudgementDelayed` of @buddha/shared
 * for the rows this list holds (a test pins the two equal).
 */
function judgementDelayedSql(now: SQL): SQL<boolean> {
  return sql<boolean>`((${markets.status} = 'closed' AND ${markets.scheduledJudgementAt} IS NOT NULL AND ${markets.scheduledJudgementAt} <= ${now}) OR ${markets.status} = 'provisional')`;
}

/**
 * `GET /admin/operations/judgements` (145-2 "한 목록, 승인 대기 포함"): every CLOSED market, and every
 * PROVISIONAL market whose 이의 기한 has come while a dispute or a correction holds it
 * (`marketConfirmationHeld`, the authority, never the mirrors), by scheduled judgement with none
 * last (`coalesce(…, 'infinity')`, then the id). Rows come from `markets_status_close_at_idx`
 * (CLOSED) and `markets_provisional_dispute_deadline_idx`; no index on the scheduled judgement
 * (ADR-0163 구현의 선택 — a few dozen rows sorted in memory; re-check at hundreds of CLOSED).
 *
 * Each row's stage (145-11), the waiting `market_judgement` request, the holding disputes of the
 * current version, the current episode's 지연 기록 (status + version — a CLOSED record never labels
 * the PROVISIONAL row; ADR-0106 결정 10-2), 갱신 대기, the long-delay deadline (`longDelayDeadline`'s
 * instant, ADR-0098 13) and whether it is reached (CLOSED only, 145-17), and '판정 지연'.
 */
export async function readOperationsAwaitingJudgements(
  db: Transactional,
  input: Partial<AdminOperationsJudgementsQuery> = {},
  options: OperationsReadOptions = {},
): Promise<AdminAwaitingJudgementMarketPage> {
  const query = adminOperationsJudgementsQuerySchema.parse(input);
  const cursor = decodeTupleCursor(query.cursor, ['nullableMillis'], 'uuid');
  const now = nowOf(options);
  // `marketConfirmationHeld` and the hold builders render `"markets"."id"`: read FROM the
  // unaliased table, or their EXISTS would correlate to nothing.
  const sortKey = sql`coalesce(${markets.scheduledJudgementAt}, 'infinity'::timestamptz)`;
  const longDelay = sql`(CASE WHEN ${markets.scheduledJudgementAt} IS NOT NULL AND ${markets.longDelayDays} IS NOT NULL THEN ${markets.scheduledJudgementAt} + make_interval(hours => ${markets.longDelayDays} * 24) END)`;
  const after = cursor
    ? rowAfter([
        {
          key: sortKey,
          value: cursor.values[0] === CURSOR_NULL ? 'infinity' : isoOf(cursor.values[0]!),
          cast: 'timestamptz',
        },
        { key: markets.id, value: cursor.id, cast: 'uuid' },
      ])
    : undefined;
  const statement = sql`
    SELECT ${markets.id} AS id, ${markets.slug} AS slug, ${markets.title} AS title,
      ${markets.status}::text AS status,
      ${millisOf(markets.closeAt)} AS close_ms,
      ${millisOf(markets.scheduledJudgementAt)} AS judgement_ms,
      ${millisOf(markets.disputeDeadline)} AS dispute_deadline_ms,
      (SELECT ${approvalRequests.id} FROM ${approvalRequests}
        WHERE ${waitingJudgementsOf(sql`${markets.id}::text`)}
        ORDER BY ${approvalRequests.requestedAt} DESC, ${approvalRequests.id} DESC LIMIT 1) AS request_id,
      (SELECT count(*)::int FROM ${marketDisputes}
        WHERE ${holdingDisputesOf(markets.id, markets.judgementVersion)}) AS holding,
      delay.reason AS delay_reason,
      ${millisOf(sql`delay.next_review_at`)} AS delay_next_review_ms,
      ${millisOf(sql`delay.recorded_at`)} AS delay_recorded_ms,
      coalesce(delay.next_review_at <= ${now}, false) AS review_overdue,
      ${millisOf(longDelay)} AS long_delay_ms,
      coalesce(${markets.status} = 'closed' AND ${longDelay} <= ${now}, false) AS long_delay_reached,
      ${judgementDelayedSql(now)} AS delayed
    FROM ${markets}
    LEFT JOIN LATERAL (
      SELECT d.reason, d.next_review_at, d.recorded_at FROM ${marketJudgementDelays} d
      WHERE d.market_id = ${markets.id} AND d.market_status = ${markets.status}
        AND d.judgement_version IS NOT DISTINCT FROM
          (CASE WHEN ${markets.status} = 'closed' THEN NULL ELSE ${markets.judgementVersion} END)
      ORDER BY d.event_id DESC LIMIT 1
    ) delay ON true
    WHERE ${markets.status} IN ('closed', 'provisional')
      AND (${markets.status} = 'closed'
        OR (${markets.disputeDeadline} <= ${now} AND ${marketConfirmationHeld()}))
      ${query.filter === 'delayed' ? sql`AND ${judgementDelayedSql(now)}` : sql``}
      ${after ? sql`AND ${after}` : sql``}
    ORDER BY ${sortKey}, ${markets.id}
    LIMIT ${query.limit + 1}`;
  const rows = rowsOf<JudgementRow>(await db.transaction((tx) => tx.execute(statement), READ_ONLY));
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(judgementRowOf),
    meta: {
      nextCursor:
        rows.length > query.limit && last
          ? encodeTupleCursor([last.judgement_ms ?? CURSOR_NULL], last.id)
          : null,
    },
  };
}

function judgementRowOf(row: JudgementRow): AdminAwaitingJudgementMarket {
  const provisional = row.status === 'provisional';
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    stage: provisional
      ? 'dispute_or_correction'
      : row.request_id !== null
        ? 'awaiting_approval'
        : 'unregistered',
    closeAt: instant(row.close_ms)!,
    scheduledJudgementAt: instant(row.judgement_ms),
    disputeDeadline: instant(row.dispute_deadline_ms),
    judgementRequestId: row.request_id,
    holdingDisputes: row.holding,
    correctionPending: provisional && row.request_id !== null,
    delay:
      row.delay_reason === null
        ? null
        : {
            reason: row.delay_reason,
            nextReviewAt: instant(row.delay_next_review_ms)!,
            recordedAt: instant(row.delay_recorded_ms)!,
          },
    reviewOverdue: row.review_overdue,
    longDelayDeadline: instant(row.long_delay_ms),
    longDelayReached: row.long_delay_reached,
    delayed: row.delayed,
  };
}

// ---- 정산 실패 · 처리 멈춤 · 봇 자금 회수 실패 (145-4, 145-6, 145-8, 145-15) ---------------
interface FailureRow {
  kind_order: number;
  kind: OperationsFailureKind;
  id: string;
  slug: string;
  title: string;
  status: AdminOperationsFailure['status'];
  since_ms: string;
  step_status: SettlementStepStatus | null;
  step_attempts: number | null;
  step_last_error: string | null;
  step_updated_ms: string | null;
  ledger_held: boolean | null;
  stage: OperationsStuckStage | null;
  recall_attempts: number | null;
  recall_reason: OperationsRecallFailureReason | null;
  recall_failure_ms: string | null;
}

const kindOrderOf = (kind: OperationsFailureKind): number => OPERATIONS_FAILURE_KINDS.indexOf(kind);

/** `interval '30 minutes'` (145-4: a code value), rendered from the shared constant. */
const STUCK_AFTER = sql.raw(`interval '${String(OPERATIONS_STUCK_AFTER_MINUTES)} minutes'`);

/** SETTLEMENT_STEPS as an SQL array, for the first unfinished step's order. */
const STEP_ORDER = sql.raw(
  `ARRAY[${SETTLEMENT_STEPS.map((step) => `'${step}'`).join(', ')}]::text[]`,
);

/**
 * `GET /admin/operations/failures`: one list, three kinds, the oldest problem first (`since`, then
 * the kind's order, then the market id). A UNION ALL whose every branch carries the page's cursor
 * before its own `ORDER BY … LIMIT` — without it a later page would re-read each branch from its
 * start. A market is in one row at most: `stuck` at `complete` leaves out what is
 * `settlement_failed`, a held PROVISIONAL market is §3's (never `confirm`), and the recall rows are
 * terminal markets.
 *
 * - `settlement_failed` (ADR-0121): `status = 'settling'` and `payoutDelayedSql` — the public
 *   '지급 지연' fragment itself — since the `settling` event (`status_event_id`); the step (the
 *   first not `done` in SETTLEMENT_STEPS order, else `coin`) with its attempts, stored error and
 *   last update (145-6), and whether a ledger hold blocks it.
 * - `stuck` (145-4): an automatic transition due 30 minutes ago that has not come — mirroring the
 *   workers' due queries (`closeDueMarkets`, `dueProvisionalMarkets`, `finalizeDueMarkets`): the
 *   close at `close_at` (CLOSABLE_STATUSES); the confirmation at the latest of the 이의 기한 and the
 *   last clearing of a hold of the current version (a dispute's decision, retraction or closing,
 *   a judgement request's decision or retraction — GREATEST ignores NULLs) on a market nothing
 *   holds (`marketConfirmationHeld`); the start at `resolved_at`; the completion at the `settling`
 *   event on a market whose payout is not late.
 * - `recall_failed` (145-8, 145-15): a SETTLED or CANCELLED market with no completed recall and a
 *   failed last observation (`state = 'failed'` only; `waiting` is blocked, not failed), since the
 *   market ended (its terminal event — fixed, unlike the last failure the minute scan moves; the
 *   last failure is the row's `recall.lastFailureAt`).
 */
export async function readOperationsFailures(
  db: Transactional,
  input: Partial<AdminOperationsFailuresQuery> = {},
  options: OperationsReadOptions = {},
): Promise<AdminOperationsFailurePage> {
  const query = adminOperationsFailuresQuerySchema.parse(input);
  const cursor = decodeTupleCursor(query.cursor, ['millis', 'int'], 'uuid');
  const now = nowOf(options);
  const limit = query.limit + 1;
  const after = (since: SQL, kind: OperationsFailureKind): SQL =>
    cursor
      ? sql`AND ${rowAfter([
          { key: since, value: isoOf(cursor.values[0]!), cast: 'timestamptz' },
          { key: sql.raw(String(kindOrderOf(kind))), value: cursor.values[1]!, cast: 'bigint' },
          { key: markets.id, value: cursor.id, cast: 'uuid' },
        ])}`
      : sql``;
  const head = (kind: OperationsFailureKind, since: SQL) =>
    sql`${sql.raw(String(kindOrderOf(kind)))} AS kind_order, ${kind}::text AS kind,
      ${markets.id} AS id, ${markets.slug} AS slug, ${markets.title} AS title,
      ${markets.status}::text AS status, ${since} AS since`;
  const noSettlement = sql`NULL::text AS step_status, NULL::int AS step_attempts,
      NULL::text AS step_last_error, NULL::text AS step_updated_ms, NULL::boolean AS ledger_held`;
  const noStage = sql`NULL::text AS stage`;
  const noRecall = sql`NULL::int AS recall_attempts, NULL::text AS recall_reason,
      NULL::text AS recall_failure_ms`;
  /** The instant a SETTLING market started its payout: its `settling` event. */
  const settlingSince = sql`coalesce(settling_event.created_at, ${markets.resolvedAt}, ${markets.updatedAt})`;
  const settlingEvent = sql`LEFT JOIN ${marketEvents} settling_event
      ON settling_event.id = ${markets.statusEventId}`;
  const stuckStage = (stage: OperationsStuckStage) => sql`${stage}::text AS stage`;
  const stuckWhere = (since: SQL) => sql`${since} <= ${now} - ${STUCK_AFTER}`;
  const order = sql`ORDER BY since, id LIMIT ${limit}`;

  const confirmDue = sql`GREATEST(${markets.disputeDeadline},
      (SELECT max(coalesce(${marketDisputes.decidedAt}, ${marketDisputes.retractedAt}, ${marketDisputes.closedAt}))
        FROM ${marketDisputes}
        WHERE ${marketDisputes.marketId} = ${markets.id}
          AND ${marketDisputes.judgementVersion} = ${markets.judgementVersion}),
      (SELECT max(coalesce(${approvalRequests.decidedAt}, ${approvalRequests.retractedAt}))
        FROM ${approvalRequests}
        WHERE ${approvalRequests.targetType} = 'market'
          AND ${approvalRequests.targetId} = ${markets.id}::text
          AND ${approvalRequests.kind} = ${MARKET_JUDGEMENT_APPROVAL_KIND}))`;
  /**
   * The instant a recall row's market ended: its terminal (`settled`/`cancelled`) event, which
   * `status_event_id` keeps once the market is terminal. Not the attempt's last failure — the
   * minute scan retries a failed recall and moves that forward each time, so as a sort key it
   * would re-list a row already shown on an earlier page and never sort it as old.
   */
  const recallSince = sql`coalesce(terminal_event.created_at, ${markets.settledAt}, ${markets.updatedAt})`;

  const statement = sql`
    SELECT u.*, ${millisOf(sql`u.since`)} AS since_ms FROM (
      (SELECT ${head('settlement_failed', settlingSince)},
          step.status AS step_status, step.attempts AS step_attempts,
          step.last_error AS step_last_error, ${millisOf(sql`step.updated_at`)} AS step_updated_ms,
          ${ledgerHeldMarketSql(markets.id)} AS ledger_held, ${noStage}, ${noRecall}
        FROM ${markets} ${settlingEvent}
        LEFT JOIN LATERAL (
          SELECT s.status, s.attempts, s.last_error, s.updated_at FROM ${marketSettlementSteps} s
          WHERE s.market_id = ${markets.id}
          ORDER BY (s.status = 'done'), array_position(${STEP_ORDER}, s.step::text), s.step
          LIMIT 1
        ) step ON true
        WHERE ${markets.status} = 'settling' AND ${payoutDelayedSql(markets.id)}
          ${after(settlingSince, 'settlement_failed')}
        ${order})
      UNION ALL
      (SELECT ${head('stuck', sql`${markets.closeAt}`)}, ${noSettlement}, ${stuckStage('close')},
          ${noRecall}
        FROM ${markets}
        WHERE ${markets.status} IN ('open', 'paused') AND ${stuckWhere(sql`${markets.closeAt}`)}
          ${after(sql`${markets.closeAt}`, 'stuck')}
        ${order})
      UNION ALL
      (SELECT ${head('stuck', confirmDue)}, ${noSettlement}, ${stuckStage('confirm')}, ${noRecall}
        FROM ${markets}
        WHERE ${markets.status} = 'provisional' AND NOT ${marketConfirmationHeld()}
          AND ${stuckWhere(confirmDue)}
          ${after(confirmDue, 'stuck')}
        ${order})
      UNION ALL
      (SELECT ${head('stuck', sql`${markets.resolvedAt}`)}, ${noSettlement}, ${stuckStage('start')},
          ${noRecall}
        FROM ${markets}
        WHERE ${markets.status} = 'resolved' AND ${stuckWhere(sql`${markets.resolvedAt}`)}
          ${after(sql`${markets.resolvedAt}`, 'stuck')}
        ${order})
      UNION ALL
      (SELECT ${head('stuck', settlingSince)}, ${noSettlement}, ${stuckStage('complete')},
          ${noRecall}
        FROM ${markets} ${settlingEvent}
        WHERE ${markets.status} = 'settling' AND NOT ${payoutDelayedSql(markets.id)}
          AND ${stuckWhere(settlingSince)}
          ${after(settlingSince, 'stuck')}
        ${order})
      UNION ALL
      (SELECT ${head('recall_failed', recallSince)}, ${noSettlement}, ${noStage},
          attempt.attempts AS recall_attempts, attempt.reason AS recall_reason,
          ${millisOf(sql`attempt.last_failure_at`)} AS recall_failure_ms
        FROM ${marketMakerRecallAttempts} attempt
        JOIN ${markets} ON ${markets.id} = attempt.market_id
        LEFT JOIN ${marketEvents} terminal_event ON terminal_event.id = ${markets.statusEventId}
        WHERE attempt.state = 'failed' AND ${markets.status} IN ('settled', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM ${marketMakerRecalls} recall
            WHERE recall.market_id = ${markets.id})
          ${after(recallSince, 'recall_failed')}
        ${order})
    ) u
    ORDER BY u.since, u.kind_order, u.id
    LIMIT ${limit}`;
  const rows = rowsOf<FailureRow>(
    await db.transaction((tx: Tx) => tx.execute(statement), READ_ONLY),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(failureRowOf),
    meta: {
      nextCursor:
        rows.length > query.limit && last
          ? encodeTupleCursor([last.since_ms, String(last.kind_order)], last.id)
          : null,
    },
  };
}

function failureRowOf(row: FailureRow): AdminOperationsFailure {
  const base = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    since: instant(row.since_ms)!,
  };
  switch (row.kind) {
    case 'settlement_failed':
      return {
        ...base,
        kind: 'settlement_failed',
        retryable: true,
        settlement: {
          stepStatus: row.step_status,
          settlementAttempts: row.step_attempts ?? 0,
          settlementLastError: row.step_last_error,
          lastAttemptAt: instant(row.step_updated_ms),
          ledgerHeld: row.ledger_held === true,
        },
      };
    case 'stuck':
      // 145-14: the operator retry is for SETTLING markets only; a stuck start stays the
      // worker's automatic transition.
      return { ...base, kind: 'stuck', retryable: row.stage === 'complete', stage: row.stage! };
    case 'recall_failed':
      return {
        ...base,
        kind: 'recall_failed',
        retryable: false,
        recall: {
          recallAttempts: row.recall_attempts!,
          recallReason: row.recall_reason!,
          lastFailureAt: instant(row.recall_failure_ms),
        },
      };
  }
}
