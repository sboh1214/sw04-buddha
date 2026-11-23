'use client';

import { MARKET_CONFLICTS_KEY, useMarketConflicts } from '@/hooks/use-market-conflicts';
import { NoConflictConfirmation } from './market-conflict-panel';

import { Stack, Text } from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, type MarketJudgementCompensationPending, api, unwrap } from '@/lib/api';
import {
  COMPENSATION_DECISION_TEXTS,
  type CompensationDecision,
  type CompensationField,
  type CompensationRequestValues,
  compensationFailure,
  compensationRequestDraft,
  compensationReviewUnavailable,
  compensationSummaryText,
  compensationUnrequestable,
  compensationUnrequestableNote,
} from '@/lib/market-judgement-compensation';
import { revertDraft } from '@/lib/market-review';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * The 판정 오류 보상's dialogs (#144 part 2, ADR-0166; owner answers 144-1·144-2·144-4·144-7·144-12·
 * 144-16; ADR-0120 decision 5): 보상 요청 (what the server computed now — no account and no amount
 * to type, 144-1 —, the internal reason, the reason the compensated members read in their wallets,
 * 144-12, and the unchecked 이해충돌 없음 confirmation), and on the waiting request 보상 승인 (the
 * decision's reason and the confirmation again — the approval pays at once, 144-2), 보상 반려 (a
 * reason alone: a 정리 목적의 반려, no conflict confirmation) and its requester's 철회 (nothing to
 * fill in). Drawn in the review's frame (`ReviewDialogShell`), each confirm off until the admin on
 * screen is known (`useOperatorId`, ADR-0092) — every write names that admin — and mounted only
 * while the panel holds it for the admin who opened it (`useHeldForOperator`). Each decision
 * decides the request it was opened on (`usePinnedRequest`). A refusal stays in the dialog, under
 * the reason it is about or above the buttons (`compensationFailure`); another account's cookie
 * closes it with a toast. Sent, it closes with a toast and the market as the write committed it
 * goes on screen (`useApplyMarket`), the panel putting focus on its heading.
 */
export function JudgementCompensationDialog({
  kind,
  market,
  onClose,
}: {
  kind: 'request' | CompensationDecision;
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  switch (kind) {
    case 'request':
      return <RequestCompensationDialog market={market} onClose={onClose} />;
    case 'approve':
      return <ApproveCompensationDialog market={market} onClose={onClose} />;
    case 'reject':
      return <RejectCompensationDialog market={market} onClose={onClose} />;
    case 'retract':
      return <RetractCompensationDialog market={market} onClose={onClose} />;
  }
}

/**
 * The request a dialog was opened on, kept from its first draw with what it says — so one decided
 * or retracted meanwhile is decided by no reason its admin gave the old one. `changed` once the
 * market's waiting request is another (or none); the server refuses the old one regardless
 * ('decided', 'retracted').
 */
function usePinnedRequest(market: AdminMarket) {
  const [request] = useState(() => market.judgementIncident.compensation?.pending ?? null);
  return {
    request,
    changed:
      request === null ||
      market.judgementIncident.compensation?.pending?.requestId !== request.requestId,
  };
}

/**
 * One compensation write: sent as the admin on screen, its refusal said where `compensationFailure`
 * puts it — the detail read again when the screen behind is out of date — and its answer applied.
 */
function useCompensationWrite<V>(
  market: AdminMarket,
  onClose: (sent: boolean) => void,
  success: string,
  send: (variables: V) => Promise<AdminMarket>,
) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [fieldError, setFieldError] = useState<{
    field: CompensationField;
    message: string;
  } | null>(null);
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
      const failure = compensationFailure(error);
      if (failure.kind === 'toast') {
        // Another account's cookie: the panel drops this dialog once the session names the admin
        // really signed in, so the refusal is a toast that outlives it.
        toaster.create({ type: 'error', title: failure.message });
        onClose(false);
        return;
      }
      if (failure.kind === 'field') {
        setFieldError({ field: failure.field, message: failure.message });
        return;
      }
      setRefusal(failure.message);
      if (failure.refresh) {
        void queryClient.invalidateQueries({ queryKey: [...MARKET_CONFLICTS_KEY, market.id] });
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });
  return { mutation, fieldError, refusal };
}

/** What a request sends, taken from the dialog when its confirm is pressed; `by` the admin. */
interface RequestVariables {
  request: CompensationRequestValues;
  by: string;
}

/**
 * 보상 요청 (144-1, 144-2, 144-12): what the server computed now (`preview` — the list it freezes is
 * the one it computes again under the request's lock), the two reasons, checked as the API checks
 * them (`compensationRequestDraft`) and said once the confirm was pressed, and the confirmation.
 * Once the market read takes no request (`compensationUnrequestable`) the dialog says why and sends
 * nothing. The requester may be the paid version's registrant (144-4 "보상 요청은 할 수 있다"); the
 * server refuses a request no other admin could approve (`no_decider`).
 */
function RequestCompensationDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const compensation = market.judgementIncident.compensation;
  const [values, setValues] = useState<CompensationRequestValues>({ reason: '', userReason: '' });
  const [tried, setTried] = useState(false);
  const [noConflict, setNoConflict] = useState(false);
  const conflicts = useMarketConflicts(market.id);
  const conflictBlocked = conflicts.data?.operator.conflicted === true;
  const draft = compensationRequestDraft(values);
  const unrequestable = compensation === null ? 'none' : compensationUnrequestable(compensation);
  const { mutation, fieldError, refusal } = useCompensationWrite(
    market,
    onClose,
    copy.adminMarketJudgementCompensationRequested,
    async ({ request, by }: RequestVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgement-compensations', {
          params: { path: { id: market.id } },
          body: { ...request, noConflictConfirmed: true, expectedAccountId: by },
        }),
      ).data,
  );
  const errorOf = (field: CompensationField) =>
    fieldError?.field === field ? fieldError.message : tried ? draft.errors[field] : null;
  const pending = mutation.isPending;
  const preview = compensation?.preview ?? null;
  return (
    <ReviewDialogShell
      testId="market-judgement-compensation-request-dialog"
      title={copy.adminMarketJudgementCompensationRequestTitle}
      body={copy.adminMarketJudgementCompensationRequestBody}
      confirmLabel={copy.adminMarketJudgementCompensationRequest}
      pending={pending}
      confirmDisabled={
        !noConflict || conflictBlocked || operatorId === undefined || unrequestable !== null
      }
      refusal={
        refusal ?? (unrequestable === null ? null : compensationUnrequestableNote(unrequestable))
      }
      onClose={() => onClose(false)}
      onConfirm={() => {
        setTried(true);
        if (
          !noConflict ||
          conflictBlocked ||
          operatorId === undefined ||
          unrequestable !== null ||
          draft.request === null
        )
          return;
        mutation.mutate({ request: draft.request, by: operatorId });
      }}
    >
      <Stack gap="4">
        {preview !== null && (
          <Text fontSize="sm" data-testid="market-judgement-compensation-request-dialog-preview">
            <Text as="span" fontWeight="medium">
              {copy.adminMarketJudgementCompensationPreview}
            </Text>{' '}
            {compensationSummaryText(
              preview.accountCount,
              formatCoin(parseCoinAmount(preview.totalCoin)),
            )}
          </Text>
        )}
        <ReasonField
          testId="market-judgement-compensation-request-reason"
          label={copy.adminMarketJudgementCompensationReason}
          hint={copy.adminMarketJudgementCompensationReasonHint}
          value={values.reason}
          onChange={(reason) => setValues((held) => ({ ...held, reason }))}
          error={errorOf('reason')}
          disabled={pending}
        />
        <ReasonField
          testId="market-judgement-compensation-request-user-reason"
          label={copy.adminMarketJudgementCompensationUserReason}
          hint={copy.adminMarketJudgementCompensationUserReasonHint}
          value={values.userReason}
          onChange={(userReason) => setValues((held) => ({ ...held, userReason }))}
          error={errorOf('userReason')}
          disabled={pending}
        />
        <NoConflictConfirmation
          blocked={conflictBlocked}
          checked={noConflict}
          onChecked={setNoConflict}
          disabled={pending}
          testId="market-judgement-compensation-request-confirm-conflict"
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/** What a decision sends, taken from the dialog when its confirm is pressed; `by` the admin. */
interface DecisionVariables {
  requestId: string;
  reason: string;
  by: string;
}

/**
 * 보상 승인 (144-2, 144-4; #143): by an admin who is neither the requester nor the paid version's
 * registrant, with the decision's reason (admins only) and the 이해충돌 없음 confirmation,
 * unchecked. The approval pays every listed account at once and cannot be undone; off while the
 * market is ledger-held or an account needs a ledger check (144-16), which the server refuses
 * again.
 */
function ApproveCompensationDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const texts = COMPENSATION_DECISION_TEXTS.approve;
  const pinned = usePinnedRequest(market);
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const [noConflict, setNoConflict] = useState(false);
  const conflicts = useMarketConflicts(market.id);
  const conflictBlocked = conflicts.data?.operator.conflicted === true;
  const unavailable = compensationReviewUnavailable(market, 'approve', operatorId);
  const { mutation, fieldError, refusal } = useCompensationWrite(
    market,
    onClose,
    texts.done,
    async ({ requestId, reason, by }: DecisionVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgement-compensations/{requestId}/approve', {
          params: { path: { id: market.id, requestId } },
          body: { reason, noConflictConfirmed: true, expectedAccountId: by },
        }),
      ).data,
  );
  const blockedCount = market.judgementIncident.compensation?.preview?.blockedCount ?? 0;
  const standing =
    unavailable === 'held'
      ? copy.adminMarketJudgementCompensationHeld
      : unavailable === 'blocked'
        ? copy.adminMarketJudgementCompensationBlockedNote.replace(
            '{n}',
            blockedCount.toLocaleString('ko-KR'),
          )
        : unavailable === 'registrant'
          ? copy.errMarketJudgementCompensationRegistrant
          : null;
  const testId = 'market-judgement-compensation-approve-dialog';
  return (
    <ReviewDialogShell
      testId={testId}
      title={texts.title}
      body={texts.body}
      confirmLabel={texts.confirm}
      pending={mutation.isPending}
      confirmDisabled={
        !noConflict ||
        conflictBlocked ||
        !draft.ready ||
        operatorId === undefined ||
        pinned.changed ||
        unavailable !== null
      }
      refusal={
        refusal ?? (pinned.changed ? copy.adminMarketJudgementCompensationChanged : standing)
      }
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = pinned.request?.requestId;
        if (
          !noConflict ||
          conflictBlocked ||
          operatorId === undefined ||
          requestId === undefined ||
          unavailable !== null
        )
          return;
        mutation.mutate({ requestId, reason: draft.reason, by: operatorId });
      }}
    >
      <Stack gap="4">
        <PinnedRequestLine request={pinned.request} testId={`${testId}-request`} />
        <NoConflictConfirmation
          blocked={conflictBlocked}
          checked={noConflict}
          onChecked={setNoConflict}
          disabled={mutation.isPending}
          testId="market-judgement-compensation-approve-confirm-conflict"
        />
        <ReasonField
          testId={`${testId}-reason`}
          label={copy.adminMarketJudgementCompensationDecisionReason}
          hint={copy.adminMarketJudgementCompensationDecisionReasonHint}
          value={reasonText}
          onChange={setReasonText}
          error={fieldError?.field === 'reason' ? fieldError.message : null}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/**
 * 보상 반려: any admin but the requester, with a reason alone — a 정리 목적의 반려 (ADR-0120 decision
 * 5: no conflict confirmation, the paid version's registrant included), most often to reword the
 * members' reason. Nothing is paid, and a new request may follow.
 */
function RejectCompensationDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const texts = COMPENSATION_DECISION_TEXTS.reject;
  const pinned = usePinnedRequest(market);
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const { mutation, fieldError, refusal } = useCompensationWrite(
    market,
    onClose,
    texts.done,
    async ({ requestId, reason, by }: DecisionVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgement-compensations/{requestId}/reject', {
          params: { path: { id: market.id, requestId } },
          body: { reason, expectedAccountId: by },
        }),
      ).data,
  );
  const testId = 'market-judgement-compensation-reject-dialog';
  return (
    <ReviewDialogShell
      testId={testId}
      title={texts.title}
      body={texts.body}
      confirmLabel={texts.confirm}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || pinned.changed}
      refusal={refusal ?? (pinned.changed ? copy.adminMarketJudgementCompensationChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = pinned.request?.requestId;
        if (operatorId === undefined || requestId === undefined) return;
        mutation.mutate({ requestId, reason: draft.reason, by: operatorId });
      }}
    >
      <Stack gap="4">
        <PinnedRequestLine request={pinned.request} testId={`${testId}-request`} />
        <ReasonField
          testId={`${testId}-reason`}
          label={copy.adminMarketJudgementCompensationDecisionReason}
          hint={copy.adminMarketJudgementCompensationDecisionReasonHint}
          value={reasonText}
          onChange={setReasonText}
          error={fieldError?.field === 'reason' ? fieldError.message : null}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/** 철회 (the requester's alone, before a decision): nothing to fill in. */
function RetractCompensationDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const texts = COMPENSATION_DECISION_TEXTS.retract;
  const pinned = usePinnedRequest(market);
  const { mutation, refusal } = useCompensationWrite(
    market,
    onClose,
    texts.done,
    async ({ requestId, by }: { requestId: string; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgement-compensations/{requestId}/retract', {
          params: { path: { id: market.id, requestId } },
          body: { expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-judgement-compensation-retract-dialog"
      title={texts.title}
      body={texts.body}
      confirmLabel={texts.confirm}
      pending={mutation.isPending}
      confirmDisabled={operatorId === undefined || pinned.changed}
      refusal={refusal ?? (pinned.changed ? copy.adminMarketJudgementCompensationChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = pinned.request?.requestId;
        if (operatorId !== undefined && requestId !== undefined) {
          mutation.mutate({ requestId, by: operatorId });
        }
      }}
    >
      <PinnedRequestLine
        request={pinned.request}
        testId="market-judgement-compensation-retract-dialog-request"
      />
    </ReviewDialogShell>
  );
}

/** What the request a dialog decides says: its frozen list's count and total, members' reason. */
function PinnedRequestLine({
  request,
  testId,
}: {
  request: MarketJudgementCompensationPending | null;
  testId: string;
}) {
  if (request === null) return null;
  return (
    <Stack gap="1" fontSize="sm" color="fg.muted" data-testid={testId}>
      <Text data-testid={`${testId}-summary`}>
        {compensationSummaryText(
          request.accountCount,
          formatCoin(parseCoinAmount(request.totalCoin)),
        )}
      </Text>
      <Text whiteSpace="pre-wrap" wordBreak="break-word" lineClamp={3}>
        {copy.adminMarketJudgementCompensationUserReason}: {request.userReason}
      </Text>
    </Stack>
  );
}
