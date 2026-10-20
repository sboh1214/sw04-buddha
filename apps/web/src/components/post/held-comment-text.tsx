'use client';

import { Alert, Button, Stack, Textarea } from '@chakra-ui/react';
import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { copy } from '@/copy';
import { type CommentBoxGoing } from '@/hooks/use-comment-draft';
import { type CommentThread, type Post } from '@/lib/api';
import { type HeldText, type HeldTextPlace, goneBoxReason } from '@/lib/comments';
import { heldTextsAfter, heldTextsOf, initialHeldTexts } from '@/lib/held-comment-texts';

/**
 * The texts a comment section holds apart from any box (오너 결정 2026-10-20 답 4, ADR-0074 7-25),
 * for the account on screen (`accountId`): a box whose write was refused and which went — the
 * refusal and the box going arrive in either order (`going`), and the text is shown once both have
 * — and the drafts taken back after an onboarding step that no box can take (`hold`). Each stays
 * until the writer closes it (`dismiss`). The rules are lib/held-comment-texts.ts's; this hook
 * feeds them, and tells each box that goes why its place takes it no more, as `view` — the post and
 * its threads on screen — now reads (`goneBoxReason`).
 */
export function useHeldCommentTexts(
  accountId: string | undefined,
  view: { postState: Post['state']; threads: readonly CommentThread[] },
): {
  held: readonly HeldText[];
  going: CommentBoxGoing;
  hold: (accountId: string, texts: readonly Omit<HeldText, 'focus'>[]) => void;
  dismiss: (id: string) => void;
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

  const actions = useMemo(() => {
    const going: CommentBoxGoing = {
      refused: (boxId, writer, { reason, stale }) =>
        dispatch({ type: 'refused', boxId, accountId: writer, reason, stale }),
      left: (boxId, writer, text, place: HeldTextPlace, focus) =>
        dispatch({
          type: 'left',
          boxId,
          accountId: writer,
          text,
          place,
          goneReason: goneBoxReason(place, latest.current),
          focus,
        }),
      landed: (boxId) => dispatch({ type: 'landed', boxId }),
      dropped: (boxId) => dispatch({ type: 'dropped', boxId }),
      mounted: (boxId) => dispatch({ type: 'mounted', boxId }),
    };
    return {
      going,
      hold: (writer: string, texts: readonly Omit<HeldText, 'focus'>[]) =>
        dispatch({ type: 'hold', accountId: writer, texts }),
      dismiss: (id: string) => dispatch({ type: 'dismiss', id }),
    };
  }, []);

  const held = useMemo(() => heldTextsOf(state), [state]);
  return { held, ...actions };
}

/**
 * Text a comment box held, shown where the box stood (or under the threads, when that place is
 * gone) with why it cannot be sent (오너 결정 2026-10-20 답 4): the reason, the text itself in a
 * read-only box the writer can select and copy from, line breaks and all, and 닫기. Leaving the
 * page while it is shown asks first, as a box with text does (comments-section.tsx).
 *
 * The focus comes here only from the box it stands for (`held.focus`, ADR-0074 7-25): one that held
 * the focus as it went, the focus fallen to the page with it — labelled by the reason, which is
 * read out — and not if the reader has put the focus elsewhere since. Otherwise — a draft taken
 * back after a step, a box the reader had left — the focus stays where it is and the reason is an
 * alert, read out as it appears, as the refusal under a box's button is.
 */
export function HeldCommentText({ held, onClose }: { held: HeldText; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  // Decided as it first appears — on the client only: a held text is never in the server's HTML.
  const [takesFocus] = useState(
    () =>
      held.focus &&
      typeof document !== 'undefined' &&
      (document.activeElement === null || document.activeElement === document.body),
  );
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
      <Alert.Root status="error" role={takesFocus ? undefined : 'alert'}>
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description id={reasonId} data-testid="comment-held-reason">
            {held.reason}
          </Alert.Description>
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
