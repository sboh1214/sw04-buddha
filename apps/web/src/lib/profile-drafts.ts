import { interestIds } from './onboarding';
import { type DraftStorage, POST_DRAFT_TTL_MS } from './post-drafts';
import { bioToSend, interestsChanged } from './profile';

/**
 * MY 설정's 소개 and interest categories kept in this tab across the onboarding step (오너 결정
 * 2026-10-22 답 3, ADR-0078: «새 소개·더한 카테고리로 단계에 갈 때 쓰던 소개·고른 카테고리를 탭에 1시간
 * 두었다가 되살림») — and the nickname typed, the same way (오너 결정 2026-10-22 (2차) 답 2: «닉네임도
 * 되살림») — the public profile's counterpart of a post's and a comment's drafts
 * (lib/post-drafts.ts, lib/comment-drafts.ts), whose rules it follows.
 *
 * MY 설정 is exempt from the onboarding gate for an account facing a re-consent alone
 * (`ONBOARDING_EXEMPT_PAGES`): it clears its 소개 and drops categories there with a session alone,
 * and what the onboarding still keeps from it — a new 소개, a category added, a nickname change,
 * the marketing switch — sends it to its step instead of being sent (`useSettingsStep`), which comes
 * back to MY 설정. As the page goes there, each of the three cards holding what the account does
 * not have — a 소개 typed other than its own (`bioDraftToKeep`), categories picked other than its own
 * (`interestsDraftToKeep`), a nickname typed other than its own (`nicknameDraftToKeep`) — keeps it
 * here, whichever card's save sent the page; MY 설정, drawn again for the same account with no step
 * left (the step done, #57-9), puts it back into its card and says so. Nothing of it goes to the
 * server.
 *
 * - Where: `sessionStorage`, this tab's — as a post's draft, and for the same reasons.
 * - Keyed by the card (`profileDraftStorageKey`), and held for the account that wrote it: another
 *   account signed in on the tab never reads it.
 * - Gone: once taken back (the card holds it again, unsaved) — or found with nothing to put back:
 *   the account has the same now, or the card holds an edit of its own made since it was drawn,
 *   which is not written over (`bioToRestore`, `interestsToRestore`, `nicknameToRestore`) — once a
 *   save of that card succeeds, when the account signs out in the tab, and PROFILE_DRAFT_TTL_MS
 *   after it was kept. A card holding nothing new as the page goes leaves what an earlier trip kept
 *   as it is.
 * - Only what the card shows: the 소개 box's text as typed, the ids of the categories picked among
 *   those offered, compared with the account's among those offered (a category operators retired
 *   is in the account's picks, never on screen), the nickname box's text as typed (ADR-0078 7-25,
 *   오너 결정 2026-10-22 (2차) 답 2 — it was not kept before that answer).
 *
 * Pure functions over a `DraftStorage`, plus the browser's binding to this tab's `sessionStorage`
 * at the end — none of it throws: a storage the browser refuses keeps nothing and restores nothing.
 */

/** A card's draft: the 소개 box's text, the interest categories picked, the nickname box's text. */
export type ProfileDraft =
  | { readonly kind: 'bio'; readonly text: string }
  | { readonly kind: 'interests'; readonly categoryIds: readonly number[] }
  | { readonly kind: 'nickname'; readonly text: string };

/** Which card's draft. */
export type ProfileDraftKind = ProfileDraft['kind'];

/** The draft of the card `K`. */
export type ProfileDraftOf<K extends ProfileDraftKind> = Extract<ProfileDraft, { kind: K }>;

/** How long a kept draft waits for MY 설정: the posts' and comments' hour (owner: «1시간»). */
export const PROFILE_DRAFT_TTL_MS = POST_DRAFT_TTL_MS;

/** Every kept profile draft's storage key starts with this (apart from the posts' and comments'). */
export const PROFILE_DRAFT_PREFIX = 'buddha.profileDraft:';

export function profileDraftStorageKey(kind: ProfileDraftKind): string {
  return `${PROFILE_DRAFT_PREFIX}${kind}`;
}

/**
 * What the 소개 card keeps as the page goes to the step: the box's text as typed when saving it
 * would change the account's 소개 (`held` — `Me.profile.bio`) — a new text, or an empty box over a
 * 소개 not yet cleared; null when it holds nothing new (spaces at either end and line endings aside,
 * as `bioToSend` reads it).
 */
