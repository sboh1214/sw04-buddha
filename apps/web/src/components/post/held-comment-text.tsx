'use client';

import { Alert, Button, Stack, Textarea } from '@chakra-ui/react';
import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { RestrictedModerationLink } from '@/components/moderation/refusal-text';
import { copy } from '@/copy';
import { type CommentBoxGoing } from '@/hooks/use-comment-draft';
import { type CommentThread } from '@/lib/api';
import {
  type CommentsPostState,
  type HeldText,
  type HeldTextPlace,
  goneBoxReason,
} from '@/lib/comments';
import {
  type GoingBoxWrite,
  heldTextsAfter,
  heldTextsOf,
  initialHeldTexts,
  pageMayGo,
  refusedEvent,
} from '@/lib/held-comment-texts';

/**
 * The texts a comment section holds apart from any box (오너 결정 2026-10-20 답 4 and 2026-10-21
 * 답 2, ADR-0074 7-25), for the account on screen (`accountId`): a box whose write was refused and
 * which went — the refusal and the box going arrive in either order (`going`), and the text is
 * shown once both have — a box with text and no write that went because its place took it no more,
 * and the drafts taken back after an onboarding step that no box can take (`hold`). Each stays
 * until the writer closes it (`dismiss`). The rules are lib/held-comment-texts.ts's; this hook
 * feeds them, and tells each box that goes why its place takes it no more, as `view` — the post and
 * its threads on screen — now reads (`goneBoxReason`) — and, asked by the box before it keeps
 * anything for an onboarding step, whether it does (`placeGone`: a box taken away in place is shown
 * here, a step left or not). A post gone from every view (`postState`
 * 'gone') is told to the rules from an effect, after the boxes that went with it: `pageMayGo` then
 * says when no text is shown or on its way — a box gone with its write in flight hears its refusal
 * a moment later — for the post page's 404 (2026-10-21 답 1).
 */
export function useHeldCommentTexts(
  accountId: string | undefined,
  view: { postState: CommentsPostState; threads: readonly CommentThread[] },
): {
  held: readonly HeldText[];
  pageMayGo: boolean;
  going: CommentBoxGoing;
  hold: (accountId: string, texts: readonly Omit<HeldText, 'focus' | 'shown'>[]) => void;
  dismiss: (id: string) => void;
  /** The held text `id` says `reason` now: why its edit, brought onto the screen, cannot open. */
  reason: (id: string, reason: string) => void;
} {
  const [state, dispatch] = useReducer(heldTextsAfter, accountId, initialHeldTexts);
  // Another account on screen — or none — starts afresh, in this very render: a box this switch
  // takes away tells of the account it was written by, and is not heard (lib/held-comment-texts.ts).
  if (state.accountId !== accountId) dispatch({ type: 'account', accountId });
  // The view as this render drew it, for the boxes this render takes away: a layout effect, so it
  // is in place before their own cleanups (passive effects) run in the same commit.
  const latest = useRef(view);
  useLayoutEffect(() => {
    latest.current = view;
  });
  // Heard after the boxes this render takes away have told theirs: React runs the cleanups of a
  // commit's removed components before the effects of the components it keeps.
  const postGone = view.postState === 'gone';
  useEffect(() => {
    if (postGone) dispatch({ type: 'post-gone' });
  }, [postGone]);

  const actions = useMemo(() => {
    const going: CommentBoxGoing = {
      refused: (boxId, writer, refusal) => dispatch(refusedEvent(boxId, writer, refusal)),
      left: (boxId, writer, text, place: HeldTextPlace, focus, write: GoingBoxWrite) =>
        dispatch({
          type: 'left',
          boxId,
          accountId: writer,
          text,
          place,
          goneReason: goneBoxReason(place, latest.current),
          focus,
          write,
        }),
      landed: (boxId) => dispatch({ type: 'landed', boxId }),
      dropped: (boxId) => dispatch({ type: 'dropped', boxId }),
      mounted: (boxId) => dispatch({ type: 'mounted', boxId }),
      // The same view `left` reads: the box's place as the commit that took it away drew the page.
      placeGone: (place: HeldTextPlace) => goneBoxReason(place, latest.current) !== undefined,
    };
    return {
      going,
      hold: (writer: string, texts: readonly Omit<HeldText, 'focus' | 'shown'>[]) =>
        dispatch({ type: 'hold', accountId: writer, texts }),
      dismiss: (id: string) => dispatch({ type: 'dismiss', id }),
      reason: (id: string, reason: string) => dispatch({ type: 'reason', id, reason }),
    };
  }, []);

  const held = useMemo(() => heldTextsOf(state), [state]);
  // Every text this commit drew for the first time is drawn now: a later mount of it — its place
  // moved, under its comment or at its thread's end — is not new (`HeldCommentText`). From an
  // effect of the section, which React runs after the commit that mounted them all: each held text
  // is drawn somewhere (`placeHeldTexts` leaves none out) — but for an edit's text on its way into
  // its edit's box, which the section leaves out while its 대댓글 is on screen (`drawn` in
  // comments-section.tsx) for the commit or two until that box has it: it was drawn, and marked so,
  // before a read brought its 대댓글, and it is closed once the box has it — or drawn again
  // as it was, should the box not take it.
  useEffect(() => {
    const fresh = held.filter((text) => !text.shown).map((text) => text.id);
    if (fresh.length > 0) dispatch({ type: 'shown', ids: fresh });
  }, [held]);
  return { held, pageMayGo: pageMayGo(state), ...actions };
}

