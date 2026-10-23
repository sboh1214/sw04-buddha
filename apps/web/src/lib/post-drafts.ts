import type { JSONContent } from '@tiptap/react';
import { copy } from '@/copy';
import { hasOnboardingStepLeft, type Onboarding } from './onboarding';

/**
 * A post draft kept in this browser across the onboarding (오너 결정 2026-10-20, ADR-0073: «재동의로
 * 온보딩 단계로 이동할 때 쓰던 글 → 이 브라우저에 잠시 두었다가 동의를 마치고 돌아오면 되살림»).
 *
 * When the onboarding gate takes a member with an unsaved draft from the write or the edit screen
 * to its step — `GET /me` came to name a step left, a re-consent after a revision say, or a write
 * was refused with ONBOARDING_REQUIRED and `['me']` was read again — the screen keeps the draft
 * here as it goes (`shouldKeepPostDraft`, hooks/use-post-draft.ts), and the same screen, opened
 * again by the same account once the step is done (the onboarding comes back to it, #57-9), takes
 * it back and says so. Nothing of it goes to the server.
 *
 * - Where: `sessionStorage`, this tab's — the gate and the onboarding's return happen in the tab
 *   the draft was written in; another tab, another window and a later visit never see it, and it
 *   goes with the tab. (`localStorage` would outlive the tab and reach every tab of the browser.)
 * - Keyed by the screen: a new post per market, an edit per post (`postDraftStorageKey`), and held
 *   for the account that wrote it — another account signed in on the tab never reads it.
 * - Gone: once taken back (the form holds it again and guards it like any draft — leaving asks,
 *   and the gate keeps it again should it send the account on once more), once a write or an edit
 *   of that screen by the same account succeeds (one in flight when the gate took the account
 *   away included, and a form the gate takes away while that success is being handled keeps
 *   nothing — `postDraftLanded`; another account's write of the same screen, sent before the tab
 *   changed hands, leaves it), when the writer discards it (asked first,
 *   `nextRestoredDraftState`), when the account signs out in the tab, and POST_DRAFT_TTL_MS after
 *   it was kept.
 * - Only what it can carry: a title or a body changed, or a draft taken back before
 *   (`hasDraftToKeep`). An image still uploading is not in it — the editor inserts the image when
 *   the upload answers, and the gate has taken the editor away by then — so a form whose only
 *   change is an upload in flight keeps nothing, and its screen opened again is not "restored".
 * - The uploads: an image node is its media id, which the server serves only once a post shows it
 *   — so beside the text it keeps a small preview of each new upload (DRAFT_PREVIEW_MAX_SIDE: the
 *   copy the editor drew every new upload from, made while the image went up), and the editor
 *   taking the draft back draws the image from it until the post is saved. A draft too big for the
 *   storage with its previews is kept without them.
 *
 * Pure functions over a `DraftStorage` (the tests hand a Map's), plus the browser's binding to this
 * tab's `sessionStorage` at the end — none of it throws: a storage the browser refuses (a private
 * window's quota, blocked site data) keeps nothing and restores nothing.
 */

/** Which screen's draft: a new post on a market, or an edit of a post. */
export type PostDraftKey = { kind: 'new'; marketId: string } | { kind: 'edit'; postId: string };

/** What the screen takes back. */
export interface PostDraft {
  /** The title field as it was (blank: none). */
  title: string;
  /** The editor's JSON (`editor.getJSON()`), what the write would have sent. */
  body: JSONContent;
  /** Small previews of the uploads, by media id: `data:image/…;base64,` URLs. */
  previews: Readonly<Record<string, string>>;
}

/** The part of the Web Storage API the drafts use. */
export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * How long a kept draft waits for its screen: an hour (오너 결정 2026-10-20 3차 답 2 — the owner's
 * «잠시», which the implementation set and the owner kept). The onboarding's steps take minutes; a
 * draft older than this is more likely forgotten than wanted, and the tab may have changed hands.
 * Closing the tab removes it sooner. The uploads it names outlive it (ORPHAN_MEDIA_HOURS, 24).
 */
export const POST_DRAFT_TTL_MS = 60 * 60 * 1000;

/**
 * The longer side of a new upload's preview, in pixels: the copy the editor draws the image from
 * until the post is saved (`boundedPreviewOf`, ADR-0073 9-24) and the copy a kept draft takes with
 * it (9-38) — one copy, so changing this changes both.
 */
