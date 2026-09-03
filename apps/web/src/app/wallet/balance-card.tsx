'use client';

import { Alert, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { formatP, parsePAmount } from '@buddha/shared';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';

/** Balance summary (PLAN 11.3). `locked_p` is always 0 in the MVP but shown for honesty. */
export function BalanceCard() {
  const { data: me, isPending, isFetching, refetch } = useMe();

  return (
    <Card.Root data-testid="wallet-balance">
      <Card.Body>
        {isPending ? (
          <Skeleton height="12" />
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
              {formatP(parsePAmount(me.balance.availableP))}
            </Text>
            <HStack gap="2" color="fg.muted" fontSize="sm">
              <Text>{copy.walletLocked}</Text>
              <Text data-testid="wallet-locked">{formatP(parsePAmount(me.balance.lockedP))}</Text>
            </HStack>
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
