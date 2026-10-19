import * as z from 'zod';
import { coinAmountSchema } from './api/coin-amount.js';
import { roleSchema } from './enums.js';
import { nicknameSchema } from './nickname.js';
import { onboardingSchema } from './onboarding.js';
import { phoneVerificationSchema } from './phone-verification.js';
import { startGrantSchema } from './start-grant.js';
import { TIME_ZONE_MAX_LENGTH } from './time-zone.js';

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
      /**
       * When the nickname may change again (#57-6: once in NICKNAME_CHANGE_INTERVAL_DAYS after
       * the onboarding): the last change plus the interval — past once it has gone by — or null
       * while it never changed after the onboarding's nickname step (which is not a change).
       */
      nicknameChangeAvailableAt: z.iso.datetime().nullable(),
      /**
       * The account's interest categories (#58, N04 §2's 관심 카테고리), category ids in id order;
       * empty while none is chosen. A public profile item once #41 shows the profile (#37-5).
       */
      interestCategoryIds: z.array(z.number().int().min(1)),
    }),
    balance: z.object({ availableCoin: coinAmountSchema, lockedCoin: coinAmountSchema }),
    linkedAccounts: z.array(linkedAccountSchema),
    /**
     * The account's 본인확인 (ADR-0070): the mobile number it proved with an SMS code, the real
     * name it gave, and when; null until it confirms a code, which is what sends a signed-in
     * account to `/onboarding`. Owner-only, like everything here.
     */
    verification: phoneVerificationSchema.nullable(),
    /**
     * The account's start Coin (#70, ADR-0071): `pending` while the amount is undecided (the
     * wallet says it will be paid), `granted` once paid, `number_used` when the onboarding asked
     * for it but the verified number had already received its start Coin on another account
     * (ADR-0069 decision 1 #57-1; the notice screen says so, ADR-0072); null until the onboarding
     * asks for it. Owner-only, like the balance: only the account learns this of its own number.
     */
    startGrant: startGrantSchema.nullable(),
    /**
     * The onboarding (#58): which steps are done and where the account resumes. What sends a
     * signed-in account that has not completed it to `/onboarding` (#57-8).
     */
    onboarding: onboardingSchema,
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof meSchema>;

/**
 * `PATCH /me`: the nickname change of MY 설정, held to the rules and the interval (#57-6,
 * nickname.ts). Names the account the screen shows (`expectedAccountId`, as every owner write since
 * A-PG-24): with a change a month, renaming the account another tab signed in as would cost it its
 * change until the interval passes.
 */
export const updateMeBodySchema = z
  .object({ nickname: nicknameSchema, expectedAccountId: z.string().min(1).max(255) })
  .meta({ id: 'UpdateMeBody' });
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;
