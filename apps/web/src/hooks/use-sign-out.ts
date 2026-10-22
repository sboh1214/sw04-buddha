'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { signOut } from '@/lib/auth-client';
import { clearAllSessionCommentDrafts } from '@/lib/comment-drafts';
import { clearSessionPostDrafts } from '@/lib/post-drafts';
import { clearSessionProfileDrafts } from '@/lib/profile-drafts';

/** What `signOutInOrder` runs, in its order. */
export interface SignOutSteps {
  /**
   * What the screen tells the server first, while the session is there — the onboarding's leave
   * report (`useInterestsLeaveReport`, ADR-0078). Waited for; a failure does not keep the account
   * signed in.
   */
  readonly beforeSignOut?: () => Promise<void>;
  /** better-auth's sign-out: `{ error }` on a failure. */
  readonly signOut: () => Promise<{ error?: unknown }>;
  readonly onFailed: () => void;
  readonly onSignedOut: () => void;
}

/**
 * The sign-out's order: `beforeSignOut`, then the sign-out, then what follows it — on success only.
 * Plain, so the unit tests drive it under `environment: 'node'`.
 */
export async function signOutInOrder(steps: SignOutSteps): Promise<void> {
  if (steps.beforeSignOut) {
    try {
      await steps.beforeSignOut();
    } catch {
      // Not the sign-out's to hear: the account still signs out.
    }
  }
  // better-auth reports every failure as `{ error }` now that `fetchOrNetworkError` covers
  // the transport too; the catch stays as belt-and-braces. The session signal that clears
  // `useSession` fires on success only (client/proxy.mjs), so navigating home regardless
  // would just look like a logout.
  let failed: boolean;
  try {
    failed = (await steps.signOut()).error != null;
  } catch {
    failed = true;
  }
  if (failed) {
    steps.onFailed();
    return;
  }
  steps.onSignedOut();
}

/**
 * 로그아웃, as one action for every control that offers it (`SignOutButton`: MY, /onboarding,
 * /set-password): sign out, empty the tab's cache and go home. A failure is a toast and nothing
 * else. `beforeSignOut` is what the screen has to tell the server before the session ends
 * (`signOutInOrder`): /onboarding's leave report.
 */
export function useSignOut(beforeSignOut?: () => Promise<void>): () => Promise<void> {
  const router = useRouter();
  const queryClient = useQueryClient();

  return function handleSignOut() {
    return signOutInOrder({
      beforeSignOut,
      signOut,
      onFailed: () => toaster.create({ type: 'error', title: copy.logoutFailed }),
      onSignedOut: () => {
        // Everything, not just `['me']`. The browser QueryClient is a singleton for the tab's
        // lifetime (lib/query-client.ts) and none of the keys carry a user id, so a ledger,
        // payment list or admin memo left behind here would be served — fresh, for the 30s
        // staleTime, so not even refetched — to whoever logs in next on this browser. This
        // covers the tab that clicked; every other tab learns of the sign-out from better-auth
        // (a localStorage broadcast) and is emptied by SessionCacheGuard when its session
        // identity changes.
        queryClient.clear();
        // So are the post, comment and MY 설정 drafts an onboarding step kept in this tab
        // (lib/post-drafts.ts, lib/comment-drafts.ts, lib/profile-drafts.ts — owner decisions
        // 2026-10-22 answer 3 and (2nd) answer 2, the nickname's too): each is its writer's only,
        // and whoever signs in next here never sees one.
        clearSessionPostDrafts();
        clearAllSessionCommentDrafts();
        clearSessionProfileDrafts();
        router.push('/');
        router.refresh();
      },
    });
  };
}
