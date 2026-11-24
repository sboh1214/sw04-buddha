import {
  OBSERVATION_TIME_ZONE,
  OBSERVATION_WINDOW_HOURS,
  OBSERVATION_WINDOW_MS,
  observationWeekFlags,
  observationWeeks,
  type AdminObservationAfterSettlementWeek,
  type AdminObservationDiscussionWeek,
  type AdminObservationFirstFillWeek,
  type AdminObservationMetrics,
  type AdminObservationReportHandlingWeek,
  type ObservationMetric,
  type ObservationWeek,
} from '@buddha/shared';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isHumanAccountTypeSql } from './account-types.js';
import { adminSpansCte, wasAdminAtSql } from './admin-role-spans.js';
import type { Db } from './client.js';
import { isFillExcludedSql } from './fill-classification-read.js';
import { fills, user } from './schema/index.js';

/*
 * 관측 지표 (#96, ADR-0169; definitions in ADR-0167 결정 4, shared rules 결정 5, defaults 결정 8):
 * the four weekly service-wide values of `GET /admin/observation-metrics` — 첫 체결 전환 (96-1),
 * 정산 후 재참여 (96-2), 유효 토론 (96-3), 신고 처리 시간 (96-4) — recomputed from the source
 * tables on every read (95-8: no aggregate table, view, cache or job). One REPEATABLE READ, READ
 * ONLY transaction reads them all: one snapshot, one `asOf`, and a structural proof that the GET
 * writes nothing. Every event time read is capped `< asOf` (the transaction's `now()`; tests pin
 * it), a report is closed as of `asOf` only when it was resolved before it, and state without a
 * compared time (the latest fill classification, a post's or a comment's deletion or hiding) is
 * read as it is now (95-8: a later flag, clear, hide or unhide changes past weeks).
 *
 * Who counts (95-1, 95-2, 결정 5의 1·2·3): persons only, by the #115 rule — a fill side through
 * the type its row copied, everything else through the `"user"` row — and never an account while
 * it held the admin role by the grant and revoke records (admin-role-spans.ts). A fill counts
 * unless its latest approved classification marks it (`isFillExcludedSql`, ADR-0131). The answer
 * carries weekly counts and durations only: no account, market, post or report (95-10).
 *
 * Plans: every statement reads one bounded range (the 12 shown weeks, plus 7 × 24 hours of fills),
 * and every hit set is a join or a WHERE-level EXISTS — a hash (semi/anti) join — never an EXISTS
 * in a select-list aggregate FILTER, which would stay a correlated SubPlan over the fill set.
 */

/** Anything with a transaction (the pooled `Db`). */
type Transactional = Pick<Db, 'transaction'>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Test-only: the instant every statement compares with, instead of the transaction's `now()`. */
export interface ObservationMetricsReadOptions {
  asOf?: Date;
}

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/** A code constant (95-5), rendered as a literal so a GROUP BY ordinal sees one expression. */
const TIME_ZONE = sql.raw(`'${OBSERVATION_TIME_ZONE}'`);
/** The observation window (95-9, 95-12), a code constant. */
const WINDOW = sql.raw(`interval '${OBSERVATION_WINDOW_HOURS} hours'`);

/** An instant as a bound `timestamptz` parameter. */
const at = (instant: Date): SQL => sql`${instant.toISOString()}::timestamptz`;

/**
 * SQL: the KST Monday (95-5) of the week holding `instant`, as `YYYY-MM-DD` — Postgres weeks start
 * on Monday and KST keeps no daylight saving, so this is `kstDateOf(kstWeekStartOf(instant))` of
 * @buddha/shared (a db test pins the two together).
 */
export function observationWeekSql(instant: SQLWrapper): SQL<string> {
  return sql<string>`to_char(date_trunc('week', (${instant}) AT TIME ZONE ${TIME_ZONE}),
                             'YYYY-MM-DD')`;
}

/**
 * The CTE `countable_fill_sides(owner_id, created_at)` (결정 5의 2·3, 결정 8의 10): the person
 * sides of the fills in [from, to) before `asOf` that no approved classification marks, of the
 * accounts `owners` (a CTE with `user_id`) names, while not admin by the records. The mark is
 * read once per fill, before the unpivot. A person's fill against the bot counts for the person
 * (95-2); the bot's side never enters. All fills of one intake share their instant, so a window
 * that asks for at least one side counts partial fills once (95-4).
 */
