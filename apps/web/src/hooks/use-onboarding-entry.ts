'use client';

import { useMe } from '@/hooks/use-me';
import { hasOnboardingStepLeft, onboardingEntryPath } from '@/lib/onboarding';

/**
 * The write and edit entries of a page the onboarding gate lets an account facing a re-consent
 * alone open (`ONBOARDING_EXEMPT_PAGES`, 오너 결정 2026-10-20, ADR-0073): such an account is sent to
 * its remaining step rather than to the form, and comes back to the form once it is done.
 * - `stepLeft`: `GET /me` names a step left (false while it is not known) — a control that opens a
 *   form in place (#48's comment boxes) or writes at a press (#49's 좋아요) goes to
 *   `entryPath(<this page>)` instead.
 * - `entryPath(target)`: where a link to the form at `target` goes — `target`, or
 *   `/onboarding?next=<target>` with a step left.
 * The server refuses those writes besides (`OnboardedGuard`); this keeps the screen from offering
 * a form whose sending would only be refused.
 */
export function useOnboardingEntry(): {
  stepLeft: boolean;
  entryPath: (target: string) => string;
} {
  const { data: me, isLoggedIn } = useMe();
  const onboarding = isLoggedIn && me ? me.onboarding : undefined;
  return {
    stepLeft: hasOnboardingStepLeft(onboarding),
    entryPath: (target) => onboardingEntryPath(target, onboarding),
  };
}
