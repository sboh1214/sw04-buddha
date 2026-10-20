import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type HeldTextPlace } from './comments';
import {
  type HeldTextsEvent,
  type HeldTextsState,
  heldTextsAfter,
  heldTextsOf,
  initialHeldTexts,
} from './held-comment-texts';

/**
 * The texts a comment section holds apart from any box (오너 결정 2026-10-20 답 4, ADR-0074 7-25),
 * in every order the news arrives: a refused write's box shown once both the refusal and its text
 * are heard, nothing of a box closed, landed or dropped, the reason the thread's when the refusal
 * was about something else, and only the account on screen's.
 */

const A = 'account-a';
const B = 'account-b';
const THREAD: HeldTextPlace = { kind: 'thread', threadId: 't1' };

const run = (events: readonly HeldTextsEvent[], from: HeldTextsState = initialHeldTexts(A)) =>
  events.reduce(heldTextsAfter, from);

const refused = (
  boxId: string,
  reason: string = copy.errCommentParentGone,
  stale = true,
  accountId = A,
): HeldTextsEvent => ({ type: 'refused', boxId, accountId, reason, stale });

const left = (
  boxId: string,
  more: Partial<{ accountId: string; goneReason: string; focus: boolean }> = {},
): HeldTextsEvent => ({
  type: 'left',
  boxId,
  accountId: more.accountId ?? A,
  text: `${boxId}의 글자`,
  place: THREAD,
  goneReason: more.goneReason,
  focus: more.focus ?? true,
});

/** What is shown: id, reason and text. */
const shown = (state: HeldTextsState) =>
  heldTextsOf(state).map(({ id, reason, text }) => [id, reason, text]);

describe('text a refused box leaves', () => {
  it('is shown once both the refusal and the box going are heard, in either order', () => {
    const expected = [['box', copy.errCommentParentGone, 'box의 글자']];
    expect(shown(run([refused('box')]))).toEqual([]);
    expect(shown(run([left('box')]))).toEqual([]);
    expect(shown(run([refused('box'), left('box')]))).toEqual(expected);
    expect(shown(run([left('box'), refused('box')]))).toEqual(expected);
    expect(heldTextsOf(run([left('box'), refused('box')]))[0]).toMatchObject({
      place: THREAD,
      focus: true,
    });
  });

  it('is nothing for a box closed or kept for a step after its refusal (dropped)', () => {
    expect(shown(run([refused('box'), { type: 'dropped', boxId: 'box' }]))).toEqual([]);
  });

  it('is nothing once the write lands, whatever came before it', () => {
    expect(shown(run([left('box'), { type: 'landed', boxId: 'box' }]))).toEqual([]);
    // Refused once, sent again, gone while that write was in flight, and it landed.
    expect(
      shown(
        run([
          refused('box', copy.errNetwork, false),
          left('box'),
          { type: 'landed', boxId: 'box' },
        ]),
      ),
    ).toEqual([]);
  });

  it('ignores a refusal heard after its box went with nothing to hold — until it is mounted again', () => {
    expect(shown(run([{ type: 'dropped', boxId: 'box' }, refused('box')]))).toEqual([]);
    // React's development check unmounts a box and mounts it again at once.
    expect(
      shown(
        run([
          { type: 'dropped', boxId: 'box' },
          { type: 'mounted', boxId: 'box' },
          refused('box'),
          left('box'),
        ]),
      ),
    ).toEqual([['box', copy.errCommentParentGone, 'box의 글자']]);
  });

  it('stays until it is closed', () => {
    const state = run([refused('a'), left('a'), refused('b'), left('b')]);
    expect(shown(state).map(([id]) => id)).toEqual(['a', 'b']);
    expect(shown(heldTextsAfter(state, { type: 'dismiss', id: 'a' })).map(([id]) => id)).toEqual([
      'b',
    ]);
  });

  it('says why its place takes it no more when the refusal was about something else', () => {
    // A network failure under the button, then the 댓글 deleted elsewhere and the box gone with it.
    expect(
      shown(
        run([
          refused('box', copy.errNetwork, false),
          left('box', { goneReason: copy.errCommentParentDeleted }),
        ]),
      ),
    ).toEqual([['box', copy.errCommentParentDeleted, 'box의 글자']]);
    // The refusal about the thread is the server's word for it.
    expect(
      shown(run([left('box', { goneReason: copy.errCommentParentDeleted }), refused('box')])),
    ).toEqual([['box', copy.errCommentParentGone, 'box의 글자']]);
    // Nothing there says: the refusal's words.
    expect(shown(run([refused('box', copy.errNetwork, false), left('box')]))).toEqual([
      ['box', copy.errNetwork, 'box의 글자'],
    ]);
  });

  it('takes the focus only from a box that held it', () => {
    expect(heldTextsOf(run([refused('box'), left('box', { focus: false })]))[0]?.focus).toBe(false);
  });
});

describe('drafts taken back and held apart', () => {
  it('are shown as they are, without the focus', () => {
    const state = run([
      {
        type: 'hold',
        accountId: A,
        texts: [
          { id: 'taken-back:x', place: THREAD, reason: copy.errCommentParentGone, text: '답글' },
        ],
      },
    ]);
    expect(heldTextsOf(state)).toEqual([
      {
        id: 'taken-back:x',
        place: THREAD,
        reason: copy.errCommentParentGone,
        text: '답글',
        focus: false,
      },
    ]);
  });
});

describe('the account on screen', () => {
  it('holds its own texts only: another account, or none, starts afresh', () => {
    const shownForA = run([refused('box'), left('box')]);
    expect(shown(shownForA)).toHaveLength(1);
    expect(shown(heldTextsAfter(shownForA, { type: 'account', accountId: B }))).toEqual([]);
    expect(shown(heldTextsAfter(shownForA, { type: 'account', accountId: undefined }))).toEqual([]);
    expect(heldTextsAfter(shownForA, { type: 'account', accountId: A })).toBe(shownForA);
  });

  it('does not hear a box the switch took away, nor a refusal of its write arriving after', () => {
    // The tab learns of a sign-out elsewhere: `GET /me` is reset, A's refused box goes with it.
    const signedOut = run([
      refused('box', copy.errNetwork, false),
      { type: 'account', accountId: undefined },
      left('box'),
      refused('box'),
    ]);
    expect(shown(signedOut)).toEqual([]);
    // B signs in: still nothing of A's.
    expect(shown(heldTextsAfter(signedOut, { type: 'account', accountId: B }))).toEqual([]);
    // A box of A refused after B is on screen.
    expect(shown(run([{ type: 'account', accountId: B }, left('box'), refused('box')]))).toEqual(
      [],
    );
    // Drafts taken back for A, held once B is on screen.
    expect(
      shown(
        run([
          { type: 'account', accountId: B },
          {
            type: 'hold',
            accountId: A,
            texts: [{ id: 'taken-back:x', place: THREAD, reason: '까닭', text: '답글' }],
          },
        ]),
      ),
    ).toEqual([]);
  });
});
