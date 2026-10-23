import { type DraftStorage, POST_DRAFT_TTL_MS } from './post-drafts';
import { hasOnboardingStepLeft, type Onboarding } from './onboarding';

/**
 * A comment draft kept in this browser across the onboarding (오너 결정 2026-10-20, ADR-0074: «재동의로
 * 온보딩 단계로 이동할 때 쓰던 글·댓글 → 이 브라우저에 잠시 두었다가 동의를 마치고 돌아오면 되살림») —
 * the comment-sized counterpart of a post's (lib/post-drafts.ts), whose rules it follows.
 *
 * The post page is exempt from the onboarding gate for an account facing a re-consent alone
 * (`ONBOARDING_EXEMPT_PAGES`); its comment writes send such an account to its step instead
 * (`useOnboardingEntry`, components/post/comments-section.tsx), and the gate sends any other
 * account with a step left on from the page. Either way the page goes, and each box going with it
 * that holds text keeps it here (`shouldKeepCommentDraft`, hooks/use-comment-draft.ts); the post
 * page, opened again by the same account with nothing left (the onboarding comes back to it,
 * #57-9), takes every draft of that post back into its box and says so. Nothing of it goes to the
 * server.
 *
 * - Where: `sessionStorage`, this tab's — as a post's draft, and for the same reasons.
 * - Keyed by the box: the post's new 댓글, a 대댓글 of one 댓글 (the box at the end of its thread,
 *   which every 답글 of the thread opens), and the edit of one comment (`commentDraftStorageKey`),
 *   each under its post — and held for the account that wrote it: another account signed in on
 *   the tab never reads it.
 * - Gone: once taken back (the box holds it again and guards it like any text — leaving asks, and
 *   going to a step keeps it again), once a write or an edit of that box by the same account
 *   succeeds (`commentDraftLanded`, one in flight when the page went included — another account's
 *   write of the same box, sent before the tab changed hands, leaves it), when the account signs
 *   out in the tab, and COMMENT_DRAFT_TTL_MS after it was kept.
 * - Only text: a comment is plain text (#45-3), so a draft is the box's text as it was.
 *
 * Pure functions over a `DraftStorage`, plus the browser's binding to this tab's `sessionStorage`
 * at the end — none of it throws: a storage the browser refuses keeps nothing and restores nothing.
 */

/**
 * Which box's draft: a post's new 댓글, a 대댓글 under the 댓글 `parentId`, an edit of `commentId`.
 * An edit names its box by the comment alone; `threadId` — the 댓글 whose thread holds it, itself
 * for a 댓글 — rides with the text kept, so the page coming back can read on through that thread's
 * 대댓글 for one not yet read ('답글 더 보기', 오너 결정 2026-10-21, ADR-0074).
 */
export type CommentDraftKey =
  | { kind: 'comment'; postId: string }
  | { kind: 'reply'; postId: string; parentId: string }
  | { kind: 'edit'; postId: string; commentId: string; threadId?: string };

/** The drafts of one post kept for one account, by box (ids lower-cased, as the API spells them). */
export interface CommentDrafts {
  /** The new 댓글's box. */
  readonly comment: string | undefined;
  /** The reply box of each thread, by its 댓글's id. */
  readonly replies: ReadonlyMap<string, string>;
  /** The edit box of each comment, by its id. */
  readonly edits: ReadonlyMap<string, string>;
  /**
   * The thread each edit's comment is in (its 댓글's id), by the comment's id, where it was kept
   * with one (`CommentDraftKey`'s `threadId`).
   */
  readonly editThreads: ReadonlyMap<string, string>;
}

export const NO_COMMENT_DRAFTS: CommentDrafts = {
  comment: undefined,
  replies: new Map(),
  edits: new Map(),
  editThreads: new Map(),
};

/**
 * How long a kept draft waits for its page: the post drafts' hour (오너 결정 2026-10-20 3차 답 2 — the
 * owner's «잠시» for 글·댓글 alike). Closing the tab removes it sooner.
 */
export const COMMENT_DRAFT_TTL_MS = POST_DRAFT_TTL_MS;

