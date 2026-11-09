'use client';

import {
  Alert,
  Badge,
  Button,
  Heading,
  HStack,
  Link as ChakraLink,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { useState } from 'react';
import { type ReconciliationTarget } from '@buddha/shared';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useReconciliationHolds, useReconciliationResults } from '@/hooks/use-reconciliation';
import { type ReconciliationHoldDetail, type ReconciliationResult } from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import {
  RECONCILIATION_SCOPE_LABEL,
  RECONCILIATION_SOURCE_LABEL,
  RECONCILIATION_FINDING_LABEL,
  type RecoveryAction,
  reconciliationHoldTarget,
  reconciliationRecoveryState,
} from '@/lib/reconciliation';
import { ReconciliationRecoveryDialog, RunReconciliationDialog } from './reconciliation-dialogs';
import { CorrectionDialog } from './reconciliation-correction-dialogs';

type DialogState =
  | { kind: 'run'; target: ReconciliationTarget | null }
  | { kind: 'correction'; resultId: string }
  | { kind: 'recovery'; holdId: string; action: RecoveryAction };

function ReadError({ stale = false }: { stale?: boolean }) {
  if (stale)
    return (
      <Alert.Root status="warning" role="status">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  return (
    <Alert.Root status="error" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.errUnknown}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

export function ReconciliationResultCard({
  result,
  onCorrection,
}: {
  result: ReconciliationResult;
  onCorrection?: (resultId: string) => void;
}) {
  const operatorId = useOperatorId();
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`reconciliation-result-${result.id}`}
    >
      <HStack justify="space-between" flexWrap="wrap" gap="2">
        <HStack flexWrap="wrap">
          <Badge colorPalette={result.passed ? 'green' : 'orange'}>
            {result.passed ? copy.reconciliationPassed : copy.reconciliationFailed}
          </Badge>
          <Text fontWeight="semibold">{RECONCILIATION_SCOPE_LABEL[result.scope]}</Text>
        </HStack>
        <Text color="fg.muted" fontSize="sm">
          {formatKst(result.checkedAt)}
        </Text>
      </HStack>
      <Text fontSize="sm" wordBreak="break-all">
        {copy.reconciliationTarget} {result.targetKey}
      </Text>
      <Text fontSize="sm" color="fg.muted">
        {RECONCILIATION_SOURCE_LABEL[result.source]}
      </Text>
      {result.findings.map((finding, index) => (
        <Stack key={`${finding.code}-${index}`} gap="1" borderLeftWidth="2px" pl="3">
          <Text fontWeight="medium">{RECONCILIATION_FINDING_LABEL[finding.code]}</Text>
          <Text fontSize="sm" wordBreak="break-word">
            {copy.reconciliationExpected} {finding.expected} · {copy.reconciliationActual}{' '}
            {finding.actual}
          </Text>
          {finding.detail && (
            <Text fontSize="sm" color="fg.muted" wordBreak="break-word">
              {finding.detail}
            </Text>
          )}
        </Stack>
      ))}
      {!result.passed && onCorrection && (
        <Button
          alignSelf="start"
          size="sm"
          variant="outline"
          disabled={operatorId === undefined}
          onClick={() => onCorrection(result.id)}
          data-testid={`correction-preview-${result.id}`}
        >
          {copy.reconciliationCorrectionPreview}
        </Button>
      )}
    </Stack>
  );
}

