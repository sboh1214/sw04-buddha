'use client';

import { Alert, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { profileView } from '@/lib/query-client';
import { startGrantPending } from '@/lib/wallet';

/**
 * Balance summary (PLAN 11.3). `locked_coin` is always 0 in the MVP but shown for honesty.
 *
 * Under the balance, while the account's start Coin waits for its amount, the owner's notice that
 * it will be paid (ADR-0069 decision 4 #70, `startGrantPending`). The balance it sits under is
 * still the account's real one — 0 for a new account — so the notice says why rather than leaving
 * a bare 0 Coin. When the worker pays the grant, `user:balance` moves the figure and asks for the
 * profile again (`applyBalanceEvent`), which takes the notice away.
 */
export function BalanceCard() {
  const { data: me, isPending, isFetching, isLoggedIn, refetch } = useMe();
  // The same four states MY's other screens read, and for the same reason: MY's session gate is
  // server-side and runs only on navigation, so a session that ends under a mounted card left it
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
                <NextLink href={{ pathname: '/login', query: { next: '/my/wallet' } }}>
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
            <CoinText
              as="p"
              fontSize="3xl"
              fontWeight="bold"
              amount={parseCoinAmount(me.balance.availableCoin)}
              data-testid="wallet-available"
            />
            <HStack gap="2" color="fg.muted" fontSize="sm">
              <Text>{copy.walletLocked}</Text>
              <CoinText
                amount={parseCoinAmount(me.balance.lockedCoin)}
                data-testid="wallet-locked"
              />
            </HStack>
            {startGrantPending(me) && (
              <Alert.Root status="info" mt="3" data-testid="wallet-start-grant-pending">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.walletStartGrantPending}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
