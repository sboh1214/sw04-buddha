import * as z from 'zod';

/**
 * Real name and mobile number of an account (ADR-0043), collected as a PG's buyer details — no
 * PG reads them since SmartroPay went (ADR-0049, D8 keeps the collection). Email sign-up
 * collects them on the set-password step and every other account is sent to `/onboarding`
 * until it provides them. Not verified yet (본인인증 comes later), so these are what the
 * member typed, checked for shape only.
 */

/** user_contacts.real_name is varchar(30). */
export const REAL_NAME_MIN_LENGTH = 2;
export const REAL_NAME_MAX_LENGTH = 30;

/**
 * Letters of any script (Hangul, Latin, …), with spaces and the middle dot `·` between them —
 * no digits, no other symbols. Starts and ends with a letter (or a combining mark after one).
 */
export const REAL_NAME_PATTERN = /^\p{L}[\p{L}\p{M} ·]*[\p{L}\p{M}]$/u;

/** A Korean mobile number, digits only: 010/011/016/017/018/019 + 7 or 8 digits. */
export const PHONE_PATTERN = /^01[016789]\d{7,8}$/;

/**
 * NFC-normalised before the checks, so a name typed as decomposed Hangul (NFD, macOS) is stored
 * as the same syllables and counted by syllable, not by jamo.
 */
export const realNameSchema = z
  .string()
  .trim()
  .normalize('NFC')
  .min(REAL_NAME_MIN_LENGTH)
  .max(REAL_NAME_MAX_LENGTH)
  .regex(REAL_NAME_PATTERN, 'only letters, spaces and ·');

/**
 * Accepts the ways a number is usually typed (`010-1234-5678`, `010 1234 5678`) and yields the
 * digits alone, which is what is stored and what the PG receives.
 */
export const phoneSchema = z
  .string()
  .trim()
  .max(20)
  .regex(/^[0-9 -]+$/, 'only digits, spaces and -')
  .transform((value) => value.replace(/[ -]/g, ''))
  .pipe(z.string().regex(PHONE_PATTERN, 'must be a Korean mobile number (01X)'));

/** The two fields, both every time: what the forms take and what `user_contacts` stores. */
export const contactFieldsSchema = z.object({ realName: realNameSchema, phone: phoneSchema });
export type ContactFields = z.infer<typeof contactFieldsSchema>;

/**
 * `PUT /me/contact` (and the email sign-up step): the two fields, and the account the screen is
 * showing (`expectedAccountId`, as on the charge and coupon bodies). The cookie decides
 * whose contact is written, and a tab whose session was switched elsewhere (another tab signed
 * in as somebody else; sign-ins are not broadcast) keeps showing the old account until it
 * refetches — the sign-up step's second request can even leave after the switch — so the server
 * refuses (403 FORBIDDEN naming the field) rather than overwrite another account's real name and
 * number with these.
 */
export const contactBodySchema = z
  .object({
    ...contactFieldsSchema.shape,
    /** The signed-in user id the screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'ContactBody' });
export type ContactBody = z.infer<typeof contactBodySchema>;

/** A stored contact: `phone` is digits only. */
export const contactSchema = z
  .object({
    realName: z.string(),
    phone: z.string().regex(PHONE_PATTERN),
  })
  .meta({ id: 'Contact' });
export type Contact = z.infer<typeof contactSchema>;
