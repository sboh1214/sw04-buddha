import { type CommentBoxRefusal, type HeldText, type HeldTextPlace } from './comments';

/**
 * The texts a post page's comment section holds apart from any box (오너 결정 2026-10-20 답 4 and
 * 2026-10-21 답 2, ADR-0074 7-25), as a pure state machine over what the section hears — so every
 * order the news can arrive in is a unit test (held-comment-texts.test.ts), and
 * components/post/held-comment-text.tsx is the hook around it.
 *
 * A box tells the section how its write ended and how it went (hooks/use-comment-draft.ts,
 * `CommentBoxGoing`): `refused` with the refusal's words, `left` with the text it held as it went
 * and how its write stood then (in flight, refused, or none), `landed`, `dropped` when it went with
 * nothing to hold (closed, its write landed, nothing changed, or its text kept for an onboarding
 * step as the page went — never a box taken away in place, step or not), and `mounted` again
 * (React's development check unmounts and mounts a box at once). A box whose write was in flight
 * or refused is shown once both the refusal and the box going are heard, in either order; a box
 * with no write is shown at once, with why its place takes it no more
 * (`goneBoxReason`) — or, its place taking it still (the page itself going, say), is dropped. Each
 * stays until the writer closes it (`dismiss`) — or the box's write lands after all. Drafts taken
 * back after a step that no box can take are held as they are (`hold`), with the server's words
 * for why.
 *
 * A post that left every view (`post-gone`, 오너 결정 2026-10-21 답 1) is heard after the boxes that
 * went with it — the section tells it from an effect of the render the post went in, which React
 * runs after that render's boxes have gone and told theirs — so `pageMayGo` speaks for every text
 * of that moment: the post page holds off its 404 until it says so.
 *
 * A text is new once: the section tells which texts it has drawn (`shown`, after the commit that
 * drew them), so a later mount of one — its place moved between its comment and its thread's end as
 * the threads read again hold that comment or not (`placeHeldTexts`) — neither reads its reason out
 * again nor takes the focus (ADR-0074 7-25). A text closed and held again later is new again. An
 * edit's text whose 대댓글 a read has just brought onto the screen is the section's to open in that
 * edit (`heldEditsBrought`, 오너 결정 2026-10-22 (2차) 답 2·(3차) 답 1) — it closes it (`dismiss`)
 * once the box has it — or, the edit not opening there, to say why (`reason`: hidden, another
 * account's, or past the 300 a read of the pages keeps — 3차 답 3's words); so does an edit's text
 * whose thread is read to its end without its 대댓글 (`heldEditsReadToTheirEnd`: gone). A new reason
 * is new again, read out where the text is drawn, never taking the focus.
 *
 * Each text is its writer's: the section is told who is on screen (`account`), and another account
 * — a sign-out or a sign-in in another tab of this browser, seen by SessionCacheGuard — starts it
 * afresh, as the drafts kept in the tab are only ever their writer's (lib/comment-drafts.ts). A box
 * that goes because of that switch, or a write refused after it, tells it of the account it was
 * written by, and is not heard.
 */

/**
 * How a box's write stood as the box went: in flight, refused (and not sent again), or none —
 * nothing sent since it opened, or sent and landed.
 */
export type GoingBoxWrite = 'pending' | 'refused' | 'none';

/** What the section has heard of one box, or of a draft taken back. */
interface Heard {
  /** Who wrote it. */
  accountId: string;
  /**
   * The box's write was refused in these words; `stale`: they say the thread on screen is out of
   * date; `restricted`: a writing restriction refused it (#185).
   */
  refusal?: { reason: string; stale: boolean; restricted?: boolean };
  /** The box went holding this text, from this place. */
  text?: string;
  place?: HeldTextPlace;
  /** Why its place took it no more as the box went (`goneBoxReason`), if it did not. */
  goneReason?: string;
  /**
   * How its write stood as the box went: with none it is shown at once with `goneReason`; in
   * flight, it waits for its refusal (or its landing).
   */
  write?: GoingBoxWrite;
  /** The focus was in the box as it went. */
  focus?: boolean;
  /**
   * Drawn already (`shown`): a later mount of it — its place moved between its comment and its
   * thread's end, as the threads read again hold that comment or not — is not a new text.
   */
  shown?: boolean;
}

export interface HeldTextsState {
  /** The account on screen, the only one whose texts are kept; undefined: none (yet). */
  accountId: string | undefined;
  heard: ReadonlyMap<string, Heard>;
  /** Boxes that went with nothing to hold: a refusal of their write arriving later is not shown. */
  gone: ReadonlySet<string>;
  /** The post left every view, heard after the boxes that went with it. */
  postGone: boolean;
}

