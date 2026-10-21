'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { useOnboardingEntry } from '@/hooks/use-onboarding-entry';
import type { Me } from '@/lib/api';
import { onboardingEntryPath } from '@/lib/onboarding';
import { PROFILE_SETTINGS_PATH, profileItemRefusalMove } from '@/lib/profile';

/**
 * MY 설정's way to the remaining step (#41, ADR-0078 7-24). The gate lets an account facing a
 * re-consent alone stay on the page so it can clear its public profile's 소개 and drop interest
 * categories with a session alone (ONBOARDING_EXEMPT_PAGES, owner decision 2026-10-21 answer 2);
 * what the onboarding still keeps from it there goes to its step first, which comes back to
 * MY 설정 once done — as the post page's writes do (`useOnboardingEntry`, ADR-0073):
 * - `stepLeft`: `GET /me` names a step left (false while it is not known) — on this page, a
 *   re-consent;
 * - `toStep()`: to that step, nothing sent (`profileItemSaveGoesToStep` says when);
 * - `afterRefusal(error)`: a save refused for the onboarding (ONBOARDING_REQUIRED) — sent before
 *   `GET /me` said a step is left — goes where `profileItemRefusalMove` says, once the hook has read
 *   `['me']` again: true when it went (to the step, or the gate takes the account), so the card
 *   says nothing; false and the card says why (`profileItemFailure`).
 */
export function useSettingsStep(): {
  stepLeft: boolean;
  toStep: () => void;
  afterRefusal: (error: unknown) => boolean;
} {
  const { stepLeft, entryPath } = useOnboardingEntry();
  const router = useRouter();
  const queryClient = useQueryClient();
  return {
    stepLeft,
    toStep: () => router.push(entryPath(PROFILE_SETTINGS_PATH) as Route),
    afterRefusal: (error) => {
      // `['me']` as the refusal read it again — not as this render saw it — and the page now.
      const onboarding = queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding;
      const pathname = window.location.pathname;
      const move = profileItemRefusalMove(error, { pathname, onboarding });
      if (move === 'step') {
        router.push(onboardingEntryPath(PROFILE_SETTINGS_PATH, onboarding) as Route);
      }
      return move !== undefined;
    },
  };
}