function countableFillSidesCte(input: { from: Date; to: Date; asOf: Date; owners: SQL }): SQL {
  const f = alias(fills, 'f');
  return sql`countable_fill_sides AS (
    SELECT side.owner_id, cf.created_at
      FROM (SELECT f.id, f.created_at, f.incoming_owner_id, f.resting_owner_id,
                   ${isHumanAccountTypeSql(f.incomingAccountType)} AS incoming_human,
                   ${isHumanAccountTypeSql(f.restingAccountType)} AS resting_human
              FROM fills f
             WHERE f.created_at >= ${at(input.from)} AND f.created_at < ${at(input.to)}
               AND f.created_at < ${at(input.asOf)}
               AND NOT ${isFillExcludedSql(f.id)}) cf
     CROSS JOIN LATERAL (VALUES (cf.incoming_owner_id, cf.incoming_human),
                                (cf.resting_owner_id, cf.resting_human)) AS side(owner_id, human)
     WHERE side.human
       AND side.owner_id IN (SELECT o.user_id FROM ${input.owners} o)
       AND NOT ${wasAdminAtSql(sql`side.owner_id`, sql`cf.created_at`)}
  )`;
}

/** The bounds every statement of one read shares. */
interface Range {
  asOf: Date;
  /** The oldest shown week's start. */
  start: Date;
  /** The current week's end. */
  end: Date;
}

/** The person join of a statement (#115): `"user" u` and the rule over its type column. */
const u = alias(user, 'u');
const isPerson = (): SQL => isHumanAccountTypeSql(u.accountType);

// ---- 첫 체결 전환 (96-1, ADR-0167 결정 4, 결정 8의 1·10) ------------------------------------
/**
 * The cohort: person accounts whose onboarding finished (`nickname_confirmed_at`, written once)
 * in the range and who were not admin then (8의 1); `filled` those with a countable fill in
 * [start, start + 168h). No fill can precede the start (the order route needs the onboarding), so
 * this is 8의 10's "the earliest countable fill within 7 × 24 hours".
 */
function firstFillSql(range: Range): SQL {
  return sql`WITH ${adminSpansCte()},
  cohort AS (
    SELECT p.user_id, p.nickname_confirmed_at AS start_at
      FROM profiles p JOIN "user" u ON u.id = p.user_id
     WHERE p.nickname_confirmed_at >= ${at(range.start)}
       AND p.nickname_confirmed_at < ${at(range.end)}
       AND p.nickname_confirmed_at < ${at(range.asOf)}
       AND ${isPerson()}
       AND NOT ${wasAdminAtSql(sql`p.user_id`, sql`p.nickname_confirmed_at`)}
  ),
  ${countableFillSidesCte({
    from: range.start,
    to: new Date(range.end.getTime() + OBSERVATION_WINDOW_MS),
    asOf: range.asOf,
    owners: sql`cohort`,
  })},
  hits AS (
    SELECT DISTINCT c.user_id
      FROM cohort c JOIN countable_fill_sides s ON s.owner_id = c.user_id
       AND s.created_at >= c.start_at AND s.created_at < c.start_at + ${WINDOW}
  )
  SELECT ${observationWeekSql(sql`c.start_at`)} AS week,
         count(*)::int AS accounts, count(h.user_id)::int AS filled
    FROM cohort c LEFT JOIN hits h ON h.user_id = c.user_id
   GROUP BY 1`;
}

// ---- 정산 후 재참여 (96-2, ADR-0167 결정 4, 95-3, 결정 8의 1) ---------------------------------
/**
 * The pairs: (market, account) with a settlement record of a market paid out
 * (`markets.settled_at`, status SETTLED) in the range — YES and NO holdings one pair, zero payouts
 * and VOID included, no split by result — of a person not admin at the payout (8의 1) who still
 * has an unmarked fill in that market (95-3: flags only, admin time is not read here); `returned`
 * those with a countable fill in any market in [settled_at, settled_at + 168h). The window starts
 * at the payout instant itself (the half-open convention of every window, at millisecond grain).
 */