function HoldCard({
  detail,
  onRun,
  onAction,
}: {
  detail: ReconciliationHoldDetail;
  onRun: (target: ReconciliationTarget) => void;
  onAction: (action: RecoveryAction) => void;
}) {
  const operatorId = useOperatorId();
  const state = reconciliationRecoveryState(detail, operatorId);
  const target = reconciliationHoldTarget(detail);
  return (
    <Stack
      gap="4"
      borderWidth="1px"
      borderRadius="l2"
      p="4"
      data-testid={`reconciliation-hold-${detail.hold.id}`}
    >
      <HStack justify="space-between" flexWrap="wrap" gap="2">
        <Badge colorPalette={state.active ? 'orange' : 'green'}>
          {state.active ? copy.reconciliationHeld : copy.reconciliationRecovered}
        </Badge>
        <Text fontSize="sm" color="fg.muted">
          {copy.reconciliationStartedAt} {formatKst(detail.hold.startedAt)}
        </Text>
      </HStack>
      {detail.market ? (
        <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
          <NextLink href={`/admin/markets/${detail.market.id}`}>{detail.market.title}</NextLink>
        </ChakraLink>
      ) : detail.user ? (
        <ChakraLink asChild fontWeight="semibold">
          <NextLink href={`/admin/moderation/users/${encodeURIComponent(detail.user.id)}`}>
            {nicknameShown(detail.user.nickname)}
          </NextLink>
        </ChakraLink>
      ) : (
        <Text wordBreak="break-all">{detail.hold.targetKey}</Text>
      )}
      {state.active && (
        <Text fontSize="sm" color="fg.muted">
          {detail.hold.scope === 'market'
            ? copy.reconciliationMarketHoldHint
            : copy.reconciliationAccountHoldHint}
        </Text>
      )}
      {detail.hold.recoveredAt && (
        <Text fontSize="sm">
          {copy.reconciliationRecoveredAt} {formatKst(detail.hold.recoveredAt)}
        </Text>
      )}
      {detail.latestResult ? (
        <ReconciliationResultCard result={detail.latestResult} />
      ) : (
        <Text color="fg.muted">{copy.reconciliationNotChecked}</Text>
      )}
      {state.active && (
        <Stack gap="3">
          {state.paused ? (
            <Text fontSize="sm">{copy.reconciliationPausePath}</Text>
          ) : !state.passed ? (
            <Text fontSize="sm" color="fg.muted">
              {copy.reconciliationNeedPass}
            </Text>
          ) : null}
          <HStack flexWrap="wrap" gap="2">
            <Button
              size="sm"
              variant="outline"
              disabled={operatorId === undefined || target === null}
              onClick={() => {
                if (target) onRun(target);
              }}
              data-testid={`reconciliation-rerun-${detail.hold.id}`}
            >
              {copy.reconciliationRerun}
            </Button>
            {state.paused && detail.market ? (
              <Button asChild size="sm" variant="outline">
                <NextLink href={`/admin/markets/${detail.market.id}`}>
                  {copy.reconciliationOpenMarket}
                </NextLink>
              </Button>
            ) : (
              state.pending === null && (
                <Button
                  size="sm"
                  disabled={!state.canRequest}
                  onClick={() => onAction('request')}
                  data-testid={`reconciliation-request-${detail.hold.id}`}
                >
                  {copy.reconciliationRequest}
                </Button>
              )
            )}
          </HStack>
        </Stack>
      )}
      {state.pending && (
        <Stack
          gap="3"
          borderWidth="1px"
          borderRadius="l2"
          p="3"
          data-testid={`reconciliation-pending-${state.pending.id}`}
        >
          <Text fontWeight="semibold">{copy.reconciliationPendingRequest}</Text>
          <Text fontSize="sm">
            {nicknameShown(state.pending.requestedBy.nickname)} ·{' '}
            {formatKst(state.pending.requestedAt)}
          </Text>
          <Text whiteSpace="pre-wrap" wordBreak="break-word">
            {state.pending.reason}
          </Text>
          {state.own && (
            <Text fontSize="sm" color="fg.muted">
              {copy.reconciliationOwnRequest}
            </Text>
          )}
          {state.stale && (
            <Text fontSize="sm" color="fg.muted">
              {copy.reconciliationStale}
            </Text>
          )}
          <HStack flexWrap="wrap">
            <Button
              size="sm"
              disabled={!state.canApprove}
              onClick={() => onAction('approve')}
              data-testid={`reconciliation-approve-${state.pending.id}`}
            >
              {copy.reconciliationApprove}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!state.canReject}
              onClick={() => onAction('reject')}
              data-testid={`reconciliation-reject-${state.pending.id}`}
            >
              {copy.reconciliationReject}
            </Button>
            {state.own && (
              <Button
                size="sm"
                variant="outline"
                disabled={!state.canRetract}
                onClick={() => onAction('retract')}
                data-testid={`reconciliation-retract-${state.pending.id}`}
              >
                {copy.reconciliationRetract}
              </Button>
            )}
          </HStack>
        </Stack>
      )}
      {detail.requests.some((request) => request.status !== 'pending') && (
        <details>
          <summary>{copy.reconciliationRequests}</summary>
          <Stack mt="3" gap="3">
            {detail.requests
              .filter((request) => request.status !== 'pending')
              .map((request) => (
                <Stack key={request.id} gap="1" borderLeftWidth="2px" pl="3">
                  <Text fontSize="sm">
                    {request.status === 'approved'
                      ? copy.reconciliationApprove
                      : request.status === 'rejected'
                        ? copy.reconciliationReject
                        : copy.reconciliationRetract}{' '}
                    · {formatKst(request.decidedAt ?? request.retractedAt ?? request.requestedAt)}
                  </Text>
                  <Text fontSize="sm">{nicknameShown(request.requestedBy.nickname)}</Text>
                  <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
                    {request.reason}
                  </Text>
                  {request.decidedBy && (
                    <Text fontSize="sm">{nicknameShown(request.decidedBy.nickname)}</Text>
                  )}
                  {request.decisionReason && (
                    <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
                      {request.decisionReason}
                    </Text>
                  )}
                </Stack>
              ))}
          </Stack>
        </details>
      )}
    </Stack>
  );
}

