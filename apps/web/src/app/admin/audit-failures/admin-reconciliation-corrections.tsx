'use client';

import {
  Alert,
  Badge,
  Button,
  Heading,
  HStack,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useState } from 'react';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useCorrectionRequests } from '@/hooks/use-reconciliation-corrections';
import { type ReconciliationCorrectionRequest } from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import { CORRECTION_STATUS_LABEL, correctionRequestState } from '@/lib/reconciliation-corrections';
import {
  CorrectionDialog,
  CorrectionFacts,
  type CorrectionDialogTarget,
} from './reconciliation-correction-dialogs';

export function CorrectionRequestCard({
  request,
  onAction,
}: {
  request: ReconciliationCorrectionRequest;
  onAction: (target: CorrectionDialogTarget) => void;
}) {
  const operatorId = useOperatorId();
  const state = correctionRequestState(request, operatorId);
  return (
    <Stack
      gap="3"
      p="4"
      borderWidth="1px"
      borderRadius="l2"
      data-testid={`correction-request-${request.id}`}
    >
      <HStack justify="space-between" flexWrap="wrap">
        <Badge
          colorPalette={
            request.status === 'approved'
              ? 'green'
              : request.status === 'pending'
                ? 'orange'
                : 'gray'
          }
        >
          {CORRECTION_STATUS_LABEL[request.status]}
        </Badge>
        <Text fontSize="sm">{formatKst(request.requestedAt)}</Text>
      </HStack>
      <CorrectionFacts candidate={request.candidate} />
      <Text fontSize="sm">{nicknameShown(request.requestedBy.nickname)}</Text>
      {request.userReason !== null && (
        <Stack gap="1">
          <Text fontWeight="medium">{copy.reconciliationCorrectionUserReason}</Text>
          <Text whiteSpace="pre-wrap" wordBreak="break-word">
            {request.userReason}
          </Text>
        </Stack>
      )}
      <Stack gap="1">
        <Text fontWeight="medium">{copy.reconciliationCorrectionInternalReason}</Text>
        <Text whiteSpace="pre-wrap" wordBreak="break-word">
          {request.reason}
        </Text>
      </Stack>
      {state.pending ? (
        <>
          {state.own && (
            <Text fontSize="sm" color="fg.muted">
              {copy.reconciliationOwnRequest}
            </Text>
          )}
          <HStack flexWrap="wrap">
            <Button
              size="sm"
              disabled={!state.canApprove}
              data-testid={`correction-approve-${request.id}`}
              onClick={() =>
                onAction({ action: 'approve', resultId: request.resultId, requestId: request.id })
              }
            >
              {copy.reconciliationCorrectionApprove}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!state.canReject}
              data-testid={`correction-reject-${request.id}`}
              onClick={() =>
                onAction({ action: 'reject', resultId: request.resultId, requestId: request.id })
              }
            >
              {copy.reconciliationCorrectionReject}
            </Button>
            {state.own && (
              <Button
                size="sm"
                variant="outline"
                disabled={!state.canRetract}
                data-testid={`correction-retract-${request.id}`}
                onClick={() =>
                  onAction({ action: 'retract', resultId: request.resultId, requestId: request.id })
                }
              >
                {copy.reconciliationCorrectionRetract}
              </Button>
            )}
          </HStack>
        </>
      ) : (
        <Stack gap="1" fontSize="sm">
          <Text>{formatKst(request.decidedAt ?? request.retractedAt ?? request.requestedAt)}</Text>
          {request.decidedBy && <Text>{nicknameShown(request.decidedBy.nickname)}</Text>}
          {request.decisionReason && (
            <Text whiteSpace="pre-wrap" wordBreak="break-word">
              {request.decisionReason}
            </Text>
          )}
          {request.status === 'approved' && (
            <Text color="fg.muted">{copy.reconciliationCorrectionSeparateRecovery}</Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

export function AdminReconciliationCorrections() {
  const [all, setAll] = useState(false);
  const list = useCorrectionRequests(all);
  const [dialog, setDialog] = useHeldForOperator<CorrectionDialogTarget>();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="4" data-testid="admin-reconciliation-corrections">
      <Heading as="h2" size="xl">
        {copy.reconciliationCorrectionTitle}
      </Heading>
      <Text color="fg.muted">{copy.reconciliationCorrectionIntro}</Text>
      <HStack gap="3" flexWrap="wrap">
        <NativeSelect.Root maxW="sm">
          <NativeSelect.Field
            aria-label={copy.reconciliationCorrectionRequests}
            value={all ? 'all' : 'pending'}
            onChange={(event) => setAll(event.target.value === 'all')}
            data-testid="correction-request-filter"
          >
            <option value="pending">{copy.reconciliationCorrectionPendingOnly}</option>
            <option value="all">{copy.reconciliationCorrectionAll}</option>
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
          {items.length === 0 && <Text color="fg.muted">{copy.reconciliationCorrectionEmpty}</Text>}
          {items.map((request) => (
            <CorrectionRequestCard key={request.id} request={request} onAction={setDialog} />
          ))}
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid="correction-requests-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="correction-requests-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </>
      )}
      {dialog && (
        <CorrectionDialog
          key={`${dialog.resultId}-${dialog.action}-${'requestId' in dialog ? dialog.requestId : ''}`}
          target={dialog}
          onClose={() => setDialog(null)}
        />
      )}
    </Stack>
  );
}
