import { describe, expect, it } from 'vitest';
import {
  COMMENT_DRAFT_PREFIX,
  COMMENT_DRAFT_TTL_MS,
  NO_COMMENT_DRAFTS,
  type CommentDraftKey,
  clearAllCommentDrafts,
  clearCommentDraft,
  clearCommentDrafts,
  commentDraftBoxKey,
  commentDraftLanded,
  commentDraftLandedSince,
  commentDraftMoment,
  commentDraftStorageKey,
  hasCommentDrafts,
  keepCommentDraft,
  mergeCommentDrafts,
  readCommentDrafts,
  shouldKeepCommentDraft,
  sweepCommentDrafts,
  withoutCommentDrafts,
} from './comment-drafts';
import { type Onboarding } from './onboarding';
import { POST_DRAFT_PREFIX, POST_DRAFT_TTL_MS, type DraftStorage } from './post-drafts';

/**
 * The comment drafts an onboarding step keeps in this tab (오너 결정 2026-10-20 답 2, ADR-0074): kept
 * and taken back by box and account — one item each (ADR-0092 답 3) — a whole post's at once, gone
 * after the post drafts' hour, cleared, and never thrown on by a storage the browser refuses.
 */

class MemoryStorage implements DraftStorage {
  readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

/** A storage the browser refuses: every call throws (blocked site data). */
const refusing: DraftStorage = {
  get length(): number {
    throw new DOMException('denied', 'SecurityError');
  },
  key() {
    throw new DOMException('denied', 'SecurityError');
  },
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  removeItem() {
    throw new DOMException('denied', 'SecurityError');
  },
};

const POST = 'B7C9A1D2-6F34-4E58-9B0A-2D1E5F8C7A46';
const post = POST.toLowerCase();
const OTHER_POST = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const PARENT = '6F9619FF-8B86-D011-B42D-00C04FC964FF';
const parent = PARENT.toLowerCase();
const EDITED = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';
const ACCOUNT = 'account-a';
/** Another account the tab may show. */
const OTHER = 'account-b';
const NOW = Date.UTC(2026, 9, 20, 3, 0, 0);

const newComment: CommentDraftKey = { kind: 'comment', postId: POST };
const reply: CommentDraftKey = { kind: 'reply', postId: POST, parentId: PARENT };
const edit: CommentDraftKey = { kind: 'edit', postId: POST, commentId: EDITED };

const onboarding = (nextStep: Onboarding['nextStep']) => ({ nextStep }) as Onboarding;

describe('a comment draft’s place in the tab', () => {
  it('is its box under its post, lower-cased, apart from the post drafts', () => {
    expect(commentDraftBoxKey(newComment)).toBe(`${COMMENT_DRAFT_PREFIX}${post}:comment`);
    expect(commentDraftBoxKey(reply)).toBe(`${COMMENT_DRAFT_PREFIX}${post}:reply:${parent}`);
    expect(commentDraftBoxKey(edit)).toBe(`${COMMENT_DRAFT_PREFIX}${post}:edit:${EDITED}`);
    expect(COMMENT_DRAFT_PREFIX.startsWith(POST_DRAFT_PREFIX)).toBe(false);
    expect(POST_DRAFT_PREFIX.startsWith(COMMENT_DRAFT_PREFIX)).toBe(false);
  });

  it('is one item per box and account: the box’s key and the account’s id, as the API spells it (ADR-0092, 오너 결정 2026-10-26 17:21 답 3)', () => {
    expect(commentDraftStorageKey(newComment, ACCOUNT)).toBe(
      `${COMMENT_DRAFT_PREFIX}${post}:comment@${ACCOUNT}`,
    );
    expect(commentDraftStorageKey(reply, OTHER)).toBe(
      `${COMMENT_DRAFT_PREFIX}${post}:reply:${parent}@${OTHER}`,
    );
    expect(commentDraftStorageKey({ ...edit, threadId: PARENT }, ACCOUNT)).toBe(
      `${COMMENT_DRAFT_PREFIX}${post}:edit:${EDITED}@${ACCOUNT}`,
    );
    // An account id is no uuid (better-auth's): its case is its own, and an '@' in it is escaped.
    expect(commentDraftStorageKey(reply, 'AbC')).not.toBe(commentDraftStorageKey(reply, 'abc'));
    expect(commentDraftStorageKey(reply, 'a@b')).toBe(
      `${COMMENT_DRAFT_PREFIX}${post}:reply:${parent}@a%40b`,
    );
    const storage = new MemoryStorage();
    keepCommentDraft(storage, reply, 'a@b', '답글', NOW);
    expect([...readCommentDrafts(storage, POST, 'a@b', NOW).replies]).toEqual([[parent, '답글']]);
    expect(readCommentDrafts(storage, POST, 'b', NOW)).toBe(NO_COMMENT_DRAFTS);
    expect(storage.items.size).toBe(1);
  });

  it('waits the post drafts’ hour (오너 결정 2026-10-20 3차 답 2)', () => {
    expect(COMMENT_DRAFT_TTL_MS).toBe(POST_DRAFT_TTL_MS);
    expect(COMMENT_DRAFT_TTL_MS).toBe(60 * 60 * 1000);
  });
});

describe('keeping and taking back', () => {
  it('takes back every box of the post for the account that wrote them, as they were', () => {
    const storage = new MemoryStorage();
    expect(keepCommentDraft(storage, newComment, ACCOUNT, '새 댓글\n둘째 줄', NOW)).toBe(true);
    expect(keepCommentDraft(storage, reply, ACCOUNT, '답글', NOW)).toBe(true);
    expect(keepCommentDraft(storage, edit, ACCOUNT, '고친 댓글', NOW)).toBe(true);
    // Another post's box is not this post's.
    keepCommentDraft(storage, { kind: 'comment', postId: OTHER_POST }, ACCOUNT, '다른 글', NOW);

    const drafts = readCommentDrafts(storage, POST, ACCOUNT, NOW + 1_000);
    expect(drafts.comment).toBe('새 댓글\n둘째 줄');
    expect([...drafts.replies]).toEqual([[parent, '답글']]);
    expect([...drafts.edits]).toEqual([[EDITED, '고친 댓글']]);
    // Reading removes nothing: the page removes what it took once it holds it.
    expect(storage.items.size).toBe(4);
    clearCommentDrafts(storage, POST, ACCOUNT);
    expect([...storage.items.keys()]).toEqual([
      commentDraftStorageKey({ kind: 'comment', postId: OTHER_POST }, ACCOUNT),
    ]);
  });

  it('keeps an edit’s thread with its text, for the page to read on through it (답글 더 보기)', () => {
    const storage = new MemoryStorage();
    keepCommentDraft(storage, { ...edit, threadId: PARENT }, ACCOUNT, '고친 답글', NOW);
    // The same box as an edit kept without one: the storage key is the comment's alone.
    expect([...storage.items.keys()]).toEqual([commentDraftStorageKey(edit, ACCOUNT)]);
    const drafts = readCommentDrafts(storage, POST, ACCOUNT, NOW + 1);
    expect([...drafts.edits]).toEqual([[EDITED, '고친 답글']]);
    expect([...drafts.editThreads]).toEqual([[EDITED, parent]]);
    // An edit kept without one (a 댓글's) has none; a thread that is no id is not read.
    keepCommentDraft(storage, edit, ACCOUNT, '고친 댓글', NOW + 2);
    expect(readCommentDrafts(storage, POST, ACCOUNT, NOW + 3).editThreads.size).toBe(0);
    storage.setItem(
      commentDraftStorageKey(edit, ACCOUNT),
      JSON.stringify({ version: 1, accountId: ACCOUNT, savedAt: NOW, text: 'x', threadId: 'nope' }),
    );
    const odd = readCommentDrafts(storage, POST, ACCOUNT, NOW + 4);
    expect([...odd.edits]).toEqual([[EDITED, 'x']]);
    expect(odd.editThreads.size).toBe(0);
  });

  it('replaces what was kept for the same box', () => {
    const storage = new MemoryStorage();
    keepCommentDraft(storage, reply, ACCOUNT, '처음', NOW);
    keepCommentDraft(storage, reply, ACCOUNT, '나중', NOW + 1);
    expect([...readCommentDrafts(storage, POST, ACCOUNT, NOW + 2).replies]).toEqual([
      [parent, '나중'],
    ]);
  });

  it('never shows one past the hour, nor what is not a draft — and removes them', () => {
    const storage = new MemoryStorage();
    keepCommentDraft(storage, reply, ACCOUNT, '오래된 답글', NOW - COMMENT_DRAFT_TTL_MS - 1);
    storage.setItem(commentDraftStorageKey(edit, ACCOUNT), '{not json');
    storage.setItem(`${COMMENT_DRAFT_PREFIX}${post}:reply:not-an-id@${ACCOUNT}`, '{}');
    // An item of no account (a box's key alone), or one whose account is not its writer.
    storage.setItem(commentDraftBoxKey(newComment), '{}');
    storage.setItem(
      commentDraftStorageKey(newComment, ACCOUNT),
      JSON.stringify({ version: 1, accountId: OTHER, savedAt: NOW, text: 'B의 댓글' }),
    );
    expect(readCommentDrafts(storage, POST, ACCOUNT, NOW)).toBe(NO_COMMENT_DRAFTS);
    expect(storage.items.size).toBe(0);
  });

  it('never shows one account the drafts of another, and leaves them for their writer (ADR-0092, 오너 결정 2026-10-26 17:21 답 3)', () => {
    // A wrote in three boxes and the tab turned to B in place: A's boxes kept A's text. B's page
    // reads none of it, B's own kept later sits beside A's, and each account's go alone.
    const storage = new MemoryStorage();
    for (const key of [newComment, reply, edit])
      keepCommentDraft(storage, key, ACCOUNT, 'A의 글', NOW);
    expect(readCommentDrafts(storage, POST, OTHER, NOW + 1)).toBe(NO_COMMENT_DRAFTS);
    expect(storage.items.size).toBe(3);
    keepCommentDraft(storage, reply, OTHER, 'B의 답글', NOW + 2);
    expect(storage.items.size).toBe(4);
    const theirs = readCommentDrafts(storage, POST, ACCOUNT, NOW + 3);
    expect(theirs.comment).toBe('A의 글');
    expect([...theirs.replies]).toEqual([[parent, 'A의 글']]);
    expect([...theirs.edits]).toEqual([[EDITED, 'A의 글']]);
    expect([...readCommentDrafts(storage, POST, OTHER, NOW + 3).replies]).toEqual([
      [parent, 'B의 답글'],
    ]);
    // B's page took B's back: A's stay.
    clearCommentDrafts(storage, POST, OTHER);
    expect(readCommentDrafts(storage, POST, OTHER, NOW + 4)).toBe(NO_COMMENT_DRAFTS);
    expect(readCommentDrafts(storage, POST, ACCOUNT, NOW + 4).comment).toBe('A의 글');
    // A's wait the hour, as any kept draft.
    expect(readCommentDrafts(storage, POST, ACCOUNT, NOW + COMMENT_DRAFT_TTL_MS + 1)).toBe(
      NO_COMMENT_DRAFTS,
    );
    expect(storage.items.size).toBe(0);
  });

  it('sweeps every post’s drafts past the hour when one is kept', () => {
    const storage = new MemoryStorage();
    const old = { kind: 'comment', postId: OTHER_POST } as const;
    keepCommentDraft(storage, old, ACCOUNT, '오래된 댓글', NOW - COMMENT_DRAFT_TTL_MS - 1);
    // Another account's past the hour too.
    keepCommentDraft(storage, reply, OTHER, '오래된 답글', NOW - COMMENT_DRAFT_TTL_MS - 1);
    keepCommentDraft(storage, newComment, ACCOUNT, '새 댓글', NOW);
    expect([...storage.items.keys()]).toEqual([commentDraftStorageKey(newComment, ACCOUNT)]);
    storage.setItem(`${COMMENT_DRAFT_PREFIX}x`, 'junk');
    sweepCommentDrafts(storage, NOW);
    expect([...storage.items.keys()]).toEqual([commentDraftStorageKey(newComment, ACCOUNT)]);
  });

  it('clears one box, or every comment draft on signing out — never a post draft', () => {
    const storage = new MemoryStorage();
    keepCommentDraft(storage, newComment, ACCOUNT, '새 댓글', NOW);
    keepCommentDraft(storage, reply, ACCOUNT, '답글', NOW);
    storage.setItem(`${POST_DRAFT_PREFIX}new:${post}`, '{}');
    clearCommentDraft(storage, reply, ACCOUNT);
    expect(readCommentDrafts(storage, POST, ACCOUNT, NOW).replies.size).toBe(0);
    keepCommentDraft(storage, reply, OTHER, 'B의 답글', NOW);
    clearAllCommentDrafts(storage);
    expect([...storage.items.keys()]).toEqual([`${POST_DRAFT_PREFIX}new:${post}`]);
  });

  it('keeps and restores nothing where the browser refuses the storage, and never throws', () => {
    expect(keepCommentDraft(refusing, newComment, ACCOUNT, '댓글', NOW)).toBe(false);
    expect(readCommentDrafts(refusing, POST, ACCOUNT, NOW)).toBe(NO_COMMENT_DRAFTS);
    expect(() => {
      clearCommentDrafts(refusing, POST, ACCOUNT);
      clearCommentDraft(refusing, reply, ACCOUNT);
      clearAllCommentDrafts(refusing);
      sweepCommentDrafts(refusing, NOW);
    }).not.toThrow();
  });
});

describe('the drafts the page holds', () => {
  const drafts = {
    comment: '새 댓글',
    replies: new Map([[parent, '답글']]),
    edits: new Map([[EDITED, '고친 댓글']]),
    editThreads: new Map([[EDITED, parent]]),
  };

  it('lose the boxes that took theirs, and stay themselves when none did', () => {
    expect(hasCommentDrafts(NO_COMMENT_DRAFTS)).toBe(false);
    expect(hasCommentDrafts(drafts)).toBe(true);
    const left = withoutCommentDrafts(drafts, [newComment, reply]);
    expect(left.comment).toBeUndefined();
    expect(left.replies.size).toBe(0);
    expect([...left.edits]).toEqual([[EDITED, '고친 댓글']]);
    expect([...left.editThreads]).toEqual([[EDITED, parent]]);
    expect(withoutCommentDrafts(left, [reply])).toBe(left);
    expect(withoutCommentDrafts(left, [edit])).toBe(NO_COMMENT_DRAFTS);
  });

  it('take a later read’s drafts over theirs for the same box', () => {
    const later = {
      comment: undefined,
      replies: new Map([[parent, '다시 쓴 답글']]),
      edits: new Map([[EDITED, '다시 고친 댓글']]),
      editThreads: new Map<string, string>(),
    };
    const merged = mergeCommentDrafts(drafts, later);
    expect(merged.comment).toBe('새 댓글');
    expect([...merged.replies]).toEqual([[parent, '다시 쓴 답글']]);
    // The edit kept again without its thread keeps the one it had.
    expect([...merged.edits]).toEqual([[EDITED, '다시 고친 댓글']]);
    expect([...merged.editThreads]).toEqual([[EDITED, parent]]);
    expect(mergeCommentDrafts(drafts, NO_COMMENT_DRAFTS)).toBe(drafts);
  });
});

describe('a box going away', () => {
  it('keeps its text only with something to keep, not sent, and a step left', () => {
    expect(
      shouldKeepCommentDraft({ hasDraft: true, saved: false, onboarding: onboarding('consent') }),
    ).toBe(true);
    expect(
      shouldKeepCommentDraft({ hasDraft: false, saved: false, onboarding: onboarding('consent') }),
    ).toBe(false);
    expect(
      shouldKeepCommentDraft({ hasDraft: true, saved: true, onboarding: onboarding('consent') }),
    ).toBe(false);
    expect(
      shouldKeepCommentDraft({ hasDraft: true, saved: false, onboarding: onboarding(null) }),
    ).toBe(false);
    expect(shouldKeepCommentDraft({ hasDraft: true, saved: false, onboarding: undefined })).toBe(
      false,
    );
  });

  it('keeps its text with something to keep and not sent when the account on screen turned from its writer to another (ADR-0092, 오너 결정 2026-10-26 17:21 답 3)', () => {
    // Whatever the other account's steps: the writer's are not known then.
    for (const steps of [undefined, onboarding(null), onboarding('consent')]) {
      expect(
        shouldKeepCommentDraft({
          hasDraft: true,
          saved: false,
          onboarding: steps,
          accountTurned: true,
        }),
      ).toBe(true);
    }
    // Nothing to lose, or sent: nothing kept, as for a step.
    expect(
      shouldKeepCommentDraft({
        hasDraft: false,
        saved: false,
        onboarding: undefined,
        accountTurned: true,
      }),
    ).toBe(false);
    expect(
      shouldKeepCommentDraft({
        hasDraft: true,
        saved: true,
        onboarding: undefined,
        accountTurned: true,
      }),
    ).toBe(false);
    // Not turned: the step's rule alone.
    expect(
      shouldKeepCommentDraft({
        hasDraft: true,
        saved: false,
        onboarding: onboarding(null),
        accountTurned: false,
      }),
    ).toBe(false);
  });

  it('counts a write of its box landed after its last render as saved', () => {
    const before = commentDraftMoment();
    commentDraftLanded(reply, ACCOUNT);
    expect(commentDraftLandedSince(reply, ACCOUNT, before)).toBe(true);
    expect(commentDraftLandedSince(reply, ACCOUNT, commentDraftMoment())).toBe(false);
    // Another box of the post is not that one.
    expect(commentDraftLandedSince(edit, ACCOUNT, before)).toBe(false);
    expect(commentDraftLandedSince({ ...reply, parentId: parent }, ACCOUNT, before)).toBe(true);
    // Nor is the same box of another account (Codex review on PR #220): the write was A's.
    expect(commentDraftLandedSince(reply, OTHER, before)).toBe(false);
  });

  it('removes the kept draft of the account whose write landed, and no other account’s', () => {
    const storage = new MemoryStorage();
    keepCommentDraft(storage, reply, OTHER, 'B의 답글', NOW);
    clearCommentDraft(storage, reply, ACCOUNT);
    expect([...readCommentDrafts(storage, POST, OTHER, NOW).replies.values()]).toEqual([
      'B의 답글',
    ]);
    clearCommentDraft(storage, reply, OTHER);
    expect(storage.items.size).toBe(0);
    // A's and B's both kept (the tab turned from A to B in place, A's write in flight): A's
    // landing takes A's alone.
    keepCommentDraft(storage, reply, ACCOUNT, 'A의 답글', NOW);
    keepCommentDraft(storage, reply, OTHER, 'B의 답글', NOW);
    clearCommentDraft(storage, reply, ACCOUNT);
    expect([...storage.items.keys()]).toEqual([commentDraftStorageKey(reply, OTHER)]);
  });
});
