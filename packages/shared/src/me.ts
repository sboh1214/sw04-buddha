import * as z from 'zod';
import { coinAmountSchema } from './api/coin-amount.js';
import { NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from './constants.js';
import { contactSchema } from './contact.js';
import { roleSchema } from './enums.js';

/**
 * Nickname charset (PLAN 17 Q4 default + `_`): Hangul syllables, ASCII letters, digits and
 * underscore. The underscore is required because the auto nickname is `user_XXXX` (PLAN
 * 10.4; prefix from ADR-0052). Recorded as QUESTIONS A-M1 assumption. Uniqueness is
 * case-sensitive (Postgres UNIQUE on profiles.nickname).
 */
export const NICKNAME_PATTERN = /^[A-Za-z0-9가-힣_]+$/;

export const nicknameSchema = z
  .string()
  .min(NICKNAME_MIN_LENGTH)
  .max(NICKNAME_MAX_LENGTH)
  .regex(NICKNAME_PATTERN, 'only Korean, letters, digits and _')
  .meta({ id: 'Nickname' });

export const linkedAccountSchema = z
  .object({
    /** better-auth `account.id`: what `authClient.unlinkAccount({ accountId })` expects. */
    id: z.string(),
    /** better-auth providerId: "credential" (email + password), "google", "kakao", "naver". */
    providerId: z.string(),
    /** Provider-side subject (equals the user id for credential accounts). */
    accountId: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'LinkedAccount' });
export type LinkedAccount = z.infer<typeof linkedAccountSchema>;

export const meSchema = z
  .object({
    /** better-auth user fields the settings screen shows. */
    id: z.string(),
    email: z.email(),
    emailVerified: z.boolean(),
    profile: z.object({
      nickname: nicknameSchema,
      role: roleSchema,
      createdAt: z.iso.datetime(),
    }),
    balance: z.object({ availableCoin: coinAmountSchema, lockedCoin: coinAmountSchema }),
    linkedAccounts: z.array(linkedAccountSchema),
    /**
     * Real name and mobile number (ADR-0043); null until the member provides them, which is
     * what sends a signed-in account to `/onboarding`.
     */
    contact: contactSchema.nullable(),
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof meSchema>;

export const updateMeBodySchema = z
  .object({ nickname: nicknameSchema })
  .meta({ id: 'UpdateMeBody' });
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;