function afterSettlementSql(range: Range): SQL {
  return sql`WITH ${adminSpansCte()},
  pairs AS (
    SELECT DISTINCT ps.market_id, ps.user_id, m.settled_at AS start_at
      FROM markets m
      JOIN position_settlements ps ON ps.market_id = m.id
      JOIN "user" u ON u.id = ps.user_id
     WHERE m.status = 'settled' AND m.settled_at IS NOT NULL
       AND m.settled_at >= ${at(range.start)} AND m.settled_at < ${at(range.end)}
       AND m.settled_at < ${at(range.asOf)}
       AND ${isPerson()}
       AND NOT ${wasAdminAtSql(sql`ps.user_id`, sql`m.settled_at`)}
       AND (EXISTS (SELECT 1 FROM fills fi
                     WHERE fi.market_id = ps.market_id AND fi.incoming_owner_id = ps.user_id
                       AND NOT ${isFillExcludedSql(sql`fi.id`)})
         OR EXISTS (SELECT 1 FROM fills fr
                     WHERE fr.market_id = ps.market_id AND fr.resting_owner_id = ps.user_id
                       AND NOT ${isFillExcludedSql(sql`fr.id`)}))
  ),
  ${countableFillSidesCte({
    from: range.start,
    to: new Date(range.end.getTime() + OBSERVATION_WINDOW_MS),
    asOf: range.asOf,
    owners: sql`pairs`,
  })},
  returned AS (
    SELECT DISTINCT p.market_id, p.user_id
      FROM pairs p JOIN countable_fill_sides s ON s.owner_id = p.user_id
       AND s.created_at >= p.start_at AND s.created_at < p.start_at + ${WINDOW}
  )
  SELECT ${observationWeekSql(sql`p.start_at`)} AS week,
         count(*)::int AS pairs, count(r.user_id)::int AS returned
    FROM pairs p LEFT JOIN returned r ON r.market_id = p.market_id AND r.user_id = p.user_id
   GROUP BY 1`;
}

// ---- 유효 토론 (96-3, ADR-0167 결정 4, 결정 8의 5) ------------------------------------------
/**
 * Posts and comments (댓글 and 대댓글) written in the range and neither deleted nor hidden now — a
 * visible comment under a hidden or deleted post or comment counts, its market the post's
 * (8의 5) — by persons not admin when writing. Notices and likes are never read (8의 5, 96-5).
 */
function discussionSql(range: Range): SQL {
  return sql`WITH ${adminSpansCte()},
  items AS (
    SELECT 'post' AS kind, p.author_id, p.market_id, p.created_at
      FROM posts p
     WHERE p.created_at >= ${at(range.start)} AND p.created_at < ${at(range.end)}
       AND p.created_at < ${at(range.asOf)}
       AND p.deleted_at IS NULL AND p.hidden_at IS NULL
    UNION ALL
    SELECT 'comment' AS kind, c.author_id, p.market_id, c.created_at
      FROM post_comments c JOIN posts p ON p.id = c.post_id
     WHERE c.created_at >= ${at(range.start)} AND c.created_at < ${at(range.end)}
       AND c.created_at < ${at(range.asOf)}
       AND c.deleted_at IS NULL AND c.hidden_at IS NULL
  )
  SELECT ${observationWeekSql(sql`i.created_at`)} AS week,
         count(*) FILTER (WHERE i.kind = 'post')::int AS posts,
         count(*) FILTER (WHERE i.kind = 'comment')::int AS comments,
         count(DISTINCT i.author_id)::int AS authors,
         count(DISTINCT i.market_id)::int AS markets
    FROM items i JOIN "user" u ON u.id = i.author_id
   WHERE ${isPerson()} AND NOT ${wasAdminAtSql(sql`i.author_id`, sql`i.created_at`)}
   GROUP BY 1`;
}

// ---- 신고 처리 시간 (96-4, ADR-0167 결정 4, 결정 8의 2·3·4·6·7, 결과 5) --------------------------
/**
 * Reports a person filed while not admin (8의 2) before `asOf`. Nothing but `reports` is read:
 * #187's link flags, sanction appeals, 판정 이의 and judgement incidents are not reports (8의 3).
 */
function eligibleReportsCte(range: Range): SQL {
  return sql`eligible AS (
    SELECT r.id, r.target_type, r.target_key, r.status, r.action_id, r.created_at,
           r.resolved_at, r.resolved_by
      FROM reports r JOIN "user" u ON u.id = r.reporter_id
     WHERE r.created_at < ${at(range.asOf)}
       AND ${isPerson()}
       AND NOT ${wasAdminAtSql(sql`r.reporter_id`, sql`r.created_at`)}
  )`;
}