export function bioDraftToKeep(text: string, held: string | null): string | null {
  return bioToSend(text) === held ? null : text;
}

/**
 * What the nickname card keeps as the page goes to the step: the box's text as typed when it names
 * a nickname other than the account's (`held` — `Me.profile.nickname`), read as the form reads it
 * (`nicknameFormSchema`: trimmed, compared as is) — the change a 저장 would send; null when it
 * holds the account's nickname or nothing (no nickname is cleared: an empty box is no change to
 * keep). Kept whatever the nickname rules say of it, as the 소개 over its limit is — what was typed,
 * which 저장 checks again on return.
 */
export function nicknameDraftToKeep(text: string, held: string): string | null {
  const name = text.trim();
  return name === '' || name === held ? null : text;
}

/** The ids in id order, each once. */
function idsOf(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * What the interests card keeps as the page goes to the step: the categories picked among those
 * the list offers (`chosen` — `interestIds`) when they differ from the account's (`held` —
 * `Me.profile.interestCategoryIds`) — one added, one dropped, or both — read among the categories
 * offered (`offered`, `GET /categories`), as the card's 저장 reads them (`interestsChanged`): the
 * account's picks still hold a category operators retired, which the list neither offers nor
 * shows, and an untouched card is no change. Null when they do not differ, and while the list has
 * not loaded (`offered` undefined — nothing on screen was picked or unpicked before it, and the
 * picks read among no categories would be none).
 */
export function interestsDraftToKeep(
  chosen: readonly number[],
  held: readonly number[],
  offered: readonly { id: number }[] | undefined,
): number[] | null {
  if (offered === undefined || !interestsChanged(chosen, held, offered)) return null;
  return interestIds(new Set(chosen), offered);
}

/**
 * What the 소개 card puts back from a kept draft: its text, when it differs from the account's 소개
 * now (another tab may have saved the same meanwhile) and the box (`typed`, its text now) holds
 * nothing of its own that saving would send — a step done in another tab is learned while the card
 * is open, and what the member has typed in it since is not written over (ADR-0078 7-25 (3)); null
 * when there is nothing to put back.
 */
export function bioToRestore(
  draft: ProfileDraftOf<'bio'>,
  held: string | null,
  typed: string,
): string | null {
  if (bioDraftToKeep(typed, held) !== null) return null;
  return bioDraftToKeep(draft.text, held);
}

/**
 * What the interests card puts back from a kept draft, once the list has loaded (`offered`): its
 * picks among the categories offered now, when — read among them — they differ from the account's
 * (a category kept and retired since is neither shown nor put back) and the card's picks now
 * (`chosen`) are still the account's — picks made since the card was drawn are not written over,
 * as for the 소개; null when there is nothing to put back.
 */
export function interestsToRestore(
  draft: ProfileDraftOf<'interests'>,
  held: readonly number[],
  offered: readonly { id: number }[],
  chosen: readonly number[],
): number[] | null {
  if (interestsChanged(chosen, held, offered)) return null;
  const kept = interestIds(new Set(draft.categoryIds), offered);
  return interestsChanged(kept, held, offered) ? kept : null;
}

/**
 * What the nickname card puts back from a kept draft: its text, when it still names a nickname
 * other than the account's now (another tab may have changed it to the same meanwhile) and the box
 * (`typed`, its text now) holds the account's nickname — anything else in it, emptied included, is
 * the member's own since the card was drawn and is not written over (a step done in another tab,
 * learned late: the newer typing wins, ADR-0078 7-25 (3), 오너 결정 2026-10-22 (2차) 답 2); null when
 * there is nothing to put back.
 */
export function nicknameToRestore(
  draft: ProfileDraftOf<'nickname'>,
  held: string,
  typed: string,
): string | null {
  if (typed.trim() !== held) return null;
  return nicknameDraftToKeep(draft.text, held);
}

/** A kept draft as it is stored. */
interface StoredProfileDraft {
  version: 1;
  accountId: string;
  savedAt: number;
  text?: string;
  categoryIds?: number[];
}

