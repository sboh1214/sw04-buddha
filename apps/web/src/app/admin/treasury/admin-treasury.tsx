'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  Heading,
  HStack,
  Link,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { formatCoin } from '@buddha/shared';
import NextLink from 'next/link';
import { useState } from 'react';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useTreasury, useTreasuryHistory, useTreasuryRequests } from '@/hooks/use-treasury';
import { type AdminTreasury, type TreasuryIssueRequest } from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import { TREASURY_STATUS_LABEL, treasuryFailure, treasuryRequestState } from '@/lib/treasury';
import {
  TreasuryDialog,
  TreasuryRequestFacts,
  type TreasuryDialogTarget,
} from './treasury-dialogs';

export function TreasuryBalance({ treasury }: { treasury: AdminTreasury }) {
  const fields = [
    ['availableCoin', copy.treasuryAvailable],
    ['lockedCoin', copy.treasuryLocked],
    ['ledgerCoin', copy.treasuryLedger],
    ['issuedCoin', copy.treasuryIssued],
  ] as const;
  return (
    <Stack gap="3" data-testid="treasury-balance">
      {treasury.status === 'uninitialized' && (
        <Stack gap="1" data-testid="treasury-uninitialized">
          <Text fontWeight="medium">{copy.treasuryUninitialized}</Text>
          <Text color="fg.muted" fontSize="sm">
            {copy.treasuryUninitializedHint}
          </Text>
        </Stack>
      )}
      {treasury.status === 'inconsistent' && (
        <Alert.Root status="warning" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{copy.treasuryInconsistent}</Alert.Title>
            <Alert.Description>{copy.treasuryIssueLedgerMismatch}</Alert.Description>
            <Link asChild>
              <NextLink href="/admin/audit-failures">{copy.adminAuditFailures}</NextLink>
            </Link>
          </Alert.Content>
        </Alert.Root>
      )}
      <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }}>
        {fields.map(([key, label]) => (
          <DataList.Item
            key={key}
            flexDirection={{ base: 'column', md: 'row' }}
            data-testid={`treasury-${key}`}
          >
            <DataList.ItemLabel>{label}</DataList.ItemLabel>
            <DataList.ItemValue overflowWrap="anywhere">
              {treasury[key] === null ? '—' : formatCoin(BigInt(treasury[key]))}
            </DataList.ItemValue>
          </DataList.Item>
        ))}
      </DataList.Root>
    </Stack>
  );
}

