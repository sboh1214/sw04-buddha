import { describe, expect, it } from 'vitest';
import { INT4_MAX } from './constants.js';
import {
  INTEREST_CATEGORIES_INPUT_MAX,
  INTERESTS_FIRST_ANSWER_WINDOW_HOURS,
  REQUIRED_ONBOARDING_STEPS,
  answerInterestsStepBodySchema,
  missingOnboardingSteps,
  onboardingRequiredDetailsSchema,
  onboardingSchema,
  onboardingState,
  setInterestCategoriesBodySchema,
  setOnboardingNicknameBodySchema,
  type OnboardingProgress,
} from './onboarding.js';

const none: OnboardingProgress = {
  consent: false,
  verification: false,
  nickname: false,
  interests: false,
};
const record = {
  item: 'terms' as const,
  version: 'draft-2026-10-18',
  agreed: true,
  recordedAt: '2026-10-18T00:00:00.000Z',
};

describe('onboarding steps (decision 4 #58, #57-7)', () => {
  it('runs consent, verification and nickname', () => {
    expect(REQUIRED_ONBOARDING_STEPS).toEqual(['consent', 'verification', 'nickname']);
  });

  it('names the required steps not done, in order', () => {
    expect(missingOnboardingSteps(none)).toEqual(['consent', 'verification', 'nickname']);
    expect(missingOnboardingSteps({ ...none, verification: true })).toEqual([
      'consent',
      'nickname',
    ]);
    expect(
      missingOnboardingSteps({
        consent: true,
        verification: true,
        nickname: true,
        interests: false,
      }),
    ).toEqual([]);
  });
});

describe('onboardingState', () => {
  it('resumes at the first step not done (#57-8)', () => {
    expect(onboardingState(none, []).nextStep).toBe('consent');
    expect(onboardingState({ ...none, consent: true }, []).nextStep).toBe('verification');
    expect(onboardingState({ ...none, consent: true, verification: true }, []).nextStep).toBe(
      'nickname',
    );
    // A re-consent after a revision: the account had done everything else.
    const reconsent = onboardingState(
      { consent: false, verification: true, nickname: true, interests: true },
      [record],
    );
    expect(reconsent).toEqual({
      consent: false,
      verification: true,
      nickname: true,
      completed: false,
      interests: true,
      nextStep: 'consent',
      consents: [record],
    });
    expect(onboardingSchema.parse(reconsent)).toEqual(reconsent);
  });

  it('completes with the three required steps: the interests are no step to resume at', () => {
    // An account that left before answering them skipped them (오너 결정 2026-10-19 (2차) 5).
    const done = { consent: true, verification: true, nickname: true, interests: false };
    expect(onboardingState(done, [])).toMatchObject({
      completed: true,
      interests: false,
      nextStep: null,
    });
    expect(onboardingState({ ...done, interests: true }, [])).toMatchObject({
      completed: true,
      interests: true,
      nextStep: null,
    });
    expect(
      onboardingSchema.safeParse({ ...onboardingState(done, []), nextStep: 'interests' }).success,
    ).toBe(false);
  });

  it('describes the refusal of an account that has not done them', () => {
    expect(onboardingRequiredDetailsSchema.parse({ steps: ['consent'] })).toEqual({
      steps: ['consent'],
    });
    expect(onboardingRequiredDetailsSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(onboardingRequiredDetailsSchema.safeParse({ steps: ['interests'] }).success).toBe(false);
  });
});

describe('onboarding bodies', () => {
  it('takes the nickname step’s nickname in the stored format, the auto nickname included', () => {
    for (const nickname of ['user_A7K2', '홍길동']) {
      expect(setOnboardingNicknameBodySchema.parse({ nickname, expectedAccountId: 'u1' })).toEqual({
        nickname,
        expectedAccountId: 'u1',
      });
    }
    expect(
      setOnboardingNicknameBodySchema.safeParse({ nickname: 'a', expectedAccountId: 'u1' }).success,
    ).toBe(false);
  });

  it.each([
    ['the onboarding step', answerInterestsStepBodySchema],
    ['MY 설정', setInterestCategoriesBodySchema],
  ])('takes any number of category ids within the input bound, none included (%s)', (_, schema) => {
    for (const categoryIds of [[], [1], [3, 1, 3]]) {
      expect(schema.parse({ categoryIds, expectedAccountId: 'u1' })).toEqual({
        categoryIds,
        expectedAccountId: 'u1',
      });
    }
    for (const categoryIds of [
      [0],
      [1.5],
      [INT4_MAX + 1],
      Array.from({ length: INTEREST_CATEGORIES_INPUT_MAX + 1 }, (_, i) => i + 1),
    ]) {
      expect(schema.safeParse({ categoryIds, expectedAccountId: 'u1' }).success).toBe(false);
    }
    expect(schema.safeParse({ categoryIds: [] }).success).toBe(false);
  });
});

describe('the interests step’s first answer (owner decision 2026-10-21 (3rd) answer 1)', () => {
  it('stays open 24 hours after the nickname step, the value the owner set', () => {
    expect(INTERESTS_FIRST_ANSWER_WINDOW_HOURS).toBe(24);
  });
});
