import * as z from 'zod';

/** PLAN 10.2 password bounds; 128 is better-auth's default maxPasswordLength. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .meta({ id: 'Password' });

/**
 * What better-auth's `user.name` holds for every account: nothing that names anyone. The column is
 * better-auth's and cannot be null; on the service a member is their nickname (`profiles`). A
 * social login's provider name is not stored, nor its profile photo — `user.image` stays null
 * (오너 결정 2026-10-19 (2차) 3, ADR-0072): the API's auth database hooks write this on every account
 * created, whatever the sign-up passed, and keep any later update — a provider's on sign-in or
 * linking, better-auth's own update-user — from writing either column. The seed's admins too.
 */
export const AUTH_USER_NAME = '';

/** The longest destination a sign-up carries through its verification mail (`RegisterBody.next`). */
export const NEXT_PATH_MAX_LENGTH = 2048;

/** ASCII control characters (0x00-0x1f, 0x7f) or a backslash (0x5c) anywhere in the path. */
function hasControlCharOrBackslash(path: string): boolean {
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Whether `path` is a path on this origin, safe to send a visitor to after signing in or up — the
 * one rule the web's post-auth destinations (`safeNextPath`, apps/web lib/next-path.ts) and the
 * sign-up's `next` (below) apply, so a crafted `?next=https://evil` never turns either into an open
 * redirect:
 * - `//host` is protocol-relative and `/\host` is treated the same by browsers;
 * - ASCII control characters are refused anywhere: the WHATWG URL parser strips tab and newline
 *   before parsing, so `/\t/evil.com` would resolve to `http://evil.com/`;
 * - finally the path must resolve on a fixed dummy origin, which is the authoritative check.
 */
export function isSameOriginPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (hasControlCharOrBackslash(path)) return false;
  try {
    return new URL(path, 'https://x.invalid').origin === 'https://x.invalid';
  } catch {
    return false;
  }
}

/** A post-auth destination: a path on this origin (`isSameOriginPath`), query string included. */
export const nextPathSchema = z
  .string()
  .max(NEXT_PATH_MAX_LENGTH)
  .refine(isSameOriginPath, 'not a path on this origin')
  .meta({ id: 'NextPath' });

/** Where the sign-up's verification link lands: the first password (ADR-0024). */
export const SET_PASSWORD_PATH = '/set-password';

/**
 * The verification link's destination (its `callbackURL`): /set-password, carrying `next` when the
 * sign-up has one and it is somewhere other than home (#58). The API builds the first mail's link
 * with it and the web the re-sent one's, so both land in the same place. better-auth adds its own
 * `error` to it on a broken link (`appendQueryParams`), beside `next`.
 */
export function setPasswordCallbackURL(next: string | undefined): string {
  return next === undefined || next === '/'
    ? SET_PASSWORD_PATH
    : `${SET_PASSWORD_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * Sign-up asks for the email only (ADR-0024): the account exists without any password until
 * the mailbox is proven, so registering someone else's address gains an attacker nothing.
 *
 * `next` is the page the visitor was on before signing up (#58, ADR-0069 decision 1 #57-9: after
 * the onboarding it goes back there). It rides in the verification link's `callbackURL`
 * (`/set-password?next=…`), the only thing that crosses the mailbox, so a link opened in another
 * browser still knows it. Optional: a sign-up from nowhere in particular goes home.
 */
export const registerBodySchema = z
  .object({ email: z.email(), next: nextPathSchema.optional() })
  .meta({ id: 'RegisterBody' });
export type RegisterBody = z.infer<typeof registerBodySchema>;

/**
 * Always the same answer, whether the address was free or already registered: telling the
 * two apart would let anyone enumerate accounts.
 */
export const registerResultSchema = z
  .object({ status: z.literal('sent') })
  .meta({ id: 'RegisterResult' });
export type RegisterResult = z.infer<typeof registerResultSchema>;

/**
 * First password of an account that has none (after verification, or a social-only user), and
 * the account the screen is showing (`expectedAccountId`, as on the charge and coupon
 * bodies). The cookie decides whose password is set, and a tab whose session was switched
 * elsewhere (another tab signed in as somebody else; sign-ins are not broadcast) keeps showing
 * the old account until it refetches — so the server refuses (403 FORBIDDEN naming the field)
 * rather than give that account a password typed on another's screen.
 */
export const setPasswordBodySchema = z
  .object({
    newPassword: passwordSchema,
    /** The signed-in user id the screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'SetPasswordBody' });
export type SetPasswordBody = z.infer<typeof setPasswordBodySchema>;

export const okResultSchema = z.object({ ok: z.literal(true) }).meta({ id: 'OkResult' });
export type OkResult = z.infer<typeof okResultSchema>;
