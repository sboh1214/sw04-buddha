import * as z from 'zod';

/*
 * 관측 지표 (#96, ADR-0169; #151, ADR-0170; decisions in ADR-0167): the admin screen
 * `/admin/observation-metrics` shows six service-wide weekly values — 첫 체결 전환, 정산 후 재참여
 * (cohorts, 95-7), 유효 토론 and 신고 처리 시간 (by occurrence week, 95-7), then #151's two
 * visit-based cohorts 관심 등록 후 재방문 and 결과 조회 (appended after the four, 96-7) — recomputed
 * from the source records on every view (95-8). This module is the one definition of the weeks,
 * the '진행 중'·'자료 없음' rules, the visit windows, the percentile and the ratio that the
 * @buddha/db reader (`observation-metrics.ts`), the web and the tests share. Every value here is a
 * code constant, never a release setting (ADR-0167 결정 8의 6; 95-9 fixed the seven days, 95-12
 * the visit windows' Korean dates). The answer carries counts and durations only — no account,
 * market, post, report or visit (95-10), no target or alert (95-11) — and its admin-only field
 * names are the PRIVATE_DATA item `observation-metrics`.
 */

// ---- constants -----------------------------------------------------------------------
/** 95-9 "(a) 모두 7일", 95-12: the two fill-based cohorts watch 7 × 24 hours from their start. */
export const OBSERVATION_WINDOW_HOURS = 168;

/** ADR-0167 결정 8의 6 "보이는 주의 범위(최근 몇 주)는 구현이 고른다": the latest 12 KST weeks. */
export const OBSERVATION_WEEKS_SHOWN = 12;

/** 96-4 "중앙값·90번째 백분위", nearest-rank (결정 8의 6); the median is P50. */
export const OBSERVATION_PERCENTILES = [50, 90] as const;
export type ObservationPercentile = (typeof OBSERVATION_PERCENTILES)[number];

/** 95-5: weeks start on Monday 00:00 in this zone (no daylight saving since 1988). */
export const OBSERVATION_TIME_ZONE = 'Asia/Seoul';

/**
 * When `position_settlements` (migration 0064, #126 — it did not backfill) started to be
 * written on the deployed environment: the end of the 'Deploy over SSM' step of the Deploy run
 * of PR #269's merge (f8476724, run 42635357422), 2026-11-09 23:34:45 KST — the migration ran
 * inside that step, which began at 14:33:44Z. Markets paid out before it have no records, so
 * 정산 후 재참여 shows '자료 없음' for every week that starts before it (owner answer 96-11).
 */
export const POSITION_SETTLEMENTS_SINCE = new Date('2026-11-09T14:34:45.000Z');

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Korea keeps no daylight saving since 1988: KST is UTC + 9 hours at every instant. */
const KST_OFFSET_MS = 9 * HOUR_MS;
/** The observation window in milliseconds. */
export const OBSERVATION_WINDOW_MS = OBSERVATION_WINDOW_HOURS * HOUR_MS;

// ---- KST weeks (95-5) ----------------------------------------------------------------
function assertInstant(instant: Date): void {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new RangeError('observation metrics need a valid instant');
  }
}

/**
 * The instant the KST week holding `instant` starts: Monday 00:00 KST. The SQL bucket
 * `date_trunc('week', ts AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'` is the same
 * instant (a db test pins the two together).
 */
export function kstWeekStartOf(instant: Date): Date {
  assertInstant(instant);
  const local = instant.getTime() + KST_OFFSET_MS;
  const day = Math.floor(local / DAY_MS);
  // 1970-01-01 was a Thursday: day 0 is weekday 3 counted from Monday.
  const weekday = (((day + 3) % 7) + 7) % 7;
  return new Date((day - weekday) * DAY_MS - KST_OFFSET_MS);
}

