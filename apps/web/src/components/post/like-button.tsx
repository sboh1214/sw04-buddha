'use client';

import {
  Button,
  Popover,
  Portal,
  Stack,
  Text,
  VisuallyHidden,
  type ButtonProps,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { forwardRef, useId, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useLike } from '@/hooks/use-likes';
import {
  type LikeButtonView,
  type LikeTarget,
  likeButtonView,
  likeCountText,
  likeFailureMessage,
  likePressAction,
} from '@/lib/likes';
import { loginPathBackTo } from '@/lib/next-path';
import { postPath } from '@/lib/posts';

/**
 * 좋아요 on the post page (#49, ADR-0076): the toggle beside the post (`target.kind` 'post') and
 * beside each 댓글 and 대댓글 ('comment'), with the count in it ('좋아요 N').
 *
 * The count is public and comes from the post or the comment the page holds, so the server's HTML
 * has it for every reader; whether the reader liked it is theirs alone and is decided in the
 * browser (`useLike`, the one `GET /me/likes/posts/:postId` of the page). Every rung is
 * `likeButtonView` and every press `likePressAction` (lib/likes.ts); this component draws and
 * dispatches them. A toggle button: `aria-pressed` says whether the reader likes it and the name
 * stays '좋아요 N' either way (WAI-ARIA APG, as the watch button), with the heart filled and the
 * brand tint repeating the state for the eye — colour never carries it alone (PLAN 11.2).
 *
 * A visitor's press opens a small prompt: one sentence and 로그인, which comes back to this post
 * (`loginPathBackTo`, the comment box's way back). Nothing is remembered for after the login; the
 * reader presses again. The button is one element on every rung — the server's HTML and the
 * hydrating render are the pending rung, and a visitor's turns into the signed-out one once the
 * session answers, so a button that changed its element there would drop the keyboard focus a
 * visitor already put on it. The prompt therefore hangs beside the button rather than wrapping it
 * (no `Popover.Trigger`, whose popup attributes a member's toggle must not carry): the popover is
 * told the button is its trigger (`ids.trigger`), which places it, keeps a press of the button
 * from counting as a press outside, and gives the focus back to it on closing; the button carries
 * the popup's attributes on the signed-out rung only.
 *
 * A member's press moves the toggle and the count at once (`updateLikeOptions`), and a failure
 * puts both back with a toast saying which change did not happen. The toast is raised from the
 * write's promise, not from a per-call callback: a refusal that the comment was hidden or deleted
 * reads the thread again before the mutation settles, which takes this button away with the
 * observer such callbacks ride on (ADR-0074's lesson).
 */
export function LikeButton({
  postId,
  target,
  count,
}: {
  postId: string;
  target: LikeTarget;
  /** The public count of the post or the comment, as the page holds it. */
  count: number;
}) {
  const like = useLike(postId, target);
  const view = likeButtonView({
    sessionPending: like.sessionPending,
    signedIn: like.signedIn,
    mine: like.mine,
    saving: like.toggle.isPending,
  });
  const look = target.kind === 'post' ? POST_LOOK : COMMENT_LOOK;
  const testId = target.kind === 'post' ? 'post-like' : 'comment-like';
  const id = useId();
  const ids = {
    button: `${id}-like`,
    prompt: `${id}-prompt`,
    promptText: `${id}-prompt-text`,
    reason: `${id}-reason`,
  };
  const [promptOpen, setPromptOpen] = useState(false);
  const signedOut = view.kind === 'signed-out';
  // The prompt belongs to the signed-out rung: a session that arrived meanwhile closes it, and a
  // later sign-out does not find it open again.
  if (!signedOut && promptOpen) setPromptOpen(false);

  const press = () => {
    if (signedOut) {
      setPromptOpen((open) => !open);
      return;
    }
    if (view.kind !== 'toggle') return;
    const action = likePressAction(view.press);
    if (action === null) return;
    // The toggle is drawn only once the session named the account.
    const accountId = like.accountId;
    if (accountId === undefined) return;
    const { liked } = action;
    void like.toggle
      .mutateAsync({ target, liked, expectedAccountId: accountId })
      .catch((error: unknown) => {
        toaster.create({ type: 'error', title: likeFailureMessage(error, target.kind, liked) });
      });
  };

  return (
    <>
      <LikeToggle
        id={ids.button}
        view={view}
        count={count}
        look={look}
        onClick={press}
        data-testid={testId}
        aria-haspopup={signedOut ? 'dialog' : undefined}
        aria-expanded={signedOut ? promptOpen : undefined}
        aria-controls={signedOut && promptOpen ? ids.prompt : undefined}
        // Why it cannot be pressed (ADR-0076 7-15): the tooltip for the pointer, the description
        // for a screen reader — every button of the page is on this rung at once, so no toast.
        aria-describedby={view.kind === 'unavailable' ? ids.reason : undefined}
        title={view.kind === 'unavailable' ? copy.likeMineUnavailable : undefined}
      />
      {view.kind === 'unavailable' && (
        <VisuallyHidden id={ids.reason}>{copy.likeMineUnavailable}</VisuallyHidden>
      )}
      {signedOut && (
        <Popover.Root
          open={promptOpen}
          onOpenChange={(details) => setPromptOpen(details.open)}
          ids={{ trigger: ids.button, content: ids.prompt }}
          lazyMount
          unmountOnExit
          positioning={{ placement: 'bottom-start' }}
        >
          <Portal>
            <Popover.Positioner>
              {/* Named by its sentence: the popover links a title only when it is in the page
                  as the popover starts, and this content mounts on opening (lazyMount). */}
              <Popover.Content
                maxW="min(20rem, calc(100vw - 2rem))"
                aria-labelledby={ids.promptText}
                data-testid="like-sign-in"
              >
                <Popover.Arrow>
                  <Popover.ArrowTip />
                </Popover.Arrow>
                <Popover.Body>
                  <Stack gap="3" align="flex-start">
                    <Text id={ids.promptText} textStyle="bodySm">
                      {copy.likeSignInPrompt}
                    </Text>
                    <Button asChild size="sm" variant="outline">
                      <NextLink
                        href={loginPathBackTo(postPath(postId)) as Route}
                        data-testid="like-sign-in-login"
                      >
                        {copy.login}
                      </NextLink>
                    </Button>
                  </Stack>
                </Popover.Body>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
      )}
    </>
  );
}

/**
 * The post's toggle stands alone under the text, the watch button's pill (its props in its order:
 * Chakra memoises a style set's CSS under its keys, see post-card.tsx); the comment's sits in its
 * row of actions and looks like 답글 beside it.
 */
const POST_LOOK = {
  size: 'sm',
  h: '32px',
  px: '3',
  borderRadius: 'pill',
  textStyle: 'emphasisSm',
} as const;
const COMMENT_LOOK = { size: 'xs', variant: 'ghost' } as const;

type LikeToggleProps = ButtonProps & {
  view: LikeButtonView;
  count: number;
  look: typeof POST_LOOK | typeof COMMENT_LOOK;
};

/**
 * The button itself, on every rung. Not `disabled` while a press is on the wire or while the
 * reader's state is read: a disabled button drops the keyboard focus it holds. The press waits
 * instead (`likePressAction`'s `wait`, and `LikeButton` sends nothing off the toggle rung), and
 * `aria-busy` says so. Only when the reader's likes could not be read is it `aria-disabled` (still
 * focusable). A ref and the rest of the props go through (the sign-in prompt's attributes).
 */
const LikeToggle = forwardRef<HTMLButtonElement, LikeToggleProps>(function LikeToggle(
  { view, count, look, ...rest },
  ref,
) {
  const pressed = view.kind === 'toggle' && view.pressed;
  const busy = view.kind === 'pending' || (view.kind === 'toggle' && view.press === 'wait');
  const variant = 'variant' in look ? look.variant : pressed ? 'subtle' : 'outline';
  return (
    <Button
      ref={ref}
      {...look}
      variant={variant}
      colorPalette={pressed ? 'brand' : 'gray'}
      aria-pressed={view.kind === 'toggle' ? pressed : undefined}
      aria-busy={busy ? true : undefined}
      aria-disabled={view.kind === 'unavailable' ? true : undefined}
      data-view={view.kind}
      {...rest}
    >
      <HeartIcon filled={pressed} />
      {likeCountText(count)}
    </Button>
  );
});

/** The repo draws its own icons (watch-button.tsx); the label beside it carries the name. */
function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.6 4.5 7.1 4.5c2 0 3.6 1.1 4.9 2.9 1.3-1.8 2.9-2.9 4.9-2.9 3.5 0 5.6 3.5 4.4 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" />
    </svg>
  );
}