export function TreasuryRequestCard({
  request,
  onAction,
}: {
  request: TreasuryIssueRequest;
  onAction: (target: TreasuryDialogTarget) => void;
}) {
  const state = treasuryRequestState(request, useOperatorId());
  return (
    <Stack
      gap="3"
      p="4"
      borderWidth="1px"
      borderRadius="l2"
      data-testid={`treasury-request-${request.id}`}
    >
      <Badge
        alignSelf="start"
        colorPalette={
          request.status === 'approved' ? 'green' : request.status === 'pending' ? 'orange' : 'gray'
        }
      >
        {TREASURY_STATUS_LABEL[request.status]}
      </Badge>
      <TreasuryRequestFacts request={request} />
      {state.pending ? (
        <>
          {state.own && (
            <Text fontSize="sm" color="fg.muted">
              {copy.treasuryIssueOwnRequest}
            </Text>
          )}
          <HStack flexWrap="wrap">
            <Button
              size="sm"
              disabled={!state.canApprove}
              data-testid={`treasury-approve-${request.id}`}
              onClick={() => onAction({ action: 'approve', requestId: request.id })}
            >
              {copy.treasuryIssueApprove}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!state.canReject}
              data-testid={`treasury-reject-${request.id}`}
              onClick={() => onAction({ action: 'reject', requestId: request.id })}
            >
              {copy.treasuryIssueReject}
            </Button>
            {state.own && (
              <Button
                size="sm"
                variant="outline"
                disabled={!state.canRetract}
                data-testid={`treasury-retract-${request.id}`}
                onClick={() => onAction({ action: 'retract', requestId: request.id })}
              >
                {copy.treasuryIssueRetract}
              </Button>
            )}
          </HStack>
        </>
      ) : (
        <Stack gap="1" fontSize="sm">
          <Text>{formatKst(request.decidedAt ?? request.retractedAt ?? request.requestedAt)}</Text>
          {request.decidedBy && <Text>{nicknameShown(request.decidedBy.nickname)}</Text>}
          {request.decisionReason && (
            <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
              {request.decisionReason}
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function TreasuryHistory() {
  const list = useTreasuryHistory();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="4" data-testid="treasury-history">
      <HStack flexWrap="wrap" justify="space-between">
        <Heading as="h3" size="lg">
          {copy.treasuryIssueHistory}
        </Heading>
        <Button
          size="sm"
          variant="outline"
          loading={list.isRefetching}
          onClick={() => void list.refetch()}
        >
          {copy.retry}
        </Button>
      </HStack>
      <Text fontSize="sm" color="fg.muted">
        {copy.treasuryIssueHistoryHint}
      </Text>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : (
        <>
          {list.isRefetchError && (
            <Alert.Root status="warning" role="status">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          {items.length === 0 && <Text color="fg.muted">{copy.treasuryIssueHistoryEmpty}</Text>}
          {items.map((row) => (
            <Stack
              key={row.id}
              p="4"
              gap="2"
              borderWidth="1px"
              borderRadius="l2"
              data-testid={`treasury-issuance-${row.id}`}
            >
              <Text fontWeight="semibold">{formatCoin(BigInt(row.amountCoin))}</Text>
              <Text fontSize="sm">
                {copy.treasuryIssuedAt} {formatKst(row.issuedAt)}
              </Text>
              <Text fontSize="sm">
                {copy.treasuryRequestedBy} {nicknameShown(row.requestedBy.nickname)}
              </Text>
              <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                {row.requestReason}
              </Text>
              <Text fontSize="sm">
                {copy.treasuryApprovedBy} {nicknameShown(row.approvedBy.nickname)}
              </Text>
              <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                {row.approvalReason}
              </Text>
            </Stack>
          ))}
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid="treasury-history-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="treasury-history-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </>
      )}
    </Stack>
  );
}

export function AdminTreasuryScreen() {
  const operatorId = useOperatorId();
  const treasury = useTreasury();
  const [all, setAll] = useState(false);
  const list = useTreasuryRequests(all);
  const [dialog, setDialog] = useHeldForOperator<TreasuryDialogTarget>();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="6" data-testid="admin-treasury">
      <HStack justify="space-between" flexWrap="wrap">
        <Heading as="h2" size="xl">
          {copy.adminTreasury}
        </Heading>
        <Button
          disabled={operatorId === undefined}
          data-testid="treasury-request-open"
          onClick={() => setDialog({ action: 'request' })}
        >
          {copy.treasuryIssueRequest}
        </Button>
      </HStack>
      <Text color="fg.muted">{copy.treasuryIntro}</Text>
      <Card.Root>
        <Card.Body gap="3">
          <Button
            alignSelf="end"
            size="sm"
            variant="outline"
            loading={treasury.isFetching}
            onClick={() => void treasury.refetch()}
          >
            {copy.retry}
          </Button>
          {treasury.isPending ? (
            <Skeleton height="24" />
          ) : (
            <>
              {treasury.isError && (
                <Alert.Root status="warning" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{treasuryFailure(treasury.error).message}</Alert.Description>
                  </Alert.Content>
                </Alert.Root>
              )}
              {treasury.data && <TreasuryBalance treasury={treasury.data} />}
            </>
          )}
        </Card.Body>
      </Card.Root>
      <Stack gap="4">
        <Heading as="h3" size="lg">
          {copy.treasuryIssueRequests}
        </Heading>
        <HStack gap="3" flexWrap="wrap">
          <NativeSelect.Root maxW="sm">
            <NativeSelect.Field
              aria-label={copy.treasuryIssueRequests}
              value={all ? 'all' : 'pending'}
              onChange={(event) => setAll(event.target.value === 'all')}
              data-testid="treasury-request-filter"
            >
              <option value="pending">{copy.treasuryIssuePendingOnly}</option>
              <option value="all">{copy.treasuryIssueAll}</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Button
            size="sm"
            variant="outline"
            loading={list.isRefetching}
            onClick={() => void list.refetch()}
          >
            {copy.retry}
          </Button>
        </HStack>
        {list.isPending ? (
          <Skeleton height="24" />
        ) : list.isLoadingError ? (
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        ) : (
          <>
            {list.isRefetchError && (
              <Alert.Root status="warning" role="status">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
            {items.length === 0 && <Text color="fg.muted">{copy.treasuryIssueEmpty}</Text>}
            {items.map((request) => (
              <TreasuryRequestCard key={request.id} request={request} onAction={setDialog} />
            ))}
            {list.hasNextPage && (
              <>
                <LoadMoreFailed
                  list={list}
                  message={copy.errUnknown}
                  data-testid="treasury-requests-more-failed"
                />
                <Button
                  alignSelf="center"
                  size="sm"
                  variant="ghost"
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                  data-testid="treasury-requests-more"
                >
                  {copy.loadMore}
                </Button>
              </>
            )}
          </>
        )}
      </Stack>
      <TreasuryHistory />
      {dialog && (
        <TreasuryDialog
          key={dialog.action === 'request' ? 'request' : `${dialog.action}-${dialog.requestId}`}
          target={dialog}
          onClose={() => setDialog(null)}
        />
      )}
    </Stack>
  );
}
