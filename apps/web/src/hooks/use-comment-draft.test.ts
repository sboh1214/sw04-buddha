import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Me } from '@/lib/api';
import { type DraftStorage } from '@/lib/post-drafts';
import {
  commentDraftLanded,
  commentDraftMoment,
  commentDraftStorageKey,
  readCommentDrafts,
} from '@/lib/comment-drafts';
import { type HeldText } from '@/lib/comments';
import {
  type CommentBoxDraft,
  commentBoxLeaves,
  keepHeldCommentDraft,
  keepSectionTextsForStep,
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

  it('keeps nothing with no step left, for another account, or with nothing changed', () => {
    expect(keepHeldCommentDraft(box(), me('account-a', null))).toBe(false);
    expect(keepHeldCommentDraft(box(), me('account-b', 'consent'))).toBe(false);
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
    commentDraftLanded(last.key);
    expect(keepHeldCommentDraft(last, me('account-a', 'consent'))).toBe(false);
    expect(storage.getItem(commentDraftStorageKey(last.key))).toBeNull();
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
    commentDraftLanded(last.key);
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
  });
  const section = {
    postId: POST.toUpperCase(),
    accountId: 'account-a',
    held: [
      held({ kind: 'thread', threadId: PARENT }, '보내지 못한 답글'),
      held({ kind: 'comment', commentId: EDITED, threadId: PARENT }, '보내지 못한 수정'),
      held({ kind: 'post' }, '보내지 못한 댓글'),
    ],
    drafts: {
      comment: undefined,
      replies: new Map(),
      edits: new Map([
        [PARENT, '아직 상자에 들지 않은 수정'],
        [REPLY, '아직 상자에 들지 않은 답글 수정'],
      ]),
      editThreads: new Map([[REPLY, PARENT]]),
    },
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
});
