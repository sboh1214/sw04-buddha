'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type RefCallback,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useLeaveGuard } from '@/hooks/use-leave-guard';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type Me } from '@/lib/api';
import {
  type CommentDraftKey,
  type CommentDrafts,
  NO_COMMENT_DRAFTS,
  clearSessionCommentDrafts,
  commentDraftLandedSince,
  commentDraftMoment,
  hasCommentDrafts,
  keepSessionCommentDraft,
  mergeCommentDrafts,
  readSessionCommentDrafts,
  shouldKeepCommentDraft,
  withoutCommentDrafts,
} from '@/lib/comment-drafts';
import {
  type CommentBoxRefusal,
  type HeldText,
  type HeldTextPlace,
  commentBoxRefusal,
  commentDraftKeyOfPlace,
  commentTextChanged,
} from '@/lib/comments';
import { type AwaitingText, type GoingBoxWrite } from '@/lib/held-comment-texts';

/**
 * What the comment section does with a box that goes (components/post/held-comment-text.tsx, rules
 * in lib/held-comment-texts.ts): a box whose write was refused and which went — the thread read
 * again after the refusal no longer holds it — is shown there, its text with why it cannot be
 * sent, until the writer closes it (오너 결정 2026-10-20 답 4); so is a box with text and no write
 * that went because its place took it no more (오너 결정 2026-10-21 답 2). The refusal and the box
 * going arrive in either order. Each names the account that wrote it: only the account on screen's
 * is heard.
 */
export interface CommentBoxGoing {
  /**
   * The box's write was refused (`commentBoxRefusal`): in these words; `stale`, they say the thread
   * on screen is out of date (`isStaleThreadRefusal`); `restricted`, a writing restriction refused
   * it (`isRestricted`, #185 — the way to 조치·신고 내역 goes under its words wherever they are
   * shown).
   */
  refused(boxId: string, accountId: string, refusal: CommentBoxRefusal): void;
  /**
   * The box went holding `text` other than it started with, its write as `write` says (in flight,
   * refused, or none); `focus`: the focus was in it as it went.
   */
  left(
    boxId: string,
    accountId: string,
    text: string,
    place: HeldTextPlace,
    focus: boolean,
    write: GoingBoxWrite,
  ): void;
  /** The box's write landed: nothing of it is held. */
  landed(boxId: string): void;
  /**
   * The box went with nothing to hold: closed (취소 — asked first when it held a changed text,
   * 오너 결정 2026-10-21 답 3), its write landed, its text kept for a step, or nothing other than it
   * started with (`commentBoxLeaves`).
   */
  dropped(boxId: string): void;
  /**
   * The box is mounted — again, after React's development check unmounts and remounts it at once:
   * it is not gone.
   */
  mounted(boxId: string): void;
  /**
   * The place a box stood in takes it no more, as the section last drew the post and its threads
   * (`goneBoxReason`): asked by a box as it goes, before anything of it is kept for a step
   * (`commentBoxLeaves`). A box the page takes away as it goes still had its place.
   */
  placeGone(place: HeldTextPlace): boolean;
}

/** The section's `CommentBoxGoing`, for every box under it; none outside a section. */
export const CommentBoxGoingContext = createContext<CommentBoxGoing | null>(null);

/** A box as of its last render. */
export interface CommentBoxDraft {
  /** Where an onboarding step keeps its text (lib/comment-drafts.ts). */
  key: CommentDraftKey;
  /** The account on screen, the text's writer. */
  accountId: string;
  text: string;
  /** What the box started with: '' for a new comment, the comment's text for an edit. */
  initial: string;
  /** Its write is in flight. */
  pending: boolean;
  /** Its last write was refused, and it says so. */
  refused: boolean;
  /** Where it stands, so text it leaves is shown there. */
  place: HeldTextPlace;
}

/** A box as of its last render, as it goes. */
export interface GoingCommentBox extends CommentBoxDraft {
  /** A `commentDraftMoment` taken when the render was committed. */
  moment: number;
  /** The writer closed it (취소): nothing of it is kept or held. */
  closed: boolean;
}

/** Each mounted box as of its last render, by box. */
const held = new Map<string, GoingCommentBox>();

