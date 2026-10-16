'use client';

import { Button, Skeleton } from '@chakra-ui/react';
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useWatch } from '@/hooks/use-watchlist';
import { loginPathBackTo } from '@/lib/next-path';
import { watchButtonView, watchFailureMessage, watchPressAction } from '@/lib/watchlist';

/**
 * 관심 등록 on the market detail (#89, ADR-0064) — the one entry point (ADR-0061 decision 3: on
 * the detail only, not on the cards). A toggle button: `aria-pressed` says whether this market is
 * on the reader's watchlist and the label stays '관심 등록' either way (a toggle whose name changes
 * with its state reads as two controls, WAI-ARIA APG), with the star filled and the brand tint
 * repeating the state for the eye. Colour never carries it alone (PLAN 11.2).
 *
 * Every rung is `watchButtonView` and every press `watchPressAction` (lib/watchlist.ts); this
 * component only draws and dispatches them. Nothing of the state is in the server's
 * HTML: the watchlist is nobody's business but the member's (#37), the page forwards no cookie,
 * and `useSession` holds the session pending through hydration, so the server and the first
 * client render draw the same placeholder for every visitor. A signed-out press goes to the login
 * page told to come back here (`loginPathBackTo`); nothing is remembered, so the visitor presses
 * again once back (the owner's choice). A signed-in press moves the toggle at once
 * (`updateWatchOptions`), and a failure puts it back with a toast saying which change failed.
 */
export function WatchButton({ marketId }: { marketId: string }) {
  const watch = useWatch(marketId);
  const router = useRouter();
  const pathname = usePathname();
  const view = watchButtonView({
    sessionPending: watch.sessionPending,
    signedIn: watch.signedIn,
    state: watch.state,
    saving: watch.toggle.isPending,
  });

  // No read has succeeded yet: nothing is drawn until one does (owner decision, ADR-0064).
  if (view.kind === 'hidden') return null;

  if (view.kind === 'placeholder') {
    // The toggle's own height and width, so the header row does not move when it resolves.
    return <Skeleton h="32px" w="96px" borderRadius="pill" data-testid="watch-button-pending" />;
  }

  const press = () => {
    const action = watchPressAction(view.press);
    if (action === null) return;
    if (action.kind === 'login') {
      router.push(loginPathBackTo(pathname) as Route);
      return;
    }
    // The toggle is drawn signed in only once the session named the account.
    const accountId = watch.accountId;
    if (accountId === undefined) return;
    const { watched } = action;
    watch.toggle.mutate(
      { marketId, watched, expectedAccountId: accountId },
      {
        onError: (error) => {
          toaster.create({ type: 'error', title: watchFailureMessage(error, watched) });
        },
      },
    );
  };

  return (
    <Button
      size="sm"
      h="32px"
      px="3"
      borderRadius="pill"
      variant={view.pressed ? 'subtle' : 'outline'}
      colorPalette={view.pressed ? 'brand' : 'gray'}
      textStyle="emphasisSm"
      aria-pressed={view.pressed}
      // Not `disabled` while a press is on the wire: a disabled button drops the keyboard focus
      // it holds. The second press is ignored instead (`wait`, which `watchPressAction` sends
      // nowhere). For the same reason the toggle never goes back to the placeholder once drawn.
      aria-busy={view.press === 'wait' ? true : undefined}
      onClick={press}
      data-testid="watch-button"
    >
      <StarIcon filled={view.pressed} />
      {copy.watchToggle}
    </Button>
  );
}

/** The repo draws its own icons (password-input.tsx); the label beside it carries the name. */
function StarIcon({ filled }: { filled: boolean }) {
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
      <path d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95L12 2.5z" />
    </svg>
  );
}
