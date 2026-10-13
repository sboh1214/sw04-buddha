import { afterAll, describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  formatKst,
  formatRemaining,
  isoToKstLocal,
  kstLocalToIso,
  rowAnchor,
  tickingNow,
} from './datetime';

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

describe('formatRemaining', () => {
  const closeAt = '2026-09-06T12:00:00.000Z';
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  /** The instant `ms` before the close, as the caller's injected `now`. */
  const before = (ms: number) => Date.parse(closeAt) - ms;

  it('counts down in two units whatever zone the machine is in', () => {
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      // A duration is the same length in every zone: unlike formatKst, this must never
      // acquire an offset, and the loop is what would catch it if it did.
      expect(formatRemaining(closeAt, before(3 * DAY + 4 * HOUR)), tz).toBe(
        `3${copy.unitDay} 4${copy.unitHour}`,
      );
      expect(formatRemaining(closeAt, before(4 * HOUR + 12 * MINUTE)), tz).toBe(
        `4${copy.unitHour} 12${copy.unitMinute}`,
      );
      expect(formatRemaining(closeAt, before(12 * MINUTE + 30_000)), tz).toBe(
        `12${copy.unitMinute} 30${copy.unitSecond}`,
      );
      expect(formatRemaining(closeAt, before(30_000)), tz).toBe(`30${copy.unitSecond}`);
    }
  });

  it('drops the smaller unit when it has run out and truncates rather than rounds', () => {
    expect(formatRemaining(closeAt, before(2 * DAY))).toBe(`2${copy.unitDay}`);
    expect(formatRemaining(closeAt, before(HOUR))).toBe(`1${copy.unitHour}`);
    // One second short of two days is 1일 23시간, never 2일: a countdown may not claim time
    // the market does not have.
    expect(formatRemaining(closeAt, before(2 * DAY - 1000))).toBe(
      `1${copy.unitDay} 23${copy.unitHour}`,
    );
  });

  it('renders nothing once the close has passed or the instant is unreadable', () => {
    // A-M3-31: a market whose close time has passed stays `open` until the close job runs, so
    // this is an ordinary state — the badge shows 마감됨 in this space.
    expect(formatRemaining(closeAt, Date.parse(closeAt))).toBe('');
    expect(formatRemaining(closeAt, Date.parse(closeAt) + 1000)).toBe('');
    expect(formatRemaining('not-a-date', Date.parse(closeAt))).toBe('');
    expect(formatRemaining('', Date.parse(closeAt))).toBe('');
  });
});

describe('tickingNow', () => {
  /** The server answered ten seconds before this market closes. */
  const CLOSE = Date.parse('2026-09-08T12:00:00.000Z');
  const anchor = CLOSE - 10_000;
  /** What the badge, and an order panel's close gate, ask: has the close passed yet? */
  const closed = (now: number) => now >= CLOSE;

  it('advances the server anchor by the browser duration, so a wrong clock cannot move the close', () => {
    // THE HAZARD: `closeAt` is the SERVER's instant and `Date.now()` is the visitor's, so the old
    // `Math.max(anchor, Date.now())` compared two machines. Here the browser supplies only the
    // elapsed — the one thing its clock measures correctly — and the reading is the same at every
    // skew, which is the whole point of the change.
    for (const elapsedMs of [0, 5_000, 9_999, 10_000, 30_000]) {
      const wallNow = anchor + elapsedMs; // a synced browser
      expect(tickingNow(anchor, elapsedMs, wallNow)).toBe(anchor + elapsedMs);
      // A minute fast and a minute slow answer identically: the wall clock is not consulted.
      expect(tickingNow(anchor, elapsedMs, wallNow + 60_000)).toBe(anchor + elapsedMs);
      expect(tickingNow(anchor, elapsedMs, wallNow - 60_000)).toBe(anchor + elapsedMs);
    }
  });

  it('keeps a slow browser from trading past the close, which the old floor did not', () => {
    // A browser a minute BEHIND used to be pinned at the anchor for the whole minute — the panel
    // went on offering 예/아니오 in a market that had closed, and the server refused each press.
    const elapsedMs = 11_000;
    const slowWall = anchor + elapsedMs - 60_000;
    expect(closed(Math.max(anchor, slowWall))).toBe(false); // the old reading: still open
    expect(closed(tickingNow(anchor, elapsedMs, slowWall))).toBe(true);
  });

  it('keeps a fast browser from taking a live market away, the half A-M4-23 dismissed', () => {
    // The worse direction, and the one the record called impossible ("only at the instant the
    // countdown reaches zero"): a browser a minute AHEAD won the `Math.max` outright and drew
    // 마감 a full minute early, so the visitor simply could not trade an open market.
    const elapsedMs = 5_000;
    const fastWall = anchor + elapsedMs + 60_000;
    expect(closed(Math.max(anchor, fastWall))).toBe(true); // the old reading: closed, wrongly
    expect(closed(tickingNow(anchor, elapsedMs, fastWall))).toBe(false);
  });

  it('hands back the wall clock when there is no anchor to add to', () => {
    // A card on the home grid renders the badge with no `now`: nothing to anchor to, and
    // display-only. That is today's behaviour, kept.
    expect(tickingNow(undefined, 5_000, 1_234_567)).toBe(1_234_567);
  });

  it('never runs backwards on a negative elapsed', () => {
    // `performance.now()` is monotonic, so this is defence rather than a case seen — but the
    // clock feeding a close gate must not be the thing that re-opens a closed market.
    expect(tickingNow(anchor, -5_000, anchor)).toBe(anchor);
  });
});

