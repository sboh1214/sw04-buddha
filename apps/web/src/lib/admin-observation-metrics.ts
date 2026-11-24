import { kstDateOf, observationRatioPercent } from '@buddha/shared';
import { copy } from '@/copy';
import { formatKst } from './datetime';

/**
 * 관측 지표 (#96, ADR-0169; decisions in ADR-0167) as the admin screen reads it: the counts and
 * durations of `GET /admin/observation-metrics` in words. The answer carries counts only; the
 * ratio is the shared helper's (`observationRatioPercent`), so the screen and the tests compute
 * it once. Kept out of the component so vitest can run it under its node environment
 * (admin-observation-metrics.test.ts).
 */

/** The four tables in screen order: the answer's arrays and their test-id slugs. */
export const OBSERVATION_TABLES = [
  { metric: 'firstFill', slug: 'first-fill' },
  { metric: 'afterSettlement', slug: 'after-settlement' },
  { metric: 'discussion', slug: 'discussion' },
  { metric: 'reportHandling', slug: 'report-handling' },
] as const;

/** The root test id; each table's is `${root}-${slug}`, each row's `${table}-${week}`. */
export const OBSERVATION_TEST_ID = 'admin-observation-metrics';

/** A count as the tables write it: `1,234`. */
export function observationCount(count: number): string {
  return count.toLocaleString('ko-KR');
}

/**
 * When the answer was read (`asOf`, the database's clock in its one snapshot), labelled as the
 * admin screens label a time: `기준 시각 2026. 11. 24. 오후 3:00`, in Seoul.
 */
export function observationAsOf(asOf: string): string {
  return `${copy.adminObservationAsOf} ${formatKst(asOf)}`;
}

/** `M. D.`, or `YYYY. M. D.` with the year. */
function dateText(year: number, month: number, day: number, withYear: boolean): string {
  const date = `${String(month)}. ${String(day)}.`;
  return withYear ? `${String(year)}. ${date}` : date;
}

/**
 * A week of the answer (its Monday as a KST date, `YYYY-MM-DD`) as the tables name it:
 * `11. 23.(월) ~ 11. 29.(일)` (96-9). Both dates carry the year only when the Monday is not in the
 * Korean year of `asOf` (`2025. 12. 29.(월) ~ 2026. 1. 4.(일)`). Computed from the date string
 * itself — never `new Date(week)` in the browser's zone, which would shift it.
 */
export function weekLabel(week: string, asOf: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(week);
  if (match === null) return week;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const sunday = new Date(Date.UTC(year, month - 1, day + 6));
  const asOfDate = new Date(asOf);
  const currentYear = Number.isNaN(asOfDate.getTime())
    ? year
    : Number(kstDateOf(asOfDate).slice(0, 4));
  const withYear = year !== currentYear;
  return copy.adminObservationWeekLabel
    .replace('{monday}', dateText(year, month, day, withYear))
    .replace(
      '{sunday}',
      dateText(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate(), withYear),
    );
}

const MINUTE_MS = 60_000;

/**
 * A wall-clock duration (96-4 "실제 경과 시간") floored to the minute: `1분 미만`, `12분`,
 * `3시간 5분`, and from a day on days and hours, the minutes dropped (`2일 4시간`) — a zero part
 * is left out (`3시간`, `2일`). Null (a week with no case) is `—`. Not `formatWait`: that rounds up
 * and is a member's wait.
 */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return copy.adminObservationNone;
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return copy.adminObservationElapsedUnderMinute;
  const unit = (template: string, n: number) => template.replace('{n}', observationCount(n));
  if (minutes < 60) return unit(copy.adminObservationElapsedMinutes, minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    const head = unit(copy.adminObservationElapsedHours, hours);
    return rest === 0 ? head : `${head} ${unit(copy.adminObservationElapsedMinutes, rest)}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const head = unit(copy.adminObservationElapsedDays, days);
  return rest === 0 ? head : `${head} ${unit(copy.adminObservationElapsedHours, rest)}`;
}

/** A ratio cell: `42.9%`, or `—` read as 대상 없음 when the denominator is 0 (결정 8의 6). */
export interface ObservationRatioCell {
  text: string;
  /** What a reader hears for `—`; undefined when a percentage is shown. */
  label: string | undefined;
}

export function observationRatio(numerator: number, denominator: number): ObservationRatioCell {
  const percent = observationRatioPercent(numerator, denominator);
  return percent === null
    ? { text: copy.adminObservationNone, label: copy.adminObservationNoTarget }
    : { text: `${percent}%`, label: undefined };
}

/** The numerator and denominator beside a ratio (95-7): `3 / 7`. */
export function observationFraction(numerator: number, denominator: number): string {
  return `${observationCount(numerator)} / ${observationCount(denominator)}`;
}

/** 유효 토론's one cell (96-8): `글·댓글 12 (글 3 · 댓글 9)`, replies among the comments. */
export function discussionPostsComments(row: { posts: number; comments: number }): string {
  return copy.adminObservationPostsComments
    .replace('{total}', observationCount(row.posts + row.comments))
    .replace('{posts}', observationCount(row.posts))
    .replace('{comments}', observationCount(row.comments));
}

/**
 * A row's state (95-7, 95-8, 결정 8의 6·7): `noData` wins over `inProgress` — the server already
 * never sends both, and the screen holds to it too. `done` draws no status.
 */
export type ObservationRowState = 'noData' | 'inProgress' | 'done';

export function observationRowState(row: {
  inProgress: boolean;
  noData: boolean;
}): ObservationRowState {
  if (row.noData) return 'noData';
  return row.inProgress ? 'inProgress' : 'done';
}

/** The line under 신고 처리 시간 when pending targets are older than the oldest week, else null. */
export function pendingEarlierLine(pendingTargetsEarlier: number): string | null {
  return pendingTargetsEarlier > 0
    ? copy.adminObservationPendingEarlier.replace('{n}', observationCount(pendingTargetsEarlier))
    : null;
}
