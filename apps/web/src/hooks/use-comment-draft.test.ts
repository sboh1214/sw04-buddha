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
 * A comment box going away (오너 결정 2026-10-20 답 2·4, ADR-0074): its text is kept in this tab when
 * the page is going to an onboarding step — for the account on screen, with text other than the
 * box started with, and no write of it landed since its last render — and never otherwise; and it
 * is left to the section, to show with why it cannot be sent, only while its write is in flight or
 * refused and the writer did not close it. The section going to a step keeps the texts it shows
 * apart from any box the same way, as the drafts of the boxes they stood for.
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

  it('is its text while its write is in flight or refused', () => {
    expect(commentBoxLeaves(going({ pending: true }), me('account-a', null))).toBe('left');
    expect(commentBoxLeaves(going({ refused: true }), me('account-a', null))).toBe('left');
  });

  it('is nothing once the writer closed it (취소), even after a refusal', () => {
    expect(commentBoxLeaves(going({ refused: true, closed: true }), me('account-a', null))).toBe(
      'dropped',
    );
  });

  it('is nothing once a write of it landed since its last render', () => {
    const last = going({ pending: true });
    commentDraftLanded(last.key);
    expect(commentBoxLeaves(last, me('account-a', null))).toBe('dropped');
  });

  it('is nothing when its text is kept for a step — which keeps it', () => {
    expect(commentBoxLeaves(going({ refused: true }), me('account-a', 'consent'))).toBe('dropped');
    expect(storage.items.size).toBe(1);
  });

  it('is nothing with nothing to lose, or with no write in flight or refused (ADR-0074 결과 4)', () => {
    expect(commentBoxLeaves(going({ refused: true, text: '  ' }), me('account-a', null))).toBe(
      'dropped',
    );
    expect(commentBoxLeaves(going(), me('account-a', null))).toBe('dropped');
  });
});

describe('what the comment section keeps as it goes', () => {
  const EDITED = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
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
      edits: new Map([[PARENT, '아직 상자에 들지 않은 수정']]),
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
        [EDITED, '보내지 못한 수정'],
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
