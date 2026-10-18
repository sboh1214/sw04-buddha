import * as z from 'zod';

/**
 * The time zone a member reads times in (ADR-0061 #60-8, ADR-0063): the one picked in MY 설정,
 * stored on the profile, or none — "follow the browser". The web applies it; nothing on the
 * server formats a time in it.
 */

/** profiles.time_zone is varchar(64); the longest IANA name today is 32 characters. */
export const TIME_ZONE_MAX_LENGTH = 64;

/**
 * The shape of an IANA zone name: `Area/Location[/Sublocation]` or a legacy single word (`UTC`,
 * `EST5EDT`), in ASCII letters, digits, `_`, `-` and `+`, every part starting with a capital
 * letter as every tzdb name does (`Asia/Seoul`, `America/Port-au-Prince`, `Etc/GMT+9`). What it
 * keeps out is what `Intl.DateTimeFormat` would accept although it is no IANA name — an offset
 * such as `+09:00`, a lower-case spelling such as `asia/seoul` (`Intl` matches names whatever
 * their case) — and every control character, NUL included (Postgres text cannot store NUL).
 */
const IANA_NAME_PATTERN = /^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*)*$/;

/**
 * Whether `name` is an IANA zone this runtime's `Intl` knows, spelled as the zone database spells
 * it. On the API that is Node's ICU: the same check the browser's own list passed, against the
 * tzdata the server has. A zone too new for it is refused rather than stored unreadable.
 *
 * `Intl` matches a name whatever its case (`ASIA/SEOUL` is Asia/Seoul), and no engine's list
 * holds such a spelling, so a name that differs from the engine's own (`resolvedOptions()`) in
 * case alone is refused: stored, it would sit beside the real one as a second choice in the
 * settings select and compare unequal to it by name. Another name the engine resolves to
 * (`Asia/Kolkata` to `Asia/Calcutta`, `ROK` to `Asia/Seoul`) is an alias and is kept — whose case
 * the engine cannot tell, beyond the capital each part starts with (ADR-0063).
 *
 * A non-string is refused before the pattern sees it: `RegExp#test` reads `undefined` as the
 * string 'undefined', and `Intl` takes `timeZone: undefined` as "the default zone".
 */
export function isKnownTimeZone(name: string): boolean {
  if (typeof name !== 'string' || !IANA_NAME_PATTERN.test(name)) return false;
  let resolved: unknown;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    // RangeError: the runtime has no such zone.
    return false;
  }
  if (typeof resolved !== 'string' || resolved === '') return false;
  return resolved === name || resolved.toLowerCase() !== name.toLowerCase();
}

/**
 * A zone name as a request carries it: trimmed, 1..64 characters, known to `Intl` in the zone
 * database's spelling (`isKnownTimeZone`). Stored as given (not as `resolvedOptions().timeZone`):
 * engines disagree on which spelling of a renamed zone is canonical (`Asia/Kolkata` and
 * `Asia/Calcutta`), and the browser that picked the name from its own list must find it there
 * again.
 */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(TIME_ZONE_MAX_LENGTH)
  .refine(isKnownTimeZone, 'must be an IANA time zone name');

/**
 * `PUT /me/time-zone`: the zone to read times in, or `null` to follow the browser again. The key
 * is required either way, so a body that forgot it is a 400 rather than a silent clear.
 *
 * The body also names the account the screen is showing (`expectedAccountId`, as on the
 * verification and password bodies, A-PG-24). The cookie decides whose profile is written, and a
 * tab whose session was switched elsewhere (another window signed in as somebody else; sign-ins
 * are not broadcast) keeps showing the old account: without it the zone picked there would land
 * on the other account, which nothing on that screen would show (ADR-0063). The server refuses
 * the mismatch (403 FORBIDDEN naming the field) before it writes.
 */
export const updateTimeZoneBodySchema = z
  .object({
    timeZone: timeZoneSchema.nullable(),
    /** The signed-in user id the screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'UpdateTimeZoneBody' });
export type UpdateTimeZoneBody = z.infer<typeof updateTimeZoneBodySchema>;