/**
 * What a box going away does with `last`, its state as of its last render, given `me` — `GET /me`
 * as the cache holds it now: keeps its text in this tab, for its writer only, when `me` names a
 * step left of the writer — the page going to that step, or going any other way while it is left
 * (ADR-0074 7-23·7-24) — or when `me` is another account: the account on screen turned from the
 * writer to another in place, and the section draws its boxes for the account on screen
 * (`accountTurned`, `shouldKeepCommentDraft`; ADR-0092, 오너 결정 2026-10-26 17:21 답 3). `me`
 * absent — SessionCacheGuard's reset, a sign-out — keeps nothing. A write of the box that landed
 * after that render counts as saved (`commentDraftLandedSince` — a write that account sent).
 * Whether it kept it. A box of the writer still on screen keeps it only when its place took it still
 * as it went (`commentBoxLeaves`): one the page took away in place is shown apart instead.
 */
export function keepHeldCommentDraft(
  last: CommentBoxDraft & { moment: number },
  me: Me | undefined,
): boolean {
  if (me === undefined) return false;
  const accountTurned = me.id !== last.accountId;
  const saved = commentDraftLandedSince(last.key, last.accountId, last.moment);
  if (
    !shouldKeepCommentDraft({
      hasDraft: commentTextChanged(last.text, last.initial),
      saved,
      // Another account's steps are not the writer's.
      onboarding: accountTurned ? undefined : me.onboarding,
      accountTurned,
    })
  ) {
    return false;
  }
  return keepSessionCommentDraft(last.key, last.accountId, last.text);
}

/**
 * What a box going away leaves the section (`last` as of its last render; `me`, `GET /me` as the
 * cache holds it now; `placeGone`, its place takes it no more as the section last drew the page —
 * `CommentBoxGoing.placeGone`): nothing (`dropped`) when the writer closed it, a write of it landed
 * since, it holds nothing other than it started with, or — its place taking it still, so the page
 * itself is going — its text is kept for an onboarding step (`keepHeldCommentDraft`, which keeps
 * it); else its text, with how its write stood — in flight (`pending`), refused (`refused`), or none
 * (`none`). The section shows a text whose write was in flight or refused once the refusal is heard
 * (오너 결정 2026-10-20 답 2·4), and one with no write at once when its place takes it no more — the
 * thread or the post changed under it (오너 결정 2026-10-21 답 2) — and drops it when its place
 * takes it still (the page going, say).
 *
 * A box the page took away in place is shown apart even while a step is left (a re-consent's
 * account stays on the post page, 7-23): the read that took it is no leaving, and its text is never
 * both shown and kept — the section keeps what it shows when the page does go to the step
 * (`keepSectionTextsForStep`), and a text the writer closed before does not come back after it.
 *
 * A box that goes because the account on screen turned from its writer to another in place — `me`
 * another account: the section draws its boxes for the account on screen (ADR-0092, 오너 결정
 * 2026-10-26 17:21 답 3) — leaves the section nothing: the text is the writer's, who is not on
 * screen, and is kept as the writer's draft (`keepHeldCommentDraft`), its write in flight or
 * refused or none, whatever its place says — back on the post page, the writer gets it in its box,
 * or apart with why its place takes it no more (`resolveCommentDrafts`). The section, told of the
 * other account in the same render, would not hear it anyway (lib/held-comment-texts.ts).
 */
export function commentBoxLeaves(
  last: GoingCommentBox,
  me: Me | undefined,
  placeGone: boolean,
): 'dropped' | GoingBoxWrite {
  if (last.closed || commentDraftLandedSince(last.key, last.accountId, last.moment))
    return 'dropped';
  if (!commentTextChanged(last.text, last.initial)) return 'dropped';
  if (me !== undefined && me.id !== last.accountId) {
    keepHeldCommentDraft(last, me);
    return 'dropped';
  }
  if (!placeGone && keepHeldCommentDraft(last, me)) return 'dropped';
  return last.pending ? 'pending' : last.refused ? 'refused' : 'none';
}

/**
 * What the comment section keeps as it goes, given `me` — `GET /me` as the cache holds it now: the
 * texts it shows apart from any box (`held`, 답 4) and the drafts taken back after a step that no
 * box has taken yet (`drafts`), each as the draft of the box it stood for
 * (`commentDraftKeyOfPlace`), when the page is going to a step left of the account on screen — as
 * a box's text is (`keepHeldCommentDraft`, 답 2), however the page goes: a write's entry sending it
 * to the step does not ask first, as it loses nothing. Back after the step, the post page shows
 * each again where it can go — its box, or apart with why (`resolveCommentDrafts`). React runs a
 * page's cleanups from the top down, so a box's own text, kept after this, wins over a held text of
 * the same box. Whether it kept any.
 */
export function keepSectionTextsForStep(section: SectionTexts, me: Me | undefined): boolean {
  const { accountId } = section;
  if (accountId === undefined || me?.id !== accountId) return false;
  if (!shouldKeepCommentDraft({ hasDraft: true, saved: false, onboarding: me.onboarding })) {
    return false;
  }
  return keepSectionTexts(section, accountId);
}

