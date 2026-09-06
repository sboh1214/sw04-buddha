import { afterAll, describe, expect, it } from 'vitest';
import { formatKst, isoToKstLocal, kstLocalToIso } from './datetime';

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('kstLocalToIso', () => {
  it('reads the field as KST whatever zone the machine is in', () => {
    // Node re-reads process.env.TZ per Date operation, so this is the real regression guard:
    // with `new Date(local)` the UTC row below came back as 2026-12-31T23:59Z, nine hours out.
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      expect(kstLocalToIso('2026-12-31T23:59'), tz).toBe('2026-12-31T14:59:00.000Z');
    }
  });

  it('accepts a value that carries seconds', () => {
    process.env.TZ = 'UTC';
    expect(kstLocalToIso('2026-12-31T23:59:30')).toBe('2026-12-31T14:59:30.000Z');
  });

  it('treats an empty or unparseable field as "no expiry"', () => {
    expect(kstLocalToIso('')).toBeNull();
    expect(kstLocalToIso('not-a-date')).toBeNull();
    expect(kstLocalToIso('2026-13-45T99:99')).toBeNull();
  });
});

describe('isoToKstLocal', () => {
  it('renders the instant in KST whatever zone the machine is in', () => {
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      expect(isoToKstLocal('2026-12-31T14:59:00.000Z'), tz).toBe('2026-12-31T23:59');
      // Crosses a date line in KST: 20:30Z is 05:30 the next morning in Seoul.
      expect(isoToKstLocal('2026-02-28T20:30:00.000Z'), tz).toBe('2026-03-01T05:30');
    }
  });

  it('is the inverse of kstLocalToIso for a minute-precision value', () => {
    process.env.TZ = 'America/New_York';
    const local = '2026-09-06T09:05';
    const iso = kstLocalToIso(local);
    expect(iso).not.toBeNull();
    expect(isoToKstLocal(iso ?? '')).toBe(local);
  });

  it('pads single-digit months, days, hours and minutes', () => {
    expect(isoToKstLocal('2026-01-02T00:03:00.000Z')).toBe('2026-01-02T09:03');
  });

  it('returns an empty field for an unparseable instant', () => {
    expect(isoToKstLocal('')).toBe('');
    expect(isoToKstLocal('not-a-date')).toBe('');
  });
});

describe('formatKst', () => {
  it('renders in KST regardless of the machine zone', () => {
    // 14:59Z is 23:59 in Seoul (and 09:59 in New York). The day period reads "오후" whether
    // the ICU at hand renders ko-KR as "PM" (CLDR 48 / ICU 78, some Node 24 builds) or as
    // "오후" (browsers, other Node builds): formatKst maps the token itself.
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      expect(formatKst('2026-12-31T14:59:00.000Z'), tz).toBe('2026. 12. 31. 오후 11:59');
      // Crosses a date line in KST: 20:30Z is 05:30 the next morning in Seoul.
      expect(formatKst('2026-02-28T20:30:00.000Z'), tz).toBe('2026. 3. 1. 오전 5:30');
    }
  });

  it('renders nothing for an unparseable instant', () => {
    expect(formatKst('not-a-date')).toBe('');
  });
});
