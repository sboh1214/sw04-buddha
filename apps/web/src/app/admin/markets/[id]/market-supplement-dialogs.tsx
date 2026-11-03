'use client';

import { Field, NativeSelect, Stack } from '@chakra-ui/react';
import {
  MARKET_SUPPLEMENT_REJECT_REASONS,
  type MarketSupplementRejectReason,
} from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, api, unwrap } from '@/lib/api';
import { revertDraft } from '@/lib/market-review';
import {
  SUPPLEMENT_REJECT_REASON_LABEL,
  supplementFailure,
  supplementRejectDraft,
} from '@/lib/market-supplement';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * The 규칙 보충's three dialogs (#80, ADR-0101; ADR-0093 decision 2 #172 item 15): 승인 (the reason),
 * 반려 (a reason from the list — 의미 변경 says the change belongs to the pause procedure, #114,
 * which the 반려 itself does not start — and the 설명) and 철회 (the requester's: nothing to fill
 * in). Drawn in the review's frame (`ReviewDialogShell`), each confirm off until what it would send
 * is whole and until the admin on screen is known (`useOperatorId`, ADR-0092): every write names
 * that admin. Mounted only while the panel holds it for the admin who opened it
 * (`useHeldForOperator`), so what was picked and typed for A goes with it once `['me']` turns to B
 * (ADR-0092 answer 1). Each decides the request it was opened on (`useSupplementRequest`). A
 * refusal stays in the dialog, under the field it is about or above the buttons
 * (`supplementFailure`: an item rule the approval meets again — the close while PAUSED, the lead
 * close — is said there too); another account's cookie closes it with a toast. Sent, it closes
 * with a toast and the market as the write committed it goes on screen (`useApplyMarket`) — after
 * an approval, with its new version.
 */

export type SupplementDialogKind = 'approve' | 'reject' | 'retract';

export function SupplementDialog({
  kind,
  market,
  onClose,
}: {
  kind: SupplementDialogKind;
  market: AdminMarket;
  onClose: () => void;
}) {
  switch (kind) {
    case 'approve':
      return <ApproveSupplementDialog market={market} onClose={onClose} />;
    case 'reject':
      return <RejectSupplementDialog market={market} onClose={onClose} />;
    case 'retract':
      return <RetractSupplementDialog market={market} onClose={onClose} />;
  }
}

/**
 * The request a dialog was opened on: sent as `requestId` and kept from the dialog's first draw —
 * a refetch while it is open must not move it — so a request retracted and another made meanwhile
 * is decided by no confirmation its admin gave the old text. `changed` once the market's waiting
 * request is another (or none): the dialog says so and its confirm stays off; the server refuses
 * the old one regardless ('decided', 'retracted').
 */
function useSupplementRequest(market: AdminMarket): { requestId: string | null; changed: boolean } {
  const [requestId] = useState(() => market.supplement.pending?.requestId ?? null);
  return {
    requestId,
    changed: requestId === null || market.supplement.pending?.requestId !== requestId,
  };
}

/** The dialog fields a refusal can land under. */
type DialogField = 'reason' | 'rejectReason';

/** What each write sends, taken from the dialog when its confirm is pressed; `by` is the admin. */
interface ApproveVariables {
  requestId: string;
  reason: string;
  by: string;
}
interface RejectVariables {
  requestId: string;
  rejectReason: MarketSupplementRejectReason;
  reason: string;
  by: string;
}
interface RetractVariables {
  requestId: string;
  by: string;
}

/**
 * One supplement decision: sent as the admin on screen, its refusal said where `supplementFailure`
 * puts it — the detail read again when the screen behind is out of date — and its answer applied.
 */
function useSupplementWrite<V>(
  market: AdminMarket,
  onClose: () => void,
  success: string,
  send: (variables: V) => Promise<AdminMarket>,
) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [fieldError, setFieldError] = useState<{ field: DialogField; message: string } | null>(
    null,
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: success });
      onClose();
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = supplementFailure(error, undefined, market.leadCloseGapMinutes);
      if (failure.kind === 'toast') {
        // Another account's cookie: the page drops this dialog once the session names the admin
        // really signed in, so the refusal is a toast that outlives it.
        toaster.create({ type: 'error', title: failure.message });
        onClose();
        return;
      }
      if (
        failure.kind === 'field' &&
        (failure.field === 'reason' || failure.field === 'rejectReason')
      ) {
        setFieldError({ field: failure.field, message: failure.message });
      } else {
        // An item's rule has no input here: its sentence is the dialog's.
        setRefusal(failure.message);
      }
      if (failure.kind !== 'field' && failure.refresh) {
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });
  const errorOf = (field: DialogField) => (fieldError?.field === field ? fieldError.message : null);
  return { mutation, errorOf, refusal };
}

/**
 * 승인 (#172 item 15): another admin than the requester; the market takes the new text and a new
 * version at once. The confirm waits for a reason (`revertDraft`: 1..500 trimmed).
 */
function ApproveSupplementDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const decided = useSupplementRequest(market);
  const { mutation, errorOf, refusal } = useSupplementWrite(
    market,
    onClose,
    copy.adminMarketSupplementApproved,
    async ({ requestId, reason, by }: ApproveVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/supplements/{requestId}/approve', {
          params: { path: { id: market.id, requestId } },
          body: { reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-supplement-approve-dialog"
      title={copy.adminMarketSupplementApproveTitle}
      body={copy.adminMarketSupplementApproveBody}
      confirmLabel={copy.adminMarketSupplementApprove}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || decided.changed}
      refusal={refusal ?? (decided.changed ? copy.adminMarketSupplementRequestChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        const { requestId } = decided;
        if (operatorId === undefined || requestId === null) return;
        mutation.mutate({ requestId, reason: draft.reason, by: operatorId });
      }}
    >
      <ReasonField
        testId="market-supplement-approve-reason"
        label={copy.adminMarketSupplementApproveReason}
        hint={copy.adminMarketSupplementDecisionHint}
        value={reasonText}
        onChange={setReasonText}
        error={errorOf('reason')}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/** 반려's fields: the reason from the list (MARKET_SUPPLEMENT_REJECT_REASONS), then the 설명. */
export function SupplementRejectFields({
  value,
  onValue,
  description,
  onDescription,
  reasonError,
  descriptionError,
  disabled,
}: {
  value: string;
  onValue: (value: string) => void;
  description: string;
  onDescription: (value: string) => void;
  reasonError: string | null;
  descriptionError: string | null;
  disabled: boolean;
}) {
  return (
    <Stack gap="4">
      <Field.Root invalid={reasonError !== null} required>
        <Field.Label>{copy.adminMarketReviewRejectReason}</Field.Label>
        <NativeSelect.Root disabled={disabled}>
          <NativeSelect.Field
            value={value}
            onChange={(event) => onValue(event.target.value)}
            placeholder={copy.adminMarketReviewRejectReasonPlaceholder}
            data-testid="market-supplement-reject-reason"
          >
            {MARKET_SUPPLEMENT_REJECT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {SUPPLEMENT_REJECT_REASON_LABEL[reason]}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
        <Field.ErrorText data-testid="market-supplement-reject-reason-error">
          {reasonError}
        </Field.ErrorText>
      </Field.Root>
      <ReasonField
        testId="market-supplement-reject-description"
        label={copy.adminMarketReviewRejectDescription}
        hint={copy.adminMarketSupplementDecisionHint}
        value={description}
        onChange={onDescription}
        error={descriptionError}
        disabled={disabled}
      />
    </Stack>
  );
}

/**
 * 반려 (#172 item 15): another admin than the requester, in any status — a request still waiting at
 * the close ends so. The confirm waits for a reason picked and a 설명 (`supplementRejectDraft`).
 */
function RejectSupplementDialog({ market, onClose }: { market: AdminMarket; onClose: () => void }) {
  const operatorId = useOperatorId();
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const draft = supplementRejectDraft(value, description);
  const decided = useSupplementRequest(market);
  const { mutation, errorOf, refusal } = useSupplementWrite(
    market,
    onClose,
    copy.adminMarketSupplementRejected,
    async ({ requestId, rejectReason, reason, by }: RejectVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/supplements/{requestId}/reject', {
          params: { path: { id: market.id, requestId } },
          body: { rejectReason, reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-supplement-reject-dialog"
      title={copy.adminMarketSupplementRejectTitle}
      body={copy.adminMarketSupplementRejectBody}
      confirmLabel={copy.adminMarketSupplementReject}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || decided.changed}
      refusal={refusal ?? (decided.changed ? copy.adminMarketSupplementRequestChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        const { requestId } = decided;
        if (operatorId === undefined || requestId === null || draft.rejectReason === null) return;
        mutation.mutate({
          requestId,
          rejectReason: draft.rejectReason,
          reason: draft.reason,
          by: operatorId,
        });
      }}
    >
      <SupplementRejectFields
        value={value}
        onValue={setValue}
        description={description}
        onDescription={setDescription}
        reasonError={errorOf('rejectReason')}
        descriptionError={errorOf('reason')}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/** 철회 (the requester's alone, any status): nothing to fill in, the confirm says what it does. */
function RetractSupplementDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const decided = useSupplementRequest(market);
  const { mutation, refusal } = useSupplementWrite(
    market,
    onClose,
    copy.adminMarketSupplementRetracted,
    async ({ requestId, by }: RetractVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/supplements/{requestId}/retract', {
          params: { path: { id: market.id, requestId } },
          body: { expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-supplement-retract-dialog"
      title={copy.adminMarketSupplementRetractTitle}
      body={copy.adminMarketSupplementRetractBody}
      confirmLabel={copy.adminMarketSupplementRetract}
      pending={mutation.isPending}
      confirmDisabled={operatorId === undefined || decided.changed}
      refusal={refusal ?? (decided.changed ? copy.adminMarketSupplementRequestChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        const { requestId } = decided;
        if (operatorId !== undefined && requestId !== null) {
          mutation.mutate({ requestId, by: operatorId });
        }
      }}
    >
      {null}
    </ReviewDialogShell>
  );
}