/**
 * What the comment section keeps as the account on screen turns from `section.accountId` — whose
 * texts `section` holds, as the section last drew them — to `accountNow`, another account, in place
 * (`['me']` naming another account before the session does, ADR-0090 결정 4-2): the texts it showed
 * apart and the drafts taken back that no box took yet, each as the writer's draft of the box it
 * stood for, as a step keeps them (`keepSectionTextsForStep`) — and the texts still on their way
 * (`awaiting`: a box gone with its write in flight, its refusal not heard yet — the refusal, heard
 * after the turn, is the writer's and is not heard), unless a write of that box landed since the
 * section drew them (`commentDraftLandedSince`; one landing later removes the draft,
 * `commentDraftLanded`). The section, drawn for the account now on screen, holds none of them any
 * more (lib/held-comment-texts.ts starts afresh), and the writer, on screen again, gets each back in
 * its box or apart with why (ADR-0092, 오너 결정 2026-10-26 17:21 답 3 «이 PR에서 함께, 적던 것은 A의
 * 초안으로»). Nothing when nobody was on screen or nobody is now — SessionCacheGuard's reset, a
 * sign-out, a `GET /me` not answered yet — nor for the same account. Run before the boxes the turn
 * takes away keep theirs (a layout effect, before their passive cleanups; or the section's own
 * cleanup, `keepSectionTextsAsItGoes`, which React runs before theirs): a box's own text, kept after
 * this, wins over a held text of the same box, as when the page goes to a step. Whether it kept any.
 */
export function keepSectionTextsForTurn(
  section: SectionTexts,
  accountNow: string | undefined,
): boolean {
  const { accountId } = section;
  if (accountId === undefined || accountNow === undefined || accountNow === accountId) return false;
  let kept = keepSectionTexts(section, accountId);
  const postId = section.postId.toLowerCase();
  for (const { place, text } of section.awaiting) {
    const key = commentDraftKeyOfPlace(postId, place);
    if (commentDraftLandedSince(key, accountId, section.moment)) continue;
    if (keepSessionCommentDraft(key, accountId, text)) kept = true;
  }
  return kept;
}

/**
 * What the comment section keeps as it goes, given `me` — `GET /me` as the cache holds it now: its
 * texts for a step left of the account on screen (`keepSectionTextsForStep`), or — `me` naming
 * another account — as the account on screen turns (`keepSectionTextsForTurn`). The turn's own
 * render can take the section away before ever drawing it for the other account: the onboarding
 * gate puts its placeholder in place of the post page for an account with a first onboarding step
 * left (the page is exempt for a re-consent alone), so the layout effect that keeps them on a turn
 * never runs (ADR-0092 8-26). Whether it kept any.
 */
export function keepSectionTextsAsItGoes(section: SectionTexts, me: Me | undefined): boolean {
  return keepSectionTextsForStep(section, me) || keepSectionTextsForTurn(section, me?.id);
}

/** The texts a comment section holds for the account on screen (`accountId`), as it drew them. */
export interface SectionTexts {
  postId: string;
  accountId: string | undefined;
  held: readonly HeldText[];
  /**
   * The texts on their way to be held (`heldTextsAwaitingOf`): kept as the account turns
   * (`keepSectionTextsForTurn`), not for a step.
   */
  awaiting: readonly AwaitingText[];
  drafts: CommentDrafts;
  /** A `commentDraftMoment` taken as the section drew them. */
  moment: number;
}

/** Keeps `section`'s texts as `accountId`'s drafts of the boxes they stood for. Whether it kept any. */
function keepSectionTexts(section: SectionTexts, accountId: string): boolean {
  const { held, drafts } = section;
  const postId = section.postId.toLowerCase();
  let kept = false;
  const keep = (key: CommentDraftKey, text: string) => {
    if (keepSessionCommentDraft(key, accountId, text)) kept = true;
  };
  if (drafts.comment !== undefined) keep({ kind: 'comment', postId }, drafts.comment);
  for (const [parentId, text] of drafts.replies) keep({ kind: 'reply', postId, parentId }, text);
  for (const [commentId, text] of drafts.edits) {
    keep({ kind: 'edit', postId, commentId, threadId: drafts.editThreads.get(commentId) }, text);
  }
  for (const text of held) keep(commentDraftKeyOfPlace(postId, text.place), text.text);
  return kept;
}

/**
 * The ref for a box's outermost element (`useCommentBoxDraft`), which follows the focus in it: the
 * focus was in the box as it went when it is on it still, or fell to the page with nothing focused
 * since it was last in the box (a pressed button turned busy and disabled may drop it on the way).
 */