export type HeldTextsEvent =
  | { type: 'account'; accountId: string | undefined }
  | {
      type: 'refused';
      boxId: string;
      accountId: string;
      reason: string;
      stale: boolean;
      /** A writing restriction's refusal (RESTRICTED, #185): the text shown with it says so. */
      restricted?: boolean;
    }
  | {
      type: 'left';
      boxId: string;
      accountId: string;
      text: string;
      place: HeldTextPlace;
      /** `goneBoxReason` of its place as the thread read when it went. */
      goneReason: string | undefined;
      focus: boolean;
      write: GoingBoxWrite;
    }
  | { type: 'landed'; boxId: string }
  | { type: 'dropped'; boxId: string }
  | { type: 'mounted'; boxId: string }
  | {
      type: 'hold';
      accountId: string;
      texts: readonly { id: string; place: HeldTextPlace; reason: string; text: string }[];
    }
  | { type: 'dismiss'; id: string }
  /**
   * A held text's place says something else now (오너 결정 2026-10-22 (2차) 답 2·(3차) 답 1): the
   * edit's 대댓글, brought onto the screen by a read, takes no edit from it — hidden, another
   * account's, or past the 300 a read of the pages keeps (`heldEditsBrought`) — or its thread, read
   * to its end, does not hold it: gone (`heldEditsReadToTheirEnd`). Nothing for a text not shown, or
   * one that says it already.
   */
  | { type: 'reason'; id: string; reason: string }
  | { type: 'shown'; ids: readonly string[] }
  | { type: 'post-gone' };

/**
 * What the section hears of a box's refused write (`CommentBoxGoing.refused`,
 * components/post/held-comment-text.tsx): the refusal as the box told it (`commentBoxRefusal`),
 * every part of it — a writing restriction's mark too (#185), which puts the way to 조치·신고 내역
 * under the text should it be held apart with those words (`heldTextsOf`, ADR-0082 7-6).
 */
export function refusedEvent(
  boxId: string,
  accountId: string,
  refusal: CommentBoxRefusal,
): Extract<HeldTextsEvent, { type: 'refused' }> {
  const { reason, stale, restricted } = refusal;
  return { type: 'refused', boxId, accountId, reason, stale, restricted };
}

export function initialHeldTexts(accountId: string | undefined): HeldTextsState {
  return { accountId, heard: new Map(), gone: new Set(), postGone: false };
}

function hear(state: HeldTextsState, id: string, news: Heard): HeldTextsState {
  return { ...state, heard: new Map(state.heard).set(id, { ...state.heard.get(id), ...news }) };
}

function forget(state: HeldTextsState, id: string): HeldTextsState {
  if (!state.heard.has(id)) return state;
  const heard = new Map(state.heard);
  heard.delete(id);
  return { ...state, heard };
}

/** The state once `event` is heard (the same object when it changes nothing). */
export function heldTextsAfter(state: HeldTextsState, event: HeldTextsEvent): HeldTextsState {
  switch (event.type) {
    case 'account':
      return event.accountId === state.accountId
        ? state
        : { ...state, accountId: event.accountId, heard: new Map() };
    case 'refused':
      if (event.accountId !== state.accountId || state.gone.has(event.boxId)) return state;
      return hear(state, event.boxId, {
        accountId: event.accountId,
        refusal: { reason: event.reason, stale: event.stale, restricted: event.restricted },
      });
    case 'left':
      if (event.accountId !== state.accountId) return state;
      // No write, and its place takes it still: the box went for another reason (the page going,
      // its account switching) — nothing to hold, as a box closed.
      if (event.write === 'none' && event.goneReason === undefined) {
        return heldTextsAfter(state, { type: 'dropped', boxId: event.boxId });
      }
      return hear(state, event.boxId, {
        accountId: event.accountId,
        text: event.text,
        place: event.place,
        goneReason: event.goneReason,
        focus: event.focus,
        write: event.write,
      });
    case 'landed':
      return forget(state, event.boxId);
    case 'dropped': {
      const gone = new Set(state.gone).add(event.boxId);
      return { ...forget(state, event.boxId), gone };
    }
    case 'mounted': {
      if (!state.gone.has(event.boxId)) return state;
      const gone = new Set(state.gone);
      gone.delete(event.boxId);
      return { ...state, gone };
    }
    case 'hold': {
      if (event.accountId !== state.accountId || event.texts.length === 0) return state;
      const heard = new Map(state.heard);
      for (const { id, place, reason, text } of event.texts) {
        // The server's words for why, already: the place is what it is about.
        heard.set(id, {
          accountId: event.accountId,
          refusal: { reason, stale: true },
          text,
          place,
        });
      }
      return { ...state, heard };
    }
    case 'dismiss':
      return forget(state, event.id);
    case 'reason': {
      const one = state.heard.get(event.id);
      // Only a text shown, and only to say something else: the same words again are no news.
      if (one === undefined || one.accountId !== state.accountId) return state;
      const now = reasonOf(one);
      if (now === undefined || now === event.reason) return state;
      // The server's words for why, as a draft held: new news, so read out as it is drawn again —
      // and never taking the focus, which the reader has on the button that read the 대댓글.
      return {
        ...state,
        heard: new Map(state.heard).set(event.id, {
          ...one,
          refusal: { reason: event.reason, stale: true },
          focus: false,
          shown: false,
        }),
      };
    }
    case 'shown': {
      let heard: Map<string, Heard> | undefined;
      for (const id of event.ids) {
        const one = (heard ?? state.heard).get(id);
        if (one === undefined || one.shown === true) continue;
        heard ??= new Map(state.heard);
        heard.set(id, { ...one, shown: true });
      }
      return heard === undefined ? state : { ...state, heard };
    }
    case 'post-gone':
      return state.postGone ? state : { ...state, postGone: true };
  }
}

