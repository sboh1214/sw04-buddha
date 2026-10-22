'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  type ProfileDraftKind,
  type ProfileDraftOf,
  clearSessionProfileDraft,
  readSessionProfileDraft,
} from '@/lib/profile-drafts';

/**
 * The toast that says a card took its draft back: one id for MY 설정, so the 소개 and the interest
 * categories taken back together say it once (the toaster updates a toast with the same id).
 */
export const PROFILE_DRAFT_RESTORED_TOAST_ID = 'profile-draft-restored';

/**
 * A MY 설정 card's draft that the page kept on its way to the onboarding step (owner decisions
 * 2026-10-22 answer 3 and 2026-10-22 (2nd) answer 2 — the 소개, the interest categories, the
 * nickname; lib/profile-drafts.ts), taken back once the card is drawn for the account
 * that wrote it with no step left — read from the tab then (or later, a step done in another tab
 * while the page stayed open), removed from it, and handed to `take`, which puts it into the card
 * unsaved and answers whether there was anything to put back: not when another tab saved the same
 * meanwhile, nor when the card holds an edit of its own made since it was drawn — learned late, the
 * step's end does not write over what the member is typing or picking, and what was kept is dropped
 * without a word (ADR-0078 7-25 (3)). Said once, in a toast like the app's other notices — the
 * toaster's region is the live region that reads it out — with the posts' and comments' sentence.
 * While `wait` holds — a step left (the account came back to MY 설정 by the re-consent step's link,
 * owner decision 2026-10-22 answer 2), or what `take` compares with not loaded yet (the interest
 * categories' list) — the draft stays kept, for the return the step brings or the load.
 */
export function useProfileDraftTakenBack<K extends ProfileDraftKind>(
  kind: K,
  accountId: string,
  wait: boolean,
  take: (draft: ProfileDraftOf<K>) => boolean,
): void {
  const latest = useRef(take);
  useLayoutEffect(() => {
    latest.current = take;
  });
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current || wait) return;
    taken.current = true;
    const draft = readSessionProfileDraft(kind, accountId);
    if (draft === null) return;
    clearSessionProfileDraft(kind);
    if (latest.current(draft)) {
      toaster.create({
        id: PROFILE_DRAFT_RESTORED_TOAST_ID,
        type: 'info',
        title: copy.profileDraftRestored,
      });
    }
  }, [kind, accountId, wait]);
}
