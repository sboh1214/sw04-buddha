import { type HeldText, type HeldTextPlace } from './comments';

/**
 * The texts a post page's comment section holds apart from any box (오너 결정 2026-10-20 답 4,
 * ADR-0074 7-25), as a pure state machine over what the section hears — so every order the news
 * can arrive in is a unit test (held-comment-texts.test.ts), and components/post/held-comment-text.tsx
 * is the hook around it.
 *
 * A box tells the section how its write ended and how it went (hooks/use-comment-draft.ts,
 * `CommentBoxGoing`): `refused` with the refusal's words, `left` with the text it held as it went
 * while its write was in flight or refused, `landed`, `dropped` when it went with nothing to hold
 * (closed, its write landed, its text kept for an onboarding step), and `mounted` again (React's
 * development check unmounts and mounts a box at once). The refusal and the box going arrive in
 * either order; a text is shown once both have, and until the writer closes it (`dismiss`) — or
 * the box's write lands after all. Drafts taken back after a step that no box can take are held
 * as they are (`hold`), with the server's words for why.
 *
 * Each text is its writer's: the section is told who is on screen (`account`), and another account
 * — a sign-out or a sign-in in another tab of this browser, seen by SessionCacheGuard — starts it
 * afresh, as the drafts kept in the tab are only ever their writer's (lib/comment-drafts.ts). A box
 * that goes because of that switch, or a write refused after it, tells it of the account it was
 * written by, and is not heard.
 */

/** What the section has heard of one box, or of a draft taken back. */
interface Heard {
  /** Who wrote it. */
  accountId: string;
  /** The box's write was refused in these words; `stale`: they say the thread on screen is out of date. */
  refusal?: { reason: string; stale: boolean };
  /** The box went holding this text, from this place. */
  text?: string;
  place?: HeldTextPlace;
  /** Why its place took it no more as the box went (`goneBoxReason`), if it did not. */
  goneReason?: string;
  /** The focus was in the box as it went. */
  focus?: boolean;
}

export interface HeldTextsState {
  /** The account on screen, the only one whose texts are kept; undefined: none (yet). */
  accountId: string | undefined;
  heard: ReadonlyMap<string, Heard>;
  /** Boxes that went with nothing to hold: a refusal of their write arriving later is not shown. */
  gone: ReadonlySet<string>;
}

export type HeldTextsEvent =
  | { type: 'account'; accountId: string | undefined }
  | { type: 'refused'; boxId: string; accountId: string; reason: string; stale: boolean }
  | {
      type: 'left';
      boxId: string;
      accountId: string;
      text: string;
      place: HeldTextPlace;
      /** `goneBoxReason` of its place as the thread read when it went. */
      goneReason: string | undefined;
      focus: boolean;
    }
  | { type: 'landed'; boxId: string }
  | { type: 'dropped'; boxId: string }
  | { type: 'mounted'; boxId: string }
  | {
      type: 'hold';
      accountId: string;
      texts: readonly { id: string; place: HeldTextPlace; reason: string; text: string }[];
    }
  | { type: 'dismiss'; id: string };

export function initialHeldTexts(accountId: string | undefined): HeldTextsState {
  return { accountId, heard: new Map(), gone: new Set() };
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
        refusal: { reason: event.reason, stale: event.stale },
      });
    case 'left':
      if (event.accountId !== state.accountId) return state;
      return hear(state, event.boxId, {
        accountId: event.accountId,
        text: event.text,
        place: event.place,
        goneReason: event.goneReason,
        focus: event.focus,
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
  }
}

/**
 * The texts to show, in the order they were first heard: each with a refusal, a text and a place,
 * of the account on screen. Its reason is the refusal's words when they were about the thread on
 * screen being out of date (`isStaleThreadRefusal`); a refusal about something else — the network,
 * a limit — is not why the box went, so the text says why its place took it no more as it went
 * (`goneBoxReason`), and the refusal's words only when nothing there says.
 */
export function heldTextsOf(state: HeldTextsState): HeldText[] {
  return [...state.heard].flatMap(([id, heard]): HeldText[] => {
    const { refusal, text, place } = heard;
    if (refusal === undefined || text === undefined || place === undefined) return [];
    if (heard.accountId !== state.accountId) return [];
    const reason = refusal.stale ? refusal.reason : (heard.goneReason ?? refusal.reason);
    return [{ id, place, reason, text, focus: heard.focus === true }];
  });
}
