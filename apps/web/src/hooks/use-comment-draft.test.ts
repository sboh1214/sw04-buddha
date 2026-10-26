import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Me } from '@/lib/api';
import { type DraftStorage } from '@/lib/post-drafts';
import {
  NO_COMMENT_DRAFTS,
  commentDraftLanded,
  commentDraftMoment,
  commentDraftStorageKey,
  readCommentDrafts,
} from '@/lib/comment-drafts';
import { type HeldText } from '@/lib/comments';
import {
  accountForgottenInTab,
  sessionAccountHeard,
  sessionAccountTurned,
} from '@/lib/session-account';
import {
  type CommentBoxDraft,
  type SectionTexts,
  commentBoxLeaves,
  keepHeldCommentDraft,
  keepSectionTextsAsItGoes,
  keepSectionTextsForStep,
  keepSectionTextsForTurn,
} from './use-comment-draft';

/**
 * A comment box going away (오너 결정 2026-10-20 답 2·4, 2026-10-21 답 2, ADR-0074): its text is
 * kept in this tab when the page is going to an onboarding step — for the account on screen, with
 * text other than the box started with, no write of it landed since its last render, and its place
 * taking it still (the page itself going) — and never otherwise; and any other changed text the
 * writer did not close (취소) is left to the section with how its write stood — in flight, refused
 * or none — to show with why it cannot be sent: a box a read took away in place, a step left or
 * not. The section going to a step keeps the texts it shows apart from any box the same way, as the
 * drafts of the boxes they stood for.
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

const POST = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';
const PARENT = '6f9619ff-8b86-d011-b42d-00c04fc964ff';

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { sessionStorage: storage });
});
afterEach(() => {
  vi.unstubAllGlobals();
  // Nobody heard from the session and no reset under way (lib/session-account.ts), as before the
  // forward order's tests.
  accountForgottenInTab();
});

/** `GET /me` for `id`, with `nextStep` left. */
const me = (id: string, nextStep: Me['onboarding']['nextStep']) =>
  ({ id, onboarding: { nextStep } }) as Me;

/** A reply box of `PARENT` as of its last render. */
const box = (partial: Partial<CommentBoxDraft> = {}) => ({
  key: { kind: 'reply', postId: POST, parentId: PARENT } as const,
  accountId: 'account-a',
  text: '쓰던 답글',
  initial: '',
  pending: false,
  refused: false,
  place: { kind: 'thread', threadId: PARENT } as const,
  moment: commentDraftMoment(),
  ...partial,
});