/** Every kept comment draft's storage key starts with this (apart from the post drafts'). */
export const COMMENT_DRAFT_PREFIX = 'buddha.commentDraft:';

function postPrefix(postId: string): string {
  return `${COMMENT_DRAFT_PREFIX}${postId.toLowerCase()}:`;
}

export function commentDraftStorageKey(key: CommentDraftKey): string {
  switch (key.kind) {
    case 'comment':
      return `${postPrefix(key.postId)}comment`;
    case 'reply':
      return `${postPrefix(key.postId)}reply:${key.parentId.toLowerCase()}`;
    case 'edit':
      return `${postPrefix(key.postId)}edit:${key.commentId.toLowerCase()}`;
  }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The box a storage key under `postId` names, or null for anything else. */
function boxOf(postId: string, storageKey: string): CommentDraftKey | null {
  const prefix = postPrefix(postId);
  if (!storageKey.startsWith(prefix)) return null;
  const rest = storageKey.slice(prefix.length);
  if (rest === 'comment') return { kind: 'comment', postId };
  const [kind, id, ...extra] = rest.split(':');
  if (id === undefined || extra.length > 0 || !ID.test(id)) return null;
  if (kind === 'reply') return { kind: 'reply', postId, parentId: id };
  if (kind === 'edit') return { kind: 'edit', postId, commentId: id };
  return null;
}

/**
 * Whether a box going away keeps its text: it holds some to keep (`hasDraft` — text other than what
 * the box started with), the write it sent did not succeed (`saved`), and the account has an
 * onboarding step left. Any leave of such an account keeps it, however it leaves: the gate or a
 * write's entry going to the step, and on the post page — exempt from the gate for a re-consent
 * alone — a link or Back too, which still asked «쓰던 내용이 사라집니다» first: the text comes back
 * only on that post's page, once the step is done, within the hour (ADR-0074 7-23·7-24). An
 * account with nothing left keeps nothing: a link or Back asked first, and that sentence is true.
 * As a post's (`shouldKeepPostDraft`).
 */
export function shouldKeepCommentDraft(state: {
  hasDraft: boolean;
  saved: boolean;
  onboarding: Onboarding | undefined;
}): boolean {
  return state.hasDraft && !state.saved && hasOnboardingStepLeft(state.onboarding);
}

/** A kept draft as it is stored; an edit's with the thread of its comment, when known. */
interface StoredCommentDraft {
  version: 1;
  accountId: string;
  savedAt: number;
  text: string;
  threadId?: string;
}

function parseStored(raw: string): StoredCommentDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { version, accountId, savedAt, text, threadId } = value as Record<string, unknown>;
  if (version !== 1 || typeof accountId !== 'string' || typeof savedAt !== 'number') return null;
  if (typeof text !== 'string') return null;
  return typeof threadId === 'string' && ID.test(threadId)
    ? { version: 1, accountId, savedAt, text, threadId }
    : { version: 1, accountId, savedAt, text };
}

function isExpired(stored: StoredCommentDraft, now: number): boolean {
  return now - stored.savedAt > COMMENT_DRAFT_TTL_MS;
}

function tryRemove(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A storage the browser refuses holds nothing to remove.
  }
}

/** The storage keys under `prefix`. */
function keysUnder(storage: DraftStorage, prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function readItem(storage: DraftStorage, key: string): StoredCommentDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  return raw === null ? null : parseStored(raw);
}

/** Removes every kept comment draft past COMMENT_DRAFT_TTL_MS, and every item that is none. */
export function sweepCommentDrafts(storage: DraftStorage, now: number): void {
  for (const key of keysUnder(storage, COMMENT_DRAFT_PREFIX)) {
    const stored = readItem(storage, key);
    if (stored === null || isExpired(stored, now)) tryRemove(storage, key);
  }
}

