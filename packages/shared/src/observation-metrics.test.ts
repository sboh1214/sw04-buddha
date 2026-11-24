import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { findExcludedIdentifier, identifierWords } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import * as shared from './index.js';
import {
  OBSERVATION_COLLECTED_SINCE,
  OBSERVATION_GROUPINGS,
  OBSERVATION_METRICS,
  OBSERVATION_METRIC_GROUPING,
  OBSERVATION_PERCENTILES,
  OBSERVATION_TIME_ZONE,
  OBSERVATION_VISIT_WINDOWS,
  OBSERVATION_WEEKS_SHOWN,
  OBSERVATION_WINDOW_HOURS,
  OBSERVATION_WINDOW_MS,
  POSITION_SETTLEMENTS_SINCE,
  adminObservationAfterSettlementWeekSchema,
  adminObservationDiscussionWeekSchema,
  adminObservationFirstFillWeekSchema,
  adminObservationMetricsSchema,
  adminObservationReportHandlingWeekSchema,
  adminObservationResultViewWeekSchema,
  adminObservationRevisitWeekSchema,
  isObservationVisitMetric,
  kstDateOf,
  kstDatePlusDays,
  kstStartOfDate,
  kstWeekStartOf,
  nearestPercentile,
  observationRatioPercent,
  observationVisitWeekClosesAt,
  observationWeekFlags,
  observationWeeks,
  type AdminObservationMetrics,
  type ObservationCoverage,
  type ObservationVisitMetric,
} from './observation-metrics.js';

const HOUR = 60 * 60 * 1_000;
const WEEK = 7 * 24 * HOUR;
const at = (iso: string) => new Date(iso);
/** An instant given in KST wall-clock time. */
const kst = (local: string) => new Date(`${local}+09:00`);
/** #96's coverage: the data start only, no visit marker, nothing purged. */
const covering = (dataStart: Date | null): ObservationCoverage => ({
  dataStart,
  visitsSince: null,
  visitsPurgedThrough: null,
});
const VISIT_METRICS: readonly ObservationVisitMetric[] = ['revisit', 'resultView'];

describe('관측 지표 constants (#96, ADR-0169)', () => {
  it('watches 7 × 24 hours, shows 12 weeks, takes P50 and P90 in KST weeks', () => {
    expect(OBSERVATION_WINDOW_HOURS).toBe(168);
    expect(OBSERVATION_WINDOW_MS).toBe(168 * HOUR);
    expect(OBSERVATION_WEEKS_SHOWN).toBe(12);
    expect(OBSERVATION_PERCENTILES).toEqual([50, 90]);
    expect(OBSERVATION_TIME_ZONE).toBe('Asia/Seoul');
  });

  it('groups the fill- and visit-based metrics as cohorts and the other two by occurrence (95-7)', () => {
    expect(OBSERVATION_GROUPINGS).toEqual(['cohort', 'occurrence']);
    // #151's two come after #96's four, 재방문 then 결과 조회 (96-7).
    expect(OBSERVATION_METRICS).toEqual([
      'firstFill',
      'afterSettlement',
      'discussion',
      'reportHandling',
      'revisit',
      'resultView',
    ]);
    expect(OBSERVATION_METRIC_GROUPING).toEqual({
      firstFill: 'cohort',
      afterSettlement: 'cohort',
      discussion: 'occurrence',
      reportHandling: 'occurrence',
      revisit: 'cohort',
      resultView: 'cohort',
    });
  });

  it('counts the visit windows in Korean dates: 재방문 D+1~D+7, 결과 조회 D~D+7 (95-12)', () => {
    expect(OBSERVATION_VISIT_WINDOWS).toEqual({
      revisit: { from: 1, to: 7 },
      resultView: { from: 0, to: 7 },
    });
    expect(OBSERVATION_METRICS.filter(isObservationVisitMetric)).toEqual([...VISIT_METRICS]);
  });

  it('starts 정산 후 재참여 at 0064 deploy only (96-11), a Monday 23:34:45 KST', () => {
    expect(POSITION_SETTLEMENTS_SINCE.toISOString()).toBe('2026-11-09T14:34:45.000Z');
    expect(OBSERVATION_COLLECTED_SINCE).toEqual({ afterSettlement: POSITION_SETTLEMENTS_SINCE });
    expect(kstDateOf(POSITION_SETTLEMENTS_SINCE)).toBe('2026-11-09');
    expect(kstWeekStartOf(POSITION_SETTLEMENTS_SINCE)).toEqual(kst('2026-11-09T00:00:00.000'));
  });

  it('is exported from the package root', () => {
    expect(shared.observationWeeks).toBe(observationWeeks);
    expect(shared.adminObservationMetricsSchema).toBe(adminObservationMetricsSchema);
    expect(shared.nearestPercentile).toBe(nearestPercentile);
    expect(shared.observationVisitWeekClosesAt).toBe(observationVisitWeekClosesAt);
    expect(shared.OBSERVATION_VISIT_WINDOWS).toBe(OBSERVATION_VISIT_WINDOWS);
  });
});

