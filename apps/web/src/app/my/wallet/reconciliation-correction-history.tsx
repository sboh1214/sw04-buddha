'use client';

import { Alert, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { MINUS_SIGN, formatCoin } from '@buddha/shared';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useMemberCorrections } from '@/hooks/use-reconciliation-corrections';
import { type MemberReconciliationCorrection } from '@/lib/api';
import { readFailed } from '@/lib/query-client';
import { CORRECTION_MODE_LABEL, CORRECTION_MODE_HINT } from '@/lib/reconciliation-corrections';

export function MemberCorrectionRow({ entry }: { entry: MemberReconciliationCorrection }) {
  const dateTime = useFormatDateTime();
  const delta = BigInt(entry.balanceDeltaCoin);
  return (
    <Stack gap="2" pt="3" _first={{ pt: 0 }} data-testid={`member-correction-${entry.id}`}>
      <HStack justify="space-between" flexWrap="wrap" gap="2">
        <Text fontWeight="medium">{CORRECTION_MODE_LABEL[entry.mode]}</Text>
        <Text fontSize="xs" color="fg.muted">
          {dateTime(entry.createdAt)}
        </Text>
      </HStack>
      <Text fontSize="sm">{CORRECTION_MODE_HINT[entry.mode]}</Text>
      <Text fontSize="sm">
        {copy.reconciliationCorrectionAmount} {formatCoin(BigInt(entry.amountCoin))}
      </Text>
      {delta === 0n ? (
        <Text fontSize="sm" data-testid="member-correction-balance-delta">
          {copy.reconciliationCorrectionNoBalanceChange}
        </Text>
      ) : (
        <Text fontSize="sm" data-testid="member-correction-balance-delta">
          {copy.reconciliationCorrectionBalanceDelta} {delta > 0n ? '+' : MINUS_SIGN}
          {formatCoin(delta > 0n ? delta : -delta)}
        </Text>
      )}
      <Text fontSize="sm">
        {copy.reconciliationCorrectionBalanceAfter} {formatCoin(BigInt(entry.balanceAfterCoin))}
      </Text>
      <Text
        fontSize="sm"
        whiteSpace="pre-wrap"
        wordBreak="break-word"
        data-testid="member-correction-reason"
      >
        {entry.userReason}
      </Text>
    </Stack>
  );
}

export function ReconciliationCorrectionHistory() {
  const list = useMemberCorrections();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card.Root data-testid="member-correction-history">
      <Card.Header>
        <Text fontWeight="semibold">{copy.reconciliationCorrectionHistoryTitle}</Text>
      </Card.Header>
      <Card.Body>
        {list.isPending ? (
          <Skeleton height="24" />
        ) : readFailed(list) ? (
          <Stack gap="3" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : items.length === 0 ? (
          <Text color="fg.muted">{copy.reconciliationCorrectionHistoryEmpty}</Text>
        ) : (
          <Stack gap="3">
            <Stack gap="3" divideY="1px">
              {items.map((entry) => (
                <MemberCorrectionRow key={entry.id} entry={entry} />
              ))}
            </Stack>
            {list.hasNextPage && (
              <>
                <LoadMoreFailed
                  list={list}
                  message={copy.errUnknown}
                  data-testid="member-corrections-more-failed"
                />
                <Button
                  alignSelf="center"
                  size="sm"
                  variant="ghost"
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                  data-testid="member-corrections-more"
                >
                  {copy.loadMore}
                </Button>
              </>
            )}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
