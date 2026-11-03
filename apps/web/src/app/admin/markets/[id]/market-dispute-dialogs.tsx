'use client';

import { Stack, Text } from '@chakra-ui/react';
import { type MarketDisputeDecision } from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import {
  DISPUTE_DECISION_DIALOG,
  disputeDecisionFailure,
  disputeSubmitterName,
} from '@/lib/admin-disputes';
import { type AdminMarket, type AdminMarketDispute, api, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { revertDraft } from '@/lib/market-review';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * A 판정 이의's 기각 and 수용 (#175, ADR-0104; ADR-0093 decision 1 #173 items 2·7): one admin who did
 * not register the disputed judgement version — its approver may — with a reason the submitter
 * reads (#173 item 7) and #24 publishes without the decider (#173 item 13). Final, both. A 기각
 * says nothing needed changing; once the deadline has passed and none holds the market any more,
 * the API queues the confirmation and the worker confirms it within seconds. A 수용 is a
 * correction (#176), which goes through its own registration and another admin's approval, and the
 * market waits PROVISIONAL until then — the dialog says so. No market price, volume or majority is
 * drawn (N03 §5). Drawn in the review's frame (`ReviewDialogShell`), the confirm off until a reason
 * is typed and the admin on screen is known (`useOperatorId`, ADR-0092): the write names that
 * admin. Mounted only while the block holds it for the admin who opened it (`useHeldForOperator`),
 * so a reason typed for A goes with it once `['me']` turns to B (ADR-0092 answer 1). It decides the
 * dispute it was opened on (`usePinnedDispute`). A refusal stays in the dialog, under the reason or
 * above the buttons (`disputeDecisionFailure`); another account's cookie closes it with a toast.
 * Sent, it closes with a toast and the market as the write committed it goes on screen
 * (`useApplyMarket`), the block putting focus back on its heading (`onClose(true)`).
 */

/** What the block opened: a decision on one dispute. */
export interface DisputeAction {
  kind: MarketDisputeDecision;
  disputeId: string;
}

/**
 * The dispute a dialog was opened on, kept from its first draw with what it says — so one decided
 * or retracted meanwhile is decided by no reason its admin gave the old state. `changed` once the
 * market's read no longer has it pending; the server refuses it regardless ('decided',
 * 'retracted').
 */
function usePinnedDispute(market: AdminMarket, disputeId: string) {
  const [dispute] = useState(
    () => market.disputes.items.find((item) => item.id === disputeId) ?? null,
  );
  const now = market.disputes.items.find((item) => item.id === disputeId);
  return { dispute, changed: dispute === null || now?.status !== 'pending' };
}

/** What a decision sends, taken from the dialog when its confirm is pressed; `by` the admin. */
interface DecideVariables {
  disputeId: string;
  reason: string;
  by: string;
}

/** The decision's write, by its kind: each its own route, the same body. */
function sendDecision(market: AdminMarket, kind: MarketDisputeDecision) {
  return async ({ disputeId, reason, by }: DecideVariables): Promise<AdminMarket> =>
    kind === 'dismiss'
      ? unwrap(
          await api.POST('/api/v1/admin/markets/{id}/disputes/{disputeId}/dismiss', {
            params: { path: { id: market.id, disputeId } },
            body: { reason, expectedAccountId: by },
          }),
        ).data
      : unwrap(
          await api.POST('/api/v1/admin/markets/{id}/disputes/{disputeId}/accept', {
            params: { path: { id: market.id, disputeId } },
            body: { reason, expectedAccountId: by },
          }),
        ).data;
}

export function DisputeDecisionDialog({
  action,
  market,
  onClose,
}: {
  action: DisputeAction;
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const pinned = usePinnedDispute(market, action.disputeId);
  const texts = DISPUTE_DECISION_DIALOG[action.kind];
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: sendDecision(market, action.kind),
    onMutate: () => {
      setReasonError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: texts.done });
      onClose(true);
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = disputeDecisionFailure(error);
      if (failure.kind === 'toast') {
        // Another account's cookie: the block drops this dialog once the session names the admin
        // really signed in, so the refusal is a toast that outlives it.
        toaster.create({ type: 'error', title: failure.message });
        onClose(false);
        return;
      }
      if (failure.kind === 'field') {
        setReasonError(failure.message);
        return;
      }
      setRefusal(failure.message);
      if (failure.refresh) {
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });
  const testId = `market-dispute-${action.kind}-dialog`;
  return (
    <ReviewDialogShell
      testId={testId}
      title={texts.title}
      body={texts.body}
      confirmLabel={texts.confirm}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || pinned.changed}
      refusal={refusal ?? (pinned.changed ? copy.adminMarketDisputeChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const disputeId = pinned.dispute?.id;
        if (operatorId === undefined || disputeId === undefined) return;
        mutation.mutate({ disputeId, reason: draft.reason, by: operatorId });
      }}
    >
      <Stack gap="4">
        <PinnedDisputeLine dispute={pinned.dispute} testId={`${testId}-dispute`} />
        <ReasonField
          testId={`${testId}-reason`}
          label={copy.adminMarketDisputeDecisionReason}
          hint={copy.adminMarketDisputeDecisionHint}
          value={reasonText}
          onChange={setReasonText}
          error={reasonError}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/** Which dispute the dialog decides: who submitted it and when, and its reason's first lines. */
function PinnedDisputeLine({
  dispute,
  testId,
}: {
  dispute: AdminMarketDispute | null;
  testId: string;
}) {
  if (dispute === null) return null;
  return (
    <Stack gap="1" fontSize="sm" color="fg.muted" data-testid={testId}>
      <Text>
        {copy.adminDisputeSubmitter} {disputeSubmitterName(dispute)} ·{' '}
        {copy.adminDisputeSubmittedAt} {formatKst(dispute.submittedAt)}
      </Text>
      <Text whiteSpace="pre-wrap" wordBreak="break-word" lineClamp={3}>
        {dispute.reason}
      </Text>
    </Stack>
  );
}