describe('the elapsed a ticking clock is given', () => {
  const CLOSE = Date.parse('2026-09-08T12:00:00.000Z');

  it('counts from when the reader adopted the anchor, never from the document', () => {
    // THE REGRESSION this pins, which a first attempt shipped: `performance.now()` BARE is the
    // DOCUMENT's age, and `next/link` keeps the document — so a visitor who browsed the grid for
    // five minutes and then opened a card handed the panel `anchor + 300s`. A market 30s from
    // closing drew 마감 with every trade control gone, for every visitor, skewed clock or not.
    const anchor = CLOSE - 30_000; // the detail says: 30 seconds left
    const documentAge = 300_000; // the visitor browsed for five minutes first
    expect(tickingNow(anchor, documentAge, 0)).toBeGreaterThan(CLOSE); // what bare gave: closed
    // Measured from THIS reader's own origin, a reader that just mounted reads the anchor.
    expect(tickingNow(anchor, 0, 0)).toBe(anchor);
    expect(tickingNow(anchor, 0, 0)).toBeLessThan(CLOSE); // open, which is the truth
  });
});

describe('rowAnchor', () => {
  const SERVER_NOW = 1_000_000_000_000;

  it('anchors the rows the server rendered, and only while the list is still its answer', () => {
    // The list holds the server's own answer: its stamp IS the instant handed down.
    expect(rowAnchor(0, 20, SERVER_NOW, SERVER_NOW)).toBe(SERVER_NOW);
    expect(rowAnchor(19, 20, SERVER_NOW, SERVER_NOW)).toBe(SERVER_NOW);
  });

  it('refuses a row 더 보기 appended, which would adopt the anchor minutes late', () => {
    // `tickingNow` counts from ADOPTION, so a card mounted five minutes on would read a
    // five-minute-old instant as the present and show that much more time remaining, forever.
    expect(rowAnchor(20, 20, SERVER_NOW, SERVER_NOW)).toBeUndefined();
    expect(rowAnchor(57, 20, SERVER_NOW, SERVER_NOW)).toBeUndefined();
  });

  it('refuses every row once a client write has restamped the list', () => {
    // A refetch or a `market:tick` restamps `dataUpdatedAt` with the BROWSER's clock (query-core
    // stamps every success that way; only the hydrated payload carries the server's). A browser
    // instant is exactly what must not reach a close reading, so the anchor is dropped.
    expect(rowAnchor(0, 20, SERVER_NOW + 5_000, SERVER_NOW)).toBeUndefined();
  });

  it('has nothing to offer when the page had no instant to hand down', () => {
    // A failed prefetch: every badge shows the absolute close time until it mounts, then ticks
    // on the wall clock — the behaviour those cards have always had.
    expect(rowAnchor(0, 20, SERVER_NOW, undefined)).toBeUndefined();
  });
});
