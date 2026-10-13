'use client';

import { Alert, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { profileView } from '@/lib/query-client';

/** Balance summary (PLAN 11.3). `locked_coin` is always 0 in the MVP but shown for honesty. */
export function BalanceCard() {
  const { data: me, isPending, isFetching, isLoggedIn, refetch } = useMe();
  // The same four states /portfolio reads, and for the same reason: this screen's gate is
  // server-side and runs only on navigation, so a session that ends under it left this card
  // blaming a profile load that never failed, with a 다시 시도 that can only 401.
  const view = profileView({ isLoggedIn, isPending, isFetching, hasProfile: me !== undefined });

  return (
    <Card.Root data-testid="wallet-balance">
      <Card.Body>
        {view === 'pending' ? (
          <Skeleton height="12" />
        ) : view === 'signedOut' ? (
          <EmptyState
            message={copy.portfolioSignedOut}
            action={
              <Button asChild size="sm" variant="outline">
                <NextLink href={{ pathname: '/login', query: { next: '/wallet' } }}>
                  {copy.login}
                </NextLink>
              </Button>
            }
          />
        ) : !me ? (
          <Stack gap="3" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errProfileLoad}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" loading={isFetching} onClick={() => void refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : (
          <Stack gap="1">
            <Text fontSize="sm" color="fg.muted">
              {copy.walletBalance}
            </Text>
            <Text fontSize="3xl" fontWeight="bold" data-testid="wallet-available">
              {formatCoin(parseCoinAmount(me.balance.availableCoin))}
            </Text>
            <HStack gap="2" color="fg.muted" fontSize="sm">
              <Text>{copy.walletLocked}</Text>
              <Text data-testid="wallet-locked">
                {formatCoin(parseCoinAmount(me.balance.lockedCoin))}
              </Text>
            </HStack>
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
