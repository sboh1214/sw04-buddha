import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type HeldTextPlace } from './comments';
import {
  type GoingBoxWrite,
  type HeldTextsEvent,
  type HeldTextsState,
  heldTextsAfter,
  heldTextsAwaiting,
  heldTextsOf,
  initialHeldTexts,
  pageMayGo,
} from './held-comment-texts';

/**
 * The texts a comment section holds apart from any box (오너 결정 2026-10-20 답 4 and 2026-10-21
 * 답 1·2, ADR-0074 7-25), in every order the news arrives: a refused write's box shown once both
 * the refusal and its text are heard, a box with no write at once with why its place took it no
 * more, nothing of a box closed, landed or dropped, the reason the thread's when the refusal was
 * about something else, a text still on its way while its box's write is in flight, and only the
 * account on screen's.
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
  more: Partial<{
    accountId: string;
    goneReason: string;
    focus: boolean;
    write: GoingBoxWrite;
  }> = {},
): HeldTextsEvent => ({
  type: 'left',
  boxId,
  accountId: more.accountId ?? A,
  text: `${boxId}의 글자`,
  place: THREAD,
  goneReason: more.goneReason,
  focus: more.focus ?? true,
  write: more.write ?? 'pending',
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

  it('says a writing restriction’s refusal is one, when its words are the reason (#185, ADR-0082 7-6)', () => {
    const restriction = `${copy.errRestrictedWriting}(무기한).`;
    const restricted: HeldTextsEvent = {
      type: 'refused',
      boxId: 'box',
      accountId: A,
      reason: restriction,
      stale: false,
      restricted: true,
    };
    // Nothing there says why the box went: the restriction's words, and the way to 조치·신고 내역.
    expect(heldTextsOf(run([restricted, left('box')]))).toEqual([
      expect.objectContaining({ reason: restriction, restricted: true }),
    ]);
    // Its place took it no more: that is the reason, and no way to 조치·신고 내역 goes with it.
    const gone = heldTextsOf(
      run([restricted, left('box', { goneReason: copy.errCommentParentDeleted })]),
    );
    expect(gone).toEqual([expect.objectContaining({ reason: copy.errCommentParentDeleted })]);
    expect(gone[0]).not.toHaveProperty('restricted');
    // Any other refusal says nothing of it.
    expect(
      heldTextsOf(run([refused('box', copy.errNetwork, false), left('box')]))[0],
    ).not.toHaveProperty('restricted');
  });
});

describe('text a box with no write leaves (오너 결정 2026-10-21 답 2)', () => {
  it('is shown at once with why its place takes it no more, the focus from a box that held it', () => {
    const state = run([
      left('box', { write: 'none', goneReason: copy.errCommentParentDeleted, focus: false }),
    ]);
    expect(shown(state)).toEqual([['box', copy.errCommentParentDeleted, 'box의 글자']]);
    expect(heldTextsOf(state)[0]?.focus).toBe(false);
    expect(
      heldTextsOf(run([left('box', { write: 'none', goneReason: copy.errPostGone })]))[0]?.focus,
    ).toBe(true);
    expect(heldTextsAwaiting(state)).toBe(false);
  });

  it('stays until it is closed', () => {
    const state = run([left('box', { write: 'none', goneReason: copy.errCommentGone })]);
    expect(shown(heldTextsAfter(state, { type: 'dismiss', id: 'box' }))).toEqual([]);
  });

  it('is nothing when its place takes it still — the box went for another reason', () => {
    const state = run([left('box', { write: 'none' })]);
    expect(shown(state)).toEqual([]);
    expect(heldTextsAwaiting(state)).toBe(false);
    // As a box dropped: nothing heard of it later is shown, until it is mounted again.
    expect(shown(heldTextsAfter(state, refused('box')))).toEqual([]);
  });

  it('is the refused box’s text, with the refusal’s rules, when its write was refused', () => {
    expect(
      shown(
        run([
          refused('box', copy.errNetwork, false),
          left('box', { write: 'refused', goneReason: copy.errCommentParentHidden }),
        ]),
      ),
    ).toEqual([['box', copy.errCommentParentHidden, 'box의 글자']]);
  });
});

describe('a text on its way (the post page holds off its 404 for it, 오너 결정 2026-10-21 답 1)', () => {
  it('is a box gone with its write in flight, until its refusal or its landing is heard', () => {
    const inFlight = run([left('box')]);
    expect(heldTextsAwaiting(inFlight)).toBe(true);
    expect(shown(inFlight)).toEqual([]);
    const refusedNow = heldTextsAfter(inFlight, refused('box', copy.errPostGone));
    expect(heldTextsAwaiting(refusedNow)).toBe(false);
    expect(shown(refusedNow)).toEqual([['box', copy.errPostGone, 'box의 글자']]);
    expect(heldTextsAwaiting(heldTextsAfter(inFlight, { type: 'landed', boxId: 'box' }))).toBe(
      false,
    );
  });

  it('is never a refusal alone, a draft held, or another account’s box', () => {
    expect(heldTextsAwaiting(run([refused('box')]))).toBe(false);
    expect(heldTextsAwaiting(run([refused('box'), left('box', { write: 'refused' })]))).toBe(false);
    expect(
      heldTextsAwaiting(
        run([
          {
            type: 'hold',
            accountId: A,
            texts: [{ id: 'taken-back:x', place: THREAD, reason: copy.errPostGone, text: '답글' }],
          },
        ]),
      ),
    ).toBe(false);
    expect(heldTextsAwaiting(run([left('box', { accountId: B })]))).toBe(false);
    // A box gone refused, its refusal somehow not heard: nothing on its way — the page is not held
    // for what will not come.
    expect(heldTextsAwaiting(run([left('box', { write: 'refused' })]))).toBe(false);
    expect(
      heldTextsAwaiting(heldTextsAfter(run([left('box')]), { type: 'account', accountId: B })),
    ).toBe(false);
  });
});

describe('a post gone from every view (오너 결정 2026-10-21 답 1)', () => {
  const postGone: HeldTextsEvent = { type: 'post-gone' };

  it('lets its page go once heard with nothing held — never before it is heard', () => {
    expect(pageMayGo(run([]))).toBe(false);
    expect(pageMayGo(run([postGone]))).toBe(true);
    expect(run([postGone, postGone])).toEqual(run([postGone]));
  });

  it('holds its page while a text is shown, until the last is closed', () => {
    const state = run([
      refused('a', copy.errPostGone),
      left('a'),
      left('b', { write: 'none', goneReason: copy.errPostGone }),
      postGone,
    ]);
    expect(pageMayGo(state)).toBe(false);
    const one = heldTextsAfter(state, { type: 'dismiss', id: 'a' });
    expect(pageMayGo(one)).toBe(false);
    expect(pageMayGo(heldTextsAfter(one, { type: 'dismiss', id: 'b' }))).toBe(true);
  });

  it('holds its page while a box gone with its write in flight awaits its refusal', () => {
    const state = run([left('box'), postGone]);
    expect(pageMayGo(state)).toBe(false);
    const refusedNow = heldTextsAfter(state, refused('box', copy.errPostGone));
    expect(shown(refusedNow)).toEqual([['box', copy.errPostGone, 'box의 글자']]);
    expect(pageMayGo(refusedNow)).toBe(false);
    expect(pageMayGo(heldTextsAfter(refusedNow, { type: 'dismiss', id: 'box' }))).toBe(true);
  });

  it('leaves the texts held before it with their own reasons: only what goes with it says the post is gone', () => {
    // Held before the post went: a 답글 refused as its 댓글 went (the refusal's words), a box whose
    // other refusal was followed by its 댓글 going (its place's reason), and a draft taken back that
    // its 댓글 no longer takes. Then a box with no write goes with the post.
    const before = run([
      refused('a'),
      left('a', { goneReason: copy.errCommentParentDeleted }),
      refused('b', copy.errNetwork, false),
      left('b', { goneReason: copy.errCommentParentDeleted }),
      {
        type: 'hold',
        accountId: A,
        texts: [
          { id: 'taken-back:x', place: THREAD, reason: copy.errCommentParentHidden, text: '답글' },
        ],
      },
    ]);
    const after = run(
      [left('c', { write: 'none', goneReason: copy.errPostGone }), postGone],
      before,
    );
    expect(shown(after)).toEqual([
      ['a', copy.errCommentParentGone, 'a의 글자'],
      ['b', copy.errCommentParentDeleted, 'b의 글자'],
      ['taken-back:x', copy.errCommentParentHidden, '답글'],
      ['c', copy.errPostGone, 'c의 글자'],
    ]);
  });

  it('says the post is gone for a box that went with it in flight, when the browser cuts that write', () => {
    // The box went in the render the post went in, its write hung; the browser cuts it at last: a
    // refusal about the network, not about the thread — the text says why its place takes it no
    // more (ADR-0074 7-25), not a sentence that reads as "send it again".
    const state = run([left('box', { goneReason: copy.errPostGone }), postGone]);
    expect(pageMayGo(state)).toBe(false);
    const cut = heldTextsAfter(state, refused('box', copy.errNetwork, false));
    expect(shown(cut)).toEqual([['box', copy.errPostGone, 'box의 글자']]);
    expect(pageMayGo(cut)).toBe(false);
    expect(pageMayGo(heldTextsAfter(cut, { type: 'dismiss', id: 'box' }))).toBe(true);
  });

  it('lets it go for a box that went with nothing to hold', () => {
    expect(pageMayGo(run([left('box', { write: 'none' }), postGone]))).toBe(true);
    expect(pageMayGo(run([refused('box'), { type: 'dropped', boxId: 'box' }, postGone]))).toBe(
      true,
    );
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
        shown: false,
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

describe('a text drawn once (ADR-0074 7-25)', () => {
  const drawnOf = (state: HeldTextsState) =>
    heldTextsOf(state).map(({ id, focus, shown: drawn }) => [id, focus, drawn]);
  const takenBack = (id: string): HeldTextsEvent => ({
    type: 'hold',
    accountId: A,
    texts: [{ id, place: THREAD, reason: copy.errNetwork, text: '수정' }],
  });

  it('is new until the section says it drew it: a later mount — its place moved — is not', () => {
    const state = run([refused('box'), left('box'), takenBack('taken-back:x')]);
    expect(drawnOf(state)).toEqual([
      ['box', true, false],
      ['taken-back:x', false, false],
    ]);
    const drawn = heldTextsAfter(state, { type: 'shown', ids: ['box', 'taken-back:x'] });
    // Still the same text, its focus as it went: only no longer new.
    expect(drawnOf(drawn)).toEqual([
      ['box', true, true],
      ['taken-back:x', false, true],
    ]);
    expect(shown(drawn)).toEqual(shown(state));
    // Said again (React's development check runs an effect twice), or of a text not held: no change.
    expect(heldTextsAfter(drawn, { type: 'shown', ids: ['box', 'gone'] })).toBe(drawn);
    expect(heldTextsAfter(state, { type: 'shown', ids: [] })).toBe(state);
  });

  it('is new again once closed and held again, and for the next account', () => {
    const drawn = run([takenBack('taken-back:x'), { type: 'shown', ids: ['taken-back:x'] }]);
    const heldAgain = run(
      [{ type: 'dismiss', id: 'taken-back:x' }, takenBack('taken-back:x')],
      drawn,
    );
    expect(drawnOf(heldAgain)).toEqual([['taken-back:x', false, false]]);
    const forB = run(
      [
        { type: 'account', accountId: B },
        {
          type: 'hold',
          accountId: B,
          texts: [{ id: 'taken-back:x', place: THREAD, reason: '까닭', text: '수정' }],
        },
      ],
      drawn,
    );
    expect(drawnOf(forB)).toEqual([['taken-back:x', false, false]]);
  });
});

describe('a held edit’s 대댓글 brought onto the screen by a read (오너 결정 2026-10-22 (2차) 답 2, (3차) 답 1·3)', () => {
  const EDIT: HeldTextPlace = { kind: 'comment', commentId: 'r9', threadId: 't1' };
  const detailsOf = (state: HeldTextsState) =>
    heldTextsOf(state).map(({ id, reason, text, focus, shown: drawn }) => [
      id,
      reason,
      text,
      focus,
      drawn,
    ]);

  it('says why its edit cannot open now that it is read: new news, read out again, never taking the focus', () => {
    // A draft taken back past the 300 a read of the pages keeps, drawn.
    const draft = run([
      {
        type: 'hold',
        accountId: A,
        texts: [
          { id: 'taken-back:r9', place: EDIT, reason: copy.errCommentEditNotRead, text: '수정' },
        ],
      },
      { type: 'shown', ids: ['taken-back:r9'] },
    ]);
    expect(
      detailsOf(
        heldTextsAfter(draft, {
          type: 'reason',
          id: 'taken-back:r9',
          reason: copy.errCommentNotEditable,
        }),
      ),
    ).toEqual([['taken-back:r9', copy.errCommentNotEditable, '수정', false, false]]);
    // Brought past the 300 a read of the pages keeps: no box there — the owner's words, read out.
    expect(
      detailsOf(
        heldTextsAfter(draft, {
          type: 'reason',
          id: 'taken-back:r9',
          reason: copy.errCommentEditNotReopened,
        }),
      ),
    ).toEqual([['taken-back:r9', copy.errCommentEditNotReopened, '수정', false, false]]);
    // An edit's box gone with the focus in it — a read again taking its 대댓글 out of the 300, its
    // write refused for the network meanwhile — and drawn: its place's reason gives way too.
    const box = run([
      {
        type: 'left',
        boxId: 'box',
        accountId: A,
        text: 'box의 글자',
        place: EDIT,
        goneReason: copy.errCommentEditNotRead,
        focus: true,
        write: 'none',
      },
      refused('box', copy.errNetwork, false),
      { type: 'shown', ids: ['box'] },
    ]);
    expect(detailsOf(box)).toEqual([['box', copy.errCommentEditNotRead, 'box의 글자', true, true]]);
    expect(
      detailsOf(
        heldTextsAfter(box, { type: 'reason', id: 'box', reason: copy.errCommentNotYours }),
      ),
    ).toEqual([['box', copy.errCommentNotYours, 'box의 글자', false, false]]);
  });

  it('changes nothing for a text not held — closed, or another account’s gone with the switch', () => {
    const state = run([refused('box'), left('box')]);
    const event: HeldTextsEvent = { type: 'reason', id: 'box', reason: copy.errCommentNotYours };
    const closed = heldTextsAfter(state, { type: 'dismiss', id: 'box' });
    expect(heldTextsAfter(closed, event)).toBe(closed);
    const switched = heldTextsAfter(state, { type: 'account', accountId: B });
    expect(heldTextsAfter(switched, event)).toBe(switched);
  });

  it('changes nothing when it says what the text says already, nor for a text not shown yet', () => {
    // The section asks again on every render a thread ended without the 대댓글 holds
    // (`heldEditsReadToTheirEnd`): the same words again are no news — not read out again.
    const drawn = run([
      {
        type: 'hold',
        accountId: A,
        texts: [{ id: 'taken-back:r9', place: EDIT, reason: copy.errCommentGone, text: '수정' }],
      },
      { type: 'shown', ids: ['taken-back:r9'] },
    ]);
    const same: HeldTextsEvent = {
      type: 'reason',
      id: 'taken-back:r9',
      reason: copy.errCommentGone,
    };
    expect(heldTextsAfter(drawn, same)).toBe(drawn);
    // A box gone with its write in flight is shown once its refusal comes: a reason before that
    // shows nothing.
    const onItsWay = run([left('box', { write: 'pending', goneReason: copy.errCommentGone })]);
    expect(heldTextsOf(onItsWay)).toEqual([]);
    const early: HeldTextsEvent = { type: 'reason', id: 'box', reason: copy.errCommentGone };
    expect(heldTextsAfter(onItsWay, early)).toBe(onItsWay);
  });
});
