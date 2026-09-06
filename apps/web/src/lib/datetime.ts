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

/** An ISO instant rendered for reading in KST (`2026. 9. 6. 오후 3:00`), as the lists show it. */
export function formatKst(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '' : kstDateTime.format(parsed);
}