export type CommentBoxRootRef = RefCallback<HTMLDivElement>;

/**
 * The ref for the content of the box's own dialog (its 취소's '쓰던 내용 버리기', drawn in a portal
 * outside the box): the focus in it is the box's (ADR-0074 7-25) — a read that takes the box away
 * while it is open takes the dialog with it, and the focus it held goes to the text the box left
 * rather than to the page's start.
 */
export type CommentBoxDialogRef = RefCallback<HTMLDivElement>;

/**
 * A comment box's text on its way out (오너 결정 2026-10-20·21, ADR-0074):
 * - Leaving the page with text other than the box started with asks first (2026-10-20 답 1,
 *   `useLeaveGuard`, the post form's sentence) — not while its write is in flight: the text is the
 *   server's then.
 * - Going while the page goes to an onboarding step keeps the text in this tab (답 2,
 *   `keepHeldCommentDraft`), and the post page takes it back after the step. The box going is what
 *   decides, with what it held at its last render and what `['me']` says now, as a post form's
 *   (hooks/use-post-draft.ts). So does going because `['me']` turned from the writer to another
 *   account in place — the section draws its boxes for the account on screen — for the writer, who
 *   gets it back on the post page (ADR-0092, 오너 결정 2026-10-26 17:21 답 3).
 * - Going otherwise hands its text to the section (`CommentBoxGoing`), which shows it with why it
 *   cannot be sent until the writer closes it: while its write is in flight or refused (답 4), and
 *   with no write when its thread or its post changed under it (2026-10-21 답 2).
 *
 * The box tells it how its write ended — `landed` and `refused(error)`, from the write's promise,
 * which settles whether or not the box is still there — and `close` is the writer's 취소 (asked
 * first by the box when the text changed, 2026-10-21 답 3): the box goes holding nothing. `rootRef`
 * goes on the box's outermost element and `dialogRef` on its own dialog's content: the section
 * moves the focus to a text the box left only if the focus was in the box — or in that dialog — as
 * it went (ADR-0074 7-25).
 */
export function useCommentBoxDraft(box: CommentBoxDraft): {
  landed: () => void;
  refused: (error: unknown) => void;
  close: () => void;
  rootRef: CommentBoxRootRef;
  dialogRef: CommentBoxDialogRef;
} {
  const queryClient = useQueryClient();
  const going = useContext(CommentBoxGoingContext);
  // A writing restriction's refusal (#185) says its end in the member's zone.
  const format = useFormatDateTime();
  // Unique among the boxes mounted in the page's life: a box mounted later gets a new one.
  const boxId = useId();
  useLeaveGuard(!box.pending && commentTextChanged(box.text, box.initial), copy.postLeaveConfirm);
  useEffect(() => {
    held.set(boxId, {
      ...box,
      moment: commentDraftMoment(),
      closed: held.get(boxId)?.closed ?? false,
    });
  });
  // The focus as the box goes: read in a layout effect's cleanup, which React runs before it takes
  // the box's elements out of the page — its dialog's too, portal and all — and the cleanup below,
  // a passive effect's, runs after.
  const element = useRef<HTMLDivElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const focusWasInside = useRef(false);
  const focusAsItWent = useRef(false);
  // The box and its own dialog, as one: the focus moving between them stays the box's.
  const follow = useCallback((target: HTMLDivElement) => {
    const focusIn = () => {
      focusWasInside.current = true;
    };
    const focusOut = (event: FocusEvent) => {
      // Gone to an element outside the box and its dialog: no longer the box's. Gone nowhere (the
      // page, the window): still the last place it was.
      const next = event.relatedTarget;
      if (
        next instanceof Node &&
        element.current?.contains(next) !== true &&
        dialog.current?.contains(next) !== true
      ) {
        focusWasInside.current = false;
      }
    };
    target.addEventListener('focusin', focusIn);
    target.addEventListener('focusout', focusOut);
    return () => {
      target.removeEventListener('focusin', focusIn);
      target.removeEventListener('focusout', focusOut);
    };
  }, []);
  const rootRef = useCallback<CommentBoxRootRef>(
    (root) => {
      if (root === null) return;
      element.current = root;
      return follow(root);
    },
    [follow],
  );
  const unfollowDialog = useRef<(() => void) | null>(null);
  const dialogRef = useCallback<CommentBoxDialogRef>(
    (content) => {
      unfollowDialog.current?.();
      unfollowDialog.current = null;
      if (content === null) return;
      dialog.current = content;
      const unfollow = follow(content);
      const detach = () => {
        unfollow();
        if (dialog.current === content) dialog.current = null;
        if (unfollowDialog.current === detach) unfollowDialog.current = null;
      };
      unfollowDialog.current = detach;
      return detach;
    },
    [follow],
  );
  useLayoutEffect(
    () => () => {
      const root = element.current;
      const active = document.activeElement;
      focusAsItWent.current =
        root !== null &&
        (root.contains(active) ||
          dialog.current?.contains(active) === true ||
          ((active === null || active === document.body) && focusWasInside.current));
    },
    [],
  );
  useEffect(() => {
    going?.mounted(boxId);
    return () => {
      const last = held.get(boxId);
      held.delete(boxId);
      if (last === undefined) return;
      const leaves = commentBoxLeaves(
        last,
        queryClient.getQueryData<Me>(ME_QUERY_KEY),
        going?.placeGone(last.place) ?? false,
      );
      if (leaves === 'dropped') going?.dropped(boxId);
      else going?.left(boxId, last.accountId, last.text, last.place, focusAsItWent.current, leaves);
    };
  }, [boxId, queryClient, going]);
  const write = box.key.kind === 'edit' ? 'edit' : 'create';
  return {
    landed: () => going?.landed(boxId),
    refused: (error) =>
      going?.refused(boxId, box.accountId, commentBoxRefusal(error, write, format)),
    close: () => {
      const last = held.get(boxId);
      if (last !== undefined) held.set(boxId, { ...last, closed: true });
    },
    rootRef,
    dialogRef,
  };
}

