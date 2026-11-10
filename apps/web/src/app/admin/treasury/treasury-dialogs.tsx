'use client';

import { Alert, Button, Field, Input, Skeleton, Stack, Text } from '@chakra-ui/react';
import { COIN_AMOUNT_INPUT_MAX_LENGTH, formatCoin } from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { ADMIN_TREASURY_KEY, applyTreasuryWrite, useTreasuryRequest } from '@/hooks/use-treasury';
import { api, unwrap, type TreasuryIssueRequest, type TreasuryIssueWrite } from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import {
  treasuryFailure,
  treasuryIssueDraft,
  treasuryReasonDraft,
  treasuryRequestState,
  type TreasuryAction,
} from '@/lib/treasury';
import { ReasonField, ReviewDialogShell } from '../markets/[id]/market-review-dialogs';

export type TreasuryDialogTarget =
  { action: 'request' } | { action: TreasuryAction; requestId: string };

export function TreasuryRequestFacts({ request }: { request: TreasuryIssueRequest }) {
  return (
    <Stack gap="2" data-testid="treasury-request-facts">
      <Text fontWeight="semibold">
        {copy.treasuryIssueAmount} {formatCoin(BigInt(request.amountCoin))}
      </Text>
      <Text fontSize="sm">
        {copy.treasuryRequestedBy} {nicknameShown(request.requestedBy.nickname)}
      </Text>
      <Text fontSize="sm">{formatKst(request.requestedAt)}</Text>
      <Stack gap="1">
        <Text fontWeight="medium">{copy.treasuryIssueReason}</Text>
        <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
          {request.reason}
        </Text>
      </Stack>
    </Stack>
  );
}

function useTreasuryWrite(
  send: (by: string) => Promise<TreasuryIssueWrite>,
  onClose: () => void,
  success: string,
) {
  const client = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onMutate: () => setRefusal(null),
    onSuccess: async (fresh) => {
      await applyTreasuryWrite(client, fresh);
      toaster.create({ type: 'success', title: success });
      onClose();
      void client.invalidateQueries({ queryKey: ADMIN_TREASURY_KEY });
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = treasuryFailure(error);
      if (failure.close) {
        toaster.create({ type: 'error', title: failure.message });
        onClose();
      } else setRefusal(failure.message);
      void client.invalidateQueries({ queryKey: ADMIN_TREASURY_KEY });
    },
  });
  return { mutation, refusal };
}

function TreasuryRequestDialog({ onClose }: { onClose: () => void }) {
  const operatorId = useOperatorId();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const draft = treasuryIssueDraft(amount, reason);
  const { mutation, refusal } = useTreasuryWrite(
    async (by) =>
      unwrap(
        await api.POST('/api/v1/admin/treasury/issue-requests', {
          body: { expectedAccountId: by, amountCoin: draft.amountCoin, reason: draft.reason },
        }),
      ).data,
    onClose,
    copy.treasuryIssueSaved,
  );
  return (
    <ReviewDialogShell
      testId="treasury-request-dialog"
      title={copy.treasuryIssueRequest}
      body={copy.treasuryIssueRequestBody}
      confirmLabel={copy.treasuryIssueRequest}
      pending={mutation.isPending}
      confirmDisabled={operatorId === undefined || !draft.ready}
      refusal={refusal}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId !== undefined) mutation.mutate(operatorId);
      }}
    >
      <Field.Root invalid={amount.trim() !== '' && !draft.validAmount}>
        <Field.Label>{copy.treasuryIssueAmount}</Field.Label>
        <Input
          inputMode="numeric"
          value={amount}
          maxLength={COIN_AMOUNT_INPUT_MAX_LENGTH}
          disabled={mutation.isPending}
          onChange={(event) => setAmount(event.target.value)}
          data-testid="treasury-issue-amount"
        />
        <Field.HelperText>{copy.treasuryIssueAmountHint}</Field.HelperText>
        <Field.ErrorText>{copy.treasuryIssueAmountInvalid}</Field.ErrorText>
      </Field.Root>
      <ReasonField
        testId="treasury-issue-reason"
        label={copy.treasuryIssueReason}
        hint={copy.treasuryIssueReasonHint}
        value={reason}
        onChange={setReason}
        error={null}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