describe('kstWeekStartOf (95-5)', () => {
  it('puts Sunday 23:59:59.999 KST in the week of the Monday before', () => {
    expect(kstWeekStartOf(kst('2026-11-29T23:59:59.999'))).toEqual(kst('2026-11-23T00:00:00.000'));
  });

  it('starts a week at Monday 00:00:00.000 KST', () => {
    expect(kstWeekStartOf(kst('2026-11-30T00:00:00.000'))).toEqual(kst('2026-11-30T00:00:00.000'));
    expect(kstWeekStartOf(kst('2026-11-30T00:00:00.000')).toISOString()).toBe(
      '2026-11-29T15:00:00.000Z',
    );
  });

  it('reads an instant given in UTC in KST (Sunday 15:00Z is Monday 00:00 KST)', () => {
    expect(kstWeekStartOf(at('2026-11-29T14:59:59.999Z'))).toEqual(at('2026-11-22T15:00:00.000Z'));
    expect(kstWeekStartOf(at('2026-11-29T15:00:00.000Z'))).toEqual(at('2026-11-29T15:00:00.000Z'));
  });

  it('crosses the year end: 2027-01-03 belongs to the week of Monday 2026-12-28', () => {
    expect(kstWeekStartOf(kst('2027-01-03T12:00:00.000'))).toEqual(kst('2026-12-28T00:00:00.000'));
    expect(kstWeekStartOf(kst('2027-01-01T00:00:00.000'))).toEqual(kst('2026-12-28T00:00:00.000'));
    expect(kstWeekStartOf(kst('2027-01-04T00:00:00.000'))).toEqual(kst('2027-01-04T00:00:00.000'));
  });

  it('returns a Monday for every day of a week, and the date of it in KST', () => {
    for (let day = 0; day < 14; day++) {
      const instant = new Date(kst('2026-11-23T08:30:00.000').getTime() + day * 24 * HOUR);
      const start = kstWeekStartOf(instant);
      expect(new Date(start.getTime() + 9 * HOUR).getUTCDay(), String(day)).toBe(1);
      expect(start.getTime()).toBeLessThanOrEqual(instant.getTime());
      expect(instant.getTime() - start.getTime()).toBeLessThan(WEEK);
    }
    expect(kstDateOf(kst('2026-11-23T00:00:00.000'))).toBe('2026-11-23');
    expect(kstDateOf(at('2026-11-22T15:00:00.000Z'))).toBe('2026-11-23');
    expect(kstDateOf(at('2026-11-22T14:59:59.999Z'))).toBe('2026-11-22');
  });

  it('refuses an invalid instant', () => {
    expect(() => kstWeekStartOf(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => observationWeeks(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('observationWeeks', () => {
  const asOf = kst('2026-11-25T10:00:00.000');
  const weeks = observationWeeks(asOf);

  it('lists 12 contiguous weeks, newest first, the first holding asOf', () => {
    expect(weeks).toHaveLength(12);
    expect(weeks[0]).toEqual({
      week: '2026-11-23',
      start: kst('2026-11-23T00:00:00.000'),
      end: kst('2026-11-30T00:00:00.000'),
    });
    expect(weeks[0]!.start.getTime()).toBeLessThanOrEqual(asOf.getTime());
    expect(weeks[0]!.end.getTime()).toBeGreaterThan(asOf.getTime());
    for (let index = 1; index < weeks.length; index++) {
      expect(weeks[index]!.end).toEqual(weeks[index - 1]!.start);
      expect(weeks[index]!.end.getTime() - weeks[index]!.start.getTime()).toBe(WEEK);
    }
    expect(weeks.map((week) => week.week)).toEqual([
      '2026-11-23',
      '2026-11-16',
      '2026-11-09',
      '2026-11-02',
      '2026-10-26',
      '2026-10-19',
      '2026-10-12',
      '2026-10-05',
      '2026-09-28',
      '2026-09-21',
      '2026-09-14',
      '2026-09-07',
    ]);
  });

  it('names each week by the KST date of its Monday, across the year end', () => {
    const turn = observationWeeks(kst('2027-01-03T23:59:59.999'));
    expect(turn[0]!.week).toBe('2026-12-28');
    expect(turn[1]!.week).toBe('2026-12-21');
    expect(observationWeeks(kst('2027-01-04T00:00:00.000'))[0]!.week).toBe('2027-01-04');
  });
});

describe('observationWeekFlags (결정 8의 6·7, 95-7, 95-8, 96-11)', () => {
  const asOf = kst('2026-12-02T10:00:00.000');
  const weeks = observationWeeks(asOf);
  const dataStart = kst('2026-01-01T00:00:00.000');

  it('keeps the two newest cohort weeks in progress, the current occurrence week only', () => {
    for (const metric of ['firstFill', 'afterSettlement'] as const) {
      expect(
        weeks.map(
          (week) => observationWeekFlags(week, metric, asOf, covering(dataStart)).inProgress,
        ),
        metric,
      ).toEqual([true, true, ...Array<boolean>(10).fill(false)]);
    }
    for (const metric of ['discussion', 'reportHandling'] as const) {
      expect(
        weeks.map(
          (week) => observationWeekFlags(week, metric, asOf, covering(dataStart)).inProgress,
        ),
        metric,
      ).toEqual([true, ...Array<boolean>(11).fill(false)]);
    }
  });

  it('ends a cohort week at its end + 168h, to the millisecond', () => {
    const week = weeks[1]!;
    const closes = week.end.getTime() + 168 * HOUR;
    expect(
      observationWeekFlags(week, 'firstFill', new Date(closes - 1), covering(dataStart)),
    ).toEqual({
      inProgress: true,
      noData: false,
    });
    expect(observationWeekFlags(week, 'firstFill', new Date(closes), covering(dataStart))).toEqual({
      inProgress: false,
      noData: false,
    });
  });

  it('ends an occurrence week at its end, to the millisecond', () => {
    const week = weeks[0]!;
    const end = week.end.getTime();
    expect(
      observationWeekFlags(week, 'discussion', new Date(end - 1), covering(dataStart)).inProgress,
    ).toBe(true);
    expect(
      observationWeekFlags(week, 'discussion', new Date(end), covering(dataStart)).inProgress,
    ).toBe(false);
  });

  it('shows 자료 없음 for weeks ending at or before the data start, and never 진행 중 with it', () => {
    // Data starts inside the newest week: the week before it ends exactly at its start.
    const start = weeks[0]!.start;
    for (const metric of OBSERVATION_METRICS) {
      expect(observationWeekFlags(weeks[0]!, metric, asOf, covering(start)), metric).toEqual({
        inProgress: true,
        noData: false,
      });
      // The second cohort week would be 진행 중, but 자료 없음 wins.
      expect(observationWeekFlags(weeks[1]!, metric, asOf, covering(start)), metric).toEqual({
        inProgress: false,
        noData: true,
      });
      expect(
        observationWeekFlags(weeks[1]!, metric, asOf, covering(new Date(start.getTime() - 1))),
        metric,
      ).toEqual({
        inProgress: OBSERVATION_METRIC_GROUPING[metric] === 'cohort',
        noData: false,
      });
    }
  });

  it('shows 자료 없음 for every week of an empty database (no data start)', () => {
    for (const metric of OBSERVATION_METRICS) {
      for (const week of weeks) {
        expect(observationWeekFlags(week, metric, asOf, covering(null))).toEqual({
          inProgress: false,
          noData: true,
        });
      }
    }
  });

  it('shows 자료 없음 for 정산 후 재참여 alone in weeks starting before 0064 deploy (96-11)', () => {
    const around = observationWeeks(kst('2026-11-25T10:00:00.000'));
    const deployWeek = around.find((week) => week.week === '2026-11-09')!;
    const nextWeek = around.find((week) => week.week === '2026-11-16')!;
    const earlier = around.find((week) => week.week === '2026-11-02')!;
    const asOfLater = kst('2026-12-31T00:00:00.000');
    // The week holding the deploy instant is partly before it: 자료 없음 too.
    for (const week of [deployWeek, earlier]) {
      expect(observationWeekFlags(week, 'afterSettlement', asOfLater, covering(dataStart))).toEqual(
        {
          inProgress: false,
          noData: true,
        },
      );
      for (const metric of ['firstFill', 'discussion', 'reportHandling'] as const) {
        expect(
          observationWeekFlags(week, metric, asOfLater, covering(dataStart)).noData,
          metric,
        ).toBe(false);
      }
    }
    expect(
      observationWeekFlags(nextWeek, 'afterSettlement', asOfLater, covering(dataStart)),
    ).toEqual({
      inProgress: false,
      noData: false,
    });
    expect(deployWeek.start.getTime()).toBeLessThan(POSITION_SETTLEMENTS_SINCE.getTime());
    expect(deployWeek.end.getTime()).toBeGreaterThan(POSITION_SETTLEMENTS_SINCE.getTime());
  });
});

describe('Korean dates (95-12, #151)', () => {
  it('moves a date by whole days across the month and year end, as SQL `date + integer`', () => {
    expect(kstDatePlusDays('2026-11-23', 0)).toBe('2026-11-23');
    expect(kstDatePlusDays('2026-11-23', 7)).toBe('2026-11-30');
    expect(kstDatePlusDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(kstDatePlusDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(kstDatePlusDays('2027-01-04', -7)).toBe('2026-12-28');
    expect(kstDatePlusDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('starts a Korean date at its 00:00 KST, which is the day before 15:00Z', () => {
    expect(kstStartOfDate('2026-11-23')).toEqual(kst('2026-11-23T00:00:00.000'));
    expect(kstStartOfDate('2026-11-23').toISOString()).toBe('2026-11-22T15:00:00.000Z');
    expect(kstDateOf(kstStartOfDate('2026-11-23'))).toBe('2026-11-23');
    expect(kstDateOf(new Date(kstStartOfDate('2026-11-23').getTime() - 1))).toBe('2026-11-22');
  });

  it('refuses what is not a real YYYY-MM-DD date or a whole number of days', () => {
    for (const date of ['2026-02-30', '11/23', '2026-11-23T00:00:00Z', '', '2026-1-3']) {
      expect(() => kstDatePlusDays(date, 1), date).toThrow(RangeError);
      expect(() => kstStartOfDate(date), date).toThrow(RangeError);
    }
    expect(() => kstDatePlusDays('2026-11-23', 1.5)).toThrow(RangeError);
  });
});

describe('observationWeekFlags for the visit-based cohorts (#151, 결정 8의 6·7, 95-8, 95-12)', () => {
  const asOf = kst('2026-12-02T10:00:00.000');
  const weeks = observationWeeks(asOf);
  const dataStart = kst('2026-01-01T00:00:00.000');
  const coverage = covering(dataStart);

  it('keeps the two newest weeks in progress, as the fill-based cohorts', () => {
    for (const metric of VISIT_METRICS) {
      expect(
        weeks.map((week) => observationWeekFlags(week, metric, asOf, coverage).inProgress),
        metric,
      ).toEqual([true, true, ...Array<boolean>(10).fill(false)]);
    }
  });

  it('closes a week at 00:00 KST after its last window date, the instant end + 168h (T5)', () => {
    // Over a year of asOf instants, every shown week of both metrics.
    for (let day = 0; day < 371; day += 7) {
      const at = new Date(kst('2026-11-25T10:00:00.000').getTime() + day * 24 * HOUR);
      for (const week of observationWeeks(at)) {
        for (const metric of VISIT_METRICS) {
          const closes = observationVisitWeekClosesAt(week, metric);
          expect(closes.getTime(), `${week.week} ${metric}`).toBe(
            week.end.getTime() + OBSERVATION_WINDOW_MS,
          );
          // Sunday S of the week, window through S + 7: the day after that starts at `closes`.
          expect(kstDateOf(closes)).toBe(kstDatePlusDays(week.week, 6 + 7 + 1));
          expect(kstDateOf(new Date(closes.getTime() - 1))).toBe(kstDatePlusDays(week.week, 13));
        }
      }
    }
  });

  it('ends a week’s 진행 중 at that instant, to the millisecond', () => {
    const week = weeks[1]!;
    for (const metric of VISIT_METRICS) {
      const closes = observationVisitWeekClosesAt(week, metric).getTime();
      expect(observationWeekFlags(week, metric, new Date(closes - 1), coverage)).toEqual({
        inProgress: true,
        noData: false,
      });
      expect(observationWeekFlags(week, metric, new Date(closes), coverage)).toEqual({
        inProgress: false,
        noData: false,
      });
    }
  });

  describe('the collection start (visitsSince, migration 0082)', () => {
    // A marker inside weeks[4] (2026-11-02), Wednesday 15:20 KST.
    const deployWeek = weeks[4]!;
    const marker = kst('2026-11-04T15:20:00.000');
    const withMarker = (visitsSince: Date | null, start: Date | null = dataStart) => ({
      dataStart: start,
      visitsSince,
      visitsPurgedThrough: null,
    });

    it('cuts nothing without a marker (a wiped or reset database)', () => {
      for (const metric of VISIT_METRICS) {
        for (const week of weeks) {
          expect(observationWeekFlags(week, metric, asOf, withMarker(null)).noData).toBe(false);
        }
      }
    });

    it('cuts nothing when the marker is not later than the data start (migrated before the seed)', () => {
      for (const since of [dataStart, new Date(dataStart.getTime() - 1), kst('2025-06-01T00:00')]) {
        for (const metric of VISIT_METRICS) {
          for (const week of weeks) {
            expect(observationWeekFlags(week, metric, asOf, withMarker(since)).noData).toBe(false);
          }
        }
      }
    });

    it('shows 자료 없음 for every week starting before a later marker, the deploy week included', () => {
      expect(deployWeek.week).toBe('2026-11-02');
      expect(deployWeek.start.getTime()).toBeLessThan(marker.getTime());
      expect(deployWeek.end.getTime()).toBeGreaterThan(marker.getTime());
      for (const metric of VISIT_METRICS) {
        expect(
          weeks.map((week) => observationWeekFlags(week, metric, asOf, withMarker(marker)).noData),
          metric,
        ).toEqual([false, false, false, false, ...Array<boolean>(8).fill(true)]);
      }
      // #96's four do not read the visits: the marker changes none of them.
      for (const metric of [
        'firstFill',
        'afterSettlement',
        'discussion',
        'reportHandling',
      ] as const) {
        for (const week of weeks) {
          expect(observationWeekFlags(week, metric, asOf, withMarker(marker)), metric).toEqual(
            observationWeekFlags(week, metric, asOf, covering(dataStart)),
          );
        }
      }
    });

    it('shows a week starting exactly at the marker (a Monday 00:00 KST marker)', () => {
      const monday = weeks[3]!;
      for (const metric of VISIT_METRICS) {
        expect(observationWeekFlags(monday, metric, asOf, withMarker(monday.start)).noData).toBe(
          false,
        );
        expect(
          observationWeekFlags(
            monday,
            metric,
            asOf,
            withMarker(new Date(monday.start.getTime() + 1)),
          ).noData,
        ).toBe(true);
        expect(observationWeekFlags(weeks[4]!, metric, asOf, withMarker(monday.start)).noData).toBe(
          true,
        );
      }
    });

    it('lets 자료 없음 win over 진행 중 in the newest weeks', () => {
      const late = new Date(weeks[0]!.start.getTime() + 1);
      for (const metric of VISIT_METRICS) {
        for (const week of weeks.slice(0, 2)) {
          expect(observationWeekFlags(week, metric, asOf, withMarker(late))).toEqual({
            inProgress: false,
            noData: true,
          });
        }
      }
    });
  });

  describe('the purge horizon (visitsPurgedThrough, 방문 기록 보존기간)', () => {
    const purged = (visitsPurgedThrough: string | null) => ({
      dataStart,
      visitsSince: null,
      visitsPurgedThrough,
    });

    it('keeps 재방문’s week while its D+1 is after the horizon: H = M shown, H = M + 1 자료 없음', () => {
      for (const week of weeks) {
        const monday = week.week;
        expect(observationWeekFlags(week, 'revisit', asOf, purged(monday)).noData, monday).toBe(
          false,
        );
        expect(
          observationWeekFlags(week, 'revisit', asOf, purged(kstDatePlusDays(monday, 1))).noData,
          monday,
        ).toBe(true);
      }
    });

    it('keeps 결과 조회’s week while its D is after the horizon: H = M − 1 shown, H = M 자료 없음', () => {
      for (const week of weeks) {
        const monday = week.week;
        expect(
          observationWeekFlags(week, 'resultView', asOf, purged(kstDatePlusDays(monday, -1)))
            .noData,
          monday,
        ).toBe(false);
        expect(observationWeekFlags(week, 'resultView', asOf, purged(monday)).noData, monday).toBe(
          true,
        );
      }
    });

    it('cuts nothing with no horizon, cuts every older week with one, and leaves #96’s four alone', () => {
      for (const metric of VISIT_METRICS) {
        for (const week of weeks) {
          expect(observationWeekFlags(week, metric, asOf, purged(null)).noData).toBe(false);
        }
        // A horizon on week 3's Monday + 1: weeks 3 and older are gone for both.
        const horizon = kstDatePlusDays(weeks[3]!.week, 1);
        expect(
          weeks.map((week) => observationWeekFlags(week, metric, asOf, purged(horizon)).noData),
          metric,
        ).toEqual([false, false, false, ...Array<boolean>(9).fill(true)]);
      }
      for (const metric of [
        'firstFill',
        'afterSettlement',
        'discussion',
        'reportHandling',
      ] as const) {
        for (const week of weeks) {
          expect(
            observationWeekFlags(week, metric, asOf, purged(asOf.toISOString().slice(0, 10))),
          ).toEqual(observationWeekFlags(week, metric, asOf, covering(dataStart)));
        }
      }
    });

    it('lets 자료 없음 win over 진행 중', () => {
      for (const metric of VISIT_METRICS) {
        expect(
          observationWeekFlags(weeks[1]!, metric, asOf, purged(weeks[1]!.week)).inProgress,
        ).toBe(metric === 'revisit');
        expect(
          observationWeekFlags(weeks[1]!, metric, asOf, purged(kstDatePlusDays(weeks[1]!.week, 1))),
        ).toEqual({ inProgress: false, noData: true });
      }
    });

    it('refuses a horizon that is not a YYYY-MM-DD date', () => {
      for (const metric of VISIT_METRICS) {
        expect(() =>
          observationWeekFlags(weeks[0]!, metric, asOf, purged('2026-11-23T00:00:00Z')),
        ).toThrow(RangeError);
      }
    });
  });

  describe('what a period of P days shows (§6.4: the owner’s value, after each day’s run)', () => {
    // The current week's Monday M₀ and each weekday T of it; the run of day T has purged every
    // visit dated ≤ T − P, so H = T − P.
    const monday = '2026-11-23';
    const days = Array.from({ length: 7 }, (_, offset) => kstDatePlusDays(monday, offset));
    const flagsOn = (today: string, period: number, metric: ObservationVisitMetric) => {
      const at = new Date(kstStartOfDate(today).getTime() + 12 * HOUR);
      return observationWeeks(at).map(
        (week) =>
          observationWeekFlags(week, metric, at, {
            dataStart: kst('2024-01-01T00:00:00.000'),
            visitsSince: null,
            visitsPurgedThrough: kstDatePlusDays(today, -period),
          }).noData,
      );
    };
    const periods = Array.from({ length: 120 }, (_, index) => index + 1);
    const bounds = {
      revisit: { all: 83, gone: 13, shown: 20 },
      resultView: { all: 84, gone: 14, shown: 21 },
    };

    it.each(VISIT_METRICS)(
      'shows all 12 weeks of %s on every weekday iff P reaches its bound',
      (metric) => {
        for (const period of periods) {
          const allShown = days.every((today) =>
            flagsOn(today, period, metric).every((gone) => !gone),
          );
          expect(allShown, String(period)).toBe(period >= bounds[metric].all);
        }
      },
    );

    it.each(VISIT_METRICS)('loses or keeps the newest completed week of %s by P', (metric) => {
      for (const period of periods) {
        const week2 = days.map((today) => flagsOn(today, period, metric)[2]!);
        expect(week2.every(Boolean), `gone ${period}`).toBe(period <= bounds[metric].gone);
        expect(
          week2.every((gone) => !gone),
          `shown ${period}`,
        ).toBe(period >= bounds[metric].shown);
      }
    });
  });
});

describe('nearestPercentile (96-4, 결정 8의 6 nearest-rank)', () => {
  it.each<[number[], number | null, number | null]>([
    [[], null, null],
    [[5], 5, 5],
    [[1, 9], 1, 9],
    [[1, 2, 3, 4], 2, 4],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, 9],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 6, 10],
  ])('takes %j to median %s and P90 %s', (values, median, p90) => {
    expect(nearestPercentile(values, 50)).toBe(median);
    expect(nearestPercentile(values, 90)).toBe(p90);
  });

  it('is the value at position ⌈p·n/100⌉ of the ascending list, for n = 1…20', () => {
    for (let n = 1; n <= 20; n++) {
      // Descending input: the function orders it and leaves the argument alone.
      const values = Array.from({ length: n }, (_, index) => (n - index) * 1_000);
      const copy = [...values];
      expect(nearestPercentile(values, 50), String(n)).toBe(Math.ceil(n / 2) * 1_000);
      expect(nearestPercentile(values, 90), String(n)).toBe(Math.ceil((9 * n) / 10) * 1_000);
      expect(values).toEqual(copy);
    }
  });

  it('orders numerically, not as text', () => {
    expect(nearestPercentile([10, 9, 100, 2], 50)).toBe(9);
    expect(nearestPercentile([10, 9, 100, 2], 90)).toBe(100);
  });
});

describe('observationRatioPercent', () => {
  it.each<[number, number, string | null]>([
    [3, 7, '42.9'],
    [0, 0, null],
    [5, 0, null],
    [0, 4, '0.0'],
    [1, 3, '33.3'],
    [2, 3, '66.7'],
    [1, 8, '12.5'],
    [1, 16, '6.3'],
    [2, 2, '100.0'],
    [1, 2_000, '0.1'],
    [1, 2_001, '0.0'],
    [999_999, 1_000_000, '100.0'],
  ])('%i / %i → %s', (numerator, denominator, expected) => {
    expect(observationRatioPercent(numerator, denominator)).toBe(expected);
  });

  it('refuses a negative or fractional count', () => {
    expect(() => observationRatioPercent(-1, 3)).toThrow(RangeError);
    expect(() => observationRatioPercent(1, -3)).toThrow(RangeError);
    expect(() => observationRatioPercent(1.5, 3)).toThrow(RangeError);
  });
});

/** A valid answer: every week empty, the oldest ones before the data. */
function sampleAnswer(): AdminObservationMetrics {
  const asOf = kst('2026-12-02T10:00:00.000');
  const base = observationWeeks(asOf).map((week) => ({
    week: week.week,
    inProgress: false,
    noData: false,
  }));
  return {
    asOf: asOf.toISOString(),
    dataStart: kst('2026-01-01T00:00:00.000').toISOString(),
    visitsSince: kst('2026-11-04T15:20:00.000').toISOString(),
    visitsPurgedThrough: '2026-09-01',
    firstFill: base.map((week) => ({ ...week, accounts: 7, filled: 3 })),
    afterSettlement: base.map((week) => ({ ...week, pairs: 0, returned: 0 })),
    discussion: base.map((week) => ({ ...week, posts: 3, comments: 9, authors: 4, markets: 2 })),
    reportHandling: base.map((week) => ({
      ...week,
      cases: 2,
      medianMs: 60_000,
      p90Ms: 3_600_000,
      pendingTargets: 1,
    })),
    pendingTargetsEarlier: 0,
    revisit: base.map((week) => ({ ...week, pairs: 7, revisited: 3 })),
    resultView: base.map((week) => ({ ...week, pairs: 4, viewed: 4 })),
  };
}

describe('AdminObservationMetrics (the answer)', () => {
  it('parses a full answer as given', () => {
    const answer = sampleAnswer();
    expect(adminObservationMetricsSchema.parse(answer)).toEqual(answer);
    const empty = {
      ...answer,
      dataStart: null,
      visitsSince: null,
      visitsPurgedThrough: null,
      revisit: answer.revisit.map((week) => ({ ...week, noData: true, pairs: 0, revisited: 0 })),
      reportHandling: answer.reportHandling.map((week) => ({
        ...week,
        noData: true,
        cases: 0,
        medianMs: null,
        p90Ms: null,
        pendingTargets: 0,
      })),
    };
    expect(adminObservationMetricsSchema.parse(empty)).toEqual(empty);
  });

  it('refuses a negative or fractional count, a bad week and a wrong number of weeks', () => {
    const answer = sampleAnswer();
    const broken: unknown[] = [
      { ...answer, pendingTargetsEarlier: -1 },
      { ...answer, firstFill: answer.firstFill.map((week) => ({ ...week, filled: -1 })) },
      { ...answer, discussion: answer.discussion.map((week) => ({ ...week, posts: 1.5 })) },
      {
        ...answer,
        reportHandling: answer.reportHandling.map((week) => ({ ...week, medianMs: -5 })),
      },
      { ...answer, afterSettlement: answer.afterSettlement.map((w) => ({ ...w, week: '11/23' })) },
      { ...answer, firstFill: answer.firstFill.slice(1) },
      { ...answer, asOf: 'now' },
      { ...answer, revisit: answer.revisit.map((week) => ({ ...week, revisited: -1 })) },
      { ...answer, resultView: answer.resultView.map((week) => ({ ...week, viewed: 0.5 })) },
      { ...answer, resultView: answer.resultView.slice(1) },
      { ...answer, revisit: [...answer.revisit, answer.revisit[0]] },
      // The collection start is an instant, the purge horizon a Korean date.
      { ...answer, visitsSince: '2026-11-04' },
      { ...answer, visitsPurgedThrough: '2026-09-01T00:00:00.000Z' },
      { ...answer, visitsPurgedThrough: '2026-02-30' },
      (({ revisit: _revisit, ...rest }) => rest)(answer),
      (({ visitsPurgedThrough: _horizon, ...rest }) => rest)(answer),
    ];
    for (const value of broken) {
      expect(adminObservationMetricsSchema.safeParse(value).success).toBe(false);
    }
  });

  it('names its seven component schemas', () => {
    expect(
      [
        adminObservationFirstFillWeekSchema,
        adminObservationAfterSettlementWeekSchema,
        adminObservationDiscussionWeekSchema,
        adminObservationReportHandlingWeekSchema,
        adminObservationRevisitWeekSchema,
        adminObservationResultViewWeekSchema,
        adminObservationMetricsSchema,
      ].map((schema) => z.globalRegistry.get(schema)?.id),
    ).toEqual([
      'AdminObservationFirstFillWeek',
      'AdminObservationAfterSettlementWeek',
      'AdminObservationDiscussionWeek',
      'AdminObservationReportHandlingWeek',
      'AdminObservationRevisitWeek',
      'AdminObservationResultViewWeek',
      'AdminObservationMetrics',
    ]);
  });

  const rowSchemas = [
    adminObservationFirstFillWeekSchema,
    adminObservationAfterSettlementWeekSchema,
    adminObservationDiscussionWeekSchema,
    adminObservationReportHandlingWeekSchema,
    adminObservationRevisitWeekSchema,
    adminObservationResultViewWeekSchema,
  ];
  const fieldNames = [
    ...Object.keys(adminObservationMetricsSchema.shape),
    ...rowSchemas.flatMap((schema) => Object.keys(schema.shape)),
  ];

  it('carries counts and durations only — no id, account, market, post or report (95-10)', () => {
    for (const name of fieldNames) {
      const words = identifierWords(name);
      for (const word of ['id', 'ids', 'user', 'account', 'nickname', 'slug', 'title', 'email']) {
        expect(words, name).not.toContain(word);
      }
    }
    expect(Object.keys(adminObservationFirstFillWeekSchema.shape)).toEqual([
      'week',
      'inProgress',
      'noData',
      'accounts',
      'filled',
    ]);
    expect(Object.keys(adminObservationReportHandlingWeekSchema.shape)).toEqual([
      'week',
      'inProgress',
      'noData',
      'cases',
      'medianMs',
      'p90Ms',
      'pendingTargets',
    ]);
    expect(Object.keys(adminObservationRevisitWeekSchema.shape)).toEqual([
      'week',
      'inProgress',
      'noData',
      'pairs',
      'revisited',
    ]);
    expect(Object.keys(adminObservationResultViewWeekSchema.shape)).toEqual([
      'week',
      'inProgress',
      'noData',
      'pairs',
      'viewed',
    ]);
    // #96's answer with #151's two coverage fields beside dataStart and its two arrays last.
    expect(Object.keys(adminObservationMetricsSchema.shape)).toEqual([
      'asOf',
      'dataStart',
      'visitsSince',
      'visitsPurgedThrough',
      'firstFill',
      'afterSettlement',
      'discussion',
      'reportHandling',
      'pendingTargetsEarlier',
      'revisit',
      'resultView',
    ]);
  });

  it('names nothing an excluded feature names (no conversion, rank, reward or score)', () => {
    const names = [
      ...fieldNames,
      ...OBSERVATION_METRICS,
      ...OBSERVATION_GROUPINGS,
      'observation-metrics',
      '/admin/observation-metrics',
      'getAdminObservationMetrics',
      'AdminObservationMetrics',
      'AdminObservationFirstFillWeek',
      'AdminObservationAfterSettlementWeek',
      'AdminObservationDiscussionWeek',
      'AdminObservationReportHandlingWeek',
      'AdminObservationRevisitWeek',
      'AdminObservationResultViewWeek',
      'nearestPercentile',
      'observationRatioPercent',
      'observationWeekFlags',
      'observationVisitWeekClosesAt',
      'isObservationVisitMetric',
      'kstWeekStartOf',
      'kstDatePlusDays',
      'kstStartOfDate',
      'POSITION_SETTLEMENTS_SINCE',
      'OBSERVATION_COLLECTED_SINCE',
      'OBSERVATION_VISIT_WINDOWS',
      'ObservationCoverage',
      'ObservationVisitMetric',
    ];
    for (const name of names) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'route'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'api', { path: true }), name).toEqual([]);
    }
  });

  it('keeps the admin-only fields private (PRIVATE_DATA `observation-metrics`)', () => {
    for (const name of [
      'medianMs',
      'p90Ms',
      'pendingTargets',
      'pendingTargetsEarlier',
      'reportHandling',
      'afterSettlement',
      'resultView',
      'visitsSince',
      'visitsPurgedThrough',
    ]) {
      expect(
        findPrivateField(name).map((hit) => hit.item),
        name,
      ).toContain('observation-metrics');
    }
    // #151's visit words are the visit records' own item (ADR-0170).
    for (const name of ['revisit', 'revisited', 'visitsSince', 'visitsPurgedThrough']) {
      expect(
        findPrivateField(name).map((hit) => hit.item),
        name,
      ).toContain('market-visits');
    }
    // The public first fill (`firstFillAt`) is not the metric's.
    expect(findPrivateField('firstFillAt').map((hit) => hit.item)).not.toContain(
      'observation-metrics',
    );
  });
});
