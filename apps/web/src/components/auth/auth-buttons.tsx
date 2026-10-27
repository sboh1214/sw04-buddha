'use client';

import { Badge, Button, HStack, Skeleton, Text } from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { MY_WALLET_PATH } from '@/lib/my';
import { nextQuery } from '@/lib/next-path';

/**
 * Right side of the top nav (PLAN 11.4 AuthButtons): logged out -> 로그인 / 가입하기;
 * logged in -> the 잔고 chip alone. There is no profile menu (owner decision 2026-10-13, #16):
 * 관리자 and 로그아웃 are in MY (app/my/account-actions.tsx) and MY itself is a primary item.
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

  if (isPending) {
    // 40px tall: the height of the pair it stands in for, so the header does not move when
    // the session resolves.
    return <Skeleton width="28" height="10" borderRadius="pill" />;
  }

  if (!isLoggedIn) {
    // Kalshi's pair (ADR-0041): 로그인 an outline pill on the neutral `border.emphasized` stroke
    // with the brand green as its text, 가입하기 the solid brand pill. Both 40px tall and both
    // `emphasisSm`, so the two read as one control at two weights rather than two controls.
    return (
      <HStack gap="2">
        <Button
          asChild
          variant="outline"
          h="40px"
          px="3"
          borderRadius="pill"
          borderColor="border.emphasized"
          color="brand.fg"
          textStyle="emphasisSm"
        >
          <NextLink href={{ pathname: '/login', query: { next: pathname } }}>{copy.login}</NextLink>
        </Button>
        {/* Carries the page too (#58, ADR-0069 decision 1 #57-9): after the onboarding a new
            account comes back to the market it was looking at. */}
        <Button asChild h="40px" px="3" borderRadius="pill" textStyle="emphasisSm">
          <NextLink href={{ pathname: '/signup', query: nextQuery(pathname) }}>
            {copy.signup}
          </NextLink>
        </Button>
      </HStack>
    );
  }

  // Available Coin only, never the order lock beside it (owner decision 2026-10-13, #16), and a
  // way into MY's 지갑 where both are broken down. Live because the socket's `user:balance`
  // writes `['me']`.
  return (
    <Badge
      asChild
      size="lg"
      variant="subtle"
      colorPalette="brand"
      borderRadius="pill"
      data-testid="balance-chip"
    >
      <NextLink href={MY_WALLET_PATH}>
        <Text as="span" color="fg.muted" fontWeight="normal" me="1">
          {copy.balance}
        </Text>
        {me ? formatCoin(parseCoinAmount(me.balance.availableCoin)) : copy.loading}
      </NextLink>
    </Badge>
  );
}
