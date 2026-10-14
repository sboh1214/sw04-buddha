'use client';

import { Alert, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { MINUS_SIGN, formatCoin, parseCoinAmount, type LedgerEntryType } from '@buddha/shared';
import { copy } from '@/copy';
import { useLedger } from '@/hooks/use-wallet';
import { type LedgerEntry } from '@/lib/api';
import { formatKst } from '@/lib/datetime';

/** PLAN Appendix A: never "베팅"; every ledger type gets plain Korean. */
const TYPE_LABEL: Record<LedgerEntryType, string> = {
  DEPOSIT: copy.ledgerTypeDeposit,
  TRADE_BUY: copy.ledgerTypeTradeBuy,
  TRADE_SELL: copy.ledgerTypeTradeSell,
  FEE: copy.ledgerTypeFee,
  SETTLEMENT_PAYOUT: copy.ledgerTypeSettlement,
  ADMIN_ADJUST: copy.ledgerTypeAdminAdjust,
  BONUS: copy.ledgerTypeBonus,
  PAYMENT_CANCEL: copy.ledgerTypePaymentCancel,
  PAYMENT_CANCEL_REVERSAL: copy.ledgerTypePaymentCancelReversal,
};

export function LedgerList() {
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useLedger();
  const entries = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card.Root data-testid="ledger-list">
      <Card.Header>
        <Text fontWeight="semibold">{copy.ledgerTitle}</Text>
      </Card.Header>
      <Card.Body>
        {isPending ? (
          <Skeleton height="24" />
        ) : isError ? (
          <Stack gap="3" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : entries.length === 0 ? (
          <Text color="fg.muted">{copy.ledgerEmpty}</Text>
        ) : (
          <Stack gap="3" divideY="1px">
            {entries.map((entry) => (
              <LedgerRow key={entry.id} entry={entry} />
            ))}
            {hasNextPage && (
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                mt="3"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                data-testid="ledger-more"
              >
                {copy.loadMore}
              </Button>
            )}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

export function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const amount = parseCoinAmount(entry.amountCoin);
  const credit = amount >= 0n;
  return (
    <HStack justify="space-between" pt="3" _first={{ pt: 0 }} align="start">
      <Stack gap="0.5">
        <Text fontWeight="medium">{TYPE_LABEL[entry.type]}</Text>
        <Text fontSize="xs" color="fg.muted">
          {formatKst(entry.createdAt)}
        </Text>
        {entry.memo && (
          <Text fontSize="xs" color="fg.muted">
            {entry.memo}
          </Text>
        )}
      </Stack>
      <Stack gap="0.5" align="end">
        {/* The sign carries the meaning; colour only reinforces it (PLAN 11.2). */}
        <Text
          fontWeight="semibold"
          colorPalette={credit ? 'yes' : 'no'}
          color="colorPalette.fg"
          whiteSpace="nowrap"
          data-testid="ledger-amount"
        >
          {credit ? '+' : MINUS_SIGN}
          {formatCoin(credit ? amount : -amount)}
        </Text>
        <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">
          {copy.ledgerBalanceAfter} {formatCoin(parseCoinAmount(entry.balanceAfterCoin))}
        </Text>
      </Stack>
    </HStack>
  );
}