/** The Korean calendar date `instant` falls on, `YYYY-MM-DD`. */
export function kstDateOf(instant: Date): string {
  assertInstant(instant);
  return new Date(instant.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

const KST_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight UTC of a `YYYY-MM-DD` date, in ms; throws on anything else or a date that is not. */
function dateMs(date: string): number {
  const ms = KST_DATE.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new RangeError('observation metrics need a YYYY-MM-DD date');
  }
  return ms;
}

/**
 * The Korean date `days` after (before, when negative) `date`, both `YYYY-MM-DD` — SQL's
 * `date + integer`. Calendar days: Korea keeps no daylight saving, so every one is 24 hours.
 */
export function kstDatePlusDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError('a date moves by whole days');
  return new Date(dateMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instant a Korean date begins: 00:00 KST of `date` (`YYYY-MM-DD`). */
export function kstStartOfDate(date: string): Date {
  return new Date(dateMs(date) - KST_OFFSET_MS);
}

/** One shown week: its Monday as a KST date and its half-open instant range [start, end). */
export interface ObservationWeek {
  /** The KST date of the week's Monday, `YYYY-MM-DD` — what the answer's rows carry. */
  readonly week: string;
  readonly start: Date;
  readonly end: Date;
}

/**
 * The latest OBSERVATION_WEEKS_SHOWN KST weeks, newest first: the first holds `asOf`, each next
 * one ends where the one before starts. The reader bounds every statement by the oldest start
 * and the newest end and fills the weeks no row names with zeros.
 */
export function observationWeeks(asOf: Date): ObservationWeek[] {
  const current = kstWeekStartOf(asOf).getTime();
  return Array.from({ length: OBSERVATION_WEEKS_SHOWN }, (_, index) => {
    const start = new Date(current - index * WEEK_MS);
    return { week: kstDateOf(start), start, end: new Date(start.getTime() + WEEK_MS) };
  });
}

// ---- '진행 중' and '자료 없음' (95-7, 95-8, ADR-0167 결정 8의 6·7) ------------------------
/**
 * How a metric groups (95-7): a cohort follows the accounts that started in a week for the
 * observation window; an occurrence metric counts what happened in the week.
 */
export const OBSERVATION_GROUPINGS = ['cohort', 'occurrence'] as const;
export type ObservationGrouping = (typeof OBSERVATION_GROUPINGS)[number];

/**
 * The six metrics, in screen order; the keys are the answer's arrays. #151's two visit-based
 * cohorts come after #96's four, 재방문 then 결과 조회 (96-7 "#151의 두 지표도 뒤에 더한다").
 */
export const OBSERVATION_METRICS = [
  'firstFill',
  'afterSettlement',
  'discussion',
  'reportHandling',
  'revisit',
  'resultView',
] as const;
export type ObservationMetric = (typeof OBSERVATION_METRICS)[number];

/** Each metric's grouping (95-7 "전환형은 코호트, 나머지는 발생 주"). */
export const OBSERVATION_METRIC_GROUPING: Readonly<Record<ObservationMetric, ObservationGrouping>> =
  {
    firstFill: 'cohort',
    afterSettlement: 'cohort',
    discussion: 'occurrence',
    reportHandling: 'occurrence',
    revisit: 'cohort',
    resultView: 'cohort',
  };

/**
 * The visit-based cohorts' windows in Korean dates counted from the start's date D (95-12 "(a)
 * 결과 조회 D~D+7, 재방문 D+1~D+7"; 95-9 "모두 7일"): 관심 등록 후 재방문 looks from the day after the
 * first watch (151-1 "다음 날부터"), 결과 조회 from the day the provisional result was first
 * published, both through D+7. The visit rows hold a date and nothing finer (151-3), so these
 * windows are dates, not OBSERVATION_WINDOW_HOURS of time.
 */
export const OBSERVATION_VISIT_WINDOWS = {
  revisit: { from: 1, to: 7 },
  resultView: { from: 0, to: 7 },
} as const satisfies Partial<
  Record<ObservationMetric, { readonly from: number; readonly to: number }>
>;
export type ObservationVisitMetric = keyof typeof OBSERVATION_VISIT_WINDOWS;

/** Whether `metric` reads the visit records (#151) and counts its window in Korean dates. */
export function isObservationVisitMetric(
  metric: ObservationMetric,
): metric is ObservationVisitMetric {
  return Object.hasOwn(OBSERVATION_VISIT_WINDOWS, metric);
}

/**
 * A metric whose source started later than the service's data: weeks starting before this
 * instant are '자료 없음' for that metric alone (96-11: 정산 후 재참여 before 0064's deploy).
 */
export const OBSERVATION_COLLECTED_SINCE: Readonly<Partial<Record<ObservationMetric, Date>>> = {
  afterSettlement: POSITION_SETTLEMENTS_SINCE,
};

export interface ObservationWeekFlags {
  readonly inProgress: boolean;
  readonly noData: boolean;
}

/**
 * What the sources cover, read in the same snapshot as the metrics and carried in the answer so
 * every layer computes the flags with observationWeekFlags alone:
 * - `dataStart`: the earliest account (`"user".created_at`), null on an empty database (#96).
 * - `visitsSince`: when the visit records began to be kept — `market_visit_collection.started_at`,
 *   written by migration 0082 when it was applied (#151, ADR-0170) — null when there is no marker
 *   (a wiped or reset database).
 * - `visitsPurgedThrough`: the latest Korean date the 방문 기록 보존기간 purge may have deleted
 *   visits of (`retention_purges` rows of kind `market_visits` that deleted something), null when
 *   it never deleted one.
 */
export interface ObservationCoverage {
  readonly dataStart: Date | null;
  readonly visitsSince: Date | null;
  /** A Korean date, `YYYY-MM-DD`. */
  readonly visitsPurgedThrough: string | null;
}

/**
 * The instant a visit-based cohort week stops being '진행 중' (ADR-0167 결정 8의 6 "방문 기반은
 * 95-12의 마지막 날짜까지"): the start of the day after the last window date of the week's last
 * cohort day — Sunday S of the week, window through S + `to`, so 00:00 KST of S + `to` + 1. That
 * is `end + 7 days`, the same instant as the fill-based cohorts' `end + OBSERVATION_WINDOW_MS`
 * (a test pins the two together), though OBSERVATION_WINDOW_MS is not how it is defined.
 */
export function observationVisitWeekClosesAt(
  week: Pick<ObservationWeek, 'start'>,
  metric: ObservationVisitMetric,
): Date {
  const sunday = kstDatePlusDays(kstDateOf(week.start), 6);
  return kstStartOfDate(kstDatePlusDays(sunday, OBSERVATION_VISIT_WINDOWS[metric].to + 1));
}

/**
 * Whether a visit-based cohort week lost visit records it would read (ADR-0167 결정 8의 7, 95-8):
 * - its weeks before the records began (`visitsSince`) — a week starting before the marker is
 *   covered only in part, the week-start cut of 96-11 — but only when the marker is later than
 *   `dataStart`: a database migrated before its first account (a fresh or reset one) missed
 *   nothing;
 * - a week whose earliest window date (its Monday M + `from`) is on or before the purge horizon
 *   `visitsPurgedThrough`: 8의 7 "관찰 기간의 일부라도 보존기간 처리가 방문 기록을 지운 코호트",
 *   exact at week grain because the purge goes by date for every account alike (151-5).
 */
function visitsMissing(
  week: Pick<ObservationWeek, 'start'>,
  metric: ObservationVisitMetric,
  coverage: ObservationCoverage,
): boolean {
  const { dataStart, visitsSince, visitsPurgedThrough } = coverage;
  if (
    visitsSince !== null &&
    dataStart !== null &&
    visitsSince.getTime() > dataStart.getTime() &&
    week.start.getTime() < visitsSince.getTime()
  ) {
    return true;
  }
  if (visitsPurgedThrough === null) return false;
  const earliest = kstDatePlusDays(kstDateOf(week.start), OBSERVATION_VISIT_WINDOWS[metric].from);
  // dateMs refuses anything but a real YYYY-MM-DD date, so a malformed horizon throws.
  return dateMs(earliest) <= dateMs(visitsPurgedThrough);
}

/**
 * A shown week's state for one metric. `coverage` is required for every metric (#151) so each
 * call site passes the same answer fields; #96's four read only its `dataStart`.
 * - `noData` (ADR-0167 결정 8의 7, 95-8): the week ended at or before `dataStart` (the earliest
 *   account — nothing the metrics read can be older; null on an empty database: every week), or
 *   it starts before the metric's own OBSERVATION_COLLECTED_SINCE (a week the late source covers
 *   only in part, 96-11), or — the two visit-based cohorts — visits it would read were never
 *   collected or were purged (visitsMissing above).
 * - `inProgress` (결정 8의 6, 95-7 "기간이 다 지나지 않은 묶음"): a fill-based cohort week until its
 *   last instant's window is over (`end + 168h > asOf` — the two newest weeks), a visit-based one
 *   until its last window date is over (observationVisitWeekClosesAt — the same instant), an
 *   occurrence week until it ends (the current week). Never on a `noData` week: '자료 없음' wins.
 */
export function observationWeekFlags(
  week: Pick<ObservationWeek, 'start' | 'end'>,
  metric: ObservationMetric,
  asOf: Date,
  coverage: ObservationCoverage,
): ObservationWeekFlags {
  assertInstant(asOf);
  const { dataStart } = coverage;
  const since = OBSERVATION_COLLECTED_SINCE[metric];
  const noData =
    dataStart === null ||
    week.end.getTime() <= dataStart.getTime() ||
    (since !== undefined && week.start.getTime() < since.getTime()) ||
    (isObservationVisitMetric(metric) && visitsMissing(week, metric, coverage));
  if (noData) return { inProgress: false, noData };
  const closesAt = isObservationVisitMetric(metric)
    ? observationVisitWeekClosesAt(week, metric).getTime()
    : OBSERVATION_METRIC_GROUPING[metric] === 'cohort'
      ? week.end.getTime() + OBSERVATION_WINDOW_MS
      : week.end.getTime();
  return { inProgress: closesAt > asOf.getTime(), noData };
}

// ---- percentiles and ratios (96-4, ADR-0167 결정 8의 6) -----------------------------------
/**
 * The nearest-rank percentile: the value at 1-based position ⌈p·n/100⌉ of the ascending list —
 * the median is P50, the lower middle when n is even. SQL `percentile_disc(p/100)` is the same
 * value (a db test pins them together). Null for an empty list ('—').
 */
export function nearestPercentile(
  values: readonly number[],
  p: ObservationPercentile,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.ceil((p * sorted.length) / 100);
  return sorted[Math.max(position, 1) - 1]!;
}

/**
 * A ratio as the screen shows it beside its counts: a percentage with one decimal, rounded half
 * up in integer arithmetic ('42.9' for 3 / 7). Null when the denominator is 0 ('—', 대상 없음 —
 * 결정 8의 6). The answer carries the counts only.
 */
export function observationRatioPercent(numerator: number, denominator: number): string | null {
  for (const value of [numerator, denominator]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('a ratio takes two non-negative integer counts');
    }
  }
  if (denominator === 0) return null;
  // Tenths of a percent, half up: ⌊(2 · 1000 · n + d) / (2 · d)⌋.
  const tenths = Math.floor((2_000 * numerator + denominator) / (2 * denominator));
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

// ---- the answer (`GET /admin/observation-metrics`) -----------------------------------
const count = z.number().int().nonnegative();
/** A duration in whole milliseconds: a year is 3.2e10, far inside the safe range. */
const durationMs = z.number().int().nonnegative();

const weekBase = {
  /** The KST date of the week's Monday (95-5). */
  week: z.iso.date(),
  inProgress: z.boolean(),
  noData: z.boolean(),
};

/**
 * 첫 체결 전환 (96-1): of the human accounts that finished onboarding (`nickname_confirmed_at`)
 * in the week and were not admin then (`accounts`), those with a countable fill within 168 hours
 * (`filled`).
 */
export const adminObservationFirstFillWeekSchema = z
  .object({ ...weekBase, accounts: count, filled: count })
  .meta({ id: 'AdminObservationFirstFillWeek' });
export type AdminObservationFirstFillWeek = z.infer<typeof adminObservationFirstFillWeekSchema>;

/**
 * 정산 후 재참여 (96-2): account·market pairs with a settlement record of a market paid out
 * (`markets.settled_at`) in the week (`pairs`), and those with a countable fill in any market
 * within 168 hours of the payout (`returned`).
 */
export const adminObservationAfterSettlementWeekSchema = z
  .object({ ...weekBase, pairs: count, returned: count })
  .meta({ id: 'AdminObservationAfterSettlementWeek' });
export type AdminObservationAfterSettlementWeek = z.infer<
  typeof adminObservationAfterSettlementWeekSchema
>;

/**
 * 유효 토론 (96-3): posts and comments (replies included) written in the week and neither
 * deleted nor hidden, the accounts that wrote them and the markets they are on. No denominator.
 */
export const adminObservationDiscussionWeekSchema = z
  .object({ ...weekBase, posts: count, comments: count, authors: count, markets: count })
  .meta({ id: 'AdminObservationDiscussionWeek' });
export type AdminObservationDiscussionWeek = z.infer<typeof adminObservationDiscussionWeekSchema>;

/**
 * 신고 처리 시간 (96-4): `cases` closed (one closing × one target), grouped by the week of their
 * earliest eligible report, with the nearest-rank median and 90th percentile of their wall-clock
 * durations (null with no case), and `pendingTargets`: targets whose earliest eligible pending
 * report came in that week (결정 8의 4).
 */
export const adminObservationReportHandlingWeekSchema = z
  .object({
    ...weekBase,
    cases: count,
    medianMs: durationMs.nullable(),
    p90Ms: durationMs.nullable(),
    pendingTargets: count,
  })
  .meta({ id: 'AdminObservationReportHandlingWeek' });
export type AdminObservationReportHandlingWeek = z.infer<
  typeof adminObservationReportHandlingWeekSchema
>;

/**
 * 관심 등록 후 재방문 (151-1, #151): account·market pairs whose first watch ever was in the week,
 * by a human account that was not admin then (`pairs`), and those whose account opened that
 * market's detail on a Korean date from D+1 to D+7 of the watch (`revisited`, 95-12).
 */
export const adminObservationRevisitWeekSchema = z
  .object({ ...weekBase, pairs: count, revisited: count })
  .meta({ id: 'AdminObservationRevisitWeek' });
export type AdminObservationRevisitWeek = z.infer<typeof adminObservationRevisitWeekSchema>;

/**
 * 결과 조회 (151-2, #151): account·market pairs of a market whose provisional result (judgement
 * version 1) was first published in the week and a human account with an unflagged fill there
 * that was not admin then (`pairs`), and those whose account opened that market's detail on a
 * Korean date from D to D+7 of the publication (`viewed`, 95-12).
 */
export const adminObservationResultViewWeekSchema = z
  .object({ ...weekBase, pairs: count, viewed: count })
  .meta({ id: 'AdminObservationResultViewWeek' });
export type AdminObservationResultViewWeek = z.infer<typeof adminObservationResultViewWeekSchema>;

const weeks = <T extends z.ZodType>(row: T) => z.array(row).length(OBSERVATION_WEEKS_SHOWN);

/**
 * The whole screen in one answer, read in one snapshot: the instant every source was compared
 * with (`asOf`), what the sources cover (`dataStart`, `visitsSince`, `visitsPurgedThrough` — the
 * ObservationCoverage the flags are computed from), the six metrics' OBSERVATION_WEEKS_SHOWN
 * weeks newest first, and the pending targets whose earliest eligible pending report is older
 * than the oldest shown week.
 */
export const adminObservationMetricsSchema = z
  .object({
    asOf: z.iso.datetime(),
    dataStart: z.iso.datetime().nullable(),
    visitsSince: z.iso.datetime().nullable(),
    visitsPurgedThrough: z.iso.date().nullable(),
    firstFill: weeks(adminObservationFirstFillWeekSchema),
    afterSettlement: weeks(adminObservationAfterSettlementWeekSchema),
    discussion: weeks(adminObservationDiscussionWeekSchema),
    reportHandling: weeks(adminObservationReportHandlingWeekSchema),
    pendingTargetsEarlier: count,
    revisit: weeks(adminObservationRevisitWeekSchema),
    resultView: weeks(adminObservationResultViewWeekSchema),
  })
  .meta({ id: 'AdminObservationMetrics' });
export type AdminObservationMetrics = z.infer<typeof adminObservationMetricsSchema>;