const ACTION_COPY = {
  approve: [copy.treasuryIssueApprove, copy.treasuryIssueApproveBody],
  reject: [copy.treasuryIssueReject, copy.treasuryIssueRejectBody],
  retract: [copy.treasuryIssueRetract, copy.treasuryIssueRetractBody],
} as const;

function TreasuryDecisionDialog({
  requestId,
  action,
  onClose,
}: {
  requestId: string;
  action: TreasuryAction;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const query = useTreasuryRequest(requestId);
  const request = query.data;
  const [pinned, setPinned] = useState<TreasuryIssueRequest | null>(null);
  // Keep one Shell across loading and the fixed proposal. The amount is never an input here.
  if (pinned === null && request) setPinned(request);
  const [reason, setReason] = useState('');
  const draft = treasuryReasonDraft(reason);
  const state = request ? treasuryRequestState(request, operatorId) : null;
  const changed =
    pinned !== null &&
    query.isSuccess &&
    (request?.id !== pinned.id ||
      request.status !== 'pending' ||
      request.amountCoin !== pinned.amountCoin ||
      request.reason !== pinned.reason ||
      request.requestedBy.id !== pinned.requestedBy.id);
  const allowed =
    action === 'approve'
      ? state?.canApprove
      : action === 'reject'
        ? state?.canReject
        : state?.canRetract;
  const [title, body] = ACTION_COPY[action];
  const { mutation, refusal } = useTreasuryWrite(
    async (by) => {
      if (pinned === null) throw new Error('No treasury request loaded');
      const path = { id: pinned.id };
      if (action === 'retract')
        return unwrap(
          await api.POST('/api/v1/admin/treasury/issue-requests/{id}/retract', {
            params: { path },
            body: { expectedAccountId: by },
          }),
        ).data;
      if (action === 'reject')
        return unwrap(
          await api.POST('/api/v1/admin/treasury/issue-requests/{id}/reject', {
            params: { path },
            body: { expectedAccountId: by, reason: draft.reason },
          }),
        ).data;
      return unwrap(
        await api.POST('/api/v1/admin/treasury/issue-requests/{id}/approve', {
          params: { path },
          body: { expectedAccountId: by, reason: draft.reason },
        }),
      ).data;
    },
    onClose,
    copy.treasuryIssueDecisionSaved,
  );
  return (
    <ReviewDialogShell
      testId={`treasury-${action}-dialog`}
      title={title}
      body={body}
      confirmLabel={title}
      pending={mutation.isPending}
      confirmDisabled={
        operatorId === undefined ||
        !allowed ||
        changed ||
        pinned === null ||
        query.isError ||
        (action !== 'retract' && !draft.ready)
      }
      refusal={refusal ?? (changed ? copy.treasuryIssueChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId !== undefined) mutation.mutate(operatorId);
      }}
    >
      {query.isError && (
        <Stack gap="2">
          <Alert.Root status="warning" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{treasuryFailure(query.error).message}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button
            type="button"
            variant="outline"
            alignSelf="start"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {copy.retry}
          </Button>
        </Stack>
      )}
      {query.isPending ? (
        <Skeleton height="24" />
      ) : (
        pinned && (
          <>
            <TreasuryRequestFacts request={pinned} />
            {state?.own && <Text>{copy.treasuryIssueOwnRequest}</Text>}
            {action !== 'retract' && (
              <ReasonField
                testId="treasury-decision-reason"
                label={copy.treasuryIssueDecisionReason}
                hint={copy.treasuryIssueDecisionReasonHint}
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

/** The caller holds this target for the operator who opened it, dropping its draft on change. */
export function TreasuryDialog({
  target,
  onClose,
}: {
  target: TreasuryDialogTarget;
  onClose: () => void;
}) {
  return target.action === 'request' ? (
    <TreasuryRequestDialog onClose={onClose} />
  ) : (
    <TreasuryDecisionDialog action={target.action} requestId={target.requestId} onClose={onClose} />
  );
}
