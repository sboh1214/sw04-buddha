'use client';

import { Alert, Badge, Button, Skeleton, Stack, Table, Text } from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useAdminJudgementCompensationRecipients } from '@/hooks/use-admin-markets';
import { nicknameShown } from '@/lib/account-closure';
import { COMPENSATION_RECIPIENT_STATE_LABEL } from '@/lib/market-judgement-compensation';

/** Each state's badge colour: a ledger check needs doing, a closed account was left unpaid. */
const STATE_PALETTE = {
  pending: 'gray',
  blocked: 'orange',
  closed: 'gray',
  paid: 'green',
} as const;

/**
 * 판정 오류 보상's 대상 계정 (#144 part 2, ADR-0166; 144-16 "관리자 화면에 어느 계정인지 보인다",
 * 144-7, 144-19): the market's listed accounts in account order, 20 per page with 더 보기 — before a
 * request the accounts owed now, while one waits its frozen list, once approved the payout's
 * records — each with its nickname ('탈퇴한 사용자' once closed), its amount and where it stands
 * (지급 대기, 원장 확인 필요, 탈퇴로 지급 못 함, 지급 완료). Admins only (the operation record's
 * list, never a member's screen). Read once when the panel opens it, no polling (ADR-0138); every
 * admin write to the market asks it again (`invalidateMarket`). A refresh that failed after rows
 * exist keeps them under a notice with 다시 시도; a 더 보기 that failed keeps them and says so above
 * its button (`LoadMoreFailed`); only a first read that failed shows the error.
 */
export function JudgementCompensationRecipients({ marketId }: { marketId: string }) {
  const list = useAdminJudgementCompensationRecipients(marketId);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="2" data-testid="market-judgement-compensation-recipients">
      {list.isPending ? (
        <Skeleton height="12" />
      ) : list.isLoadingError ? (
        <Stack
          gap="2"
          align="flex-start"
          data-testid="market-judgement-compensation-recipients-error"
        >
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
      ) : rows.length === 0 ? (
        <Text
          fontSize="sm"
          color="fg.muted"
          data-testid="market-judgement-compensation-recipients-empty"
        >
          {copy.adminMarketJudgementCompensationRecipientsEmpty}
        </Text>
      ) : (
        <Stack gap="2">
          {list.isRefetchError && (
            <Alert.Root
              status="warning"
              role="status"
              data-testid="market-judgement-compensation-recipients-stale"
            >
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
              </Alert.Content>
              <Button size="xs" variant="outline" ml="auto" onClick={() => void list.refetch()}>
                {copy.retry}
              </Button>
            </Alert.Root>
          )}
          <Table.ScrollArea borderWidth="1px" borderRadius="l2">
            <Table.Root size="sm" data-testid="market-judgement-compensation-recipients-list">
              <Table.Header>
                <Table.Row data-testid="market-judgement-compensation-recipients-head">
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementCompensationRecipientsColAccount}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">
                    {copy.adminMarketJudgementCompensationRecipientsColAmount}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementCompensationRecipientsColState}
                  </Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row
                    key={row.account.id}
                    data-testid={`market-judgement-compensation-recipient-${row.account.id}`}
                    data-state={row.state}
                  >
                    <Table.Cell wordBreak="break-word">
                      {nicknameShown(row.account.nickname)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap" textAlign="end">
                      {formatCoin(parseCoinAmount(row.amountCoin))}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">
                      <Badge colorPalette={STATE_PALETTE[row.state]} variant="subtle">
                        {COMPENSATION_RECIPIENT_STATE_LABEL[row.state]}
                      </Badge>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Table.ScrollArea>
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid="market-judgement-compensation-recipients-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="market-judgement-compensation-recipients-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}