export const DRAFT_PREVIEW_MAX_SIDE = 640;

/** Every kept draft's storage key starts with this. */
export const POST_DRAFT_PREFIX = 'buddha.postDraft:';

export function postDraftStorageKey(key: PostDraftKey): string {
  return key.kind === 'new'
    ? `${POST_DRAFT_PREFIX}new:${key.marketId.toLowerCase()}`
    : `${POST_DRAFT_PREFIX}edit:${key.postId.toLowerCase()}`;
}

/**
 * Whether the form holds a draft the storage can carry and leaving would lose: a title other than
 * the one it started with (spaces at either end aside, as `draftChanged` compares it), a body the
 * editor changed (`bodyChanged`), or a draft it took back (`restored`, until it is sent or
 * discarded). Unlike `draftChanged` — the leave guard's, which asks while an image uploads, as
 * leaving loses the upload — an upload in flight is nothing to keep: the kept draft cannot carry
 * it (the image goes into the body when the upload answers), so a form with only that would be
 * kept, and later "restored", empty.
 */
export function hasDraftToKeep(state: {
  title: string;
  initialTitle: string | null;
  bodyChanged: boolean;
  restored: boolean;
}): boolean {
  return (
    state.restored || state.bodyChanged || state.title.trim() !== (state.initialTitle ?? '').trim()
  );
}

/**
 * Whether a screen going away keeps its draft: it holds one to keep (`hasDraft` —
 * `hasDraftToKeep`), the write it sent did not succeed (`saved`), and the account has an
 * onboarding step left — what the gate is taking it to. Any other leave keeps nothing: a link or
 * Back asked first, and «쓰던 내용이 사라집니다» stays true. A write still in flight is kept: the
 * gate may take the account away while the refusal that sent it (409) is being handled, and a
 * write that lands after all clears the draft (`postDraftLanded`) — a success being handled before
 * the form renders `saved` counts as saved (`postDraftLandedSince`, hooks/use-post-draft.ts).
 */
export function shouldKeepPostDraft(state: {
  hasDraft: boolean;
  saved: boolean;
  onboarding: Onboarding | undefined;
}): boolean {
  return state.hasDraft && !state.saved && hasOnboardingStepLeft(state.onboarding);
}

/** A kept draft as it is stored. */
interface StoredDraft {
  version: 1;
  accountId: string;
  savedAt: number;
  title: string;
  body: JSONContent;
  previews: Record<string, string>;
}

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A preview the editor may draw: one of the four image types, base64 — nothing a page could run. */
const PREVIEW_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The previews of `previews` that are previews, by media ids that are media ids. */
function previewsOf(previews: unknown): Record<string, string> {
  if (!isRecord(previews)) return {};
  return Object.fromEntries(
    Object.entries(previews).filter(
      (entry): entry is [string, string] =>
        MEDIA_ID.test(entry[0]) && typeof entry[1] === 'string' && PREVIEW_URL.test(entry[1]),
    ),
  );
}

/** A stored item, if it is one this module wrote; anything else is no draft. */
function parseStored(raw: string): StoredDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) return null;
  const { accountId, savedAt, title, body, previews } = value;
  if (typeof accountId !== 'string' || typeof savedAt !== 'number' || typeof title !== 'string') {
    return null;
  }
  if (!isRecord(body) || body.type !== 'doc') return null;
  return {
    version: 1,
    accountId,
    savedAt,
    title,
    body,
    previews: previewsOf(previews),
  };
}

/** The draft stored under `key`, if it is one this module wrote (null: none, or refused). */
function readItem(storage: DraftStorage, key: string): StoredDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  return raw === null ? null : parseStored(raw);
}

function isExpired(stored: StoredDraft, now: number): boolean {
  return now - stored.savedAt > POST_DRAFT_TTL_MS;
}

function tryRemove(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A storage the browser refuses holds nothing to remove.
  }
}

/** The storage keys of every kept draft. */
function draftKeys(storage: DraftStorage): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(POST_DRAFT_PREFIX)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

/** Removes every kept draft past POST_DRAFT_TTL_MS, and every item under the prefix that is none. */
export function sweepPostDrafts(storage: DraftStorage, now: number): void {
  for (const key of draftKeys(storage)) {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return;
    }
    const stored = raw === null ? null : parseStored(raw);
    if (stored === null || isExpired(stored, now)) tryRemove(storage, key);
  }
}

