import type { JSONContent } from '@tiptap/react';
import { copy } from '@/copy';
import { draftLandings } from './draft-landings';
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
 * - Keyed by the screen — a new post per market, an edit per post (`postDraftScreenKey`) — and the
 *   account that wrote it (`postDraftStorageKey`): another account signed in on the tab never
 *   reads it, and neither reads, keeps over nor clears another account's draft of the same screen
 *   (ADR-0092, 오너 결정 2026-10-26 17:21 답 2 — A's draft waits for A while B uses the tab). An
 *   operator notice's write and edit screens (#138) use the same form and keep their drafts the
 *   same way (오너 결정 2026-10-21 (3차), ADR-0077: the gate moves an admin as it moves anyone): one key
 *   for the new notice, one per notice edited — and an edit's draft keeps the version it was typed
 *   on (`PostDraft['version']`). A notice's forms are drawn for the admin on screen, and keep their
 *   draft for that admin too when `['me']` turns to another admin in place (`shouldKeepPostDraft`'s
 *   `accountTurned`, 답 2 «A의 것으로 1시간 보관») — and so do a post's write and edit forms, drawn
 *   for the account on screen (답 3 «이 PR에서 함께, 적던 것은 A의 초안으로»).
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

/**
 * Which screen's draft: a new post on a market, an edit of a post, and — the same form, kept the
 * same way (#138, 오너 결정 2026-10-21 (3차), ADR-0077) — a new operator notice and an edit of a notice.
 */
export type PostDraftKey =
  | { kind: 'new'; marketId: string }
  | { kind: 'edit'; postId: string }
  | { kind: 'notice-new' }
  | { kind: 'notice-edit'; noticeId: string };

/** What the screen takes back. */
export interface PostDraft {
  /** The title field as it was (blank: none). */
  title: string;
  /** The editor's JSON (`editor.getJSON()`), what the write would have sent. */
  body: JSONContent;
  /** Small previews of the uploads, by media id: `data:image/…;base64,` URLs. */
  previews: Readonly<Record<string, string>>;
  /**
   * The version of the screen's subject the draft was typed on, for a screen that saves against
   * one: a notice's edit screen, whose save sends the version it was opened from
   * (`expectedEditedAt` — the notice's `editedAt` then, null when never edited; 오너 결정 2026-10-21
   * 7). A draft taken back is saved against it, not against the version the screen opened on after
   * the step: a save made meanwhile — by another admin, or this one in another tab — still refuses
   * it. Absent for a post's draft (a post's save names no version).
   */
  version?: string | null;
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

/**
 * Which screen a draft is of, whoever wrote it: the key this tab's landings are recorded under
 * (`postDraftLanded`), and the start of each account's item for it (`postDraftStorageKey`).
 */
export function postDraftScreenKey(key: PostDraftKey): string {
  switch (key.kind) {
    case 'new':
      return `${POST_DRAFT_PREFIX}new:${key.marketId.toLowerCase()}`;
    case 'edit':
      return `${POST_DRAFT_PREFIX}edit:${key.postId.toLowerCase()}`;
    case 'notice-new':
      return `${POST_DRAFT_PREFIX}notice-new`;
    case 'notice-edit':
      return `${POST_DRAFT_PREFIX}notice-edit:${key.noticeId.toLowerCase()}`;
  }
}

/**
 * The storage item of `accountId`'s draft of `key`'s screen: one per screen and account (ADR-0092,
 * 오너 결정 2026-10-26 17:21 답 2). Two accounts' drafts of one screen are two items, so B's form
 * reading the screen neither shows nor removes A's, and B's draft kept as B's form goes never
 * replaces A's — which waits, for the hour, for A to open the screen again. The account id as the
 * API spells it (it is no uuid, and its case is its own).
 */
export function postDraftStorageKey(key: PostDraftKey, accountId: string): string {
  return `${postDraftScreenKey(key)}@${encodeURIComponent(accountId)}`;
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
 * `hasDraftToKeep`, measured from what the last write that landed sent: a notice's edit screen
 * stays on the form after a save, and what is typed after it is a draft again), a write that
 * landed since did not send it (`saved`), and either the account has an onboarding step left —
 * what the gate is taking it to — or, for a form drawn for one account (a notice's, keyed by the
 * admin on screen; a post's write and edit forms, keyed by the account on screen), the account on
 * screen turned from its writer to another in place (`accountTurned`: `['me']` naming another
 * account before the session does, ADR-0090 결정 4-2 — ADR-0092, 오너 결정 2026-10-26 17:21 답 2
 * «A의 것으로 1시간 보관», 답 3 «이 PR에서 함께, 적던 것은 A의 초안으로»: kept for the writer, as the
 * gate's move keeps it, and taken back when the writer opens the screen again). Any other leave
 * keeps nothing: a link or Back asked first, and «쓰던 내용이 사라집니다» stays true. A write still
 * in flight is kept: the gate may take the account away while the refusal that sent it (409) is
 * being handled, and a write that lands after all clears the draft (`postDraftLanded`) — a success
 * being handled before the form renders it counts as saved (`postDraftLandedSince`,
 * hooks/use-post-draft.ts).
 */
export function shouldKeepPostDraft(state: {
  hasDraft: boolean;
  saved: boolean;
  /**
   * The writer's onboarding, as `['me']` says it now; undefined when `['me']` names another or is
   * empty.
   */
  onboarding: Onboarding | undefined;
  /**
   * A form drawn for its writer went with a turn of the tab's account (`goesWithAccountTurn`,
   * lib/session-account.ts): `['me']` turned to another in place, or the session did first and
   * SessionCacheGuard's reset took the form away — or the session turned to the writer after
   * `['me']` did, and that reset took away the form just drawn for the writer (ADR-0092 결정 10,
   * 8-36).
   */
  accountTurned?: boolean;
}): boolean {
  return (
    state.hasDraft &&
    !state.saved &&
    (state.accountTurned === true || hasOnboardingStepLeft(state.onboarding))
  );
}

/** A kept draft as it is stored. */
interface StoredDraft {
  version: 1;
  accountId: string;
  savedAt: number;
  title: string;
  body: JSONContent;
  previews: Record<string, string>;
  /** `PostDraft['version']` — the subject's version, not the item's format (`version`). */
  opened?: string | null;
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
  const { accountId, savedAt, title, body, previews, opened } = value;
  if (typeof accountId !== 'string' || typeof savedAt !== 'number' || typeof title !== 'string') {
    return null;
  }
  if (!isRecord(body) || body.type !== 'doc') return null;
  // A version that is not one is no draft: taken back without it, the draft would be saved against
  // whatever the screen opened on.
  if (opened !== undefined && opened !== null && typeof opened !== 'string') return null;
  return {
    version: 1,
    accountId,
    savedAt,
    title,
    body,
    previews: previewsOf(previews),
    ...(opened === undefined ? {} : { opened }),
  };
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
      ...(draft.version === undefined ? {} : { opened: draft.version }),
    } satisfies StoredDraft);
  for (const previews of [previewsOf(draft.previews), {}]) {
    try {
      storage.setItem(postDraftStorageKey(key, accountId), item(previews));
      return true;
    } catch {
      // Over the quota (or refused): try with less, then give up.
    }
  }
  return false;
}

/**
 * The draft kept for `key` by `accountId`, or null: none, past POST_DRAFT_TTL_MS, or not a draft
 * at all (removed). Another account's draft of the screen is another item, never read here and
 * left as it is (`postDraftStorageKey`). Reads only; the screen that takes it back removes it once
 * it holds it (`clearPostDraft`).
 */
export function readPostDraft(
  storage: DraftStorage,
  key: PostDraftKey,
  accountId: string,
  now: number,
): PostDraft | null {
  const storageKey = postDraftStorageKey(key, accountId);
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
  return {
    title: stored.title,
    body: stored.body,
    previews: stored.previews,
    ...(stored.opened === undefined ? {} : { version: stored.opened }),
  };
}

/**
 * Removes what `accountId` kept for `key`, and only that: another account's draft of the same
 * screen stays.
 */
export function clearPostDraft(storage: DraftStorage, key: PostDraftKey, accountId: string): void {
  tryRemove(storage, postDraftStorageKey(key, accountId));
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
 * - `landed` (a write of the form succeeded): what the form holds is the server's now, so nothing
 *   taken back is left to lose or to discard — the notice and its button go, the fields stay as
 *   they are (no redraw). A post's screen leaves for the post then; a notice's edit screen stays on
 *   the form (#138), where a discard would otherwise put back the version before the save.
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

export type RestoredDraftEvent = 'ask' | 'cancel' | 'discard' | 'landed';

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
    case 'landed':
      return state.restored === null ? state : { ...state, restored: null, asking: false };
  }
}

/**
 * The version of the subject the form's draft is typed on (`PostDraft['version']`): a draft taken
 * back carries its own, which it keeps until it is discarded or a write of it lands; otherwise the
 * screen's (`screen` — a notice's edit screen's opened version, moved by each save that lands;
 * undefined for a post's screen, whose drafts carry none).
 */
export function heldDraftVersion(
  restored: PostDraft | null,
  screen: string | null | undefined,
): string | null | undefined {
  return restored !== null && restored.version !== undefined ? restored.version : screen;
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

export function clearSessionPostDraft(key: PostDraftKey, accountId: string): void {
  const storage = sessionDrafts();
  if (storage !== null) clearPostDraft(storage, key, accountId);
}

export function clearSessionPostDrafts(): void {
  const storage = sessionDrafts();
  if (storage !== null) clearPostDrafts(storage);
}

// ---- the writes that landed in this tab ------------------------------------------------------

/**
 * When a write or an edit of each screen last landed in this tab, by the account that sent it and
 * the screen's key (`postDraftScreenKey`; lib/draft-landings.ts — the comment drafts keep theirs
 * the same way).
 * TanStack Query runs a mutation's `onSuccess` before it marks the mutation succeeded, and the
 * form renders `saved` later still; a form the gate takes away in between holds a draft from its
 * last render, and would keep — after the success cleared it — what the post already holds, which
 * its screen would then "restore" for a second post. So the success records its moment here, and
 * the form going away counts a write landed after its last render's moment as saved
 * (`postDraftLandedSince`). The form is locked while it sends, and holds what was sent: a render
 * of it while locked — the success itself renders the form again, putting its answer in the cache
 * (a notice's edit screen reads it) — keeps the moment of the render that sent (`heldPostDraftAt`,
 * hooks/use-post-draft.ts), so it never comes after the landing.
 *
 * By account (ADR-0073 9-48 — the gap Codex's review of #48 found in the comment drafts, PR #220):
 * a write sent by account A can land after the tab changed to account B, and B can have the same
 * screen open meanwhile — its own draft, kept for B across an onboarding step. A's landing says
 * nothing of B's form: it neither removes B's kept draft nor counts B's form as saved, which would
 * let B's draft go unkept as the gate takes the form away.
 */
const landings = draftLandings();

/** A moment in this tab's order of draft events: each call answers a larger number. */
export function postDraftMoment(): number {
  return landings.moment();
}

/**
 * A write or an edit of `key`'s screen sent by `accountId` (its `expectedAccountId`) landed: that
 * account's kept draft of the screen goes, and a form of it that account rendered before now keeps
 * nothing when it goes (`postDraftLandedSince`). Another account's draft and form of the same
 * screen are left as they are.
 */
export function postDraftLanded(key: PostDraftKey, accountId: string): void {
  landings.landed(postDraftScreenKey(key), accountId);
  const storage = sessionDrafts();
  if (storage !== null) clearPostDraft(storage, key, accountId);
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
  return landings.landedSince(postDraftScreenKey(key), accountId, moment);
}
