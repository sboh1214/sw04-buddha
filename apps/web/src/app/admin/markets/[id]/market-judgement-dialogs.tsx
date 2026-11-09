'use client';

import { MARKET_CONFLICTS_KEY, useMarketConflicts } from '@/hooks/use-market-conflicts';
import { NoConflictConfirmation } from './market-conflict-panel';

import { Checkbox, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, type MarketJudgementPending, api, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { MARKET_RESULT_LABEL, judgementVersionMove } from '@/lib/market-admin';
import {
  type JudgementDecision,
  type JudgementField,
  judgementApproveDraft,
  judgementCorrectionEnd,
  judgementDecisionTexts,
  judgementEarly,
  judgementFailure,
  judgementSourceText,
} from '@/lib/market-judgement';
import { revertDraft } from '@/lib/market-review';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * The 판정's dialogs (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·5·9, decision 3 the #152
 * rows '역할'·'등록 시점'): the waiting registration's 승인 (an admin other than its registrant: the
 * reason and — before the scheduled judgement — the confirmation of the NO condition's event
 * deadline, with that condition and deadline shown), 반려 (the reason) and 철회 (the registrant's:
 * nothing to fill in). No market price, volume or count is drawn: the judgement follows the rule's
 * source alone (#152 AC 8). Drawn in the review's frame (`ReviewDialogShell`), each confirm off
 * until what it would send is whole and until the admin on screen is known (`useOperatorId`,
 * ADR-0092): every write names that admin. Mounted only while the panel holds it for the admin
 * who opened it (`useHeldForOperator`), so what was checked and typed for A goes with it once
 * `['me']` turns to B (ADR-0092 answer 1). Each decides the registration it was opened on
 * (`usePinnedJudgement`). A refusal stays in the dialog, under the field it is about or above the
 * buttons (`judgementFailure`); another account's cookie closes it with a toast. Sent, it closes
 * with a toast and the market as the write committed it goes on screen (`useApplyMarket`) — after
 * an approval, 잠정 결과 with its deadline — and the panel puts focus on what took the button's
 * place (`onClose(true)`).
 *
 * A waiting 판정 정정 (#176, ADR-0105; #173 items 5·8, decision 3 '#176 정정 대기', owner answer
 * 2026-11-02) is decided by the same three, each in its own words (`judgementDecisionTexts`): its
 * 승인 moves the judgement to the next version ('v1 → v2'), publishes the new result at once, gives
 * a new deadline the first one's length from the approval (shown) and closes the replaced
 * version's pending disputes as 정정으로 종결; its 반려 and its 철회 leave the version, its deadline
 * and its disputes' results as they were, send the accepted disputes registered with it (if any)
 * back to 검토 중 and — once the 이의 기한 has passed as the detail was read (`readAt`) — say that
 * the current version is then confirmed within seconds unless a dispute still holds it, after
 * which it takes no correction (`judgementCorrectionEnd`).
 */

export type JudgementDialogKind = JudgementDecision;

export function JudgementDialog({
  kind,
  market,
  readAt,
  onClose,
}: {
  kind: JudgementDialogKind;
  market: AdminMarket;
  /** When the detail was read (its query's `dataUpdatedAt`): what a correction's end leaves. */
  readAt: number;
  onClose: (sent: boolean) => void;
}) {
  switch (kind) {
    case 'approve':
      return <ApproveJudgementDialog market={market} readAt={readAt} onClose={onClose} />;
    case 'reject':
      return <RejectJudgementDialog market={market} readAt={readAt} onClose={onClose} />;
    case 'retract':
      return <RetractJudgementDialog market={market} readAt={readAt} onClose={onClose} />;
  }
}

/**
 * The registration a dialog was opened on: sent as `requestId` and kept from the dialog's first
 * draw with what it says — so one retracted or rejected and another registered meanwhile is
 * decided by no confirmation its admin gave the old one. `changed` once the market's waiting
 * registration is another (or none); the server refuses the old one regardless ('decided',
 * 'retracted').
 */
function usePinnedJudgement(market: AdminMarket) {
  const [request] = useState(() => market.judgement.pending);
  return {
    request,
    changed: request === null || market.judgement.pending?.requestId !== request.requestId,
  };
}

/** What each decision sends, taken from the dialog when its confirm is pressed; `by` the admin. */
interface ApproveVariables {
  requestId: string;
  reason: string;
  eventDeadlineConfirmed: boolean;
  by: string;
}
interface DecideVariables {
  requestId: string;
  reason: string;
  by: string;
}
interface RetractVariables {
  requestId: string;
  by: string;
}

/**
 * One decision: sent as the admin on screen, its refusal said where `judgementFailure` puts it —
 * the detail read again when the screen behind is out of date — and its answer applied.
 */
function useJudgementWrite<V>(
  market: AdminMarket,
  onClose: (sent: boolean) => void,
  success: string,
  send: (variables: V) => Promise<AdminMarket>,
) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [fieldError, setFieldError] = useState<{
    field: JudgementField;
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
      const failure = judgementFailure(error, 'decision');
      if (failure.kind === 'toast') {
        // Another account's cookie: the page drops this dialog once the session names the admin
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
  const errorOf = (field: JudgementField) =>
    fieldError?.field === field ? fieldError.message : null;
  return { mutation, errorOf, refusal };
}

/**
 * What the registration a dialog decides says: a correction's move ('v1 → v2', #176), its result
 * and its source.
 */
function PinnedJudgementLine({
  request,
  testId,
}: {
  request: MarketJudgementPending | null;
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
      {request.correction !== null && (
        <>
          {copy.adminMarketJudgementCorrectionVersion}{' '}
          <Text as="span" data-testid={`${testId}-correction`}>
            {judgementVersionMove(request.correction.baseVersion)}
          </Text>{' '}
          ·{' '}
        </>
      )}
      {copy.adminMarketJudgementResult} {MARKET_RESULT_LABEL[request.result]} ·{' '}
      {copy.adminMarketJudgementSource} {judgementSourceText(request.source)}
    </Text>
  );
}

/**
 * A correction's new dispute window as its 승인 gives it (#173 item 5): the length of the version
 * it replaces — the first one's — counted from the approval, read off the current judgement.
 */
function CorrectionWindowLine({ market }: { market: AdminMarket }) {
  const current = market.judgement.current;
  if (current === null) return null;
  return (
    <Text fontSize="sm" data-testid="market-judgement-approve-window">
      <Text as="span" fontWeight="medium">
        {copy.adminMarketJudgementCorrectionWindow}
      </Text>{' '}
      {current.disputeWindowMinutes.toLocaleString('ko-KR')}
      {copy.adminMarketJudgementWindowMinutes}
    </Text>
  );
}

/**
 * 승인's fields: when the dialog asks for it (`asked`: before the scheduled judgement, or the
 * server said so), the NO condition and its event deadline in KST and the checkbox confirming them
 * — the test id on the label element, so a click on it is the click that checks — then the reason.
 * Nothing of the market's trading is drawn (#152 AC 8).
 */
export function ApproveJudgementFields({
  asked,
  noCondition,
  eventDeadline,
  confirmed,
  onConfirmed,
  confirmError,
  reason,
  onReason,
  reasonError,
  disabled,
}: {
  asked: boolean;
  noCondition: string;
  eventDeadline: string | null;
  confirmed: boolean;
  onConfirmed: (value: boolean) => void;
  confirmError: string | null;
  reason: string;
  onReason: (value: string) => void;
  reasonError: string | null;
  disabled: boolean;
}) {
  return (
    <Stack gap="4">
      {asked && (
        <Stack
          gap="2"
          borderWidth="1px"
          borderRadius="l2"
          p="3"
          data-testid="market-judgement-approve-deadline"
        >
          <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
            <Text as="span" fontWeight="medium">
              {copy.adminMarketNoCondition}
            </Text>{' '}
            <Text as="span" data-testid="market-judgement-approve-no-condition">
              {noCondition.trim() === '' ? '—' : noCondition}
            </Text>
          </Text>
          <Text fontSize="sm">
            <Text as="span" fontWeight="medium">
              {copy.adminMarketEventDeadline}
            </Text>{' '}
            <Text as="span" data-testid="market-judgement-approve-event-deadline">
              {eventDeadline === null ? '—' : formatKst(eventDeadline)}
            </Text>
          </Text>
          <Checkbox.Root
            checked={confirmed}
            onCheckedChange={(details) => onConfirmed(details.checked === true)}
            disabled={disabled}
            colorPalette="brand"
            alignItems="flex-start"
            data-testid="market-judgement-approve-confirm-deadline"
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control mt="0.5" />
            <Stack gap="0">
              <Checkbox.Label>{copy.adminMarketJudgementConfirmDeadline}</Checkbox.Label>
              <Text fontSize="sm" color="fg.muted">
                {copy.adminMarketJudgementConfirmDeadlineHint}
              </Text>
            </Stack>
          </Checkbox.Root>
          {confirmError !== null && (
            <Text
              fontSize="sm"
              color="fg.error"
              data-testid="market-judgement-approve-confirm-deadline-error"
            >
              {confirmError}
            </Text>
          )}
        </Stack>
      )}
      <ReasonField
        testId="market-judgement-approve-reason"
        label={copy.adminMarketJudgementApproveReason}
        hint={copy.adminMarketJudgementDecisionHint}
        value={reason}
        onChange={onReason}
        error={reasonError}
        disabled={disabled}
      />
    </Stack>
  );
}

/**
 * 승인 (CLOSED → PROVISIONAL, an admin other than the registrant, #173 item 1): the result is
 * published as 잠정 결과 at once and the dispute window runs from then (#173 item 5). A correction's
 * (#176) moves the version on a PROVISIONAL market, with the new window's length shown. Before the
 * scheduled judgement — as the dialog opened, or as the server said — the approver confirms the
 * NO condition's event deadline (decision 3 '등록 시점'), which is sent (`eventDeadlineConfirmed`)
 * and kept on the judgement. The confirm waits for a reason and, when asked, the confirmation.
 */
function ApproveJudgementDialog({
  market,
  readAt,
  onClose,
}: {
  market: AdminMarket;
  readAt: number;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const decided = usePinnedJudgement(market);
  // Before the scheduled judgement as the dialog opened: asked from its first draw. The server
  // judges by its own clock at the approval and, refusing 'required', makes the dialog ask too.
  const [early] = useState(() => judgementEarly(market));
  const [reasonText, setReasonText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [noConflict, setNoConflict] = useState(false);
  const conflicts = useMarketConflicts(market.id);
  const conflictBlocked = conflicts.data?.operator.conflicted === true;
  const end = judgementCorrectionEnd(decided.request, market, readAt);
  const correction = end !== null;
  const texts = judgementDecisionTexts('approve', end);
  const { mutation, errorOf, refusal } = useJudgementWrite(
    market,
    onClose,
    texts.done,
    async ({ requestId, reason, eventDeadlineConfirmed, by }: ApproveVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgements/{requestId}/approve', {
          params: { path: { id: market.id, requestId } },
          body: {
            reason,
            eventDeadlineConfirmed,
            expectedAccountId: by,
            noConflictConfirmed: true,
          },
        }),
      ).data,
  );
  const confirmError = errorOf('eventDeadlineConfirmed');
  // Once the server asked, the dialog keeps asking: the next send clears the refusal as it goes.
  const [askedByServer, setAskedByServer] = useState(false);
  if (confirmError !== null && !askedByServer) setAskedByServer(true);
  const asked = early || askedByServer;
  const draft = judgementApproveDraft(reasonText, confirmed, asked);
  return (
    <ReviewDialogShell
      testId="market-judgement-approve-dialog"
      title={texts.title}
      body={texts.body}
      confirmLabel={copy.adminMarketJudgementApprove}
      pending={mutation.isPending}
      confirmDisabled={
        !noConflict ||
        conflictBlocked ||
        !draft.ready ||
        operatorId === undefined ||
        decided.changed
      }
      refusal={refusal ?? (decided.changed ? copy.adminMarketJudgementRequestChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = decided.request?.requestId;
        if (!noConflict || conflictBlocked || operatorId === undefined || requestId === undefined)
          return;
        mutation.mutate({
          requestId,
          reason: draft.reason,
          eventDeadlineConfirmed: draft.eventDeadlineConfirmed,
          by: operatorId,
        });
      }}
    >
      <Stack gap="4">
        <PinnedJudgementLine request={decided.request} testId="market-judgement-approve-request" />
        {correction && <CorrectionWindowLine market={market} />}
        <NoConflictConfirmation
          blocked={conflictBlocked}
          checked={noConflict}
          onChecked={setNoConflict}
          disabled={mutation.isPending}
          testId="market-judgement-approve-confirm-conflict"
        />
        <ApproveJudgementFields
          asked={asked}
          noCondition={market.noCondition}
          eventDeadline={market.eventDeadline}
          confirmed={confirmed}
          onConfirmed={setConfirmed}
          confirmError={confirmed ? null : confirmError}
          reason={reasonText}
          onReason={setReasonText}
          reasonError={errorOf('reason')}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/**
 * 반려 (an admin other than the registrant, in any status): the market stays CLOSED and a judgement
 * is registered again — by any admin, this one included (#173 item 1). A correction's (#176) leaves
 * the current version, its deadline and its disputes' results as they were, and the accepted
 * disputes it carried go back to 검토 중 (owner answer 2026-11-02); past the deadline as read at
 * `readAt`, the version is confirmed within seconds once nothing holds it. The confirm waits for a
 * reason.
 */
function RejectJudgementDialog({
  market,
  readAt,
  onClose,
}: {
  market: AdminMarket;
  readAt: number;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const decided = usePinnedJudgement(market);
  const texts = judgementDecisionTexts(
    'reject',
    judgementCorrectionEnd(decided.request, market, readAt),
  );
  const { mutation, errorOf, refusal } = useJudgementWrite(
    market,
    onClose,
    texts.done,
    async ({ requestId, reason, by }: DecideVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgements/{requestId}/reject', {
          params: { path: { id: market.id, requestId } },
          body: { reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-judgement-reject-dialog"
      title={texts.title}
      body={texts.body}
      confirmLabel={copy.adminMarketJudgementReject}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || decided.changed}
      refusal={refusal ?? (decided.changed ? copy.adminMarketJudgementRequestChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = decided.request?.requestId;
        if (operatorId === undefined || requestId === undefined) return;
        mutation.mutate({ requestId, reason: draft.reason, by: operatorId });
      }}
    >
      <Stack gap="4">
        <PinnedJudgementLine request={decided.request} testId="market-judgement-reject-request" />
        <ReasonField
          testId="market-judgement-reject-reason"
          label={copy.adminMarketJudgementRejectReason}
          hint={copy.adminMarketJudgementDecisionHint}
          value={reasonText}
          onChange={setReasonText}
          error={errorOf('reason')}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/**
 * 철회 (the registrant's alone, any status): nothing to fill in, the confirm says what it does — a
 * correction's (#176) as its 반려 does (ADR-0105: the accepted disputes it carried go back to 검토
 * 중 too, and past the deadline the version is confirmed within seconds once nothing holds it).
 */
function RetractJudgementDialog({
  market,
  readAt,
  onClose,
}: {
  market: AdminMarket;
  readAt: number;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const decided = usePinnedJudgement(market);
  const texts = judgementDecisionTexts(
    'retract',
    judgementCorrectionEnd(decided.request, market, readAt),
  );
  const { mutation, refusal } = useJudgementWrite(
    market,
    onClose,
    texts.done,
    async ({ requestId, by }: RetractVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgements/{requestId}/retract', {
          params: { path: { id: market.id, requestId } },
          body: { expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-judgement-retract-dialog"
      title={texts.title}
      body={texts.body}
      confirmLabel={copy.adminMarketJudgementRetract}
      pending={mutation.isPending}
      confirmDisabled={operatorId === undefined || decided.changed}
      refusal={refusal ?? (decided.changed ? copy.adminMarketJudgementRequestChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = decided.request?.requestId;
        if (operatorId !== undefined && requestId !== undefined) {
          mutation.mutate({ requestId, by: operatorId });
        }
      }}
    >
      <PinnedJudgementLine request={decided.request} testId="market-judgement-retract-request" />
    </ReviewDialogShell>
  );
}