/** What `useCommentDraftsTakenBack` holds: the drafts of one post for one account. */
interface TakenBack {
  postId: string;
  accountId: string | undefined;
  /** The account they were read for, or null while not to be read (no account, a step left). */
  readFor: string | null;
  drafts: CommentDrafts;
  /** How many reads found drafts: each is removed from the tab and said once. */
  reads: number;
}

/**
 * The comment drafts an onboarding step kept for this post (오너 결정 2026-10-20 답 2,
 * lib/comment-drafts.ts) — or the account on screen turning away from their writer in place (ADR-0092
 * 답 3) — taken back once `GET /me` names the account and no step is left — read
 * from the tab as the page learns that, then removed from it and said once, in a toast like the
 * app's other notices: the toaster's region is the live region that reads it out, and each box it
 * went into says so beside it. A later read — a step done in another tab while this page stayed
 * open — adds what it finds. `take` drops the ones a box has taken, or that are shown apart;
 * `reads` counts the reads that found some (the section reads the thread again for each before
 * placing them).
 */
export function useCommentDraftsTakenBack(
  postId: string,
  accountId: string | undefined,
  stepLeft: boolean,
): {
  drafts: CommentDrafts;
  take: (keys: readonly CommentDraftKey[]) => void;
  reads: number;
} {
  const id = postId.toLowerCase();
  const readFor = accountId !== undefined && !stepLeft ? accountId : null;
  const [state, setState] = useState<TakenBack>({
    postId: id,
    accountId: undefined,
    readFor: null,
    drafts: NO_COMMENT_DRAFTS,
    reads: 0,
  });
  if (state.postId !== id || state.accountId !== accountId || state.readFor !== readFor) {
    const same = state.postId === id && state.accountId === accountId;
    const read =
      readFor !== null && !(same && state.readFor === readFor)
        ? readSessionCommentDrafts(id, readFor)
        : NO_COMMENT_DRAFTS;
    setState({
      postId: id,
      accountId,
      readFor,
      drafts: mergeCommentDrafts(same ? state.drafts : NO_COMMENT_DRAFTS, read),
      reads: hasCommentDrafts(read) ? state.reads + 1 : state.reads,
    });
  }
  const said = useRef(0);
  // The account the drafts of this read were read for: only its drafts go from the tab — another
  // account's of the post wait there for their writer (ADR-0092 답 3).
  const takenFor = state.readFor;
  useEffect(() => {
    if (state.reads === said.current) return;
    said.current = state.reads;
    if (takenFor !== null) clearSessionCommentDrafts(id, takenFor);
    toaster.create({ type: 'info', title: copy.commentDraftRestored });
  }, [state.reads, id, takenFor]);
  const take = useCallback(
    (keys: readonly CommentDraftKey[]) => {
      setState((current) => {
        const drafts = withoutCommentDrafts(current.drafts, keys);
        return drafts === current.drafts ? current : { ...current, drafts };
      });
    },
    [setState],
  );
  return { drafts: state.drafts, take, reads: state.reads };
}