/**
 * Keeps `draft` for `key`, written by `accountId`, replacing what was kept there. Over the
 * storage's quota with its previews it is kept without them (the images keep their ids, and the
 * server still takes them), and not at all if even that does not fit. Whether it was kept.
 */
export function keepPostDraft(
  storage: DraftStorage,
  key: PostDraftKey,
  accountId: string,
  draft: PostDraft,
  now: number,
): boolean {
  sweepPostDrafts(storage, now);
  const item = (previews: Record<string, string>) =>
    JSON.stringify({
      version: 1,
      accountId,
      savedAt: now,
      title: draft.title,
      body: draft.body,
      previews,
    } satisfies StoredDraft);
  for (const previews of [previewsOf(draft.previews), {}]) {
    try {
      storage.setItem(postDraftStorageKey(key), item(previews));
      return true;
    } catch {
      // Over the quota (or refused): try with less, then give up.
    }
  }
  return false;
}

/**
 * The draft kept for `key` by `accountId`, or null: none, past POST_DRAFT_TTL_MS, another
 * account's (removed — it is never shown to this one), or not a draft at all. Reads only; the
 * screen that takes it back removes it once it holds it (`clearPostDraft`).
 */
export function readPostDraft(
  storage: DraftStorage,
  key: PostDraftKey,
  accountId: string,
  now: number,
): PostDraft | null {
  const storageKey = postDraftStorageKey(key);
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const stored = parseStored(raw);
  if (stored === null || isExpired(stored, now) || stored.accountId !== accountId) {
    tryRemove(storage, storageKey);
    return null;
  }
  return { title: stored.title, body: stored.body, previews: stored.previews };
}

/** Removes what was kept for `key`. */
export function clearPostDraft(storage: DraftStorage, key: PostDraftKey): void {
  tryRemove(storage, postDraftStorageKey(key));
}

/**
 * Removes what `accountId` kept for `key`, and only that: another account's draft of the same
 * screen stays (anything that is no draft goes, as a read would remove it).
 */
export function clearPostDraftOf(
  storage: DraftStorage,
  key: PostDraftKey,
  accountId: string,
): void {
  const storageKey = postDraftStorageKey(key);
  const stored = readItem(storage, storageKey);
  if (stored === null || stored.accountId === accountId) tryRemove(storage, storageKey);
}

/** Removes every kept draft (signing out). */
export function clearPostDrafts(storage: DraftStorage): void {
  for (const key of draftKeys(storage)) tryRemove(storage, key);
}

/**
 * The size a new upload's preview (the editor's copy, which a kept draft takes) is drawn at:
 * `width` × `height` scaled so the longer side is at most `max` (never enlarged), each side at
 * least one pixel.
 */