/** Keeps `text` for `key`, written by `accountId`, replacing what was kept there. Whether it was. */
export function keepCommentDraft(
  storage: DraftStorage,
  key: CommentDraftKey,
  accountId: string,
  text: string,
  now: number,
): boolean {
  sweepCommentDrafts(storage, now);
  const threadId = key.kind === 'edit' ? key.threadId?.toLowerCase() : undefined;
  try {
    storage.setItem(
      commentDraftStorageKey(key),
      JSON.stringify({
        version: 1,
        accountId,
        savedAt: now,
        text,
        ...(threadId === undefined ? {} : { threadId }),
      } satisfies StoredCommentDraft),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The drafts kept for the post `postId` by `accountId`: none past COMMENT_DRAFT_TTL_MS and none of
 * another account's (both removed — another account's is never shown to this one), nor anything
 * that is not a draft. Reads only; the page that takes them back removes them once it holds them
 * (`clearCommentDrafts`).
 */
export function readCommentDrafts(
  storage: DraftStorage,
  postId: string,
  accountId: string,
  now: number,
): CommentDrafts {
  let comment: string | undefined;
  const replies = new Map<string, string>();
  const edits = new Map<string, string>();
  const editThreads = new Map<string, string>();
  const id = postId.toLowerCase();
  for (const storageKey of keysUnder(storage, postPrefix(id))) {
    const box = boxOf(id, storageKey);
    const stored = readItem(storage, storageKey);
    if (
      box === null ||
      stored === null ||
      isExpired(stored, now) ||
      stored.accountId !== accountId
    ) {
      tryRemove(storage, storageKey);
      continue;
    }
    if (box.kind === 'comment') comment = stored.text;
    else if (box.kind === 'reply') replies.set(box.parentId, stored.text);
    else {
      edits.set(box.commentId, stored.text);
      if (stored.threadId !== undefined) editThreads.set(box.commentId, stored.threadId);
    }
  }
  return comment === undefined && replies.size === 0 && edits.size === 0
    ? NO_COMMENT_DRAFTS
    : { comment, replies, edits, editThreads };
}

/** Whether `drafts` holds any draft. */
export function hasCommentDrafts(drafts: CommentDrafts): boolean {
  return drafts.comment !== undefined || drafts.replies.size > 0 || drafts.edits.size > 0;
}

/** `drafts` without the boxes `keys` name (taken back, or shown apart) — itself when none is held. */
export function withoutCommentDrafts(
  drafts: CommentDrafts,
  keys: readonly CommentDraftKey[],
): CommentDrafts {
  const holds = (key: CommentDraftKey) =>
    key.kind === 'comment'
      ? drafts.comment !== undefined
      : key.kind === 'reply'
        ? drafts.replies.has(key.parentId.toLowerCase())
        : drafts.edits.has(key.commentId.toLowerCase());
  if (!keys.some(holds)) return drafts;
  let comment = drafts.comment;
  const replies = new Map(drafts.replies);
  const edits = new Map(drafts.edits);
  const editThreads = new Map(drafts.editThreads);
  for (const key of keys) {
    if (key.kind === 'comment') comment = undefined;
    else if (key.kind === 'reply') replies.delete(key.parentId.toLowerCase());
    else {
      edits.delete(key.commentId.toLowerCase());
      editThreads.delete(key.commentId.toLowerCase());
    }
  }
  return comment === undefined && replies.size === 0 && edits.size === 0
    ? NO_COMMENT_DRAFTS
    : { comment, replies, edits, editThreads };
}

/** `extra` laid over `drafts`: what was kept since replaces what was held for the same box. */
export function mergeCommentDrafts(drafts: CommentDrafts, extra: CommentDrafts): CommentDrafts {
  if (!hasCommentDrafts(extra)) return drafts;
  // An edit kept again without its thread keeps the one it was kept with before.
  const editThreads = new Map(drafts.editThreads);
  for (const commentId of extra.edits.keys()) {
    const threadId = extra.editThreads.get(commentId);
    if (threadId !== undefined) editThreads.set(commentId, threadId);
  }
  return {
    comment: extra.comment ?? drafts.comment,
    replies: new Map([...drafts.replies, ...extra.replies]),
    edits: new Map([...drafts.edits, ...extra.edits]),
    editThreads,
  };
}

/** Removes what was kept for the post `postId`. */
export function clearCommentDrafts(storage: DraftStorage, postId: string): void {
  for (const key of keysUnder(storage, postPrefix(postId))) tryRemove(storage, key);
}

/** Removes what was kept for `key`. */
export function clearCommentDraft(storage: DraftStorage, key: CommentDraftKey): void {
  tryRemove(storage, commentDraftStorageKey(key));
}

/**
 * Removes what `accountId` kept for `key`, and only that: another account's draft of the same box
 * stays (anything that is no draft goes, as a read would remove it).
 */
export function clearCommentDraftOf(
  storage: DraftStorage,
  key: CommentDraftKey,
  accountId: string,
): void {
  const storageKey = commentDraftStorageKey(key);
  const stored = readItem(storage, storageKey);
  if (stored === null || stored.accountId === accountId) tryRemove(storage, storageKey);
}

/** Removes every kept comment draft (signing out). */
export function clearAllCommentDrafts(storage: DraftStorage): void {
  for (const key of keysUnder(storage, COMMENT_DRAFT_PREFIX)) tryRemove(storage, key);
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

export function keepSessionCommentDraft(
  key: CommentDraftKey,
  accountId: string,
  text: string,
): boolean {
  const storage = sessionDrafts();
  return storage === null ? false : keepCommentDraft(storage, key, accountId, text, Date.now());
}

export function readSessionCommentDrafts(postId: string, accountId: string): CommentDrafts {
  const storage = sessionDrafts();
  return storage === null
    ? NO_COMMENT_DRAFTS
    : readCommentDrafts(storage, postId, accountId, Date.now());
}

export function clearSessionCommentDrafts(postId: string): void {
  const storage = sessionDrafts();
  if (storage !== null) clearCommentDrafts(storage, postId);
}

export function clearAllSessionCommentDrafts(): void {
  const storage = sessionDrafts();
  if (storage !== null) clearAllCommentDrafts(storage);
}

// ---- the writes that landed in this tab ------------------------------------------------------

/**
 * When a write of each box last landed in this tab, by the account that sent it and the box's
 * storage key, as a `commentDraftMoment` — as the post drafts' `landedAt`, and for the same reason:
 * a write's `onSuccess` runs before the box hears of it, and a box the page takes away in between
 * holds its sent text from its last render; counting a write landed after that render as saved
 * (`commentDraftLandedSince`) keeps it from keeping a comment already written.
 *
 * By account (Codex review on PR #220): a write sent by account A can land after the tab changed to
 * account B, and B can have a box of the same post and box open meanwhile — its own text, kept for
 * B across an onboarding step. A's landing says nothing of B's box: it neither removes B's kept
 * draft nor counts B's box as saved, which would let B's text go unkept as the page leaves.
 */
const landedAt = new Map<string, number>();
let moments = 0;

function landedKey(key: CommentDraftKey, accountId: string): string {
  return `${accountId}\n${commentDraftStorageKey(key)}`;
}

/** A moment in this tab's order of comment draft events: each call answers a larger number. */
export function commentDraftMoment(): number {
  moments += 1;
  return moments;
}

/**
 * A write of `key`'s box sent by `accountId` (its `expectedAccountId`) landed: that account's kept
 * draft of the box goes, and a box of it that account rendered before now keeps nothing. Another
 * account's draft and box of the same key are left as they are.
 */
export function commentDraftLanded(key: CommentDraftKey, accountId: string): void {
  landedAt.set(landedKey(key, accountId), commentDraftMoment());
  const storage = sessionDrafts();
  if (storage !== null) clearCommentDraftOf(storage, key, accountId);
}

/**
 * Whether a write of `key`'s box by `accountId` — the account a box rendered for — landed after
 * `moment` (a `commentDraftMoment`).
 */
export function commentDraftLandedSince(
  key: CommentDraftKey,
  accountId: string,
  moment: number,
): boolean {
  return (landedAt.get(landedKey(key, accountId)) ?? 0) > moment;
}
