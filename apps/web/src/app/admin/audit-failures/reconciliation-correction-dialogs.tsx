'use client';

import { Alert, Button, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatCoin } from '@buddha/shared';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { applyCorrectionWrite, useCorrectionDetail } from '@/hooks/use-reconciliation-corrections';
import { ADMIN_RECONCILIATION_KEY } from '@/hooks/use-reconciliation';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import {
  api,
  unwrap,
  type ReconciliationCorrectionCandidate,
  type ReconciliationCorrectionDetail,
  type ReconciliationCorrectionRequest,
} from '@/lib/api';
import {
  type CorrectionAction,
  CORRECTION_MODE_HINT,
  CORRECTION_MODE_LABEL,
  correctionFailure,
  correctionReasonDraft,
  correctionRequestState,
  sameCorrectionCandidate,
} from '@/lib/reconciliation-corrections';
import { ReasonField, ReviewDialogShell } from '../markets/[id]/market-review-dialogs';

export type CorrectionDialogTarget =
  | { resultId: string; action: 'preview' }
  | { resultId: string; action: CorrectionAction; requestId: string };

export function CorrectionFacts({ candidate }: { candidate: ReconciliationCorrectionCandidate }) {
  return (
    <Stack gap="2" data-testid="correction-facts">
      <Text fontWeight="semibold">{CORRECTION_MODE_LABEL[candidate.mode]}</Text>
      <Text fontSize="sm">{CORRECTION_MODE_HINT[candidate.mode]}</Text>
      <Text fontSize="sm" wordBreak="break-all">
        {copy.reconciliationTarget}{' '}
        {candidate.accountKind === 'user'
          ? (candidate.userId ?? candidate.accountId)
          : (candidate.marketId ?? candidate.accountId)}
      </Text>
      <Text>
        {copy.reconciliationCorrectionAmount} {formatCoin(BigInt(candidate.amountCoin))}
      </Text>
      <HStack flexWrap="wrap" gap="1" fontSize="sm">
        <Text>{copy.reconciliationCorrectionBalance}</Text>
        <Text>{formatCoin(BigInt(candidate.balanceBeforeCoin))}</Text>
        <Text aria-hidden="true">→</Text>
        <Text>{formatCoin(BigInt(candidate.balanceAfterCoin))}</Text>
      </HStack>
      <HStack flexWrap="wrap" gap="1" fontSize="sm">
        <Text>{copy.reconciliationCorrectionLedger}</Text>
        <Text>{formatCoin(BigInt(candidate.ledgerBeforeCoin))}</Text>
        <Text aria-hidden="true">→</Text>
        <Text>{formatCoin(BigInt(candidate.ledgerAfterCoin))}</Text>
      </HStack>
    </Stack>
  );
}

function useCorrectionWrite(
  send: (by: string) => Promise<ReconciliationCorrectionDetail>,
  onClose: () => void,
) {
  const client = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onMutate: () => setRefusal(null),
    onSuccess: async (fresh) => {
      await applyCorrectionWrite(client, fresh);
      toaster.create({ type: 'success', title: copy.reconciliationCorrectionSaved });
      onClose();
      await Promise.all([
        client.invalidateQueries({ queryKey: ADMIN_RECONCILIATION_KEY }),
        client.invalidateQueries({ queryKey: ['admin', 'audit-failures'] }),
      ]);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = correctionFailure(error);
      if (failure.close) {
        toaster.create({ type: 'error', title: failure.message });
        onClose();
      } else {
        setRefusal(failure.message);
        void client.invalidateQueries({ queryKey: ADMIN_RECONCILIATION_KEY });
      }
    },
  });
  return { mutation, refusal };
}

type CorrectionReadState = { error: string | null; fetching: boolean; retry: () => void };

function CorrectionReadWarning({ read }: { read: CorrectionReadState }) {
  return read.error ? (
    <Stack gap="2">
      <Alert.Root status="warning" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{read.error}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
      <Button
        type="button"
        variant="outline"
        alignSelf="start"
        loading={read.fetching}
        onClick={read.retry}
      >
        {copy.retry}
      </Button>
    </Stack>
  ) : null;
}

type CorrectionQuery = ReturnType<typeof useCorrectionDetail>;
function correctionReadState(query: CorrectionQuery): CorrectionReadState {
  return {
    error: query.isError ? correctionFailure(query.error).message : null,
    fetching: query.isFetching,
    retry: () => void query.refetch(),
  };
}

/** One Shell survives loading, candidate selection and the pinned request form. Replacing the
 * Dialog.Root during selection restores the old dialog's focus into the new dialog's outside area. */