describe('a comment box going away', () => {
  it('keeps its text for its writer when the page goes to a step left', () => {
    expect(keepHeldCommentDraft(box(), me('account-a', 'consent'))).toBe(true);
    expect([...readCommentDrafts(storage, POST, 'account-a', Date.now()).replies]).toEqual([
      [PARENT, '쓰던 답글'],
    ]);
  });

  it('keeps nothing with no step left, with no `Me` in the cache, or with nothing changed', () => {
    expect(keepHeldCommentDraft(box(), me('account-a', null))).toBe(false);
    expect(keepHeldCommentDraft(box(), undefined)).toBe(false);
    expect(keepHeldCommentDraft(box({ text: '   ' }), me('account-a', 'consent'))).toBe(false);
    expect(
      keepHeldCommentDraft(
        box({
          key: { kind: 'edit', postId: POST, commentId: PARENT },
          text: '그대로',
          initial: '그대로',
        }),
        me('account-a', 'consent'),
      ),
    ).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it('keeps nothing once a write of the box landed after its last render', () => {
    const last = box();
    commentDraftLanded(last.key, 'account-a');
    expect(keepHeldCommentDraft(last, me('account-a', 'consent'))).toBe(false);
    expect(storage.getItem(commentDraftStorageKey(last.key, 'account-a'))).toBeNull();
  });

  it('keeps its text when the write that landed was another account’s: the tab changed from A to B with A’s write in flight (Codex review on PR #220)', () => {
    // A sent a 답글 from this box; the tab changed to B, who opened the same box and went to a
    // step, which kept B's text; A's write lands now. It is A's landing: B's kept draft stays, and
    // B's box — rendered before it — is not counted as saved, so it keeps its text as it goes.
    const theirs = box({ accountId: 'account-b', text: 'B가 쓰던 답글' });
    expect(keepHeldCommentDraft(theirs, me('account-b', 'consent'))).toBe(true);
    const kept = storage.getItem(commentDraftStorageKey(theirs.key, 'account-b'));
    expect(kept).not.toBeNull();
    commentDraftLanded(theirs.key, 'account-a');
    expect(storage.getItem(commentDraftStorageKey(theirs.key, 'account-b'))).toBe(kept);
    expect([...readCommentDrafts(storage, POST, 'account-b', Date.now()).replies]).toEqual([
      [PARENT, 'B가 쓰던 답글'],
    ]);
    expect(keepHeldCommentDraft(theirs, me('account-b', 'consent'))).toBe(true);
    expect(commentBoxLeaves({ ...theirs, closed: false }, me('account-b', null), true)).toBe(
      'none',
    );
    // B's own write of the box does count, and removes B's draft.
    commentDraftLanded(theirs.key, 'account-b');
    expect(storage.getItem(commentDraftStorageKey(theirs.key, 'account-b'))).toBeNull();
    expect(keepHeldCommentDraft(theirs, me('account-b', 'consent'))).toBe(false);
    expect(commentBoxLeaves({ ...theirs, closed: false }, me('account-b', null), true)).toBe(
      'dropped',
    );
  });
});

describe('a comment box going as the account on screen turns to another (ADR-0092, 오너 결정 2026-10-26 17:21 답 3 «이 PR에서 함께, 적던 것은 A의 초안으로»)', () => {
  // `['me']` turns from A to B in place, before the session does (ADR-0090 결정 4-2): the section
  // draws its boxes for the account on screen (comments-section.tsx — the threads keyed by the
  // boxes' turn, the new 댓글's box by the account), so A's boxes go with B in `['me']`. Each keeps
  // what A typed as A's draft, whatever its write and its place, and leaves the section — B's —
  // nothing; B's page reads none of it, and A's, once A is back, takes it back.
  const going = (partial: Partial<CommentBoxDraft & { closed: boolean }> = {}) => ({
    closed: false,
    ...box(partial),
  });
  const b = me('account-b', null);
  const boxes: Partial<CommentBoxDraft>[] = [
    { key: { kind: 'comment', postId: POST }, text: 'A가 쓰던 댓글', place: { kind: 'post' } },
    {},
    {
      key: { kind: 'edit', postId: POST, commentId: PARENT, threadId: PARENT },
      text: 'A가 고치던 댓글',
      initial: '댓글',
      place: { kind: 'comment', commentId: PARENT, threadId: PARENT },
    },
  ];

  it('keeps what A typed in each box as A’s, which B never reads, and leaves B’s section nothing', () => {
    for (const partial of boxes) {
      for (const write of [{}, { pending: true }, { refused: true }]) {
        for (const placeGone of [false, true]) {
          storage.items.clear();
          const last = going({ ...partial, ...write });
          expect(commentBoxLeaves(last, b, placeGone)).toBe('dropped');
          expect([...storage.items.keys()]).toEqual([
            commentDraftStorageKey(last.key, 'account-a'),
          ]);
          expect(readCommentDrafts(storage, POST, 'account-b', Date.now())).toBe(NO_COMMENT_DRAFTS);
          const theirs = readCommentDrafts(storage, POST, 'account-a', Date.now());
          const text =
            last.key.kind === 'comment'
              ? theirs.comment
              : last.key.kind === 'reply'
                ? theirs.replies.get(PARENT)
                : theirs.edits.get(PARENT);
          expect(text).toBe(last.text);
        }
      }
    }
    // The edit with its thread, for A's page to read on through it.
    storage.items.clear();
    commentBoxLeaves(going(boxes[2]), b, false);
    expect([...readCommentDrafts(storage, POST, 'account-a', Date.now()).editThreads]).toEqual([
      [PARENT, PARENT],
    ]);
  });

  it('keeps B’s own text beside A’s as B’s boxes go when the account on screen turns back to A', () => {
    expect(commentBoxLeaves(going(), b, false)).toBe('dropped');
    expect(
      commentBoxLeaves(
        going({ accountId: 'account-b', text: 'B가 쓰던 답글' }),
        me('account-a', null),
        false,
      ),
    ).toBe('dropped');
    expect([...readCommentDrafts(storage, POST, 'account-a', Date.now()).replies]).toEqual([
      [PARENT, '쓰던 답글'],
    ]);
    expect([...readCommentDrafts(storage, POST, 'account-b', Date.now()).replies]).toEqual([
      [PARENT, 'B가 쓰던 답글'],
    ]);
  });

  it('keeps nothing with nothing typed, closed, or a write of it landed; nor with no `Me` in the cache and no other account in the session (a sign-out)', () => {
    expect(commentBoxLeaves(going({ text: ' ' }), b, false)).toBe('dropped');
    expect(commentBoxLeaves(going({ closed: true }), b, false)).toBe('dropped');
    const landed = going({ pending: true });
    commentDraftLanded(landed.key, 'account-a');
    expect(commentBoxLeaves(landed, b, false)).toBe('dropped');
    expect(keepHeldCommentDraft(landed, b)).toBe(false);
    expect(storage.items.size).toBe(0);
    // Nobody on screen: the box is left to the section as before (which hears it for nobody).
    expect(commentBoxLeaves(going(), undefined, false)).toBe('none');
    expect(storage.items.size).toBe(0);
  });

  it('a write A sent that lands after the turn clears A’s kept draft, and only A’s', () => {
    const theirs = going({ pending: true });
    expect(commentBoxLeaves(theirs, b, false)).toBe('dropped');
    expect(
      commentBoxLeaves(
        going({ accountId: 'account-b', text: 'B가 쓰던 답글' }),
        me('account-a', null),
        false,
      ),
    ).toBe('dropped');
    commentDraftLanded(theirs.key, 'account-a');
    expect(readCommentDrafts(storage, POST, 'account-a', Date.now()).replies.size).toBe(0);
    expect([...readCommentDrafts(storage, POST, 'account-b', Date.now()).replies]).toEqual([
      [PARENT, 'B가 쓰던 답글'],
    ]);
  });
});

describe('a comment box going in SessionCacheGuard’s reset as the session turns to another account first (ADR-0092 결정 10, 오너 결정 2026-10-26 21:00 답 1 «정순서에서도 A의 초안으로»)', () => {
  // The forward order: the session names B first, and the guard's reset empties `['me']` — and the
  // post page's comments with it — so A's boxes go with no `Me` in the cache. Each hears from the
  // guard whom the session now names (`sessionAccountTurned`, recorded before the reset —
  // lib/session-account.ts): B, not its writer — so it keeps what A typed as A's draft, whatever
  // its write and its place, and leaves the section nothing, as when `['me']` turns first. A
  // sign-out — the session naming nobody — and the session naming the writer with no reset for it
  // under way still keep nothing, as before.
  const going = (partial: Partial<CommentBoxDraft & { closed: boolean }> = {}) => ({
    closed: false,
    ...box(partial),
  });
  const boxes: Partial<CommentBoxDraft>[] = [
    { key: { kind: 'comment', postId: POST }, text: 'A가 쓰던 댓글', place: { kind: 'post' } },
    {},
    {
      key: { kind: 'edit', postId: POST, commentId: PARENT, threadId: PARENT },
      text: 'A가 고치던 댓글',
      initial: '댓글',
      place: { kind: 'comment', commentId: PARENT, threadId: PARENT },
    },
  ];

  it('keeps what A typed in each box as A’s, which B never reads, and leaves the section nothing', () => {
    sessionAccountTurned('account-b');
    for (const partial of boxes) {
      for (const write of [{}, { pending: true }, { refused: true }]) {
        for (const placeGone of [false, true]) {
          storage.items.clear();
          const last = going({ ...partial, ...write });
          expect(commentBoxLeaves(last, undefined, placeGone)).toBe('dropped');
          expect([...storage.items.keys()]).toEqual([
            commentDraftStorageKey(last.key, 'account-a'),
          ]);
          expect(readCommentDrafts(storage, POST, 'account-b', Date.now())).toBe(NO_COMMENT_DRAFTS);
          const theirs = readCommentDrafts(storage, POST, 'account-a', Date.now());
          const text =
            last.key.kind === 'comment'
              ? theirs.comment
              : last.key.kind === 'reply'
                ? theirs.replies.get(PARENT)
                : theirs.edits.get(PARENT);
          expect(text).toBe(last.text);
        }
      }
    }
    storage.items.clear();
    expect(keepHeldCommentDraft(box(), undefined)).toBe(true);
    expect([...readCommentDrafts(storage, POST, 'account-a', Date.now()).replies]).toEqual([
      [PARENT, '쓰던 답글'],
    ]);
  });

  it('keeps nothing with nothing typed, closed, or a write of it landed — and nothing, the box left to the section as before, as the session names nobody or the writer', () => {
    sessionAccountHeard('account-b');
    expect(commentBoxLeaves(going({ text: ' ' }), undefined, false)).toBe('dropped');
    expect(commentBoxLeaves(going({ closed: true }), undefined, false)).toBe('dropped');
    const landed = going({ pending: true });
    commentDraftLanded(landed.key, 'account-a');
    expect(commentBoxLeaves(landed, undefined, false)).toBe('dropped');
    expect(storage.items.size).toBe(0);
    for (const heard of [null, 'account-a']) {
      sessionAccountHeard(heard);
      expect(commentBoxLeaves(going(), undefined, false)).toBe('none');
      expect(commentBoxLeaves(going({ refused: true }), undefined, true)).toBe('refused');
      expect(keepHeldCommentDraft(box(), undefined)).toBe(false);
    }
    expect(storage.items.size).toBe(0);
  });
});

describe('a comment box going in SessionCacheGuard’s reset as the session catches up with the account `GET /me` turned to first (ADR-0092 8-36, 오너 결정 2026-10-26 21:00 답 1 «정순서에서도 A의 초안으로» — 어느 순서로 바뀌든)', () => {
  // A comes back to the tab the session turned to B: one `visibilitychange` reads both again, and
  // `GET /me` answers A first — A's boxes are drawn and take back A's drafts, out of the tab — then
  // the session says A, and the guard's reset empties `['me']` and the comments: A's boxes go again,
  // with no `Me` in the cache and the session naming their writer. They go with the turn: each
  // keeps what it holds as A's draft and leaves the section nothing, and A's boxes, drawn again
  // once `GET /me` answers, take it back. Without the reset under way — a sign-out's own clearing —
  // the session naming the writer still keeps nothing.
  const going = (partial: Partial<CommentBoxDraft & { closed: boolean }> = {}) => ({
    closed: false,
    ...box(partial),
  });
  const boxes: Partial<CommentBoxDraft>[] = [
    { key: { kind: 'comment', postId: POST }, text: 'A가 되살린 댓글', place: { kind: 'post' } },
    {},
    {
      key: { kind: 'edit', postId: POST, commentId: PARENT, threadId: PARENT },
      text: 'A가 되살린 수정',
      initial: '댓글',
      place: { kind: 'comment', commentId: PARENT, threadId: PARENT },
    },
  ];

  it('keeps what A’s box holds as A’s while the reset for A is under way, whatever its write and its place, and leaves the section nothing', () => {
    sessionAccountTurned('account-b')();
    const settled = sessionAccountTurned('account-a');
    for (const partial of boxes) {
      for (const write of [{}, { pending: true }, { refused: true }]) {
        for (const placeGone of [false, true]) {
          storage.items.clear();
          const last = going({ ...partial, ...write });
          expect(commentBoxLeaves(last, undefined, placeGone)).toBe('dropped');
          expect([...storage.items.keys()]).toEqual([
            commentDraftStorageKey(last.key, 'account-a'),
          ]);
          const kept = readCommentDrafts(storage, POST, 'account-a', Date.now());
          const text =
            last.key.kind === 'comment'
              ? kept.comment
              : last.key.kind === 'reply'
                ? kept.replies.get(PARENT)
                : kept.edits.get(PARENT);
          expect(text).toBe(last.text);
          expect(readCommentDrafts(storage, POST, 'account-b', Date.now())).toBe(NO_COMMENT_DRAFTS);
        }
      }
    }
    // Drawn again for A, `['me']` answering: no turn — A's own leave keeps nothing.
    storage.items.clear();
    expect(commentBoxLeaves(going(), me('account-a', null), false)).toBe('none');
    expect(storage.items.size).toBe(0);
    settled();
  });

  it('keeps nothing with nothing typed, closed, or a write of it landed — and, the reset over or the tab’s account forgotten, nothing: the box left to the section as before', () => {
    const settled = sessionAccountTurned('account-a');
    expect(commentBoxLeaves(going({ text: ' ' }), undefined, false)).toBe('dropped');
    expect(commentBoxLeaves(going({ closed: true }), undefined, false)).toBe('dropped');
    const landed = going({ pending: true });
    commentDraftLanded(landed.key, 'account-a');
    expect(commentBoxLeaves(landed, undefined, false)).toBe('dropped');
    expect(storage.items.size).toBe(0);
    settled();
    expect(commentBoxLeaves(going(), undefined, false)).toBe('none');
    expect(keepHeldCommentDraft(box(), undefined)).toBe(false);
    sessionAccountTurned('account-a');
    accountForgottenInTab();
    expect(commentBoxLeaves(going({ refused: true }), undefined, true)).toBe('refused');
    expect(keepHeldCommentDraft(box(), undefined)).toBe(false);
    expect(storage.items.size).toBe(0);
  });
});

describe('what a comment box going away leaves the section', () => {
  const going = (partial: Partial<CommentBoxDraft & { closed: boolean }> = {}) => ({
    closed: false,
    ...box(partial),
  });
  /** Its place takes it still: the page itself is going. */
  const PLACE_KEPT = false;
  /** Its place takes it no more: a read took the box away in place. */
  const PLACE_GONE = true;

  it('is its text with its write in flight or refused', () => {
    for (const place of [PLACE_KEPT, PLACE_GONE]) {
      expect(commentBoxLeaves(going({ pending: true }), me('account-a', null), place)).toBe(
        'pending',
      );
      expect(commentBoxLeaves(going({ refused: true }), me('account-a', null), place)).toBe(
        'refused',
      );
    }
  });

  it('is its text with no write too — the section holds it where its place took it no more (오너 결정 2026-10-21 답 2)', () => {
    expect(commentBoxLeaves(going(), me('account-a', null), PLACE_GONE)).toBe('none');
    expect(commentBoxLeaves(going(), undefined, PLACE_GONE)).toBe('none');
    expect(
      commentBoxLeaves(
        going({
          key: { kind: 'edit', postId: POST, commentId: PARENT },
          text: '고친 댓글',
          initial: '댓글',
        }),
        me('account-a', null),
        PLACE_GONE,
      ),
    ).toBe('none');
    // Its place taking it still, the section drops it (lib/held-comment-texts.ts).
    expect(commentBoxLeaves(going(), me('account-a', null), PLACE_KEPT)).toBe('none');
  });

  it('is nothing once the writer closed it (취소), even after a refusal', () => {
    expect(
      commentBoxLeaves(going({ refused: true, closed: true }), me('account-a', null), PLACE_GONE),
    ).toBe('dropped');
  });

  it('is nothing once a write of it landed since its last render', () => {
    const last = going({ pending: true });
    commentDraftLanded(last.key, last.accountId);
    expect(commentBoxLeaves(last, me('account-a', null), PLACE_GONE)).toBe('dropped');
  });

  it('is nothing when its text is kept for a step as the page goes, its place taking it still — which keeps it', () => {
    expect(commentBoxLeaves(going({ refused: true }), me('account-a', 'consent'), PLACE_KEPT)).toBe(
      'dropped',
    );
    expect([...readCommentDrafts(storage, POST, 'account-a', Date.now()).replies]).toEqual([
      [PARENT, '쓰던 답글'],
    ]);
  });

  it('is its text, kept nowhere, when a read takes it away in place with a step left — the page stays (7-23), and the section shows it (오너 결정 2026-10-21 답 2)', () => {
    const consent = me('account-a', 'consent');
    expect(commentBoxLeaves(going(), consent, PLACE_GONE)).toBe('none');
    expect(commentBoxLeaves(going({ refused: true }), consent, PLACE_GONE)).toBe('refused');
    expect(commentBoxLeaves(going({ pending: true }), consent, PLACE_GONE)).toBe('pending');
    expect(
      commentBoxLeaves(
        going({
          key: { kind: 'comment', postId: POST },
          text: '쓰던 댓글',
          place: { kind: 'post' },
        }),
        consent,
        PLACE_GONE,
      ),
    ).toBe('none');
    // Never both shown and kept: a text closed now does not come back after the step.
    expect(storage.items.size).toBe(0);
  });

  it('is nothing with nothing to lose: no text, or an edit as the comment stands', () => {
    expect(
      commentBoxLeaves(going({ refused: true, text: '  ' }), me('account-a', null), PLACE_GONE),
    ).toBe('dropped');
    expect(commentBoxLeaves(going({ text: '' }), me('account-a', null), PLACE_GONE)).toBe(
      'dropped',
    );
    expect(
      commentBoxLeaves(
        going({
          key: { kind: 'edit', postId: POST, commentId: PARENT },
          text: '댓글 ',
          initial: '댓글',
        }),
        me('account-a', 'consent'),
        PLACE_KEPT,
      ),
    ).toBe('dropped');
    expect(storage.items.size).toBe(0);
  });

  it('is nothing once the writer closed it with no write either (취소, asked first)', () => {
    expect(commentBoxLeaves(going({ closed: true }), me('account-a', null), PLACE_GONE)).toBe(
      'dropped',
    );
    expect(commentBoxLeaves(going({ closed: true }), me('account-a', 'consent'), PLACE_KEPT)).toBe(
      'dropped',
    );
    expect(storage.items.size).toBe(0);
  });
});

describe('what the comment section keeps as it goes', () => {
  const EDITED = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
  const REPLY = 'c4cc289f-9c0a-4999-8a23-bdf5f7654113';
  const held = (place: HeldText['place'], text: string): HeldText => ({
    id: `held-${text}`,
    place,
    reason: '까닭',
    text,
    focus: false,
    shown: true,
  });
  const section: SectionTexts = {
    postId: POST.toUpperCase(),
    accountId: 'account-a',
    held: [
      held({ kind: 'thread', threadId: PARENT }, '보내지 못한 답글'),
      held({ kind: 'comment', commentId: EDITED, threadId: PARENT }, '보내지 못한 수정'),
      held({ kind: 'post' }, '보내지 못한 댓글'),
    ],
    awaiting: [],
    drafts: {
      comment: undefined,
      replies: new Map(),
      edits: new Map([
        [PARENT, '아직 상자에 들지 않은 수정'],
        [REPLY, '아직 상자에 들지 않은 답글 수정'],
      ]),
      editThreads: new Map([[REPLY, PARENT]]),
    },
    moment: commentDraftMoment(),
  };
  /** What the section kept for A, as A's page reads it. */
  const keptForA = () => {
    const kept = readCommentDrafts(storage, POST, 'account-a', Date.now());
    return {
      comment: kept.comment,
      replies: new Map(kept.replies),
      edits: new Map(kept.edits),
      editThreads: new Map(kept.editThreads),
    };
  };
  const ALL_OF_A = {
    comment: '보내지 못한 댓글',
    replies: new Map([[PARENT, '보내지 못한 답글']]),
    edits: new Map([
      [PARENT, '아직 상자에 들지 않은 수정'],
      [REPLY, '아직 상자에 들지 않은 답글 수정'],
      [EDITED, '보내지 못한 수정'],
    ]),
    editThreads: new Map([
      [REPLY, PARENT],
      [EDITED, PARENT],
    ]),
  };

  it('keeps the texts it holds apart, and drafts no box took yet, as the drafts of their boxes when the page goes to a step left (오너 결정 2026-10-20 답 2·4)', () => {
    expect(keepSectionTextsForStep(section, me('account-a', 'consent'))).toBe(true);
    const kept = readCommentDrafts(storage, POST, 'account-a', Date.now());
    expect(kept.comment).toBe('보내지 못한 댓글');
    expect([...kept.replies]).toEqual([[PARENT, '보내지 못한 답글']]);
    expect(new Map(kept.edits)).toEqual(
      new Map([
        [PARENT, '아직 상자에 들지 않은 수정'],
        [REPLY, '아직 상자에 들지 않은 답글 수정'],
        [EDITED, '보내지 못한 수정'],
      ]),
    );
    // Each edit with its thread, for the page to read on through it after the step (답글 더 보기).
    expect(new Map(kept.editThreads)).toEqual(
      new Map([
        [REPLY, PARENT],
        [EDITED, PARENT],
      ]),
    );
  });

  it('keeps nothing with no step left, for another account, or with no account on screen', () => {
    expect(keepSectionTextsForStep(section, me('account-a', null))).toBe(false);
    expect(keepSectionTextsForStep(section, me('account-b', 'consent'))).toBe(false);
    expect(keepSectionTextsForStep(section, undefined)).toBe(false);
    expect(
      keepSectionTextsForStep({ ...section, accountId: undefined }, me('account-a', 'consent')),
    ).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it('keeps A’s texts held apart and A’s drafts no box took yet as A’s, when the account on screen turns from A to B in place (ADR-0092, 오너 결정 2026-10-26 17:21 답 3)', () => {
    // The section drew them for A; B's render holds none (the held texts start afresh for B, and
    // the drafts are read for B), so they go with A — kept as A's drafts of their boxes, whatever
    // A's steps, to come back when A is on screen again.
    expect(keepSectionTextsForTurn(section, 'account-b')).toBe(true);
    const kept = readCommentDrafts(storage, POST, 'account-a', Date.now());
    expect(kept.comment).toBe('보내지 못한 댓글');
    expect([...kept.replies]).toEqual([[PARENT, '보내지 못한 답글']]);
    expect(new Map(kept.edits)).toEqual(
      new Map([
        [PARENT, '아직 상자에 들지 않은 수정'],
        [REPLY, '아직 상자에 들지 않은 답글 수정'],
        [EDITED, '보내지 못한 수정'],
      ]),
    );
    expect(new Map(kept.editThreads)).toEqual(
      new Map([
        [REPLY, PARENT],
        [EDITED, PARENT],
      ]),
    );
    expect(readCommentDrafts(storage, POST, 'account-b', Date.now())).toBe(NO_COMMENT_DRAFTS);
  });

  it('keeps nothing as nobody was or is on screen — a sign-out, `GET /me` not answered — nor for the same account', () => {
    expect(keepSectionTextsForTurn(section, undefined)).toBe(false);
    expect(keepSectionTextsForTurn({ ...section, accountId: undefined }, 'account-b')).toBe(false);
    expect(keepSectionTextsForTurn(section, 'account-a')).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it('keeps A’s texts as A’s when the render that takes it away has `GET /me` naming B — the gate’s placeholder for B’s first onboarding step, the section never drawn for B (ADR-0092 8-26)', () => {
    // The turn's layout effect never runs: the section goes in the very render `['me']` turns.
    expect(keepSectionTextsAsItGoes(section, me('account-b', 'consent'))).toBe(true);
    expect(keptForA()).toEqual(ALL_OF_A);
    expect(readCommentDrafts(storage, POST, 'account-b', Date.now())).toBe(NO_COMMENT_DRAFTS);
    // B with nothing left too (the page taken away for another reason in that render).
    storage.items.clear();
    expect(keepSectionTextsAsItGoes(section, me('account-b', null))).toBe(true);
    expect(keptForA()).toEqual(ALL_OF_A);
  });

  it('keeps them for A’s own step as before, and nothing for A with no step left or with no `Me` in the cache', () => {
    expect(keepSectionTextsAsItGoes(section, me('account-a', 'consent'))).toBe(true);
    expect(keptForA()).toEqual(ALL_OF_A);
    storage.items.clear();
    expect(keepSectionTextsAsItGoes(section, me('account-a', null))).toBe(false);
    expect(keepSectionTextsAsItGoes(section, undefined)).toBe(false);
    expect(
      keepSectionTextsAsItGoes({ ...section, accountId: undefined }, me('account-b', 'consent')),
    ).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it('keeps the texts on their way — a box gone with its write in flight, its refusal not heard yet — as A’s on the turn, but for a box whose write landed since the section drew them (ADR-0092 8-26)', () => {
    const drawn: SectionTexts = {
      ...section,
      held: [],
      drafts: NO_COMMENT_DRAFTS,
      awaiting: [
        { id: 'box-1', place: { kind: 'thread', threadId: PARENT }, text: '보내는 중이던 답글' },
        {
          id: 'box-2',
          place: { kind: 'comment', commentId: EDITED, threadId: PARENT },
          text: '보내는 중이던 수정',
        },
        { id: 'box-3', place: { kind: 'post' }, text: '보내는 중이던 댓글' },
      ],
      moment: commentDraftMoment(),
    };
    // The new 댓글's write landed after the section drew them: it is written, not kept.
    commentDraftLanded({ kind: 'comment', postId: POST }, 'account-a');
    // B's landing of the same box says nothing of A's (by account, as a box's).
    commentDraftLanded({ kind: 'reply', postId: POST, parentId: PARENT }, 'account-b');
    expect(keepSectionTextsForTurn(drawn, 'account-b')).toBe(true);
    const kept = keptForA();
    expect(kept.comment).toBeUndefined();
    expect(kept.replies).toEqual(new Map([[PARENT, '보내는 중이던 답글']]));
    expect(kept.edits).toEqual(new Map([[EDITED, '보내는 중이던 수정']]));
    expect(kept.editThreads).toEqual(new Map([[EDITED, PARENT]]));
    expect(readCommentDrafts(storage, POST, 'account-b', Date.now())).toBe(NO_COMMENT_DRAFTS);
    // The section going with B in `['me']` keeps them too; a refusal after it is not heard.
    storage.items.clear();
    expect(keepSectionTextsAsItGoes(drawn, me('account-b', 'consent'))).toBe(true);
    expect(keptForA().replies).toEqual(new Map([[PARENT, '보내는 중이던 답글']]));
    // A write landing later removes A's draft of its box (`commentDraftLanded`).
    commentDraftLanded({ kind: 'reply', postId: POST, parentId: PARENT }, 'account-a');
    expect(keptForA().replies).toEqual(new Map());
    // Not for a step: what goes there is what the section shows (ADR-0074 7-23·7-24).
    storage.items.clear();
    expect(keepSectionTextsForStep(drawn, me('account-a', 'consent'))).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it('keeps A’s texts as A’s when SessionCacheGuard’s reset empties the profile as the session turns to B first — in the layout effect with nobody on screen, or as the section goes — and nothing for a sign-out or A’s own session (ADR-0092 결정 10, 오너 결정 2026-10-26 21:00 답 1)', () => {
    // The reset's render draws the section for nobody: the layout effect passes no account, and the
    // one the tab is for now is the one the session names (`goesWithAccountTurn`), as the cleanup
    // finds it.
    sessionAccountTurned('account-b');
    expect(keepSectionTextsForTurn(section, undefined)).toBe(true);
    expect(keptForA()).toEqual(ALL_OF_A);
    expect(readCommentDrafts(storage, POST, 'account-b', Date.now())).toBe(NO_COMMENT_DRAFTS);
    storage.items.clear();
    expect(keepSectionTextsAsItGoes(section, undefined)).toBe(true);
    expect(keptForA()).toEqual(ALL_OF_A);
    storage.items.clear();
    // The texts on their way go with A too: their refusal, heard after the reset, is not heard.
    const onTheirWay: SectionTexts = {
      ...section,
      held: [],
      drafts: NO_COMMENT_DRAFTS,
      awaiting: [{ id: 'box-1', place: { kind: 'post' }, text: '보내는 중이던 댓글' }],
      moment: commentDraftMoment(),
    };
    expect(keepSectionTextsForTurn(onTheirWay, undefined)).toBe(true);
    expect(keptForA().comment).toBe('보내는 중이던 댓글');
    storage.items.clear();
    // The session naming nobody (a sign-out), or A with no reset under way (the tab's sign-out
    // emptying the cache first): nothing.
    accountForgottenInTab();
    for (const heard of [null, 'account-a']) {
      sessionAccountHeard(heard);
      expect(keepSectionTextsForTurn(section, undefined)).toBe(false);
      expect(keepSectionTextsAsItGoes(section, undefined)).toBe(false);
      expect(keepSectionTextsForTurn(onTheirWay, undefined)).toBe(false);
    }
    expect(storage.items.size).toBe(0);
  });

  it('keeps A’s texts as A’s when the session catches up with A after `GET /me` turned to A first, the reset taking away what the section drew for A — drafts just taken back among them — and nothing once that reset is over (ADR-0092 8-36)', () => {
    sessionAccountTurned('account-b')();
    const settled = sessionAccountTurned('account-a');
    // The reset's render: the layout effect with nobody on screen, or the section going.
    expect(keepSectionTextsForTurn(section, undefined)).toBe(true);
    expect(keptForA()).toEqual(ALL_OF_A);
    storage.items.clear();
    expect(keepSectionTextsAsItGoes(section, undefined)).toBe(true);
    expect(keptForA()).toEqual(ALL_OF_A);
    storage.items.clear();
    const onTheirWay: SectionTexts = {
      ...section,
      held: [],
      drafts: NO_COMMENT_DRAFTS,
      awaiting: [{ id: 'box-1', place: { kind: 'post' }, text: '보내는 중이던 댓글' }],
      moment: commentDraftMoment(),
    };
    expect(keepSectionTextsForTurn(onTheirWay, undefined)).toBe(true);
    expect(keptForA().comment).toBe('보내는 중이던 댓글');
    storage.items.clear();
    // Drawn again for A: no turn.
    expect(keepSectionTextsForTurn(section, 'account-a')).toBe(false);
    settled();
    expect(keepSectionTextsForTurn(section, undefined)).toBe(false);
    expect(keepSectionTextsAsItGoes(section, undefined)).toBe(false);
    expect(storage.items.size).toBe(0);
  });
});
