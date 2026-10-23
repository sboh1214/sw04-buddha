/**
 * The writes that landed in this tab, for the drafts an onboarding step keeps: one record each for
 * the post drafts (lib/post-drafts.ts, ADR-0073 9-38·9-48) and the comment drafts
 * (lib/comment-drafts.ts, ADR-0074 7-32), which are the same shape and kept so — the shape the
 * comment drafts were given first (Codex review on PR #220) and the post drafts then (9-48).
 *
 * TanStack Query runs a mutation's `onSuccess` before it marks the mutation succeeded, and the
 * form or the box renders it later still; one taken away in between holds its sent text from its
 * last render, and would keep — after the success cleared it — a draft already written, to be
 * "restored" for a second one. So the success records its moment (`landed`), and the form or the
 * box going away counts a write landed after its last render (`moment`) as saved (`landedSince`).
 *
 * By the account that sent the write (its `expectedAccountId`) and the storage key of the screen
 * or the box: a write sent by account A can land after the tab changed to account B, with B's own
 * form or box of the same key open meanwhile, and A's landing says nothing of it. In memory, as
 * the forms and the boxes are: this tab's, gone with the page.
 */
export interface DraftLandings {
  /** A moment in this record's order of draft events: each call answers a larger number. */
  moment(): number;
  /** A write of `storageKey`'s screen or box sent by `accountId` landed now. */
  landed(storageKey: string, accountId: string): void;
  /** Whether a write of `storageKey`'s by `accountId` landed after `moment` (a `moment()`). */
  landedSince(storageKey: string, accountId: string, moment: number): boolean;
}

export function draftLandings(): DraftLandings {
  const landedAt = new Map<string, number>();
  let moments = 0;
  const keyOf = (storageKey: string, accountId: string) => `${accountId}\n${storageKey}`;
  const moment = () => {
    moments += 1;
    return moments;
  };
  return {
    moment,
    landed: (storageKey, accountId) => {
      landedAt.set(keyOf(storageKey, accountId), moment());
    },
    landedSince: (storageKey, accountId, since) =>
      (landedAt.get(keyOf(storageKey, accountId)) ?? 0) > since,
  };
}
