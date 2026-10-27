'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { signOut } from '@/lib/auth-client';
import { clearSessionPostDrafts } from '@/lib/post-drafts';

/**
 * 로그아웃, as one action for every control that offers it (`SignOutButton`: MY, /onboarding,
 * /set-password): sign out, empty the tab's cache and go home. A failure is a toast and nothing
 * else.
 */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  const queryClient = useQueryClient();

  return async function handleSignOut() {
    // better-auth reports every failure as `{ error }` now that `fetchOrNetworkError` covers
    // the transport too; the catch stays as belt-and-braces. The session signal that clears
    // `useSession` fires on success only (client/proxy.mjs), so navigating home regardless
    // would just look like a logout.
    let failed: boolean;
    try {
      failed = (await signOut()).error != null;
    } catch {
      failed = true;
    }
    if (failed) {
      toaster.create({ type: 'error', title: copy.logoutFailed });
      return;
    }
    // Everything, not just `['me']`. The browser QueryClient is a singleton for the tab's
    // lifetime (lib/query-client.ts) and none of the keys carry a user id, so a ledger,
    // payment list or admin memo left behind here would be served — fresh, for the 30s
    // staleTime, so not even refetched — to whoever logs in next on this browser. This
    // covers the tab that clicked; every other tab learns of the sign-out from better-auth
    // (a localStorage broadcast) and is emptied by SessionCacheGuard when its session
    // identity changes.
    queryClient.clear();
    // So are the post drafts the onboarding gate kept in this tab (lib/post-drafts.ts): each is
    // its writer's only, and whoever signs in next here never sees one.
    clearSessionPostDrafts();
    router.push('/');
    router.refresh();
  };
}
