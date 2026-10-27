import { describe, expect, it } from 'vitest';
import {
  TIME_ZONE_MAX_LENGTH,
  isKnownTimeZone,
  timeZoneSchema,
  updateTimeZoneBodySchema,
} from './time-zone.js';

const NUL = String.fromCharCode(0);

describe('timeZoneSchema', () => {
  it('accepts IANA zones Intl knows, trimmed and stored as given', () => {
    for (const [input, stored] of [
      ['Asia/Seoul', 'Asia/Seoul'],
      ['America/New_York', 'America/New_York'],
      ['  Europe/London ', 'Europe/London'],
      ['America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
      ['America/Port-au-Prince', 'America/Port-au-Prince'],
      ['Etc/GMT+9', 'Etc/GMT+9'],
      ['UTC', 'UTC'],
      // Both spellings of a renamed zone: engines disagree on which is canonical, so neither is
      // rewritten into the other.
      ['Asia/Kolkata', 'Asia/Kolkata'],
      ['Asia/Calcutta', 'Asia/Calcutta'],
      // A link the engine resolves to another zone is kept as an alias, case and all.
      ['ROK', 'ROK'],
    ] as const) {
      const result = timeZoneSchema.safeParse(input);
      expect(result.success, input).toBe(true);
      expect(result.data, input).toBe(stored);
    }
  });

  it('accepts every zone this runtime lists, as the settings select offers them', () => {
    const refused = Intl.supportedValuesOf('timeZone').filter(
      (zone) => !timeZoneSchema.safeParse(zone).success,
    );
    expect(refused).toEqual([]);
  });

  it('refuses names Intl does not know, offsets, NUL and out-of-range lengths', () => {
    for (const bad of [
      '',
      '   ',
      'Mars/Olympus_Mons',
      'Asia/Seoul/Gangnam',
      'asia seoul',
      // Intl takes an offset as a zone, but it is not an IANA name.
      '+09:00',
      '-05:00',
      'GMT+9',
      `Asia/Seoul${NUL}`,
      `${NUL}Asia/Seoul`,
      // Trimming takes surrounding whitespace only; a control character inside stays and fails.
      'Asia/\tSeoul',
      'A'.repeat(TIME_ZONE_MAX_LENGTH + 1),
    ]) {
      expect(timeZoneSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses a spelling Intl matches only because it ignores case (ADR-0063)', () => {
    // Intl resolves every one of these to a real zone, but no engine lists them: stored, the
    // settings select would offer the name twice, and a comparison by name would miss.
    for (const bad of [
      'ASIA/SEOUL',
      'asia/seoul',
      'AMERICA/NEW_YORK',
      'America/New_york',
      'utc',
      'Utc',
      'etc/GMT+9',
      // An alias in lower case: the engine resolves it to another name, so the comparison with
      // that name cannot tell; the capital every part of a tzdb name starts with does.
      'asia/kolkata',
      'rok',
    ]) {
      expect(timeZoneSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('measures the length after trimming, so padding does not push a zone over the limit', () => {
    expect(timeZoneSchema.safeParse(`  Asia/Seoul${' '.repeat(TIME_ZONE_MAX_LENGTH)}`).data).toBe(
      'Asia/Seoul',
    );
  });

  it('refuses a non-string', () => {
    for (const bad of [9, true, {}, ['Asia/Seoul']]) {
      expect(timeZoneSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('isKnownTimeZone', () => {
  it('is the name check alone, without trimming', () => {
    expect(isKnownTimeZone('Asia/Seoul')).toBe(true);
    expect(isKnownTimeZone(' Asia/Seoul')).toBe(false);
    expect(isKnownTimeZone('+09:00')).toBe(false);
  });

  it('refuses what is not a string, which the pattern would read as "undefined"', () => {
    // A browser whose OS zone ICU cannot place reports `timeZone: undefined`; Intl takes that as
    // the default zone, so only the type check stops it (lib/time-zone.ts browserTimeZone).
    expect(isKnownTimeZone(undefined as never)).toBe(false);
    expect(isKnownTimeZone(null as never)).toBe(false);
  });
});

describe('updateTimeZoneBodySchema', () => {
  const account = { expectedAccountId: 'user-1' };

  it('takes a zone to set or null to follow the browser again', () => {
    expect(updateTimeZoneBodySchema.parse({ timeZone: ' America/New_York ', ...account })).toEqual({
      timeZone: 'America/New_York',
      ...account,
    });
    expect(updateTimeZoneBodySchema.parse({ timeZone: null, ...account })).toEqual({
      timeZone: null,
      ...account,
    });
  });

  it('requires the key, so a forgotten field is not a silent clear', () => {
    expect(updateTimeZoneBodySchema.safeParse(account).success).toBe(false);
    expect(updateTimeZoneBodySchema.safeParse({ timeZone: '', ...account }).success).toBe(false);
    expect(
      updateTimeZoneBodySchema.safeParse({ timeZone: 'Nowhere/Land', ...account }).success,
    ).toBe(false);
  });

  it('requires the account the screen shows, as the verification and password bodies do (A-PG-24)', () => {
    for (const body of [
      { timeZone: 'America/New_York' },
      { timeZone: null },
      { timeZone: null, expectedAccountId: '' },
      { timeZone: null, expectedAccountId: 'a'.repeat(256) },
      { timeZone: null, expectedAccountId: 7 },
    ]) {
      const parsed = updateTimeZoneBodySchema.safeParse(body);
      expect({ body, success: parsed.success }).toEqual({ body, success: false });
      expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    }
  });
});
