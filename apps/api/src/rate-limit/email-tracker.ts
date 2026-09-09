/** Longest address an `email` bucket counts. Anything longer is not a mailbox. */
const EMAIL_TRACKER_MAX = 320;

/**
 * The bucket an `email`-scoped limit counts a request against, or `undefined` when the value
 * is not an address at all.
 *
 * Case-folded and trimmed so `A@x` and ` a@x ` are one mailbox: they are one mailbox to the
 * mail server, and a limiter that disagreed would be trivially evaded by shifting a letter.
 *
 * No dependency on either caller on purpose: the same normalisation has to hold for the Nest
 * route (`POST /auth/register`, through the throttler's tracker) and for better-auth's own
 * paths (through its `hooks.before`), and those two live on opposite sides of the middie
 * boundary.
 */
export function emailTracker(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= EMAIL_TRACKER_MAX ? normalized : undefined;
}
