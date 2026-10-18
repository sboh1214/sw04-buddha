import { isKnownTimeZone } from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, isForAnotherAccount, validationField } from './api';
import { SEOUL_TIME_ZONE } from './datetime';

/**
 * Which zone a member screen reads times in (ADR-0061 #60-8, ADR-0063), as pure functions of
 * what the profile holds and what the browser reports, so vitest can run them under its node
 * environment — with the settings card's choices and what its failed save shows. The provider
 * (components/time-zone/time-zone-provider.tsx) feeds them; the formatter is `formatInTimeZone`
 * (lib/datetime.ts).
 */

/**
 * The browser's own zone, read from `Intl` — what "follow the browser" follows. A name the
 * engine reports but `isKnownTimeZone` refuses (an offset zone, a platform's private name) is
 * not a zone this app can store or mark, so Seoul stands in, the zone the first paint already
 * showed. So does no name at all: an engine that cannot place the OS zone (a `TZ` ICU does not
 * know) reports `undefined`, which `isKnownTimeZone` refuses as a non-string. Called only after
 * hydration; the server never asks (ADR-0063).
 */
export function browserTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isKnownTimeZone(zone) ? zone : SEOUL_TIME_ZONE;
}

/**
 * ADR-0061 #60-8: 'MY 설정에서 고른 시간대이고, 고르지 않았거나 로그인하지 않았으면 브라우저
 * 시간대다.' `picked` is `me.profile.timeZone` — `undefined` while signed out or before `/me`
 * has answered, `null` when the member follows the browser.
 *
 * A picked name this browser cannot read (stored from a browser with newer tzdata) falls back to
 * the browser's zone rather than to an unreadable one: the stored choice is kept, and the
 * settings select still shows it.
 */
export function effectiveTimeZone(picked: string | null | undefined, browser: string): string {
  if (picked !== null && picked !== undefined && isKnownTimeZone(picked)) return picked;
  return browser;
}

/** What TimeZoneProvider reads on every render, as `settledTimeZone` takes it. */
export interface TimeZoneReading {
  /**
   * The browser's zone (`browserTimeZone`), or `null` on the server and in the hydrating render
   * (the store's server snapshot).
   */
  browser: string | null;
  /** The account the session names (`session.user.id`), or `null` while signed out. */
  viewer: string | null;
  /** `useMe().isPending`: true until the session is known and, for a member, `/me` answered. */
  profilePending: boolean;
  /** `useMe().data`: whose profile `['me']` holds and the zone it picked. */
  me: { id: string; profile: { timeZone: string | null } } | undefined;
}

/**
 * The zone that applies to this render, or `null` while it is not known yet (ADR-0063).
 *
 * - Not before hydration (`browser` is `null`): the HTML is the same for every visitor, and the
 *   first client render must match it (AC 2).
 * - Not while `useMe` is pending: for a member who picked another zone, the browser's zone first
 *   would be a second switch, KST → the browser's → the pick, on every load.
 * - Not while `['me']` holds a profile of another account than the session's: the tab is
 *   switching accounts and SessionCacheGuard has not reset the cache yet (it does in an effect,
 *   after this render), so the zone held is the previous account's.
 *
 * Otherwise the effective zone. A visitor who is signed out has no profile to wait for: the
 * browser's zone. So has a member whose `/me` failed — nothing picked to apply — until a later
 * fetch answers.
 */
export function settledTimeZone(reading: TimeZoneReading): string | null {
  const { browser, viewer, profilePending, me } = reading;
  if (browser === null || profilePending) return null;
  if (me !== undefined && me.id !== viewer) return null;
  return effectiveTimeZone(me?.profile.timeZone, browser);
}

/** The last zone that settled, and for which viewer (an account id, or `null` signed out). */
export interface HeldTimeZone {
  readonly viewer: string | null;
  readonly zone: string;
}

/**
 * What TimeZoneProvider keeps from one render to the next: the zone that settled now, or, while
 * none has (`settled` is `null`), the one that settled last.
 *
 * THE HAZARD this exists for: `useMe` goes pending again after it has settled. better-auth sets
 * `isPending` at the start of every session fetch while its `data` is `null` — the focus refetch
 * on every return to the tab, a return online, a storage broadcast — so for a visitor who is
 * signed out it is pending once per refocus. Seoul in each of those would turn every absolute
 * time into unmarked KST for one round trip, then back. Held, the zone switches once per viewer.
 *
 * `last` itself comes back when nothing changed: the provider stores the answer during render
 * when it differs, and a new object every time would never stop asking for another render.
 */