/**
 * One case (96-4 "같은 대상의 신고들을 한 건으로"): the reports one closing closed on one target —
 * an action or an account-restriction approval by its `action_id` (one target each), a
 * dismissal by its `report_dismiss` record's `reportIds` split by target (ADR-0167 결과 5). Ids
 * are compared as text and a `reportIds` that is no array reads as empty (the guard is inside
 * the function's argument, so no plan can apply it late), so a hand-written record never fails
 * the read; an id the retention purge removed simply matches nothing (8의 7). A
 * dismissed report no record names falls back to its operator and instant — one dismissal writes
 * one clock value. Cases are grouped before the week filter (a case's start is its earliest
 * eligible report, wherever it lies); elapsed is wall-clock `resolved_at − start` in whole ms;
 * `percentile_disc` is the nearest-rank percentile (`nearestPercentile`, 8의 6; median = P50).
 */
function reportHandlingSql(range: Range): SQL {
  return sql`WITH ${adminSpansCte()},
  ${eligibleReportsCte(range)},
  dismissal_members AS (
    SELECT DISTINCT ON (x.report_id) x.report_id, a.id AS dismissal_id
      FROM admin_actions a
     CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(a.payload -> 'reportIds') = 'array'
                  THEN a.payload -> 'reportIds' ELSE '[]'::jsonb END) AS x(report_id)
     WHERE a.type = 'report_dismiss'
     ORDER BY x.report_id, a.created_at, a.id
  ),
  closed AS (
    SELECT r.target_type, r.target_key, r.created_at, r.resolved_at,
           CASE WHEN r.status = 'actioned' THEN 'a:' || r.action_id::text
                ELSE 'd:' || coalesce(d.dismissal_id::text,
                                      r.resolved_by || '@' ||
                                      (extract(epoch FROM r.resolved_at) * 1000)::bigint::text)
           END AS closing
      FROM eligible r
      LEFT JOIN dismissal_members d ON r.status = 'dismissed' AND d.report_id = r.id::text
     WHERE r.status <> 'pending' AND r.resolved_at < ${at(range.asOf)}
       AND r.resolved_at >= ${at(range.start)}
  ),
  cases AS (
    SELECT min(created_at) AS start_at, max(resolved_at) AS end_at
      FROM closed GROUP BY closing, target_type, target_key
  )
  SELECT ${observationWeekSql(sql`c.start_at`)} AS week, count(*)::int AS cases,
         (percentile_disc(0.5) WITHIN GROUP (ORDER BY c.ms))::text AS median_ms,
         (percentile_disc(0.9) WITHIN GROUP (ORDER BY c.ms))::text AS p90_ms
    FROM (SELECT start_at,
                 (extract(epoch FROM end_at - start_at) * 1000)::bigint AS ms
            FROM cases) c
   WHERE c.start_at >= ${at(range.start)} AND c.start_at < ${at(range.end)}
   GROUP BY 1`;
}

/**
 * Pending targets as of `asOf` (8의 4): targets with an eligible report filed before `asOf` and
 * not resolved before it, in the week of their earliest such report; `earlier` when that report
 * is older than the oldest shown week (`pendingTargetsEarlier`).
 */
function pendingTargetsSql(range: Range): SQL {
  return sql`WITH ${adminSpansCte()},
  ${eligibleReportsCte(range)}
  SELECT t.first_at < ${at(range.start)} AS earlier,
         ${observationWeekSql(sql`t.first_at`)} AS week, count(*)::int AS targets
    FROM (SELECT target_type, target_key, min(created_at) AS first_at
            FROM eligible
           WHERE status = 'pending' OR resolved_at >= ${at(range.asOf)}
           GROUP BY target_type, target_key) t
   GROUP BY 1, 2`;
}

// ---- the reader ---------------------------------------------------------------------------
function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

/** Rows by their week, every row's week one of the shown weeks (others are a bug). */
function byWeek<T extends { week: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.week, row]));
}

/**
 * The 12 shown weeks of one metric, newest first: the statement's row of the week or zeros, with
 * the week's '진행 중'·'자료 없음' flags (`observationWeekFlags`). A '자료 없음' week carries zeros
 * (no numbers are shown for it, 결정 8의 7 — 96-11's cut included).
 */
function weekRows<R>(
  weeks: readonly ObservationWeek[],
  metric: ObservationMetric,
  asOf: Date,
  dataStart: Date | null,
  values: (week: string, noData: boolean) => R,
) {
  return weeks.map((week) => {
    const flags = observationWeekFlags(week, metric, asOf, dataStart);
    return { week: week.week, ...flags, ...values(week.week, flags.noData) };
  });
}

