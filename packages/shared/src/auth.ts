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
 * Sign-up asks for the email only (ADR-0024): the account exists without any password until
 * the mailbox is proven, so registering someone else's address gains an attacker nothing.
 */
export const registerBodySchema = z.object({ email: z.email() }).meta({ id: 'RegisterBody' });
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
 * the account the screen is showing (`expectedAccountId`, as on the charge, coupon and trade
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
