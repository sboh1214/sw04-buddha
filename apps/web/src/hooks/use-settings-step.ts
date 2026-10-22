'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { useOnboardingEntry } from '@/hooks/use-onboarding-entry';
import type { Me } from '@/lib/api';
import { onboardingEntryPath } from '@/lib/onboarding';
import { PROFILE_SETTINGS_PATH, profileItemRefusalMove } from '@/lib/profile';

/**
 * What each card of MY 설정 keeps as the page goes to the remaining step (`useKeepForStep`), while
 * it is mounted: one page at a time shows the cards, so a module-level set is the page's.
 */
const keepers = new Set<() => void>();

/**
 * Every mounted card keeps what it holds that the account does not have — the 소개 typed, the
 * categories picked (lib/profile-drafts.ts, owner decision 2026-10-22 answer 3) — as MY 설정 goes to
 * the step, whichever card's save sent it.
 */
export function keepSettingsDraftsForStep(): void {
  for (const keep of keepers) keep();
}

/** Adds `keep` to what `keepSettingsDraftsForStep` runs, until the returned function removes it. */
export function addStepKeeper(keep: () => void): () => void {
  const run = () => keep();
  keepers.add(run);
  return () => {
    keepers.delete(run);
  };
}

/**
 * A card's part in `keepSettingsDraftsForStep`: `keep` — read as of the card's latest render — runs
 * when the page goes to the step while the card is mounted.
 */
export function useKeepForStep(keep: () => void): void {
  const latest = useRef(keep);
  useLayoutEffect(() => {
    latest.current = keep;
  });
  useEffect(() => addStepKeeper(() => latest.current()), []);
}

/**
 * MY 설정's way to the remaining step (#41, ADR-0078 7-24). The gate lets an account facing a
 * re-consent alone stay on the page so it can clear its public profile's 소개 and drop interest
 * categories with a session alone (ONBOARDING_EXEMPT_PAGES, owner decision 2026-10-21 answer 2);
 * what the onboarding still keeps from it there — a new 소개, a category added, a nickname change
 * (owner decision 2026-10-22 answer 1) and the marketing switch — goes to its step first, which
 * comes back to MY 설정 once done — as the post page's writes do (`useOnboardingEntry`, ADR-0073):
 * - `stepLeft`: `GET /me` names a step left (false while it is not known) — on this page, a
 *   re-consent;
 * - `toStep()`: to that step, nothing sent (`profileItemSaveGoesToStep` says when), the cards
 *   keeping what they hold first (`keepSettingsDraftsForStep`, owner decision 2026-10-22 answer 3);
 * - `afterRefusal(error)`: a save refused for the onboarding (ONBOARDING_REQUIRED) — sent before
 *   `GET /me` said a step is left — goes where `profileItemRefusalMove` says, once the hook has read
 *   `['me']` again, the cards keeping what they hold as for `toStep`: true when it went (to the
 *   step, or the gate takes the account), so the card says nothing; false and the card says why
 *   (`profileItemFailure`).
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
    toStep: () => {
      keepSettingsDraftsForStep();
      router.push(entryPath(PROFILE_SETTINGS_PATH) as Route);
    },
    afterRefusal: (error) => {
      // `['me']` as the refusal read it again — not as this render saw it — and the page now.
      const onboarding = queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding;
      const pathname = window.location.pathname;
      const move = profileItemRefusalMove(error, { pathname, onboarding });
      if (move !== undefined) keepSettingsDraftsForStep();
      if (move === 'step') {
        router.push(onboardingEntryPath(PROFILE_SETTINGS_PATH, onboarding) as Route);
      }
      return move !== undefined;
    },
  };
}
