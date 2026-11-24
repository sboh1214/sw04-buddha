import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  discussionPostsComments,
  formatElapsed,
  observationAsOf,
  observationFraction,
  observationRatio,
  observationRowState,
  pendingEarlierLine,
  weekLabel,
} from './admin-observation-metrics';
import { formatKst } from './datetime';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 관측 지표's words (#96, ADR-0169; 96-8, 96-9). */
describe('관측 지표 in words', () => {
  it('names a week by its Monday and Sunday, the year only off the current Korean year', () => {
    const asOf = '2026-11-24T06:00:00.000Z';
    expect(weekLabel('2026-11-23', asOf)).toBe('11. 23.(월) ~ 11. 29.(일)');
    // Across a month end.
    expect(weekLabel('2026-09-28', asOf)).toBe('9. 28.(월) ~ 10. 4.(일)');
    // A Monday of last year: both dates carry their year.
    expect(weekLabel('2025-12-29', asOf)).toBe('2025. 12. 29.(월) ~ 2026. 1. 4.(일)');
    // The current year is Seoul's: 2026-12-31T15:00Z is already 2027-01-01 there.
    expect(weekLabel('2026-12-28', '2026-12-31T15:00:00.000Z')).toBe(
      '2026. 12. 28.(월) ~ 2027. 1. 3.(일)',
    );
    expect(weekLabel('2026-12-28', '2026-12-31T14:59:59.999Z')).toBe('12. 28.(월) ~ 1. 3.(일)');
    // Not a date: as given.
    expect(weekLabel('soon', asOf)).toBe('soon');
  });

  it('floors a duration to the minute, days and hours from a day on', () => {
    expect(formatElapsed(0)).toBe('1분 미만');
    expect(formatElapsed(59_999)).toBe('1분 미만');
    expect(formatElapsed(60_000)).toBe('1분');
    expect(formatElapsed(12 * MINUTE + 59_999)).toBe('12분');
    expect(formatElapsed(HOUR)).toBe('1시간');
    expect(formatElapsed(3 * HOUR + 5 * MINUTE)).toBe('3시간 5분');
    expect(formatElapsed(DAY - 1)).toBe('23시간 59분');
    expect(formatElapsed(DAY + 23 * HOUR + 59 * MINUTE)).toBe('1일 23시간');
    expect(formatElapsed(2 * DAY)).toBe('2일');
    expect(formatElapsed(2 * DAY + 4 * HOUR + 30 * MINUTE)).toBe('2일 4시간');
    // No case in the week: no median.
    expect(formatElapsed(null)).toBe('—');
  });

  it('writes a ratio with one decimal beside its counts, and — (대상 없음) over 0', () => {
    expect(observationRatio(3, 7)).toEqual({ text: '42.9%', label: undefined });
    expect(observationRatio(2, 2)).toEqual({ text: '100.0%', label: undefined });
    expect(observationRatio(0, 5)).toEqual({ text: '0.0%', label: undefined });
    expect(observationRatio(0, 0)).toEqual({
      text: copy.adminObservationNone,
      label: copy.adminObservationNoTarget,
    });
    expect(observationFraction(3, 7)).toBe('3 / 7');
    expect(observationFraction(1234, 5678)).toBe('1,234 / 5,678');
  });

  it('writes 유효 토론’s posts and comments as one cell, the total with its split (96-8)', () => {
    expect(discussionPostsComments({ posts: 3, comments: 9 })).toBe('글·댓글 12 (글 3 · 댓글 9)');
    expect(discussionPostsComments({ posts: 0, comments: 0 })).toBe('글·댓글 0 (글 0 · 댓글 0)');
    expect(discussionPostsComments({ posts: 1000, comments: 234 })).toBe(
      '글·댓글 1,234 (글 1,000 · 댓글 234)',
    );
  });

  it('reads a row’s state with 자료 없음 over 진행 중', () => {
    expect(observationRowState({ inProgress: true, noData: false })).toBe('inProgress');
    expect(observationRowState({ inProgress: false, noData: false })).toBe('done');
    expect(observationRowState({ inProgress: false, noData: true })).toBe('noData');
    expect(observationRowState({ inProgress: true, noData: true })).toBe('noData');
  });

  it('labels the time read and the pending targets older than the shown weeks', () => {
    const asOf = '2026-11-24T06:00:00.000Z';
    expect(observationAsOf(asOf)).toBe(`기준 시각 ${formatKst(asOf)}`);
    expect(pendingEarlierLine(0)).toBeNull();
    expect(pendingEarlierLine(3)).toBe('보이는 주보다 앞서 접수된 대기 대상 3개');
  });
});