export function previewSize(
  width: number,
  height: number,
  max: number = DRAFT_PREVIEW_MAX_SIDE,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ---- the draft taken back, on the form ------------------------------------------------------

/**
 * A form's hold of the draft it took back, and the discard of it (오너 결정 2026-10-20 3차 답 3):
 * '되살린 내용 버리기' always asks first — a discard is for good, and takes everything typed since
 * the restore with it — and only the dialog's 버리기 discards:
 * - `ask` (the button): the dialog opens; the form is as it was.
 * - `cancel` (취소, Escape, a click outside): the dialog closes; the form is as it was.
 * - `discard` (버리기, only while the dialog is open): the draft goes, the form is drawn afresh
 *   with what the screen started with (`generation`, the fields' React key — a new post's empty
 *   form, or the saved post), and `discarded` sends the dialog's focus to the redrawn title field.
 *   The form says so in a toast (`POST_DRAFT_DISCARDED_TOAST`).
 */
export interface RestoredDraftState {
  /** The draft taken back, until it is discarded (or sent: the screen goes then). */
  readonly restored: PostDraft | null;
  /** The confirm dialog of the discard is open. */
  readonly asking: boolean;
  /** How many times a discard drew the form afresh. */
  readonly generation: number;
  /** A discard happened: the dialog closes onto the redrawn title field (its `finalFocusEl`). */
  readonly discarded: boolean;
}

export type RestoredDraftEvent = 'ask' | 'cancel' | 'discard';

/** A form made with `restored` taken back (null: none), nothing asked yet. */
export function restoredDraftState(restored: PostDraft | null): RestoredDraftState {
  return { restored, asking: false, generation: 0, discarded: false };
}

export function nextRestoredDraftState(
  state: RestoredDraftState,
  event: RestoredDraftEvent,
): RestoredDraftState {
  switch (event) {
    case 'ask':
      return state.restored === null || state.asking ? state : { ...state, asking: true };
    case 'cancel':
      return state.asking ? { ...state, asking: false } : state;
    case 'discard':
      // Never unasked: a discard is the answer to the dialog.
      return state.asking && state.restored !== null
        ? { restored: null, asking: false, generation: state.generation + 1, discarded: true }
        : state;
  }
}

/**
 * What a discard says (오너 결정 2026-10-20 3차 답 5: on screen too, as a toast, and to screen
 * readers once): a toast like the app's other completions, in the owner's sentence. The toaster's
 * region is the one live region that says it (components/post/post-form.tsx).
 */
export const POST_DRAFT_DISCARDED_TOAST = {
  type: 'success',
  title: copy.postDraftDiscarded,
} as const;

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

export function keepSessionPostDraft(key: PostDraftKey, accountId: string, draft: PostDraft) {
  const storage = sessionDrafts();
  return storage === null ? false : keepPostDraft(storage, key, accountId, draft, Date.now());
}

export function readSessionPostDraft(key: PostDraftKey, accountId: string): PostDraft | null {
  const storage = sessionDrafts();
  return storage === null ? null : readPostDraft(storage, key, accountId, Date.now());
}

export function clearSessionPostDraft(key: PostDraftKey): void {
  const storage = sessionDrafts();
  if (storage !== null) clearPostDraft(storage, key);
}

export function clearSessionPostDrafts(): void {
  const storage = sessionDrafts();
  if (storage !== null) clearPostDrafts(storage);
}

// ---- the writes that landed in this tab ------------------------------------------------------

/**
 * When a write or an edit of each screen last landed in this tab, by the account that sent it and
 * the screen's storage key, as a `postDraftMoment`. TanStack Query runs a mutation's `onSuccess`
 * before it marks the mutation succeeded, and the form renders `saved` later still; a form the
 * gate takes away in between holds `saved: false` from its last render, and would keep — after
 * the success cleared it — a draft the post already holds, which its screen would then "restore"
 * for a second post. So the success records its moment here, and the form going away counts a
 * write landed after its last render as saved (`postDraftLandedSince`). The form is locked while
 * it sends, so that render held what was sent. In memory, as the forms are: this tab's, gone with
 * the page.
 *
 * By account (ADR-0073 9-48 — the gap Codex's review of #48 found in the comment drafts, PR #220):
 * a write sent by account A can land after the tab changed to account B, and B can have the same
 * screen open meanwhile — its own draft, kept for B across an onboarding step. A's landing says nothing of B's
 * form: it neither removes B's kept draft nor counts B's form as saved, which would let B's draft
 * go unkept as the gate takes the form away.
 */
const landedAt = new Map<string, number>();
let moments = 0;

function landedKey(key: PostDraftKey, accountId: string): string {
  return `${accountId}\n${postDraftStorageKey(key)}`;
}

/** A moment in this tab's order of draft events: each call answers a larger number. */
export function postDraftMoment(): number {
  moments += 1;
  return moments;
}

/**
 * A write or an edit of `key`'s screen sent by `accountId` (its `expectedAccountId`) landed: that
 * account's kept draft of the screen goes, and a form of it that account rendered before now keeps
 * nothing when it goes (`postDraftLandedSince`). Another account's draft and form of the same
 * screen are left as they are.
 */
export function postDraftLanded(key: PostDraftKey, accountId: string): void {
  landedAt.set(landedKey(key, accountId), postDraftMoment());
  const storage = sessionDrafts();
  if (storage !== null) clearPostDraftOf(storage, key, accountId);
}

/**
 * Whether a write or an edit of `key`'s screen by `accountId` — the account a form rendered for —
 * landed after `moment` (a `postDraftMoment`).
 */
export function postDraftLandedSince(
  key: PostDraftKey,
  accountId: string,
  moment: number,
): boolean {
  return (landedAt.get(landedKey(key, accountId)) ?? 0) > moment;
}