/**
 * `GET /admin/observation-metrics` (#96): the four metrics over the latest 12 KST weeks, newest
 * first, in one REPEATABLE READ, READ ONLY snapshot. `dataStart` is the earliest account — nothing
 * the metrics read can be older, so a week ending at or before it is '자료 없음' (8의 7 reading;
 * null on an empty database: every week).
 */
export async function readObservationMetrics(
  db: Transactional,
  options: ObservationMetricsReadOptions = {},
): Promise<AdminObservationMetrics> {
  return db.transaction((tx) => readIn(tx, options), READ_ONLY);
}

async function readIn(tx: Tx, options: ObservationMetricsReadOptions) {
  const [head] = rowsOf<{ as_of: string; data_start: string | null }>(
    await tx.execute(sql`SELECT
      ${
        options.asOf === undefined
          ? sql`floor(extract(epoch FROM now()) * 1000)::bigint::text`
          : sql`${String(options.asOf.getTime())}::text`
      } AS as_of,
      (SELECT (extract(epoch FROM min(created_at)) * 1000)::bigint::text
         FROM "user") AS data_start`),
  );
  if (!head) throw new Error('observation metrics: the snapshot read nothing');
  const asOf = new Date(Number(head.as_of));
  const dataStart = head.data_start === null ? null : new Date(Number(head.data_start));
  const weeks = observationWeeks(asOf);
  const range: Range = { asOf, start: weeks[weeks.length - 1]!.start, end: weeks[0]!.end };

  const firstFill = byWeek(
    rowsOf<{ week: string; accounts: number; filled: number }>(
      await tx.execute(firstFillSql(range)),
    ),
  );
  const afterSettlement = byWeek(
    rowsOf<{ week: string; pairs: number; returned: number }>(
      await tx.execute(afterSettlementSql(range)),
    ),
  );
  const discussion = byWeek(
    rowsOf<{ week: string; posts: number; comments: number; authors: number; markets: number }>(
      await tx.execute(discussionSql(range)),
    ),
  );
  const handled = byWeek(
    rowsOf<{ week: string; cases: number; median_ms: string | null; p90_ms: string | null }>(
      await tx.execute(reportHandlingSql(range)),
    ),
  );
  const pendingRows = rowsOf<{ earlier: boolean; week: string; targets: number }>(
    await tx.execute(pendingTargetsSql(range)),
  );
  const pending = new Map(
    pendingRows.filter((row) => !row.earlier).map((row) => [row.week, row.targets]),
  );
  const pendingTargetsEarlier = pendingRows
    .filter((row) => row.earlier)
    .reduce((sum, row) => sum + row.targets, 0);
  const ms = (value: string | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    asOf: asOf.toISOString(),
    dataStart: dataStart?.toISOString() ?? null,
    firstFill: weekRows(
      weeks,
      'firstFill',
      asOf,
      dataStart,
      (week, noData): Omit<AdminObservationFirstFillWeek, 'week' | 'inProgress' | 'noData'> => {
        const row = noData ? undefined : firstFill.get(week);
        return { accounts: row?.accounts ?? 0, filled: row?.filled ?? 0 };
      },
    ),
    afterSettlement: weekRows(
      weeks,
      'afterSettlement',
      asOf,
      dataStart,
      (
        week,
        noData,
      ): Omit<AdminObservationAfterSettlementWeek, 'week' | 'inProgress' | 'noData'> => {
        const row = noData ? undefined : afterSettlement.get(week);
        return { pairs: row?.pairs ?? 0, returned: row?.returned ?? 0 };
      },
    ),
    discussion: weekRows(
      weeks,
      'discussion',
      asOf,
      dataStart,
      (week, noData): Omit<AdminObservationDiscussionWeek, 'week' | 'inProgress' | 'noData'> => {
        const row = noData ? undefined : discussion.get(week);
        return {
          posts: row?.posts ?? 0,
          comments: row?.comments ?? 0,
          authors: row?.authors ?? 0,
          markets: row?.markets ?? 0,
        };
      },
    ),
    reportHandling: weekRows(
      weeks,
      'reportHandling',
      asOf,
      dataStart,
      (
        week,
        noData,
      ): Omit<AdminObservationReportHandlingWeek, 'week' | 'inProgress' | 'noData'> => {
        const row = noData ? undefined : handled.get(week);
        return {
          cases: row?.cases ?? 0,
          medianMs: ms(row?.median_ms),
          p90Ms: ms(row?.p90_ms),
          pendingTargets: noData ? 0 : (pending.get(week) ?? 0),
        };
      },
    ),
    pendingTargetsEarlier,
  } satisfies AdminObservationMetrics;
}