export function holdTimeZone(
  last: HeldTimeZone | null,
  viewer: string | null,
  settled: string | null,
): HeldTimeZone | null {
  if (settled === null) return last;
  if (last !== null && last.viewer === viewer && last.zone === settled) return last;
  return { viewer, zone: settled };
}

/**
 * The zone TimeZoneProvider hands down: the one held for this viewer, or Seoul while none is —
 * the server's render, the hydrating one, the round trips until the profile is known. So a
 * page's times switch once at most (ADR-0063).
 *
 * A zone held for another viewer is not handed down: after a sign-in, a sign-out or an account
 * switch in another tab, the tab starts over from Seoul as a fresh load does (SessionCacheGuard
 * resets the cache at the same moment), rather than read the next account's screens in the
 * previous one's zone.
 */
export function displayTimeZone(held: HeldTimeZone | null, viewer: string | null): string {
  return held !== null && held.viewer === viewer ? held.zone : SEOUL_TIME_ZONE;
}

/**
 * The IANA zones with no place in them: `UTC` and the whole-hour offsets `Etc/GMT-14` …
 * `Etc/GMT+12` (POSIX signs: `Etc/GMT+5` is five hours behind UTC, and the marker after a time
 * says `GMT-5`). Every engine knows them, but V8 (Chrome, Edge — and Node) lists only zones with
 * a place, so without these a member on Chrome could not pick UTC. The links to UTC (`Etc/UTC`,
 * `Etc/GMT`, `GMT`, `Etc/GMT+0` …) are left out: the same zone, under a name `resolvedOptions()`
 * turns into `UTC` anyway.
 */
const ZONES_WITHOUT_A_PLACE: readonly string[] = [
  'UTC',
  ...Array.from({ length: 14 }, (_, i) => `Etc/GMT-${String(i + 1)}`),
  ...Array.from({ length: 12 }, (_, i) => `Etc/GMT+${String(i + 1)}`),
];

/**
 * Every IANA zone this browser knows (ADR-0061 #60-8): its own list
 * (`Intl.supportedValuesOf('timeZone')`) and the zones without a place it leaves out
 * (`ZONES_WITHOUT_A_PLACE`), each only if this engine reads it. None where
 * `Intl.supportedValuesOf` does not exist yet (Safari before 15.4): the select then offers "follow
 * the browser" and the stored zone, which is all that browser could apply anyway. Other names the
 * engine knows but does not list — links such as `US/Eastern` — are not added: no engine hands
 * out their list, and each is another name of a zone the list holds.
 */
export function supportedTimeZones(): readonly string[] {
  if (typeof Intl.supportedValuesOf !== 'function') return [];
  const listed = Intl.supportedValuesOf('timeZone');
  const held = new Set(listed);
  return [
    ...listed,
    ...ZONES_WITHOUT_A_PLACE.filter((zone) => !held.has(zone) && isKnownTimeZone(zone)),
  ];
}

/** The select's value for "follow the browser" (no stored zone): no IANA name is empty. */
export const FOLLOW_BROWSER = '';

/**
 * A zone's name as the engine's ko-KR data spells a GMT offset rather than a place: `GMT`,
 * `GMT+00:00`, `GMT-05:00`, and the same with `UTC` or a minus sign (U+2212), which other locale
 * data uses. ICU answers that for a zone with no Korean name: `UTC`, every `Etc/GMT±N`.
 */
const OFFSET_NAME = /^(?:GMT|UTC)(?:[+\-−]\d{1,2}(?::?\d{2})?)?$/;

/**
 * The Korean name the browser's `Intl` gives `zone` (owner decision 2026-10-16, ADR-0063):
 * `timeZoneName: 'longGeneric'` in ko-KR, the name that does not change with daylight saving
 * time — '미 동부 시간' all year, where `'long'` says '미 동부 표준시' in winter and
 * '미 동부 하계 표준시' in summer. `undefined` when there is none worth printing:
 *
 * - only a GMT offset (`OFFSET_NAME`): the zone has no Korean name, and an offset beside
 *   `Etc/GMT+5` would print its POSIX sign reversed (`GMT-05:00`);
 * - an empty name, or the IANA name again;
 * - a `RangeError`: an engine without `'longGeneric'` (before Chrome 95, Firefox 91, Safari
 *   15.4), or a zone this engine cannot read (stored from a browser with newer tzdata).
 *
 * `at` is the instant the name is read for: which name a zone has can change with its history.
 */