function CorrectionRequestDialog({
  query,
  onClose,
}: {
  query: CorrectionQuery;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const detail = query.data;
  const read = correctionReadState(query);
  const [pinned, setPinned] = useState<{
    resultId: string;
    candidate: ReconciliationCorrectionCandidate;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [userReason, setUserReason] = useState('');
  const member = pinned?.candidate.accountKind === 'user';
  const draft = correctionReasonDraft(reason, userReason, member);
  const stale =
    pinned !== null &&
    (detail?.result.id !== pinned.resultId ||
      !detail.candidates.some((item) => sameCorrectionCandidate(item, pinned.candidate)));
  const pending =
    pinned !== null &&
    detail?.requests.some(
      (item) =>
        item.status === 'pending' && item.candidate.accountId === pinned.candidate.accountId,
    );
  const { mutation, refusal } = useCorrectionWrite(async (by) => {
    if (pinned === null) throw new Error('No correction candidate selected');
    const { accountId, mode, amountCoin, snapshotKey } = pinned.candidate;
    return unwrap(
      await api.POST('/api/v1/admin/reconciliation/results/{resultId}/correction-requests', {
        params: { path: { resultId: pinned.resultId } },
        body: {
          expectedAccountId: by,
          accountId,
          mode,
          amountCoin,
          snapshotKey,
          reason: draft.reason,
          userReason: draft.userReason,
        },
      }),
    ).data;
  }, onClose);
  return (
    <ReviewDialogShell
      testId={pinned ? 'correction-request-dialog' : 'correction-preview-dialog'}
      title={pinned ? copy.reconciliationCorrectionRequest : copy.reconciliationCorrectionPreview}
      body={pinned ? copy.reconciliationCorrectionRequestBody : copy.reconciliationCorrectionIntro}
      confirmLabel={pinned ? copy.reconciliationCorrectionRequest : copy.close}
      pending={mutation.isPending}
      confirmDisabled={
        pinned !== null &&
        (operatorId === undefined ||
          !draft.ready ||
          stale ||
          pending === true ||
          read.error !== null)
      }
      refusal={
        refusal ??
        (stale
          ? copy.reconciliationCorrectionStale
          : pending
            ? copy.reconciliationCorrectionPending
            : null)
      }
      onClose={onClose}
      onConfirm={() => {
        if (pinned === null) onClose();
        else if (operatorId !== undefined) mutation.mutate(operatorId);
      }}
    >
      <CorrectionReadWarning read={read} />
      {pinned ? (
        <>
          <CorrectionFacts candidate={pinned.candidate} />
          {member && (
            <ReasonField
              testId="correction-user-reason"
              label={copy.reconciliationCorrectionUserReason}
              hint={copy.reconciliationCorrectionUserReasonHint}
              value={userReason}
              onChange={setUserReason}
              error={null}
              disabled={mutation.isPending}
            />
          )}
          <ReasonField
            testId="correction-internal-reason"
            label={copy.reconciliationCorrectionInternalReason}
            hint={copy.reconciliationCorrectionInternalReasonHint}
            value={reason}
            onChange={setReason}
            error={null}
            disabled={mutation.isPending}
          />
        </>
      ) : query.isPending ? (
        <Skeleton height="24" />
      ) : (
        detail && (
          <Stack gap="4">
            {detail.candidates.length === 0 && (
              <Text>{copy.reconciliationCorrectionNotEligible}</Text>
            )}
            {detail.candidates.map((item) => (
              <Stack
                key={`${item.accountId}-${item.mode}`}
                gap="3"
                borderWidth="1px"
                borderRadius="l2"
                p="3"
              >
                <CorrectionFacts candidate={item} />
                <Button
                  type="button"
                  size="sm"
                  alignSelf="start"
                  disabled={
                    operatorId === undefined ||
                    query.isError ||
                    detail.requests.some(
                      (row) =>
                        row.status === 'pending' && row.candidate.accountId === item.accountId,
                    )
                  }
                  data-testid={`correction-select-${item.accountId}-${item.mode}`}
                  onClick={() => setPinned({ resultId: detail.result.id, candidate: item })}
                >
                  {copy.reconciliationCorrectionRequest}
                </Button>
              </Stack>
            ))}
          </Stack>
        )
      )}
    </ReviewDialogShell>
  );
}

const ACTION_COPY = {
  approve: [copy.reconciliationCorrectionApprove, copy.reconciliationCorrectionApproveBody],
  reject: [copy.reconciliationCorrectionReject, copy.reconciliationCorrectionRejectBody],
  retract: [copy.reconciliationCorrectionRetract, copy.reconciliationCorrectionRetractBody],
} as const;

function CorrectionDecisionDialog({
  query,
  requestId,
  action,
  onClose,
}: {
  query: CorrectionQuery;
  requestId: string;
  action: CorrectionAction;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const detail = query.data;
  const read = correctionReadState(query);
  const request = detail?.requests.find((row) => row.id === requestId);
  const [pinned, setPinned] = useState<ReconciliationCorrectionRequest | null>(null);
  // Pin once when the first response arrives, while retaining this same dialog root.
  if (pinned === null && request) setPinned(request);
  const [reason, setReason] = useState('');
  const draft = correctionReasonDraft(reason, '', false);
  const state = request ? correctionRequestState(request, operatorId) : null;
  const changed = pinned !== null && (pinned.id !== request?.id || request.status !== 'pending');
  const stale =
    pinned !== null &&
    !detail?.candidates.some((item) => sameCorrectionCandidate(item, pinned.candidate));
  const allowed =
    action === 'approve'
      ? state?.canApprove && !stale
      : action === 'reject'
        ? state?.canReject
        : state?.canRetract;
  const [title, body] = ACTION_COPY[action];
  const { mutation, refusal } = useCorrectionWrite(async (by) => {
    if (pinned === null) throw new Error('No correction request loaded');
    const path = { resultId: pinned.resultId, requestId: pinned.id };
    if (action === 'retract')
      return unwrap(
        await api.POST(
          '/api/v1/admin/reconciliation/results/{resultId}/correction-requests/{requestId}/retract',
          { params: { path }, body: { expectedAccountId: by } },
        ),
      ).data;
    if (action === 'reject')
      return unwrap(
        await api.POST(
          '/api/v1/admin/reconciliation/results/{resultId}/correction-requests/{requestId}/reject',
          { params: { path }, body: { expectedAccountId: by, reason: draft.reason } },
        ),
      ).data;
    return unwrap(
      await api.POST(
        '/api/v1/admin/reconciliation/results/{resultId}/correction-requests/{requestId}/approve',
        { params: { path }, body: { expectedAccountId: by, reason: draft.reason } },
      ),
    ).data;
  }, onClose);
  return (
    <ReviewDialogShell
      testId={`correction-${action}-dialog`}
      title={title}
      body={body}
      confirmLabel={title}
      pending={mutation.isPending}
      confirmDisabled={
        operatorId === undefined ||
        !allowed ||
        changed ||
        pinned === null ||
        (action !== 'retract' && !draft.ready) ||
        read.error !== null
      }
      refusal={
        refusal ??
        (changed
          ? copy.reconciliationCorrectionChanged
          : !request && query.isSuccess
            ? copy.reconciliationCorrectionNotFound
            : action === 'approve' && stale
              ? copy.reconciliationCorrectionStale
              : null)
      }
      onClose={onClose}
      onConfirm={() => {
        if (operatorId !== undefined) mutation.mutate(operatorId);
      }}
    >
      <CorrectionReadWarning read={read} />
      {query.isPending ? (
        <Skeleton height="24" />
      ) : (
        pinned && (
          <>
            <CorrectionFacts candidate={pinned.candidate} />
            {pinned.userReason !== null && (
              <Stack gap="1">
                <Text fontWeight="medium">{copy.reconciliationCorrectionUserReason}</Text>
                <Text whiteSpace="pre-wrap" wordBreak="break-word">
                  {pinned.userReason}
                </Text>
              </Stack>
            )}
            <Stack gap="1">
              <Text fontWeight="medium">{copy.reconciliationCorrectionInternalReason}</Text>
              <Text whiteSpace="pre-wrap" wordBreak="break-word">
                {pinned.reason}
              </Text>
            </Stack>
            {state?.own && <Text>{copy.reconciliationOwnRequest}</Text>}
            {action !== 'retract' && (
              <ReasonField
                testId="correction-decision-reason"
                label={copy.reconciliationCorrectionInternalReason}
                hint={copy.reconciliationCorrectionInternalReasonHint}
                value={reason}
                onChange={setReason}
                error={null}
                disabled={mutation.isPending}
              />
            )}
          </>
        )
      )}
    </ReviewDialogShell>
  );
}

/** The caller holds this target for the operator who opened it. Each flow keeps one Shell. */
export function CorrectionDialog({
  target,
  onClose,
}: {
  target: CorrectionDialogTarget;
  onClose: () => void;
}) {
  const query = useCorrectionDetail(target.resultId);
  return target.action === 'preview' ? (
    <CorrectionRequestDialog query={query} onClose={onClose} />
  ) : (
    <CorrectionDecisionDialog
      query={query}
      requestId={target.requestId}
      action={target.action}
      onClose={onClose}
    />
  );
}
