/**
 * The Korean calendar day of the admin's SMS send status (ADR-0070 7-28, ADR-0061 #60-8) without
 * Postgres: the date of an instant and the start of its day, at fixed instants either side of
 * midnight in Seoul (15:00 UTC), so a wrong offset fails whatever hour the suite runs at. The
 * database's grouping by the same day is admin-sms-status.controller.test.ts's. Runs everywhere.
 */
import { describe, expect, it } from 'vitest';
import { kstDate, kstDayStart } from './sms-status.service.js';

const at = (iso: string) => Date.parse(iso);

describe('the Korean calendar day of the send status', () => {
  it('dates an instant in Seoul: the day turns at 15:00 UTC, not at UTC midnight', () => {
    expect(kstDate(at('2026-10-17T14:59:59.999Z'))).toBe('2026-10-17');
    expect(kstDate(at('2026-10-17T15:00:00.000Z'))).toBe('2026-10-18');
    // UTC midnight is 09:00 in Seoul: the same day either side of it.
    expect(kstDate(at('2026-10-17T23:59:59.999Z'))).toBe('2026-10-18');
    expect(kstDate(at('2026-10-18T00:00:00.000Z'))).toBe('2026-10-18');
    // Across a month and a year.
    expect(kstDate(at('2026-10-31T15:00:00.000Z'))).toBe('2026-11-01');
    expect(kstDate(at('2026-12-31T15:00:00.000Z'))).toBe('2027-01-01');
  });

  it('starts the day an instant falls in at midnight in Seoul', () => {
    const midnight = at('2026-10-17T15:00:00.000Z'); // 2026-10-18 00:00 in Seoul
    for (const iso of [
      '2026-10-17T15:00:00.000Z',
      '2026-10-17T23:59:59.999Z',
      '2026-10-18T03:00:00.000Z',
      '2026-10-18T14:59:59.999Z',
    ]) {
      expect(kstDayStart(at(iso)), iso).toBe(midnight);
    }
    // A millisecond before midnight is the day before's.
    expect(kstDayStart(midnight - 1)).toBe(at('2026-10-16T15:00:00.000Z'));
    // Its own date is the day's.
    expect(kstDate(kstDayStart(at('2026-10-18T03:00:00.000Z')))).toBe('2026-10-18');
  });
});
