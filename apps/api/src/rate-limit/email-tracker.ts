/**
 * The bucket an `email`-scoped limit counts a request against, or `undefined` when the value
 * is not a string with anything in it.
 *
 * Case-folded and trimmed so `A@x` and ` a@x ` are one mailbox: they are one mailbox to the
 * mail server, and a limiter that disagreed would be trivially evaded by shifting a letter.
 *
 * No upper bound on length, deliberately. The first shape of this returned `undefined` past
 * 320 characters on the argument that nothing longer is a mailbox — true, and beside the point:
 * a value the limiter declines to key on is a value the limiter does not count, and
 * `z.email()` accepts a 400-character local part, so every mail path had a recipient string
 * that was free to name (the mail fails at the relay, but each attempt is still a relay call
 * and an error line). Every caller hashes the tracker before it reaches Redis, so length costs
 * nothing there; a limiter should count everything that claims to be an address.
 *
 * No dependency on either caller on purpose: the same normalisation has to hold for the Nest
 * route (`POST /auth/register`, through the throttler's tracker) and for better-auth's own
 * paths (through its `hooks.before`), and those two live on opposite sides of the middie
 * boundary.
 */
export function emailTracker(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}
