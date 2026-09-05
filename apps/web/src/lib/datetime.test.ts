import { afterAll, describe, expect, it } from 'vitest';
import { kstLocalToIso } from './datetime';

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
