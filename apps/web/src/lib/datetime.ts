import { copy } from '@/copy';

/**
 * KST at the edges, UTC on the wire — PLAN 7 ("시각은 ISO 8601 UTC. 클라이언트가 KST로 표시")
 * and PLAN 12's "마감 시각(KST 입력, UTC 저장)" for the market form M3 still has to build.
 *
 * The offset is written out rather than derived from a timezone database: Seoul has been a
 * fixed UTC+9 with no DST since 1988, so `+09:00` is exact for every date these controls can
 * hold, and the alternative is a timezone library the app does not otherwise need.
 */
const KST_OFFSET = '+09:00';

/** `datetime-local` emits `YYYY-MM-DDTHH:mm`, or `:ss` when `step` asks for seconds. */
const WITHOUT_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Reads a `datetime-local` value as KST and returns the instant as UTC ISO, or `null` for an
 * empty or unparseable field (which the API takes as "no expiry").
 *
 * The control carries no zone, so `new Date(value)` would read it in whatever zone the
 * machine happens to be set to. Every screen here labels and renders these fields in KST, so
 * an admin on a UTC machine typing 23:59 would otherwise store 23:59Z and watch it come back
 * as 08:59 the next morning.
 */
export function kstLocalToIso(local: string): string | null {
  if (!local) return null;
  const seconds = WITHOUT_SECONDS.test(local) ? ':00' : '';
  const parsed = new Date(`${local}${seconds}${KST_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** `+09:00` as a duration, for shifting an instant into KST wall-clock fields. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * The inverse of `kstLocalToIso`: an ISO instant as the `YYYY-MM-DDTHH:mm` a `datetime-local`
 * control shows in KST, so an edit form can be prefilled with what the server holds. `''` for
 * an unparseable value (the control then shows blank rather than "Invalid Date").
 *
 * Seconds are dropped: the controls here have no `step`, and the API's timestamps for these
 * fields were written by the same controls, so nothing is lost on the round trip.
 */
export function isoToKstLocal(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  // Shift by the fixed offset and read UTC fields: no dependence on the machine's zone.
  const shifted = new Date(parsed.getTime() + KST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-` +
    `${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

const kstDateTime = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Seoul',
});

/**
 * The day period as ko-KR data older than CLDR 48 renders it. ICU 78 (CLDR 48, the ICU of
 * some Node 24 builds) says "AM"/"PM" for ko-KR; browsers and other Node builds say
 * "오전"/"오후". The screen must not depend on which ICU rendered it.
 */
const DAY_PERIODS: Readonly<Record<string, string>> = { AM: '오전', PM: '오후' };

/** An ISO instant rendered for reading in KST (`2026. 9. 6. 오후 3:00`), as the lists show it. */
export function formatKst(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return kstDateTime
    .formatToParts(parsed)
    .map((part) =>
      part.type === 'dayPeriod' ? (DAY_PERIODS[part.value] ?? part.value) : part.value,
    )
    .join('');
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The time left until `closeAt` for the countdown badge and the detail header: `3일 4시간`,
 * `4시간 12분`, `12분 30초`, `30초`. Two units at most, and the smaller one is dropped when it
 * is zero — the badge is a glance, not a stopwatch.
 *
 * `now` is injected rather than read from `Date.now()` for the reason `isClosingSoon` takes it
 * (market-admin.ts): a countdown that reads the clock inside the render produces a different
 * string on the server and in the first client render, which is a hydration mismatch on the
 * page AC 2 measures. The caller seeds `now` once and ticks it.
 *
 * `''` both for an unparseable instant and for a close that has already passed; the badge shows
 * `copy.marketClosed` there. A market whose close time is in the past stays `open` until the
 * close job runs (A-M3-31), so this is an ordinary state, not an error.
 *
 * No zone and no `Intl`: a duration is the same length in every zone, and
 * `Intl.RelativeTimeFormat` would hand the wording back to whichever ICU is at hand — the very
 * thing DAY_PERIODS above had to correct for.
 */
export function formatRemaining(closeAt: string, now: number): string {
  const parsed = new Date(closeAt).getTime();
  if (Number.isNaN(parsed)) return '';
  const remaining = parsed - now;
  if (remaining <= 0) return '';
  if (remaining >= DAY_MS) return unitPair(remaining, DAY_MS, copy.unitDay, HOUR_MS, copy.unitHour);
  if (remaining >= HOUR_MS)
    return unitPair(remaining, HOUR_MS, copy.unitHour, MINUTE_MS, copy.unitMinute);
  if (remaining >= MINUTE_MS)
    return unitPair(remaining, MINUTE_MS, copy.unitMinute, SECOND_MS, copy.unitSecond);
  return `${String(Math.floor(remaining / SECOND_MS))}${copy.unitSecond}`;
}

/** `3일 4시간`, or just `3일` when the smaller unit has run out. Both units truncate. */
function unitPair(
  remaining: number,
  majorMs: number,
  majorUnit: string,
  minorMs: number,
  minorUnit: string,
): string {
  const major = Math.floor(remaining / majorMs);
  const minor = Math.floor((remaining - major * majorMs) / minorMs);
  const head = `${String(major)}${majorUnit}`;
  return minor === 0 ? head : `${head} ${String(minor)}${minorUnit}`;
}

/**
 * The instant a ticking clock should report, given the ANCHOR it started from and how long the
 * browser has observed since. The 마감 countdown reads it, and an order panel's close gate must
 * read the same clock (A-M4-23).
 *
 * THE HAZARD it closes: the two numbers being compared come from DIFFERENT MACHINES. `closeAt`
 * is the server's, and `Date.now()` is the visitor's — a browser whose clock is wrong is wrong
 * about the close by exactly its skew, in whichever direction the skew runs. The panel used to
 * take `Math.max(anchor, Date.now())`, which is not a repair: a browser running BEHIND is pinned
 * at the anchor and its clock never advances until the skew is spent, so it goes on offering
 * trades in a market that has closed; one running AHEAD wins the `Math.max` outright and draws
 * 마감 over a market that is still open, which is the worse half — the first costs a round trip
 * the server refuses, the second takes the trade away. A-M4-23
 * recorded the first and dismissed the second as "only at the instant the countdown reaches
 * zero", which measurement did not bear out: a 60s-fast browser reads 마감 a full minute early.
 *
 * So the browser is asked only for a DURATION, which is the one thing its clock measures
 * correctly, and it is added to a server instant. `elapsedMs` must come from a MONOTONIC source
 * (`performance.now()` deltas): `Date.now()` deltas jump when NTP steps the clock mid-session,
 * which is exactly the moment this is protecting.
 *
 * `elapsedMs` must be measured from the moment THIS reader adopted THIS anchor — a monotonic
 * origin captured once per component instance, `??=` into a ref so an effect re-run cannot
 * restart it and rewind the clock. Nothing recovers time that passed before the adoption, so an
 * anchor adopted LATE is read as the present; `rowAnchor` below is what keeps a late reader from
 * adopting one at all.
 *
 * `performance.now()` BARE was tried and is WRONG, and naming it is the point of this paragraph:
 * bare is the DOCUMENT's age, and a `next/link` navigation keeps the document. The grid links to
 * the detail that way (market-card.tsx), so a visitor who browsed for five minutes before
 * clicking a card landed on a detail reading five minutes AHEAD of the anchor — measured, a
 * market 30s from closing drew 마감. That is the fast-clock half of the
 * hazard above, reintroduced for every visitor whether or not their clock is wrong.
 *
 * What a per-instance origin leaves uncounted is the head of the visit: the anchor is stamped
 * before the response is serialized, transferred, parsed and hydrated, so the clock runs that far
 * BEHIND. That direction is the safe one — the server decides a close on its own clock
 * (A-M3-16) — where the old reading was wrong by the visitor's whole skew, minutes or hours, in
 * the direction that takes the trade away.
 *
 * A suspend is the other residue, in the other direction: `performance.now()` may stop while wall
 * time passes, so a resumed tab reads behind. Advancing by `Math.max(monotonic, wallDelta)` would
 * close it and was REJECTED, because it re-opens the failure this exists to remove — on the very
 * machine this is for, the one whose clock is wrong, an NTP correction lands inside the wall
 * delta, and a measured 60s forward step then draws 마감 60s early on an open market. A resumed
 * tab is behind in every other way too and the server still refuses the late trade; a corrected
 * clock is not, and being shown 마감 on a live market takes the trade away with no recourse.
 *
 * With NO anchor the wall clock is all there is, and the caller gets it back unchanged: a card
 * on the home grid renders the badge with no `now` and is display-only.
 */
export function tickingNow(anchor: number | undefined, elapsedMs: number, wallNow: number): number {
  if (anchor === undefined) return wallNow;
  return anchor + Math.max(0, elapsedMs);
}

/**
 * The server instant a grid row may anchor its countdown to, or `undefined` for a row that must
 * fall back to the wall clock.
 *
 * THE HAZARD: `tickingNow` adds the duration observed since the anchor was ADOPTED, so an anchor
 * is only usable by a reader that mounted with it. The home page stamps ONE instant and hands it
 * to every card, including the rows 더 보기 appends minutes later. Those adopt it long after it
 * was stamped and would read it as the present — a card mounted five minutes on would show five
 * minutes more remaining than is true, and would go on being wrong by that much.
 *
 * So the instant is offered only to the rows the SERVER rendered — the first page — and only
 * while the list still holds the server's own answer for them: any client write (a refetch, a
 * `market:tick`) restamps `listUpdatedAt` with the BROWSER's clock, and a browser instant is
 * exactly what must not reach a close reading. Every other row gets `undefined`, which
 * `tickingNow` answers with the wall clock — the reading those cards had before anchoring
 * existed, and safe there because a grid badge is display-only.
 */
export function rowAnchor(
  index: number,
  serverRowCount: number,
  listUpdatedAt: number,
  now: number | undefined,
): number | undefined {
  if (now === undefined) return undefined;
  return index < serverRowCount && listUpdatedAt === now ? now : undefined;
}
