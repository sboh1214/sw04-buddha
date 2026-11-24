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
  OBSERVATION_WEEKS_SHOWN,
  OBSERVATION_WINDOW_HOURS,
  OBSERVATION_WINDOW_MS,
  POSITION_SETTLEMENTS_SINCE,
  adminObservationAfterSettlementWeekSchema,
  adminObservationDiscussionWeekSchema,
  adminObservationFirstFillWeekSchema,
  adminObservationMetricsSchema,
  adminObservationReportHandlingWeekSchema,
  kstDateOf,
  kstWeekStartOf,
  nearestPercentile,
  observationRatioPercent,
  observationWeekFlags,
  observationWeeks,
  type AdminObservationMetrics,
} from './observation-metrics.js';

const HOUR = 60 * 60 * 1_000;
const WEEK = 7 * 24 * HOUR;
const at = (iso: string) => new Date(iso);
/** An instant given in KST wall-clock time. */
const kst = (local: string) => new Date(`${local}+09:00`);

describe('관측 지표 constants (#96, ADR-0169)', () => {
  it('watches 7 × 24 hours, shows 12 weeks, takes P50 and P90 in KST weeks', () => {
    expect(OBSERVATION_WINDOW_HOURS).toBe(168);
    expect(OBSERVATION_WINDOW_MS).toBe(168 * HOUR);
    expect(OBSERVATION_WEEKS_SHOWN).toBe(12);
    expect(OBSERVATION_PERCENTILES).toEqual([50, 90]);
    expect(OBSERVATION_TIME_ZONE).toBe('Asia/Seoul');
  });

  it('groups the two fill-based metrics as cohorts and the other two by occurrence (95-7)', () => {
    expect(OBSERVATION_GROUPINGS).toEqual(['cohort', 'occurrence']);
    expect(OBSERVATION_METRICS).toEqual([
      'firstFill',
      'afterSettlement',
      'discussion',
      'reportHandling',
    ]);
    expect(OBSERVATION_METRIC_GROUPING).toEqual({
      firstFill: 'cohort',
      afterSettlement: 'cohort',
      discussion: 'occurrence',
      reportHandling: 'occurrence',
    });
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
        weeks.map((week) => observationWeekFlags(week, metric, asOf, dataStart).inProgress),
        metric,
      ).toEqual([true, true, ...Array<boolean>(10).fill(false)]);
    }
    for (const metric of ['discussion', 'reportHandling'] as const) {
      expect(
        weeks.map((week) => observationWeekFlags(week, metric, asOf, dataStart).inProgress),
        metric,
      ).toEqual([true, ...Array<boolean>(11).fill(false)]);
    }
  });

  it('ends a cohort week at its end + 168h, to the millisecond', () => {
    const week = weeks[1]!;
    const closes = week.end.getTime() + 168 * HOUR;
    expect(observationWeekFlags(week, 'firstFill', new Date(closes - 1), dataStart)).toEqual({
      inProgress: true,
      noData: false,
    });
    expect(observationWeekFlags(week, 'firstFill', new Date(closes), dataStart)).toEqual({
      inProgress: false,
      noData: false,
    });
  });

  it('ends an occurrence week at its end, to the millisecond', () => {
    const week = weeks[0]!;
    const end = week.end.getTime();
    expect(observationWeekFlags(week, 'discussion', new Date(end - 1), dataStart).inProgress).toBe(
      true,
    );
    expect(observationWeekFlags(week, 'discussion', new Date(end), dataStart).inProgress).toBe(
      false,
    );
  });

  it('shows 자료 없음 for weeks ending at or before the data start, and never 진행 중 with it', () => {
    // Data starts inside the newest week: the week before it ends exactly at its start.
    const start = weeks[0]!.start;
    for (const metric of OBSERVATION_METRICS) {
      expect(observationWeekFlags(weeks[0]!, metric, asOf, start), metric).toEqual({
        inProgress: true,
        noData: false,
      });
      // The second cohort week would be 진행 중, but 자료 없음 wins.
      expect(observationWeekFlags(weeks[1]!, metric, asOf, start), metric).toEqual({
        inProgress: false,
        noData: true,
      });
      expect(
        observationWeekFlags(weeks[1]!, metric, asOf, new Date(start.getTime() - 1)),
        metric,
      ).toEqual({
        inProgress: metric === 'firstFill' || metric === 'afterSettlement',
        noData: false,
      });
    }
  });

  it('shows 자료 없음 for every week of an empty database (no data start)', () => {
    for (const metric of OBSERVATION_METRICS) {
      for (const week of weeks) {
        expect(observationWeekFlags(week, metric, asOf, null)).toEqual({
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
      expect(observationWeekFlags(week, 'afterSettlement', asOfLater, dataStart)).toEqual({
        inProgress: false,
        noData: true,
      });
      for (const metric of ['firstFill', 'discussion', 'reportHandling'] as const) {
        expect(observationWeekFlags(week, metric, asOfLater, dataStart).noData, metric).toBe(false);
      }
    }
    expect(observationWeekFlags(nextWeek, 'afterSettlement', asOfLater, dataStart)).toEqual({
      inProgress: false,
      noData: false,
    });
    expect(deployWeek.start.getTime()).toBeLessThan(POSITION_SETTLEMENTS_SINCE.getTime());
    expect(deployWeek.end.getTime()).toBeGreaterThan(POSITION_SETTLEMENTS_SINCE.getTime());
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
  };
}

describe('AdminObservationMetrics (the answer)', () => {
  it('parses a full answer as given', () => {
    const answer = sampleAnswer();
    expect(adminObservationMetricsSchema.parse(answer)).toEqual(answer);
    const empty = {
      ...answer,
      dataStart: null,
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
    ];
    for (const value of broken) {
      expect(adminObservationMetricsSchema.safeParse(value).success).toBe(false);
    }
  });

  it('names its five component schemas', () => {
    expect(
      [
        adminObservationFirstFillWeekSchema,
        adminObservationAfterSettlementWeekSchema,
        adminObservationDiscussionWeekSchema,
        adminObservationReportHandlingWeekSchema,
        adminObservationMetricsSchema,
      ].map((schema) => z.globalRegistry.get(schema)?.id),
    ).toEqual([
      'AdminObservationFirstFillWeek',
      'AdminObservationAfterSettlementWeek',
      'AdminObservationDiscussionWeek',
      'AdminObservationReportHandlingWeek',
      'AdminObservationMetrics',
    ]);
  });

  const rowSchemas = [
    adminObservationFirstFillWeekSchema,
    adminObservationAfterSettlementWeekSchema,
    adminObservationDiscussionWeekSchema,
    adminObservationReportHandlingWeekSchema,
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
      'nearestPercentile',
      'observationRatioPercent',
      'observationWeekFlags',
      'kstWeekStartOf',
      'POSITION_SETTLEMENTS_SINCE',
      'OBSERVATION_COLLECTED_SINCE',
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
    ]) {
      expect(
        findPrivateField(name).map((hit) => hit.item),
        name,
      ).toContain('observation-metrics');
    }
    // The public first fill (`firstFillAt`) is not the metric's.
    expect(findPrivateField('firstFillAt').map((hit) => hit.item)).not.toContain(
      'observation-metrics',
    );
  });
});
