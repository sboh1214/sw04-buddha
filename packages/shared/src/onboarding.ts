import * as z from 'zod';
import { consentRecordSchema, type ConsentRecord } from './consent.js';
import { INT4_MAX } from './constants.js';
import { nicknameSchema } from './nickname.js';

/**
 * 가입 직후 온보딩 (#58, ADR-0069 decision 1 #57-7~#57-10 and decision 4 #58): 약관 동의 →
 * 본인확인 → 닉네임 설정, then the start Coin (#70) once the server has confirmed all three, the
 * notice screen, and the interest categories, which can be skipped.
 *
 * - `consent`: every required item agreed at a version that still holds (consent.ts) — false
 *   again for an account that agreed only before a revision that changed members' rights.
 * - `verification`: the SMS 본인확인 (#183, ADR-0070).
 * - `nickname`: the nickname step confirmed — the offered auto nickname unchanged counts.
 * - `interests`: the interest categories picked or skipped on their step.
 *
 * The first three are the onboarding (REQUIRED_ONBOARDING_STEPS): an account that has not done
 * them only browses, and the server refuses it what needs them (ONBOARDING_REQUIRED, #57-8), and
 * they are where an account resumes. The interest categories are not: the onboarding screen shows
 * them once, after the notice that follows the nickname step, and an account that left there has
 * skipped them — nothing sends it back (오너 결정 2026-10-19 (2차) 5, ADR-0072), and the screen
 * tells the server so (owner decision 2026-10-21, ADR-0078).
 *
 * REQUIRED_ONBOARDING_STEPS: the steps the onboarding is done with (#57-8, D18), in their order
 * (decision 4 #58).
 */
export const REQUIRED_ONBOARDING_STEPS = ['consent', 'verification', 'nickname'] as const;
export type RequiredOnboardingStep = (typeof REQUIRED_ONBOARDING_STEPS)[number];
export const onboardingStepSchema = z
  .enum(REQUIRED_ONBOARDING_STEPS)
  .meta({ id: 'OnboardingStep' });

/** Which steps an account has done; what `onboardingState` reads. */
export interface OnboardingProgress {
  readonly consent: boolean;
  readonly verification: boolean;
  readonly nickname: boolean;
  readonly interests: boolean;
}

/** The required steps an account has not done, in order. Empty: the onboarding is done. */
export function missingOnboardingSteps(progress: OnboardingProgress): RequiredOnboardingStep[] {
  return REQUIRED_ONBOARDING_STEPS.filter((step) => !progress[step]);
}

/**
 * `Me.onboarding`: the account's progress, for the web's gate and stepper. Owner-only, like all of
 * `GET /me`.
 */
export const onboardingSchema = z
  .object({
    consent: z.boolean(),
    verification: z.boolean(),
    nickname: z.boolean(),
    /** The three required steps done: the account may do what #57-8 keeps from the rest. */
    completed: z.boolean(),
    /**
     * The interest categories' step answered (#57-7): picked, skipped, or left — the screen sends
     * the skip when the account leaves it or the start-Coin notice before it without an answer
     * (owner decision 2026-10-21, ADR-0078) — or a first pick made in MY 설정 instead. Not a step to
     * resume at: an account that left the onboarding screen before answering them has skipped them.
     */
    interests: z.boolean(),
    /**
     * Where the account resumes (#57-8 '남은 단계부터'): the first required step not done, in
     * REQUIRED_ONBOARDING_STEPS order, or null once the three are done — the web's gate sends an
     * account with one to the onboarding screen.
     */
    nextStep: onboardingStepSchema.nullable(),
    /** The account's newest answer to each item it answered, in CONSENT_ITEMS order. */
    consents: z.array(consentRecordSchema),
  })
  .meta({ id: 'Onboarding' });
export type Onboarding = z.infer<typeof onboardingSchema>;

