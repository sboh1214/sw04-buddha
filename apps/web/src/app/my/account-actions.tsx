'use client';

import { Button, HStack } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useSignOut } from '@/hooks/use-sign-out';

/**
 * 관리자 (administrators only) and 로그아웃, in one place inside MY for every tab (owner decision
 * 2026-10-13: the profile menu that held them goes).
 *
 * 관리자 is a way into /admin (PLAN 12): the layout there turns members away on the server and
 * the API's AdminGuard decides for real, so this link is convenience, not the boundary. It waits
 * for `GET /me` to say the role rather than drawing a placeholder — a member never sees it, and
 * an administrator sees it appear once the profile is in.
 */
export function AccountActions() {
  const { data: me } = useMe();
  const handleSignOut = useSignOut();

  return (
    <HStack gap="2" data-testid="my-account-actions">
      {me?.profile.role === 'admin' && (
        <Button asChild size="sm" variant="outline" data-testid="my-admin">
          <NextLink href="/admin/users">{copy.navAdmin}</NextLink>
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void handleSignOut()}
        data-testid="my-logout"
      >
        {copy.logout}
      </Button>
    </HStack>
  );
}