function koreanTimeZoneName(zone: string, at: Date): string | undefined {
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat('ko-KR', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')
      ?.value.trim();
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  if (name === undefined || name === '' || name === zone || OFFSET_NAME.test(name)) {
    return undefined;
  }
  return name;
}

/** Between a zone's IANA name and its Korean name in a select option. */
const LABEL_SEPARATOR = ' — ';

/**
 * A zone as the settings select names it (owner decision 2026-10-16, 이름 + 한국어 이름): the IANA
 * name, then the Korean name the browser gives it (`America/New_York — 미 동부 시간`), or the IANA
 * name alone where it has none (`UTC`, `Etc/GMT+5`, an engine without the name).
 */
export function timeZoneLabel(zone: string, at: Date = new Date()): string {
  const name = koreanTimeZoneName(zone, at);
  return name === undefined ? zone : `${zone}${LABEL_SEPARATOR}${name}`;
}

export interface TimeZoneOption {
  value: string;
  label: string;
}

/**
 * The settings select (ADR-0061 #60-8: 고를 수 있는 목록은 브라우저가 아는 모든 IANA 시간대다):
 * "follow the browser" first, naming the zone it follows today, then every zone `supported`
 * lists (`supportedTimeZones()`), sorted by IANA name in code-unit order so the order is the same
 * in every engine. Each option's value is the IANA name; its label is `timeZoneLabel`'s, and so is
 * the zone the first one names.
 *
 * A stored zone the list does not hold — picked in another browser that spells or knows zones
 * differently — is added, so the select shows the member's real choice instead of silently
 * reading as another option, and saving without touching it changes nothing.
 */
export function timeZoneOptions(
  supported: readonly string[],
  picked: string | null,
  browser: string,
  at: Date = new Date(),
): TimeZoneOption[] {
  const zones = new Set(supported);
  if (picked !== null) zones.add(picked);
  return [
    {
      value: FOLLOW_BROWSER,
      label: `${copy.timeZoneFollowBrowser} (${timeZoneLabel(browser, at)})`,
    },
    ...[...zones].sort().map((zone) => ({ value: zone, label: timeZoneLabel(zone, at) })),
  ];
}

/** The select's value for what the profile holds. */
export function timeZoneSelectValue(picked: string | null): string {
  return picked ?? FOLLOW_BROWSER;
}

/** What the select's value asks `PUT /me/time-zone` to store: `null` follows the browser. */
export function timeZoneFromSelect(value: string): string | null {
  return value === FOLLOW_BROWSER ? null : value;
}

/**
 * What the settings 시간대 card shows when `PUT /me/time-zone` fails: a message under the select,
 * or a toast (`realNameSaveFailure` in lib/phone-verification.ts is the same split for the
 * real-name card).
 *
 * - A `VALIDATION_ERROR` naming `timeZone`: the server's Intl does not know a zone this browser
 *   listed (newer tzdata here). The select is what to change, so the message goes under it.
 * - The 403 naming `expectedAccountId` (A-PG-24): the cookie now belongs to another account and
 *   nothing was written. The hook has asked for the session again, so SessionCacheGuard puts the
 *   account that is really signed in on screen; "try again" alone would be refused the same way
 *   until it has.
 * - Anything else: the generic failure, with the error's own text as the description.
 */
export type TimeZoneSaveFailure =
  { kind: 'field'; message: string } | { kind: 'toast'; title: string; description?: string };

export function timeZoneSaveFailure(error: unknown): TimeZoneSaveFailure {
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'timeZone') {
    return { kind: 'field', message: copy.errTimeZoneInvalid };
  }
  if (isForAnotherAccount(error)) return { kind: 'toast', title: copy.sessionChanged };
  return {
    kind: 'toast',
    title: copy.errUnknown,
    description: error instanceof Error ? error.message : undefined,
  };
}