/** `Me.onboarding` from the account's progress and its newest consent answers. */
export function onboardingState(
  progress: OnboardingProgress,
  consents: readonly ConsentRecord[],
): Onboarding {
  const completed = missingOnboardingSteps(progress).length === 0;
  return {
    consent: progress.consent,
    verification: progress.verification,
    nickname: progress.nickname,
    completed,
    interests: progress.interests,
    nextStep: REQUIRED_ONBOARDING_STEPS.find((step) => !progress[step]) ?? null,
    consents: [...consents],
  };
}

/**
 * `ONBOARDING_REQUIRED`'s details: the required steps the account has not done — every one an
 * action needs (an action open to onboarded accounts only names all it misses; the code request of
 * the 본인확인 names the consent only).
 */
export const onboardingRequiredDetailsSchema = z.object({
  steps: z.array(z.enum(REQUIRED_ONBOARDING_STEPS)).min(1),
});
export type OnboardingRequiredDetails = z.infer<typeof onboardingRequiredDetailsSchema>;

const expectedAccountIdSchema = z.string().min(1).max(255);

/**
 * `POST /me/onboarding/nickname`: the nickname step. The nickname the account has (its auto
 * nickname) confirms it as it is; another one is held to the rules (nickname.ts). Either way it is
 * not a change for the interval, and the server grants the start Coin once the three steps are
 * done.
 */
export const setOnboardingNicknameBodySchema = z
  .object({ nickname: nicknameSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'SetOnboardingNicknameBody' });
export type SetOnboardingNicknameBody = z.infer<typeof setOnboardingNicknameBodySchema>;

/**
 * Bound on the categories one request names. There is no limit on how many a member picks (#57-7
 * «상한 없음»): this only bounds the input, far above the seeded list (~30, operators manage it,
 * D10).
 */
export const INTEREST_CATEGORIES_INPUT_MAX = 200;

/** The category ids one interests write names: active categories, top-level or sub (#57-7). */
const interestCategoryIdsSchema = z
  .array(z.number().int().min(1).max(INT4_MAX))
  .max(INTEREST_CATEGORIES_INPUT_MAX);

/**
 * `POST /me/onboarding/interests`: the onboarding's interests step (#57-7), from its screen — the
 * categories picked, top-level and sub-categories alike, active ones only; an empty list is the
 * skip, which the screen also sends when the account leaves it, or the start-Coin notice before it,
 * without an answer (owner decision 2026-10-21, ADR-0078). The step is answered either way and never
 * asked again. Ids repeat harmlessly.
 */
export const answerInterestsStepBodySchema = z
  .object({ categoryIds: interestCategoryIdsSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'AnswerInterestsStepBody' });
export type AnswerInterestsStepBody = z.infer<typeof answerInterestsStepBodySchema>;

/**
 * How long after the nickname step (`profiles.nickname_confirmed_at`) the interests step's answer
 * from its screen (`POST /me/onboarding/interests`) still counts as the step's first answer — the
 * account's first choice of a public profile item, which a writing or an account restriction lets
 * through. After it, an unanswered step's picks are a change as MY 설정's (refused under a
 * restriction; outside one saved, the step answered with them), and its skip records the skip. The
 * owner set it (owner decision 2026-10-21 (3rd) answer 1, ADR-0078): the screen comes right after
 * the nickname step, so this bounds the first answer of an account whose leaving the server never
 * heard of (ADR-0078 decision 7-23). A fixed value, not a release setting (docs/SETTINGS.md).
 */
export const INTERESTS_FIRST_ANSWER_WINDOW_HOURS = 24;

/**
 * `PUT /me/interest-categories`: MY 설정's interest categories (N04 §2's 관심 카테고리, a public
 * profile item, #41), replacing what the account had — top-level and sub-categories alike, active
 * ones only; an empty list drops them all. Never the onboarding step's answer
 * (`answerInterestsStepBodySchema`). Ids repeat harmlessly.
 */
export const setInterestCategoriesBodySchema = z
  .object({ categoryIds: interestCategoryIdsSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'SetInterestCategoriesBody' });
export type SetInterestCategoriesBody = z.infer<typeof setInterestCategoriesBodySchema>;
