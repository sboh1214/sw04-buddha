'use client';

import { Stack, Text } from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, type MarketCancelRequest, api, unwrap } from '@/lib/api';
import { type CancelWrite, cancelFailure } from '@/lib/market-cancel';
import { revertDraft } from '@/lib/market-review';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * The 시장 취소's dialogs (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로'): 시장 취소 요청
 * (the reason — the cancel's public one, the field says so), then the waiting request's 승인 (the
 * approver's reason, admins only), 반려 (the reason) and 철회 (the requester's: nothing to fill in).
 * Drawn in the review's frame (`ReviewDialogShell`), each confirm off until its reason is whole and
 * until the admin on screen is known (`useOperatorId`, ADR-0092): every write names that admin.
 * Each decision names the request it was opened on (`usePinnedCancel`). A refusal stays in the
 * dialog, under the reason or above the buttons (`cancelFailure`); another account's cookie closes
 * it with a toast. Sent, it closes with a toast and the market as the write committed it goes on
 * screen (`useApplyMarket`).
 */

export type CancelDialogKind = 'request' | 'approve' | 'reject' | 'retract';

export function CancelDialog({
  kind,
  market,
  onClose,
}: {
  kind: CancelDialogKind;
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  switch (kind) {
    case 'request':
      return <RequestCancelDialog market={market} onClose={onClose} />;
    case 'approve':
    case 'reject':
      return <DecideCancelDialog kind={kind} market={market} onClose={onClose} />;
    case 'retract':
      return <RetractCancelDialog market={market} onClose={onClose} />;
  }
}

/**
 * The request a decision dialog was opened on, kept from its first draw, so a request retracted
 * and another made meanwhile is decided by no confirmation its admin gave the old one. `changed`
 * once the market's waiting request is another (or none).
 */
function usePinnedCancel(market: AdminMarket) {
  const [request] = useState(() => market.cancel.pending);
  return {
    request,
    changed: request === null || market.cancel.pending?.requestId !== request.requestId,
  };
}

/** The reason of the request a decision dialog decides: what the cancel would say in public. */
function PinnedReasonLine({
  request,
  testId,
}: {
  request: MarketCancelRequest | null;
  testId: string;
}) {
  if (request === null) return null;
  return (
    <Text
      fontSize="sm"
      color="fg.muted"
      whiteSpace="pre-wrap"
      wordBreak="break-word"
      data-testid={testId}
    >
      {copy.adminMarketCancelReason} {request.reason}
    </Text>
  );
}

/** One cancel write: sent as the admin on screen, its refusal said, its answer applied. */
function useCancelWrite<V>(
  market: AdminMarket,
  onClose: (sent: boolean) => void,
  write: CancelWrite,
  success: string,
  send: (variables: V) => Promise<AdminMarket>,
) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: success });
      onClose(true);
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = cancelFailure(error, write);
      if (failure.kind === 'toast') {
        toaster.create({ type: 'error', title: failure.message });
        onClose(false);
        return;
      }
      if (failure.kind === 'field') {
        setFieldError(failure.message);
        return;
      }
      setRefusal(failure.message);
      if (failure.refresh) {
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });
  return { mutation, fieldError, refusal };
}

/**
 * 시장 취소 요청 (SCHEDULED, one admin): the confirm waits for a reason (`revertDraft`: 1..500
 * trimmed), which becomes the cancel's public reason once another admin approves it.
 */
function RequestCancelDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const { mutation, fieldError, refusal } = useCancelWrite(
    market,
    onClose,
    'request',
    copy.adminMarketCancelRequested,
    async ({ reason, by }: { reason: string; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/cancel-requests', {
          params: { path: { id: market.id } },
          body: { reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-cancel-request-dialog"
      title={copy.adminMarketCancelRequestTitle}
      body={copy.adminMarketCancelRequestBody}
      confirmLabel={copy.adminMarketCancelRequest}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined}
      refusal={refusal}
      onClose={() => onClose(false)}
      onConfirm={() => {
        if (operatorId !== undefined) mutation.mutate({ reason: draft.reason, by: operatorId });
      }}
    >
      <ReasonField
        testId="market-cancel-request-reason"
        label={copy.adminMarketCancelReason}
        hint={copy.adminMarketCancelReasonHint}
        value={reasonText}
        onChange={setReasonText}
        error={fieldError}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/**
 * 승인 (the market is cancelled at once: SCHEDULED → CANCELLED) or 반려 (nothing changes), by an
 * admin other than the requester. The confirm waits for a reason.
 */
function DecideCancelDialog({
  kind,
  market,
  onClose,
}: {
  kind: 'approve' | 'reject';
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const decided = usePinnedCancel(market);
  const approve = kind === 'approve';
  const { mutation, fieldError, refusal } = useCancelWrite(
    market,
    onClose,
    'decision',
    approve ? copy.adminMarketCancelled : copy.adminMarketPauseRejected,
    async ({ requestId, reason, by }: { requestId: string; reason: string; by: string }) =>
      unwrap(
        approve
          ? await api.POST('/api/v1/admin/markets/{id}/cancel-requests/{requestId}/approve', {
              params: { path: { id: market.id, requestId } },
              body: { reason, expectedAccountId: by },
            })
          : await api.POST('/api/v1/admin/markets/{id}/cancel-requests/{requestId}/reject', {
              params: { path: { id: market.id, requestId } },
              body: { reason, expectedAccountId: by },
            }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId={`market-cancel-${kind}-dialog`}
      title={approve ? copy.adminMarketCancelApproveTitle : copy.adminMarketCancelRejectTitle}
      body={approve ? copy.adminMarketCancelApproveBody : copy.adminMarketPauseRejectBody}
      confirmLabel={approve ? copy.adminMarketPauseApprove : copy.adminMarketPauseReject}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || decided.changed}
      refusal={refusal ?? (decided.changed ? copy.adminMarketPauseRequestChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = decided.request?.requestId;
        if (operatorId === undefined || requestId === undefined) return;
        mutation.mutate({ requestId, reason: draft.reason, by: operatorId });
      }}
    >
      <Stack gap="4">
        <PinnedReasonLine request={decided.request} testId={`market-cancel-${kind}-request`} />
        <ReasonField
          testId={`market-cancel-${kind}-reason`}
          label={approve ? copy.adminMarketPauseApproveReason : copy.adminMarketPauseRejectReason}
          hint={copy.adminMarketCancelDecisionHint}
          value={reasonText}
          onChange={setReasonText}
          error={fieldError}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/** 철회 (the requester's alone, any status): nothing to fill in, the confirm says what it does. */
function RetractCancelDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const decided = usePinnedCancel(market);
  const { mutation, refusal } = useCancelWrite(
    market,
    onClose,
    'decision',
    copy.adminMarketPauseRetracted,
    async ({ requestId, by }: { requestId: string; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/cancel-requests/{requestId}/retract', {
          params: { path: { id: market.id, requestId } },
          body: { expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-cancel-retract-dialog"
      title={copy.adminMarketCancelRetractTitle}
      body={copy.adminMarketPauseRetractBody}
      confirmLabel={copy.adminMarketPauseRetract}
      pending={mutation.isPending}
      confirmDisabled={operatorId === undefined || decided.changed}
      refusal={refusal ?? (decided.changed ? copy.adminMarketPauseRequestChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = decided.request?.requestId;
        if (operatorId !== undefined && requestId !== undefined) {
          mutation.mutate({ requestId, by: operatorId });
        }
      }}
    >
      <PinnedReasonLine request={decided.request} testId="market-cancel-retract-request" />
    </ReviewDialogShell>
  );
}
