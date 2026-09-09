'use client';

import { Avatar, Badge, Button, HStack, Menu, Portal, Skeleton, Text } from '@chakra-ui/react';
import { formatP, parsePAmount } from '@buddha/shared';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { signOut } from '@/lib/auth-client';

/**
 * Right side of the top nav (PLAN 11.4 AuthButtons): logged out -> 로그인 / 가입하기;
 * logged in -> 잔고 chip + profile menu (관리자 for admins / 설정 / 로그아웃).
 *
 * The pending skeleton below is the same on the server and through hydration because
 * `useSession` holds `isPending` until the tab has hydrated (lib/auth-client.ts). Without
 * that, this component was the repo's loudest hydration mismatch — the server sent a skeleton
 * where the client wanted the 로그인/가입하기 pair — and React recovered by regenerating the
 * tree from the root, wiping typed input and focus anywhere on the page.
 */
export function AuthButtons() {
  const { data: me, isPending, isLoggedIn } = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();

  if (isPending) {
    return <Skeleton width="28" height="9" />;
  }

  if (!isLoggedIn) {
    return (
      <HStack gap="2">
        <Button asChild variant="ghost" size="sm">
          <NextLink href={{ pathname: '/login', query: { next: pathname } }}>{copy.login}</NextLink>
        </Button>
        <Button asChild size="sm">
          <NextLink href="/signup">{copy.signup}</NextLink>
        </Button>
      </HStack>
    );
  }

  async function handleSignOut() {
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
    router.push('/');
    router.refresh();
  }

  return (
    <HStack gap="3">
      <Badge asChild size="lg" variant="subtle" colorPalette="brand" data-testid="balance-chip">
        <NextLink href="/wallet">
          <Text as="span" color="fg.muted" fontWeight="normal" me="1">
            {copy.balance}
          </Text>
          {me ? formatP(parsePAmount(me.balance.availableP)) : copy.loading}
        </NextLink>
      </Badge>
      <Menu.Root positioning={{ placement: 'bottom-end' }}>
        <Menu.Trigger asChild>
          <Button variant="ghost" size="sm" px="1" aria-label={copy.profileMenu}>
            <Avatar.Root size="xs">
              <Avatar.Fallback name={me?.profile.nickname} />
            </Avatar.Root>
            <Text as="span" display={{ base: 'none', md: 'inline' }} data-testid="nav-nickname">
              {me?.profile.nickname}
            </Text>
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="40">
              {/* The only way into /admin from the UI (PLAN 12). The layout there turns
                  members away on the server and the API's AdminGuard decides for real, so
                  this link is convenience, not the boundary. */}
              {me?.profile.role === 'admin' && (
                <Menu.Item value="admin" asChild data-testid="nav-admin">
                  <NextLink href="/admin/users">{copy.navAdmin}</NextLink>
                </Menu.Item>
              )}
              <Menu.Item value="settings" asChild>
                <NextLink href="/settings">{copy.navSettings}</NextLink>
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item value="logout" onSelect={() => void handleSignOut()}>
                {copy.logout}
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </HStack>
  );
}