/**
 * The texts to show, in the order they were first heard: each with a reason, a text and a place,
 * of the account on screen. A box whose write was in flight or refused is shown once its refusal is
 * heard: its reason is the refusal's words when they were about the thread on screen being out of
 * date (`isStaleThreadRefusal`); a refusal about something else — the network, a limit — is not why
 * the box went, so the text says why its place took it no more as it went (`goneBoxReason`), and
 * the refusal's words only when nothing there says. A box with no write is shown at once with why
 * its place took it no more (오너 결정 2026-10-21 답 2). A text whose reason is a writing
 * restriction's refusal (#185) says so (`restricted`): the way to 조치·신고 내역 goes under it, as
 * under the box's own refusal (ADR-0082 7-6).
 */
export function heldTextsOf(state: HeldTextsState): HeldText[] {
  return [...state.heard].flatMap(([id, heard]): HeldText[] => {
    const { text, place } = heard;
    if (text === undefined || place === undefined) return [];
    if (heard.accountId !== state.accountId) return [];
    const reason = reasonOf(heard);
    if (reason === undefined) return [];
    const { refusal } = heard;
    const restricted =
      refusal?.restricted === true && (refusal.stale || heard.goneReason === undefined);
    return [
      {
        id,
        place,
        reason,
        ...(restricted ? { restricted: true as const } : {}),
        text,
        focus: heard.focus === true,
        shown: heard.shown === true,
      },
    ];
  });
}

/** Why the text heard is shown (`heldTextsOf`), or nothing while it is not (yet) shown. */
function reasonOf(heard: Heard): string | undefined {
  const { refusal, text, place, goneReason } = heard;
  if (text === undefined || place === undefined) return undefined;
  return refusal === undefined
    ? heard.write === 'none'
      ? goneReason
      : undefined
    : refusal.stale
      ? refusal.reason
      : (goneReason ?? refusal.reason);
}

/** A text on its way to be shown (`heldTextsAwaitingOf`): the box's id, its place and its text. */
export interface AwaitingText {
  id: string;
  place: HeldTextPlace;
  text: string;
}

/**
 * The texts of the account on screen still on their way, in the order they were first heard: a box
 * went with its write in flight, and neither its refusal nor its landing is heard yet. Not shown
 * (`heldTextsOf`) — but the section's all the same: the account on screen turning to another in
 * place starts the rules afresh (`account`), and the refusal heard after it, the writer's, is not
 * heard, so the section keeps these as the writer's drafts as it turns (`keepSectionTextsForTurn`,
 * ADR-0092 8-26).
 */
export function heldTextsAwaitingOf(state: HeldTextsState): AwaitingText[] {
  return [...state.heard].flatMap(([id, heard]): AwaitingText[] => {
    const { text, place } = heard;
    if (text === undefined || place === undefined) return [];
    if (heard.accountId !== state.accountId) return [];
    if (heard.refusal !== undefined || heard.write !== 'pending') return [];
    return [{ id, place, text }];
  });
}

/**
 * Whether a text of the account on screen is still on its way (`heldTextsAwaitingOf`). The post
 * page holds off its 404 for it as for a text shown (오너 결정 2026-10-21 답 1): the refusal is a
 * moment away, and the text with it.
 */
export function heldTextsAwaiting(state: HeldTextsState): boolean {
  return heldTextsAwaitingOf(state).length > 0;
}

/**
 * Whether the post page, its post gone from every view, may go to its 404 (오너 결정 2026-10-21
 * 답 1): the post's going is heard — after the boxes that went with it told theirs — and no text
 * of the account on screen is shown or on its way.
 */
export function pageMayGo(state: HeldTextsState): boolean {
  return state.postGone && heldTextsOf(state).length === 0 && !heldTextsAwaiting(state);
}