/**
 * Text a comment box held, shown where the box stood (or under the threads, when that place is
 * gone) with why it cannot be sent (오너 결정 2026-10-20 답 4, 2026-10-21 답 2): the reason, the
 * text itself in a read-only box the writer can select and copy from, line breaks and all, and
 * 닫기. Leaving the page while it is shown asks first, as a box with text does
 * (comments-section.tsx) — and a post gone from every view keeps its page, rather than its 404,
 * until every such text is closed (post-screen.tsx, 2026-10-21 답 1).
 *
 * The focus comes here only from the box it stands for (`held.focus`, ADR-0074 7-25): one that held
 * the focus as it went (in the box, or in its own dialog going with it), the focus fallen to the
 * page with it — labelled by the reason, which is read out — and not if the reader has put the
 * focus elsewhere since. Otherwise — a draft taken back after a step, a box the reader had left —
 * the focus stays where it is and the reason is an alert, read out as it appears, as the refusal
 * under a box's button is. Both only the first time the text is drawn: moved — under its comment
 * once a read brings it, back to its thread's end once a read again leaves it out
 * (`placeHeldTexts`) — it is drawn anew in its new place, and then (`held.shown`) its reason is
 * neither read out again nor does it take the focus: nothing new happened to it. An edit's text
 * whose 대댓글 a read brings onto the screen opens in that edit instead, or stays here with a new
 * reason — read out then, as new, whether it moved or not (오너 결정 2026-10-22 (2차) 답 2·(3차)
 * 답 1·3, comments-section.tsx): the reason is drawn anew, in an alert inserted with it, rather than
 * left to a remount that happens to come with the same render.
 */
export function HeldCommentText({ held, onClose }: { held: HeldText; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  // Decided as it first appears — on the client only: a held text is never in the server's HTML.
  const [firstShowing] = useState(() => !held.shown);
  const [takesFocus] = useState(
    () =>
      firstShowing &&
      held.focus &&
      typeof document !== 'undefined' &&
      (document.activeElement === null || document.activeElement === document.body),
  );
  // The reason as drawn, and whether it is read out: as it first appears, unless the focus comes
  // here (its name is the reason). A new reason while drawn — the rules mark it new (`held.shown`
  // false: an edit whose 대댓글, read now, takes no edit, or whose thread ended without it) — is
  // drawn anew as an alert and read out, whether or not the text moved with it; one the rules do
  // not call new is drawn quietly (ADR-0074 7-25).
  const [said, setSaid] = useState(() => ({
    reason: held.reason,
    alert: firstShowing && !takesFocus,
  }));
  if (said.reason !== held.reason) setSaid({ reason: held.reason, alert: !held.shown });
  useEffect(() => {
    if (takesFocus) ref.current?.focus({ preventScroll: false });
  }, [takesFocus]);

  return (
    <Stack
      ref={ref}
      role="group"
      tabIndex={-1}
      aria-labelledby={reasonId}
      gap="2"
      p="3"
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="card"
      bg="surface.card"
      data-testid="comment-held"
    >
      <Alert.Root key={said.reason} status="error" role={said.alert ? 'alert' : undefined}>
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description id={reasonId} data-testid="comment-held-reason">
            {held.reason}
          </Alert.Description>
          {/* Beside the reason, not in it: the reason names the group. */}
          {held.restricted === true && <RestrictedModerationLink />}
        </Alert.Content>
      </Alert.Root>
      <Textarea
        readOnly
        value={held.text}
        aria-label={copy.commentHeldText}
        rows={3}
        data-testid="comment-held-text"
      />
      <Button
        alignSelf="flex-end"
        size="sm"
        variant="outline"
        onClick={onClose}
        data-testid="comment-held-close"
      >
        {copy.close}
      </Button>
    </Stack>
  );
}
