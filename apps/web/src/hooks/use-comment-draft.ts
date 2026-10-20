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
  type HeldText,
  type HeldTextPlace,
  commentDraftKeyOfPlace,
  commentTextChanged,
  commentWriteErrorMessage,
  isStaleThreadRefusal,
} from '@/lib/comments';

/**
 * What the comment section does with a box that goes (components/post/held-comment-text.tsx, rules
 * in lib/held-comment-texts.ts): a box whose write was refused and which went — the thread read
 * again after the refusal no longer holds it — is shown there, its text with why it cannot be
 * sent, until the writer closes it (오너 결정 2026-10-20 답 4). The refusal and the box going arrive
 * in either order. Each names the account that wrote it: only the account on screen's is heard.
 */
export interface CommentBoxGoing {
  /**
   * The box's write was refused, in these words; `stale`: they say the thread on screen is out of
   * date (`isStaleThreadRefusal`).
   */
  refused(boxId: string, accountId: string, refusal: { reason: string; stale: boolean }): void;
  /**
   * The box went holding `text` while its write was in flight or refused; `focus`: the focus was
   * in it as it went.
   */
  left(boxId: string, accountId: string, text: string, place: HeldTextPlace, focus: boolean): void;
  /** The box's write landed: nothing of it is held. */
  landed(boxId: string): void;
  /**
   * The box went with nothing to hold: closed (취소), its write landed, its text kept for a step,
   * nothing other than it started with — or no write of it in flight or refused: a box that goes
   * because its thread or its post changed under it, a 답글 whose 댓글 was deleted elsewhere, say,
   * drops its text unasked (`commentBoxLeaves`; a question for the owner, ADR-0074 결과 4).
   */
  dropped(boxId: string): void;
  /**
   * The box is mounted — again, after React's development check unmounts and remounts it at once:
   * it is not gone.
   */
  mounted(boxId: string): void;
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
 * as the cache holds it now: keeps its text in this tab when the page is going to a step left
 * (`shouldKeepCommentDraft`), for that account only. A write of the box that landed after that
 * render counts as saved (`commentDraftLandedSince`). Whether it kept it.
 */
export function keepHeldCommentDraft(
  last: CommentBoxDraft & { moment: number },
  me: Me | undefined,
): boolean {
  if (me?.id !== last.accountId) return false;
  const saved = commentDraftLandedSince(last.key, last.moment);
  if (
    !shouldKeepCommentDraft({
      hasDraft: commentTextChanged(last.text, last.initial),
      saved,
      onboarding: me.onboarding,
    })
  ) {
    return false;
  }
  return keepSessionCommentDraft(last.key, last.accountId, last.text);
}

/**
 * What a box going away leaves the section (`last` as of its last render, `me` as the cache holds
 * `GET /me` now): nothing (`dropped`) when the writer closed it, a write of it landed since, its
 * text is kept for an onboarding step (`keepHeldCommentDraft`, which keeps it), it holds nothing
 * other than it started with, or no write of it is in flight or refused; else its text (`left`),
 * which the section shows once the refusal is heard (오너 결정 2026-10-20 답 2·4). A box with text
 * and no write that goes because its thread or its post changed under it drops its text too — a
 * question for the owner (ADR-0074 결과 4).
 */
export function commentBoxLeaves(last: GoingCommentBox, me: Me | undefined): 'dropped' | 'left' {
  if (last.closed || commentDraftLandedSince(last.key, last.moment)) return 'dropped';
  if (keepHeldCommentDraft(last, me)) return 'dropped';
  if (!(last.pending || last.refused) || !commentTextChanged(last.text, last.initial)) {
    return 'dropped';
  }
  return 'left';
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
export function keepSectionTextsForStep(
  section: {
    postId: string;
    accountId: string | undefined;
    held: readonly HeldText[];
    drafts: CommentDrafts;
  },
  me: Me | undefined,
): boolean {
  const { accountId, held, drafts } = section;
  if (accountId === undefined || me?.id !== accountId) return false;
  if (!shouldKeepCommentDraft({ hasDraft: true, saved: false, onboarding: me.onboarding })) {
    return false;
  }
  const postId = section.postId.toLowerCase();
  let kept = false;
  const keep = (key: CommentDraftKey, text: string) => {
    if (keepSessionCommentDraft(key, accountId, text)) kept = true;
  };
  if (drafts.comment !== undefined) keep({ kind: 'comment', postId }, drafts.comment);
  for (const [parentId, text] of drafts.replies) keep({ kind: 'reply', postId, parentId }, text);
  for (const [commentId, text] of drafts.edits) keep({ kind: 'edit', postId, commentId }, text);
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
 * A comment box's text on its way out (오너 결정 2026-10-20, ADR-0074):
 * - Leaving the page with text other than the box started with asks first (답 1, `useLeaveGuard`,
 *   the post form's sentence) — not while its write is in flight: the text is the server's then.
 * - Going while the page goes to an onboarding step keeps the text in this tab (답 2,
 *   `keepHeldCommentDraft`), and the post page takes it back after the step. The box going is what
 *   decides, with what it held at its last render and what `['me']` says now, as a post form's
 *   (hooks/use-post-draft.ts).
 * - Going otherwise while its write is in flight or refused hands its text to the section, which
 *   shows it with why it cannot be sent until the writer closes it (답 4, `CommentBoxGoing`).
 * - Going with no write in flight or refused — its thread or post changed under it — keeps
 *   nothing (`commentBoxLeaves`): a question for the owner (ADR-0074 결과 4).
 *
 * The box tells it how its write ended — `landed` and `refused(error)`, from the write's promise,
 * which settles whether or not the box is still there — and `close` is the writer's 취소: the box
 * goes holding nothing. `rootRef` goes on the box's outermost element: the section moves the focus
 * to a text the box left only if the focus was in the box as it went (ADR-0074 7-25).
 */
export function useCommentBoxDraft(box: CommentBoxDraft): {
  landed: () => void;
  refused: (error: unknown) => void;
  close: () => void;
  rootRef: CommentBoxRootRef;
} {
  const queryClient = useQueryClient();
  const going = useContext(CommentBoxGoingContext);
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
  // the box's elements out of the page — the cleanup below, a passive effect's, runs after.
  const element = useRef<HTMLDivElement | null>(null);
  const focusWasInside = useRef(false);
  const focusAsItWent = useRef(false);
  const rootRef = useCallback<CommentBoxRootRef>((root) => {
    if (root === null) return;
    element.current = root;
    const focusIn = () => {
      focusWasInside.current = true;
    };
    const focusOut = (event: FocusEvent) => {
      // Gone to an element outside the box: no longer the box's. Gone nowhere (the page, the
      // window): still the last place it was.
      const next = event.relatedTarget;
      if (next instanceof Node && !root.contains(next)) focusWasInside.current = false;
    };
    root.addEventListener('focusin', focusIn);
    root.addEventListener('focusout', focusOut);
    return () => {
      root.removeEventListener('focusin', focusIn);
      root.removeEventListener('focusout', focusOut);
    };
  }, []);
  useLayoutEffect(
    () => () => {
      const root = element.current;
      const active = document.activeElement;
      focusAsItWent.current =
        root !== null &&
        (root.contains(active) ||
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
      if (commentBoxLeaves(last, queryClient.getQueryData<Me>(ME_QUERY_KEY)) === 'dropped') {
        going?.dropped(boxId);
      } else {
        going?.left(boxId, last.accountId, last.text, last.place, focusAsItWent.current);
      }
    };
  }, [boxId, queryClient, going]);
  const write = box.key.kind === 'edit' ? 'edit' : 'create';
  return {
    landed: () => going?.landed(boxId),
    refused: (error) =>
      going?.refused(boxId, box.accountId, {
        reason: commentWriteErrorMessage(error, write),
        stale: isStaleThreadRefusal(error),
      }),
    close: () => {
      const last = held.get(boxId);
      if (last !== undefined) held.set(boxId, { ...last, closed: true });
    },
    rootRef,
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
 * lib/comment-drafts.ts), taken back once `GET /me` names the account and no step is left — read
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
  useEffect(() => {
    if (state.reads === said.current) return;
    said.current = state.reads;
    clearSessionCommentDrafts(id);
    toaster.create({ type: 'info', title: copy.commentDraftRestored });
  }, [state.reads, id]);
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