export function AdminReconciliation() {
  const [all, setAll] = useState(false);
  const holds = useReconciliationHolds(all);
  const results = useReconciliationResults();
  const operatorId = useOperatorId();
  const [dialog, setDialog] = useHeldForOperator<DialogState>();
  const rows = holds.data?.pages.flatMap((page) => page.items) ?? [];
  const resultRows = results.data?.pages.flatMap((page) => page.items) ?? [];
  const selected =
    dialog?.kind === 'recovery' ? rows.find((row) => row.hold.id === dialog.holdId) : undefined;
  return (
    <Stack gap="8" data-testid="admin-reconciliation">
      <Stack gap="3">
        <Heading as="h2" size="xl">
          {copy.reconciliationTitle}
        </Heading>
        <Text color="fg.muted">{copy.reconciliationIntro}</Text>
        <HStack flexWrap="wrap">
          <Button
            size="sm"
            disabled={operatorId === undefined}
            onClick={() => setDialog({ kind: 'run', target: null })}
            data-testid="reconciliation-run"
          >
            {copy.reconciliationRun}
          </Button>
          <Button
            size="sm"
            variant="outline"
            loading={holds.isRefetching || results.isRefetching}
            onClick={() => {
              void holds.refetch();
              void results.refetch();
            }}
          >
            {copy.retry}
          </Button>
        </HStack>
      </Stack>
      <Stack gap="4">
        <Heading as="h3" size="lg">
          {copy.reconciliationHolds}
        </Heading>
        <NativeSelect.Root maxW="sm">
          <NativeSelect.Field
            aria-label={copy.reconciliationHolds}
            value={all ? 'all' : 'active'}
            onChange={(event) => setAll(event.target.value === 'all')}
            data-testid="reconciliation-hold-filter"
          >
            <option value="active">{copy.reconciliationActiveOnly}</option>
            <option value="all">{copy.reconciliationAllHolds}</option>
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
        {holds.isPending ? (
          <Skeleton height="24" />
        ) : holds.isLoadingError ? (
          <ReadError />
        ) : (
          <>
            {holds.isRefetchError && <ReadError stale />}
            {rows.length === 0 && <Text color="fg.muted">{copy.reconciliationNoHolds}</Text>}
            {rows.map((detail) => (
              <HoldCard
                key={detail.hold.id}
                detail={detail}
                onRun={(target) => setDialog({ kind: 'run', target })}
                onAction={(action) =>
                  setDialog({ kind: 'recovery', holdId: detail.hold.id, action })
                }
              />
            ))}
            {holds.hasNextPage && (
              <>
                <LoadMoreFailed
                  list={holds}
                  message={copy.errUnknown}
                  data-testid="reconciliation-holds-more-failed"
                />
                <Button
                  alignSelf="center"
                  size="sm"
                  variant="ghost"
                  loading={holds.isFetchingNextPage}
                  onClick={() => void holds.fetchNextPage()}
                  data-testid="reconciliation-holds-more"
                >
                  {copy.loadMore}
                </Button>
              </>
            )}
          </>
        )}
      </Stack>
      <Stack gap="4">
        <Heading as="h3" size="lg">
          {copy.reconciliationResults}
        </Heading>
        {results.isPending ? (
          <Skeleton height="24" />
        ) : results.isLoadingError ? (
          <ReadError />
        ) : (
          <>
            {results.isRefetchError && <ReadError stale />}
            {resultRows.length === 0 && (
              <Text color="fg.muted">{copy.reconciliationNoResults}</Text>
            )}
            {resultRows.map((result) => (
              <ReconciliationResultCard
                key={result.id}
                result={result}
                onCorrection={(resultId) => setDialog({ kind: 'correction', resultId })}
              />
            ))}
            {results.hasNextPage && (
              <>
                <LoadMoreFailed
                  list={results}
                  message={copy.errUnknown}
                  data-testid="reconciliation-results-more-failed"
                />
                <Button
                  alignSelf="center"
                  size="sm"
                  variant="ghost"
                  loading={results.isFetchingNextPage}
                  onClick={() => void results.fetchNextPage()}
                  data-testid="reconciliation-results-more"
                >
                  {copy.loadMore}
                </Button>
              </>
            )}
          </>
        )}
      </Stack>
      {dialog?.kind === 'run' && (
        <RunReconciliationDialog target={dialog.target} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'correction' && (
        <CorrectionDialog
          target={{ action: 'preview', resultId: dialog.resultId }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'recovery' && selected && (
        <ReconciliationRecoveryDialog
          detail={selected}
          action={dialog.action}
          onClose={() => setDialog(null)}
        />
      )}
    </Stack>
  );
}