function parseStored(raw: string, kind: ProfileDraftKind): StoredProfileDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { version, accountId, savedAt, text, categoryIds } = value as Record<string, unknown>;
  if (version !== 1 || typeof accountId !== 'string' || typeof savedAt !== 'number') return null;
  if (kind === 'bio' || kind === 'nickname')
    return typeof text === 'string' ? { version, accountId, savedAt, text } : null;
  if (
    !Array.isArray(categoryIds) ||
    !categoryIds.every((id): id is number => Number.isSafeInteger(id) && (id as number) > 0)
  ) {
    return null;
  }
  return { version, accountId, savedAt, categoryIds };
}

function isExpired(stored: StoredProfileDraft, now: number): boolean {
  return now - stored.savedAt > PROFILE_DRAFT_TTL_MS;
}

function tryRemove(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A storage the browser refuses holds nothing to remove.
  }
}

const KINDS: readonly ProfileDraftKind[] = ['bio', 'interests', 'nickname'];

/** The storage keys under PROFILE_DRAFT_PREFIX. */
function draftKeys(storage: DraftStorage): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(PROFILE_DRAFT_PREFIX)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

/** Removes every kept profile draft past PROFILE_DRAFT_TTL_MS, and every item that is none. */
export function sweepProfileDrafts(storage: DraftStorage, now: number): void {
  for (const key of draftKeys(storage)) {
    const kind = KINDS.find((candidate) => profileDraftStorageKey(candidate) === key);
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return;
    }
    const stored = kind === undefined || raw === null ? null : parseStored(raw, kind);
    if (stored === null || isExpired(stored, now)) tryRemove(storage, key);
  }
}

/** Keeps `draft`, written by `accountId`, replacing what was kept for its card. Whether it was. */
export function keepProfileDraft(
  storage: DraftStorage,
  accountId: string,
  draft: ProfileDraft,
  now: number,
): boolean {
  sweepProfileDrafts(storage, now);
  const stored: StoredProfileDraft =
    draft.kind === 'interests'
      ? { version: 1, accountId, savedAt: now, categoryIds: idsOf(draft.categoryIds) }
      : { version: 1, accountId, savedAt: now, text: draft.text };
  try {
    storage.setItem(profileDraftStorageKey(draft.kind), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/**
 * The draft kept for the card `kind` by `accountId`, or null: none, past PROFILE_DRAFT_TTL_MS,
 * another account's (removed — it is never shown to this one), or not a draft at all. Reads only;
 * the card that takes it back removes it (`clearProfileDraft`).
 */
export function readProfileDraft<K extends ProfileDraftKind>(
  storage: DraftStorage,
  kind: K,
  accountId: string,
  now: number,
): ProfileDraftOf<K> | null {
  const key = profileDraftStorageKey(kind);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const stored = parseStored(raw, kind);
  if (stored === null || isExpired(stored, now) || stored.accountId !== accountId) {
    tryRemove(storage, key);
    return null;
  }
  const text = stored.text ?? '';
  const draft: ProfileDraft =
    kind === 'interests'
      ? { kind: 'interests', categoryIds: stored.categoryIds ?? [] }
      : kind === 'bio'
        ? { kind: 'bio', text }
        : { kind: 'nickname', text };
  return draft as ProfileDraftOf<K>;
}

/** Removes what was kept for the card `kind`. */
export function clearProfileDraft(storage: DraftStorage, kind: ProfileDraftKind): void {
  tryRemove(storage, profileDraftStorageKey(kind));
}

/** Removes every kept profile draft (signing out). */
export function clearProfileDrafts(storage: DraftStorage): void {
  for (const key of draftKeys(storage)) tryRemove(storage, key);
}

// ---- this tab's sessionStorage --------------------------------------------------------------

/** This tab's `sessionStorage`, or null outside a browser or where the browser refuses it. */
function sessionDrafts(): DraftStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function keepSessionProfileDraft(accountId: string, draft: ProfileDraft): boolean {
  const storage = sessionDrafts();
  return storage === null ? false : keepProfileDraft(storage, accountId, draft, Date.now());
}

export function readSessionProfileDraft<K extends ProfileDraftKind>(
  kind: K,
  accountId: string,
): ProfileDraftOf<K> | null {
  const storage = sessionDrafts();
  return storage === null ? null : readProfileDraft(storage, kind, accountId, Date.now());
}

export function clearSessionProfileDraft(kind: ProfileDraftKind): void {
  const storage = sessionDrafts();
  if (storage !== null) clearProfileDraft(storage, kind);
}

export function clearSessionProfileDrafts(): void {
  const storage = sessionDrafts();
  if (storage !== null) clearProfileDrafts(storage);
}
