'use client';

import { Avatar, Badge, Button, HStack, Menu, Portal, Skeleton, Text } from '@chakra-ui/react';
import { formatP, parsePAmount } from '@buddha/shared';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { signOut } from '@/lib/auth-client';

/**
 * Right side of the top nav (PLAN 11.4 AuthButtons): logged out -> 로그인 / 가입하기;
 * logged in -> 잔고 chip + profile menu (설정 / 로그아웃).
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
    await signOut();
    queryClient.removeQueries({ queryKey: ['me'] });
    router.push('/');
    router.refresh();
  }

  return (
    <HStack gap="3">
      <Badge asChild size="lg" variant="subtle" colorPalette="brand" data-testid="balance-chip">
        <NextLink href="/">
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
