'use client';

import { Box, Button, Text, type ButtonProps } from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useLike, useMyLikesUnreadable } from '@/hooks/use-likes';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { useOnboardingEntry } from '@/hooks/use-onboarding-entry';
import type { Me } from '@/lib/api';
import {
  type LikeButtonView,
  type LikeTarget,
  likeButtonView,
  likeCountText,
  likeFailureMessage,
  likePressAction,
  likeRefusalMove,
  likesUnreadableId,
} from '@/lib/likes';
import { loginPathBackTo } from '@/lib/next-path';
import { onboardingEntryPath } from '@/lib/onboarding';
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
 * A visitor's press goes straight to the login page, told to come back to this post
 * (`loginPathBackTo`), as the watch button's does (owner decision 2026-10-20, answer 8); nothing
 * is remembered for after the login, and the reader presses again. A member with an onboarding
 * step left — one facing a re-consent alone, whom the gate lets stay on the post page — goes to
 * that step, coming back to this post (`useOnboardingEntry`'s `entryPath`), and the press is not
 * sent (owner decision 2026-10-20, answer 1); the server would refuse it (`OnboardedGuard`). A
 * press before `GET /me` has said so is sent: on a hard load the gate's `GET /me` and this page's
 * read of the reader's likes both wait for the session alone and go out together, the likes may
 * answer first, and a `GET /me` retried after a 5xx leaves the toggle standing for seconds. The
 * server refuses it (ONBOARDING_REQUIRED), the refusal reads `['me']` again (`afterRefusal`) before
 * the press's promise rejects, and the press then goes where `likeRefusalMove` says: to the step,
 * with no toast — or nowhere while the gate takes the account there — and the toast only when
 * `['me']` names no step to go to (owner decisions 2026-10-20 answer 1 and 2026-10-21, ADR-0076
 * 7-25). The button is one element on every rung — the server's HTML and the hydrating render are
 * the pending rung, and a visitor's turns into the signed-out one once the session answers, so a
 * keyboard focus a visitor already put on it stays.
 *
 * When the reader's likes could not be read, every button of the page shows its count and cannot
 * be pressed, and the page says why in one line (`LikesUnreadableNotice`), which each button names
 * as its description (owner decision 2026-10-20, answer 10).
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
  const { stepLeft, entryPath } = useOnboardingEntry();
  const router = useRouter();
  const queryClient = useQueryClient();
  const view = likeButtonView({
    sessionPending: like.sessionPending,
    signedIn: like.signedIn,
    mine: like.mine,
    saving: like.toggle.isPending,
  });
  const look = target.kind === 'post' ? POST_LOOK : COMMENT_LOOK;
  const testId = target.kind === 'post' ? 'post-like' : 'comment-like';
  const unavailable = view.kind === 'unavailable';

  const press = () => {
    const action = likePressAction(view, stepLeft);
    if (action === null) return;
    if (action.kind === 'login') {
      router.push(loginPathBackTo(postPath(postId)) as Route);
      return;
    }
    if (action.kind === 'step') {
      router.push(entryPath(postPath(postId)) as Route);
      return;
    }
    // The toggle is drawn only once the session named the account.
    const accountId = like.accountId;
    if (accountId === undefined) return;
    const { liked } = action;
    void like.toggle
      .mutateAsync({ target, liked, expectedAccountId: accountId })
      .catch((error: unknown) => {
        // `['me']` as the refusal read it again — not as this render saw it — and the page now.
        const onboarding = queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding;
        const pathname = window.location.pathname;
        switch (likeRefusalMove(error, { postId, pathname, onboarding })) {
          case 'step':
            router.push(onboardingEntryPath(postPath(postId), onboarding) as Route);
            return;
          case 'gate':
            return;
          case undefined:
            toaster.create({ type: 'error', title: likeFailureMessage(error, target.kind, liked) });
        }
      });
  };

  return (
    <LikeToggle
      view={view}
      count={count}
      look={look}
      onClick={press}
      data-testid={testId}
      // Why it cannot be pressed (ADR-0076 7-15): the page's line of text, which a screen reader
      // reads as the button's description, and the tooltip for a pointer on a button far from it.
      aria-describedby={unavailable ? likesUnreadableId(postId) : undefined}
      title={unavailable ? copy.likeMineUnavailable : undefined}
    />
  );
}

/**
 * The page's one line saying the reader's likes could not be read (owner decision 2026-10-20,
 * answer 10), while it is so (`useMyLikesUnreadable`): beside the post's 좋아요, or above the
 * comments under a hidden or deleted post, whose own 좋아요 is gone — there only while a published
 * comment takes one (`show`). Every like button of the page names the line as its description
 * (`likesUnreadableId`); the line exists only while it is so, so no button names an empty one.
 *
 * The line is written into a status region that is on the page before it, empty — from the
 * server's HTML on, as the comment box's limit is (comments-section.tsx): a polite live region
 * that appears with its sentence already inside is easily not announced, and this line always
 * appears after the page is drawn (the session is pending in the server's HTML). Empty, the region
 * leaves the flow (`position: absolute`, still in the accessibility tree), so it adds no gap to
 * the row or the column it stands in.
 */
export function LikesUnreadableNotice({
  postId,
  show = true,
}: {
  postId: string;
  /** Whether the line may show here at all; the region stays mounted either way. */
  show?: boolean;
}) {
  const unreadable = useMyLikesUnreadable(postId) && show;
  return (
    <Box
      role="status"
      aria-live="polite"
      position={unreadable ? undefined : 'absolute'}
      data-testid="likes-unreadable-status"
    >
      {unreadable && (
        <Text
          id={likesUnreadableId(postId)}
          textStyle="bodySm"
          color="fg.muted"
          data-testid="likes-unreadable"
        >
          {copy.likeMineUnavailable}
        </Text>
      )}
    </Box>
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
 * focusable). The rest of the props go through (the press, the description of that rung).
 */
function LikeToggle({ view, count, look, ...rest }: LikeToggleProps) {
  const pressed = view.kind === 'toggle' && view.pressed;
  const busy = view.kind === 'pending' || (view.kind === 'toggle' && view.press === 'wait');
  const variant = 'variant' in look ? look.variant : pressed ? 'subtle' : 'outline';
  return (
    <Button
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
}

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
