'use client';

import { Field, Input, NativeSelect, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ReconciliationTarget } from '@buddha/shared';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ADMIN_RECONCILIATION_KEY, applyReconciliationWrite } from '@/hooks/use-reconciliation';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { api, unwrap, type ReconciliationHoldDetail, type ReconciliationRun } from '@/lib/api';
import { revertDraft } from '@/lib/market-review';
import {
  type ReconciliationInputKind,
  type RecoveryAction,
  reconciliationFailure,
  reconciliationRecoveryState,
  reconciliationTargetDraft,
} from '@/lib/reconciliation';
import { ReasonField, ReviewDialogShell } from '../markets/[id]/market-review-dialogs';

/** The parent holds each dialog for the operator who opened it (ADR-0092). */
function useReconciliationWrite<T>(
  send: (value: T) => Promise<ReconciliationRun | ReconciliationHoldDetail>,
  onClose: () => void,
) {
  const client = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onMutate: () => setRefusal(null),
    onSuccess: async (fresh) => {
      await applyReconciliationWrite(client, fresh);
      onClose();
      await Promise.all([
        client.invalidateQueries({ queryKey: ADMIN_RECONCILIATION_KEY }),
        client.invalidateQueries({ queryKey: ['admin', 'audit-failures'] }),
        client.invalidateQueries({ queryKey: ['admin', 'market'] }),
        client.invalidateQueries({ queryKey: ['admin', 'markets'] }),
      ]);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = reconciliationFailure(error);
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

export function RunReconciliationDialog({
  target: fixedTarget,
  onClose,
}: {
  target: ReconciliationTarget | null;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const [kind, setKind] = useState<ReconciliationInputKind>('market');
  const [input, setInput] = useState('');
  const target = fixedTarget ?? reconciliationTargetDraft(kind, input);
  const { mutation, refusal } = useReconciliationWrite(
    async ({ by, target }: { by: string; target: ReconciliationTarget }) => {
      const result = unwrap(
        await api.POST('/api/v1/admin/reconciliation/run', {
          body: { expectedAccountId: by, target },
        }),
      ).data;
      toaster.create({
        type: result.result.passed ? 'success' : 'warning',
        title: copy.reconciliationRan,
      });
      return result;
    },
    onClose,
  );
  return (
    <ReviewDialogShell
      testId="reconciliation-run-dialog"
      title={copy.reconciliationRun}
      body={copy.reconciliationRunBody}
      confirmLabel={copy.reconciliationRun}
      pending={mutation.isPending}
      confirmDisabled={operatorId === undefined || target === null}
      refusal={refusal}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId !== undefined && target !== null)
          mutation.mutate({ by: operatorId, target });
      }}
    >
      {fixedTarget === null && (
        <Stack gap="4">
          <Field.Root>
            <Field.Label>{copy.reconciliationTarget}</Field.Label>
            <NativeSelect.Root disabled={mutation.isPending}>
              <NativeSelect.Field
                value={kind}
                data-testid="reconciliation-run-kind"
                onChange={(event) => {
                  setKind(event.target.value as ReconciliationInputKind);
                  setInput('');
                }}
              >
                <option value="market">{copy.reconciliationMarket}</option>
                <option value="user">{copy.reconciliationUser}</option>
                <option value="account">{copy.reconciliationLedgerAccount}</option>
                <option value="supply">{copy.reconciliationSupply}</option>
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>
          {kind !== 'supply' && (
            <Field.Root>
              <Field.Label>{copy.reconciliationTargetId}</Field.Label>
              <Input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={mutation.isPending}
                data-testid="reconciliation-run-id"
                inputMode={kind === 'account' ? 'numeric' : 'text'}
                autoComplete="off"
              />
              <Field.HelperText>
                {kind === 'market'
                  ? copy.reconciliationMarketIdHint
                  : kind === 'user'
                    ? copy.reconciliationUserIdHint
                    : copy.reconciliationAccountIdHint}
              </Field.HelperText>
            </Field.Root>
          )}
        </Stack>
      )}
    </ReviewDialogShell>
  );
}

const actionCopy = {
  request: [copy.reconciliationRequest, copy.reconciliationRequestBody],
  approve: [copy.reconciliationApprove, copy.reconciliationApproveBody],
  reject: [copy.reconciliationReject, copy.reconciliationRejectBody],
  retract: [copy.reconciliationRetract, copy.reconciliationRetractBody],
} as const;

export function ReconciliationRecoveryDialog({
  detail,
  action,
  onClose,
}: {
  detail: ReconciliationHoldDetail;
  action: RecoveryAction;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const state = reconciliationRecoveryState(detail, operatorId);
  const [pinned] = useState(() => ({
    holdId: detail.hold.id,
    failureResultId: detail.hold.failureResultId,
    request: state.pending,
  }));
  const changed =
    detail.hold.id !== pinned.holdId ||
    (action === 'request'
      ? detail.hold.failureResultId !== pinned.failureResultId
      : state.pending?.id !== pinned.request?.id);
  const allowed =
    action === 'request'
      ? state.canRequest
      : action === 'approve'
        ? state.canApprove
        : action === 'reject'
          ? state.canReject
          : state.canRetract;
  const [reason, setReason] = useState('');
  const draft = revertDraft(reason);
  const needsReason = action !== 'retract';
  const [title, body] = actionCopy[action];
  const { mutation, refusal } = useReconciliationWrite(async ({ by }: { by: string }) => {
    const path = { holdId: pinned.holdId, requestId: pinned.request?.id ?? '' };
    let result;
    if (action === 'request') {
      result = await api.POST('/api/v1/admin/reconciliation/holds/{holdId}/recovery-requests', {
        params: { path: { holdId: pinned.holdId } },
        body: {
          expectedAccountId: by,
          failureResultId: pinned.failureResultId,
          reason: draft.reason,
        },
      });
    } else if (action === 'approve') {
      result = await api.POST(
        '/api/v1/admin/reconciliation/holds/{holdId}/recovery-requests/{requestId}/approve',
        {
          params: { path },
          body: { expectedAccountId: by, reason: draft.reason },
        },
      );
    } else if (action === 'reject') {
      result = await api.POST(
        '/api/v1/admin/reconciliation/holds/{holdId}/recovery-requests/{requestId}/reject',
        {
          params: { path },
          body: { expectedAccountId: by, reason: draft.reason },
        },
      );
    } else {
      result = await api.POST(
        '/api/v1/admin/reconciliation/holds/{holdId}/recovery-requests/{requestId}/retract',
        {
          params: { path },
          body: { expectedAccountId: by },
        },
      );
    }
    const fresh = unwrap(result).data;
    toaster.create({ type: 'success', title: copy.reconciliationSaved });
    return fresh;
  }, onClose);
  return (
    <ReviewDialogShell
      testId={`reconciliation-${action}-dialog`}
      title={title}
      body={body}
      confirmLabel={title}
      pending={mutation.isPending}
      confirmDisabled={!allowed || changed || (needsReason && !draft.ready)}
      refusal={refusal ?? (changed ? copy.reconciliationChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId !== undefined) mutation.mutate({ by: operatorId });
      }}
    >
      {pinned.request && (
        <Text whiteSpace="pre-wrap" wordBreak="break-word">
          {pinned.request.reason}
        </Text>
      )}
      {needsReason && (
        <ReasonField
          testId="reconciliation-reason"
          label={copy.reconciliationReason}
          hint={copy.reconciliationReasonHint}
          value={reason}
          onChange={setReason}
          error={null}
          disabled={mutation.isPending}
        />
      )}
    </ReviewDialogShell>
  );
}
