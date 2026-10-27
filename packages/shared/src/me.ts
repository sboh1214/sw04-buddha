import * as z from 'zod';
import { coinAmountSchema } from './api/coin-amount.js';
import { NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from './constants.js';
import { roleSchema } from './enums.js';
import { phoneVerificationSchema } from './phone-verification.js';
import { TIME_ZONE_MAX_LENGTH } from './time-zone.js';

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
      /**
       * The IANA zone picked in MY 설정 (ADR-0063), or null to follow the browser. A plain
       * string here, not `timeZoneSchema`: the name was checked when it was written, and a
       * reader whose tzdata lacks it falls back to the browser's zone rather than refusing the
       * whole profile.
       */
      timeZone: z.string().max(TIME_ZONE_MAX_LENGTH).nullable(),
    }),
    balance: z.object({ availableCoin: coinAmountSchema, lockedCoin: coinAmountSchema }),
    linkedAccounts: z.array(linkedAccountSchema),
    /**
     * The account's 본인확인 (ADR-0070): the mobile number it proved with an SMS code, the real
     * name it gave, and when; null until it confirms a code, which is what sends a signed-in
     * account to `/onboarding`. Owner-only, like everything here.
     */
    verification: phoneVerificationSchema.nullable(),
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof meSchema>;

export const updateMeBodySchema = z
  .object({ nickname: nicknameSchema })
  .meta({ id: 'UpdateMeBody' });
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;
