'use client';

import { MARKET_CONFLICTS_KEY, useMarketConflicts } from '@/hooks/use-market-conflicts';
import { NoConflictConfirmation } from './market-conflict-panel';

import { Button, Field, HStack, Input, RadioGroup, Stack, Text } from '@chakra-ui/react';
import { JUDGEMENT_EVIDENCE_LINKS_MAX, JUDGEMENT_EVIDENCE_LINK_MAX } from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, type MarketJudgementIncidentPending, api, unwrap } from '@/lib/api';
import { MARKET_RESULT_LABEL } from '@/lib/market-admin';
import { collectedAtWait } from '@/lib/market-judgement';
import {
  INCIDENT_DECISION_TEXTS,
  type IncidentDecision,
  type IncidentField,
  type IncidentFormErrors,
  type IncidentFormValues,
  type IncidentRegistration,
  incidentDraft,
  incidentFailure,
  incidentFormDefaults,
  incidentPaidText,
  incidentResultChoices,
  incidentUnregistrable,
  incidentUnregistrableNote,
} from '@/lib/market-judgement-incident';
import { revertDraft } from '@/lib/market-review';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * The 판정 오류 사건's dialogs (#144 part 1, ADR-0165; owner answers 144-3·144-4·144-8·144-13;
 * ADR-0120 decision 5; ADR-0121 decision 6): 사건 등록 (the correct result — never the paid one —
 * 오류 내용, 1..5 evidence links and their collection instant in KST, the public-input notice in its
 * body and the unchecked 이해충돌 없음 confirmation), and on the waiting incident 오류 확인 and 기각
 * (the reviewer's reason, admins only, and the confirmation again) and its registrant's 철회
 * (nothing to fill in). Drawn in the review's frame (`ReviewDialogShell`), each confirm off until
 * the admin on screen is known (`useOperatorId`, ADR-0092) — every write names that admin — and
 * mounted only while the panel holds it for the admin who opened it (`useHeldForOperator`). Each
 * decision decides the incident it was opened on (`usePinnedIncident`). A refusal stays in the
 * dialog, under the field it is about or above the buttons (`incidentFailure`); another account's
 * cookie closes it with a toast. Sent, it closes with a toast and the market as the write
 * committed it goes on screen (`useApplyMarket`), the panel putting focus on its heading.
 */
export function JudgementIncidentDialog({
  kind,
  market,
  onClose,
}: {
  kind: 'register' | IncidentDecision;
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  switch (kind) {
    case 'register':
      return <RegisterIncidentDialog market={market} onClose={onClose} />;
    case 'confirm':
    case 'dismiss':
      return <ReviewIncidentDialog kind={kind} market={market} onClose={onClose} />;
    case 'retract':
      return <RetractIncidentDialog market={market} onClose={onClose} />;
  }
}

/**
 * The incident a dialog was opened on, kept from its first draw with what it says — so one decided
 * or retracted meanwhile is decided by no reason its admin gave the old one. `changed` once the
 * market's waiting incident is another (or none); the server refuses the old one regardless
 * ('decided', 'retracted').
 */
function usePinnedIncident(market: AdminMarket) {
  const [request] = useState(() => market.judgementIncident.pending);
  return {
    request,
    changed: request === null || market.judgementIncident.pending?.requestId !== request.requestId,
  };
}

/**
 * One incident write: sent as the admin on screen, its refusal said where `incidentFailure` puts
 * it — the detail read again when the screen behind is out of date — and its answer applied.
 */
function useIncidentWrite<V>(
  market: AdminMarket,
  onClose: (sent: boolean) => void,
  success: string,
  send: (variables: V) => Promise<AdminMarket>,
) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [fieldError, setFieldError] = useState<{
    field: IncidentField;
    index?: number;
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
      const failure = incidentFailure(error);
      if (failure.kind === 'toast') {
        // Another account's cookie: the panel drops this dialog once the session names the admin
        // really signed in, so the refusal is a toast that outlives it.
        toaster.create({ type: 'error', title: failure.message });
        onClose(false);
        return;
      }
      if (failure.kind === 'field') {
        setFieldError({ field: failure.field, index: failure.index, message: failure.message });
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

/** What a registration sends, taken from the dialog when its confirm is pressed; `by` the admin. */
interface RegisterVariables {
  registration: IncidentRegistration;
  by: string;
}

/**
 * 사건 등록 (144-3, 144-8; RESOLVED·SETTLING·SETTLED): what it would send is checked as the API
 * checks it (`incidentDraft`), what each field lacks said once the confirm was pressed — the
 * instant's 'after now' at once, and drawn again as the minute typed comes (`collectedAtWait`).
 * Once the market read takes no registration (`incidentUnregistrable`) the dialog says why and
 * sends nothing. The registrant may be the paid version's registrant (144-4 "사건 등록 … 할 수
 * 있다"); the server refuses a registration no other admin could decide (`no_decider`).
 */
function RegisterIncidentDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const [values, setValues] = useState<IncidentFormValues>(incidentFormDefaults);
  const set = (patch: Partial<IncidentFormValues>) => setValues((held) => ({ ...held, ...patch }));
  const [tried, setTried] = useState(false);
  const [noConflict, setNoConflict] = useState(false);
  const conflicts = useMarketConflicts(market.id);
  const conflictBlocked = conflicts.data?.operator.conflicted === true;
  const [sentLocal, setSentLocal] = useState<string | null>(null);
  // The clock is the draft's own default, read in render as the judgement form's is.
  const draft = incidentDraft(values, market.resolvedResult);
  const unregistrable = incidentUnregistrable(market);
  const [drawn, setDrawn] = useState(0);
  const afterNow = draft.errors.collectedAt === copy.errMarketJudgementCollectedAtAfter;
  useEffect(() => {
    if (!afterNow) return;
    const wait = collectedAtWait(values.collectedLocal, Date.now()) ?? 0;
    const timer = setTimeout(() => setDrawn((count) => count + 1), wait);
    return () => clearTimeout(timer);
  }, [afterNow, values.collectedLocal, drawn]);
  const { mutation, fieldError, refusal } = useIncidentWrite(
    market,
    onClose,
    copy.adminMarketJudgementIncidentRegistered,
    async ({ registration, by }: RegisterVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgement-incidents', {
          params: { path: { id: market.id } },
          body: { ...registration, noConflictConfirmed: true, expectedAccountId: by },
        }),
      ).data,
  );
  const errorOf = (field: Exclude<keyof IncidentFormErrors, 'links'>) => {
    if (fieldError?.field === field) {
      // The server's refusal of the instant holds while the field holds what was sent.
      if (field !== 'collectedAt' || sentLocal === values.collectedLocal) return fieldError.message;
    }
    const drafted = draft.errors[field];
    if (field === 'collectedAt' && drafted === copy.errMarketJudgementCollectedAtAfter) {
      return drafted;
    }
    return tried ? drafted : null;
  };
  const linkErrorOf = (index: number) => {
    if (fieldError?.field === 'links' && fieldError.index === index) return fieldError.message;
    return tried ? (draft.errors.links[index] ?? null) : null;
  };
  const linksError =
    fieldError?.field === 'links' && fieldError.index === undefined ? fieldError.message : null;
  const resultError = errorOf('correctedResult');
  const collectedError = errorOf('collectedAt');
  const pending = mutation.isPending;
  return (
    <ReviewDialogShell
      testId="market-judgement-incident-register-dialog"
      title={copy.adminMarketJudgementIncidentRegisterTitle}
      body={copy.adminMarketJudgementIncidentRegisterBody}
      confirmLabel={copy.adminMarketJudgementIncidentRegister}
      pending={pending}
      confirmDisabled={
        !noConflict || conflictBlocked || operatorId === undefined || unregistrable !== null
      }
      refusal={
        refusal ?? (unregistrable === null ? null : incidentUnregistrableNote(unregistrable))
      }
      onClose={() => onClose(false)}
      onConfirm={() => {
        setTried(true);
        if (
          !noConflict ||
          conflictBlocked ||
          operatorId === undefined ||
          unregistrable !== null ||
          draft.registration === null
        )
          return;
        setSentLocal(values.collectedLocal);
        mutation.mutate({ registration: draft.registration, by: operatorId });
      }}
    >
      <Stack gap="4">
        <Text fontSize="sm" data-testid="market-judgement-incident-register-paid">
          <Text as="span" fontWeight="medium">
            {copy.adminMarketJudgementIncidentPaidResult}
          </Text>{' '}
          {incidentPaidText(market.judgementVersion, market.resolvedResult)}
        </Text>
        <Field.Root invalid={resultError !== null} required>
          {/* The group's accessible name is its own Label part (zag's `aria-labelledby`). */}
          <RadioGroup.Root
            name="judgement-incident-result"
            value={values.correctedResult === '' ? null : values.correctedResult}
            onValueChange={(details) => set({ correctedResult: details.value ?? '' })}
            disabled={pending}
            colorPalette="brand"
          >
            <RadioGroup.Label fontWeight="medium" mb="1">
              {copy.adminMarketJudgementIncidentCorrectedResult}
            </RadioGroup.Label>
            <Text fontSize="sm" color="fg.muted" mb="2">
              {copy.adminMarketJudgementIncidentCorrectedResultHint}
            </Text>
            <HStack gap="6" flexWrap="wrap">
              {incidentResultChoices(market.resolvedResult).map((result) => (
                <RadioGroup.Item
                  key={result}
                  value={result}
                  data-testid={`market-judgement-incident-result-${result.toLowerCase()}`}
                >
                  <RadioGroup.ItemHiddenInput />
                  <RadioGroup.ItemIndicator />
                  <RadioGroup.ItemText>{MARKET_RESULT_LABEL[result]}</RadioGroup.ItemText>
                </RadioGroup.Item>
              ))}
            </HStack>
          </RadioGroup.Root>
          <Field.ErrorText data-testid="market-judgement-incident-result-error">
            {resultError}
          </Field.ErrorText>
        </Field.Root>
        <ReasonField
          testId="market-judgement-incident-description"
          label={copy.adminMarketJudgementIncidentDescription}
          hint={copy.adminMarketJudgementIncidentDescriptionHint}
          value={values.description}
          onChange={(description) => set({ description })}
          error={errorOf('description')}
          disabled={pending}
        />
        <Stack gap="2" data-testid="market-judgement-incident-links">
          <Text fontWeight="medium">{copy.adminMarketJudgementIncidentEvidence}</Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketJudgementIncidentLinksHint}
          </Text>
          {values.links.map((link, index) => {
            const error = linkErrorOf(index);
            const at = `market-judgement-incident-link-${String(index)}`;
            return (
              <Field.Root key={index} invalid={error !== null} required>
                <HStack gap="2" width="full">
                  <Input
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    placeholder={copy.adminMarketSourceUrlPlaceholder}
                    maxLength={JUDGEMENT_EVIDENCE_LINK_MAX}
                    aria-label={`${copy.adminMarketJudgementIncidentEvidence} ${String(index + 1)}`}
                    value={link}
                    onChange={(event) =>
                      set({
                        links: values.links.map((other, position) =>
                          position === index ? event.target.value : other,
                        ),
                      })
                    }
                    disabled={pending}
                    data-testid={at}
                  />
                  {values.links.length > 1 && (
                    <Button
                      size="xs"
                      variant="outline"
                      aria-label={`${copy.adminMarketJudgementLinkRemove} ${String(index + 1)}`}
                      disabled={pending}
                      onClick={() =>
                        set({ links: values.links.filter((_, other) => other !== index) })
                      }
                      data-testid={`${at}-remove`}
                    >
                      {copy.adminMarketJudgementLinkRemove}
                    </Button>
                  )}
                </HStack>
                <Field.ErrorText data-testid={`${at}-error`}>{error}</Field.ErrorText>
              </Field.Root>
            );
          })}
          {linksError !== null && (
            <Text
              fontSize="sm"
              color="fg.error"
              data-testid="market-judgement-incident-links-error"
            >
              {linksError}
            </Text>
          )}
          <Button
            size="xs"
            variant="outline"
            alignSelf="flex-start"
            disabled={pending || values.links.length >= JUDGEMENT_EVIDENCE_LINKS_MAX}
            onClick={() => set({ links: [...values.links, ''] })}
            data-testid="market-judgement-incident-link-add"
          >
            {copy.adminMarketJudgementLinkAdd}
          </Button>
        </Stack>
        <Field.Root invalid={collectedError !== null} required>
          <Field.Label>{copy.adminMarketJudgementIncidentCollectedAt}</Field.Label>
          <Input
            type="datetime-local"
            value={values.collectedLocal}
            onChange={(event) => set({ collectedLocal: event.target.value })}
            disabled={pending}
            data-testid="market-judgement-incident-collected-at"
          />
          <Field.HelperText>{copy.adminMarketJudgementIncidentCollectedAtHint}</Field.HelperText>
          <Field.ErrorText data-testid="market-judgement-incident-collected-at-error">
            {collectedError}
          </Field.ErrorText>
        </Field.Root>
        <NoConflictConfirmation
          blocked={conflictBlocked}
          checked={noConflict}
          onChecked={setNoConflict}
          disabled={pending}
          testId="market-judgement-incident-register-confirm-conflict"
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/** What a decision sends, taken from the dialog when its confirm is pressed; `by` the admin. */
interface ReviewVariables {
  requestId: string;
  reason: string;
  by: string;
}

/** Each review decision's write, by its kind: its own route, the same body. */
function sendReview(market: AdminMarket, kind: 'confirm' | 'dismiss') {
  return async ({ requestId, reason, by }: ReviewVariables): Promise<AdminMarket> =>
    kind === 'confirm'
      ? unwrap(
          await api.POST('/api/v1/admin/markets/{id}/judgement-incidents/{requestId}/confirm', {
            params: { path: { id: market.id, requestId } },
            body: { reason, noConflictConfirmed: true, expectedAccountId: by },
          }),
        ).data
      : unwrap(
          await api.POST('/api/v1/admin/markets/{id}/judgement-incidents/{requestId}/dismiss', {
            params: { path: { id: market.id, requestId } },
            body: { reason, noConflictConfirmed: true, expectedAccountId: by },
          }),
        ).data;
}

/**
 * 오류 확인 or 기각 (144-3: a review decision with a reason, by an admin who is neither the
 * registrant nor the paid version's registrant — 144-4 — nor conflicted, #143): the reviewer's
 * reason (admins only) and the 이해충돌 없음 confirmation, unchecked. 오류 확인 publishes the 판정
 * 정정 at once and cannot be undone; 기각 leaves nothing public, and a new incident may follow.
 */
function ReviewIncidentDialog({
  kind,
  market,
  onClose,
}: {
  kind: 'confirm' | 'dismiss';
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const texts = INCIDENT_DECISION_TEXTS[kind];
  const pinned = usePinnedIncident(market);
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const [noConflict, setNoConflict] = useState(false);
  const conflicts = useMarketConflicts(market.id);
  const conflictBlocked = conflicts.data?.operator.conflicted === true;
  const { mutation, fieldError, refusal } = useIncidentWrite(
    market,
    onClose,
    texts.done,
    sendReview(market, kind),
  );
  const testId = `market-judgement-incident-${kind}-dialog`;
  return (
    <ReviewDialogShell
      testId={testId}
      title={texts.title}
      body={texts.body}
      confirmLabel={texts.confirm}
      pending={mutation.isPending}
      confirmDisabled={
        !noConflict || conflictBlocked || !draft.ready || operatorId === undefined || pinned.changed
      }
      refusal={refusal ?? (pinned.changed ? copy.adminMarketJudgementIncidentChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = pinned.request?.requestId;
        if (!noConflict || conflictBlocked || operatorId === undefined || requestId === undefined)
          return;
        mutation.mutate({ requestId, reason: draft.reason, by: operatorId });
      }}
    >
      <Stack gap="4">
        <PinnedIncidentLine market={market} request={pinned.request} testId={`${testId}-request`} />
        <NoConflictConfirmation
          blocked={conflictBlocked}
          checked={noConflict}
          onChecked={setNoConflict}
          disabled={mutation.isPending}
          testId={`market-judgement-incident-${kind}-confirm-conflict`}
        />
        <ReasonField
          testId={`${testId}-reason`}
          label={copy.adminMarketJudgementIncidentReviewReason}
          hint={copy.adminMarketJudgementIncidentReviewReasonHint}
          value={reasonText}
          onChange={setReasonText}
          error={fieldError?.field === 'reason' ? fieldError.message : null}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/** 철회 (the registrant's alone, before a decision): nothing to fill in. */
function RetractIncidentDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const texts = INCIDENT_DECISION_TEXTS.retract;
  const pinned = usePinnedIncident(market);
  const { mutation, refusal } = useIncidentWrite(
    market,
    onClose,
    texts.done,
    async ({ requestId, by }: { requestId: string; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgement-incidents/{requestId}/retract', {
          params: { path: { id: market.id, requestId } },
          body: { expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-judgement-incident-retract-dialog"
      title={texts.title}
      body={texts.body}
      confirmLabel={texts.confirm}
      pending={mutation.isPending}
      confirmDisabled={operatorId === undefined || pinned.changed}
      refusal={refusal ?? (pinned.changed ? copy.adminMarketJudgementIncidentChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const requestId = pinned.request?.requestId;
        if (operatorId !== undefined && requestId !== undefined) {
          mutation.mutate({ requestId, by: operatorId });
        }
      }}
    >
      <PinnedIncidentLine
        market={market}
        request={pinned.request}
        testId="market-judgement-incident-retract-dialog-request"
      />
    </ReviewDialogShell>
  );
}

/** What the incident a dialog decides says: the paid result, the correct one and 오류 내용. */
function PinnedIncidentLine({
  market,
  request,
  testId,
}: {
  market: AdminMarket;
  request: MarketJudgementIncidentPending | null;
  testId: string;
}) {
  if (request === null) return null;
  return (
    <Stack gap="1" fontSize="sm" color="fg.muted" data-testid={testId}>
      <Text>
        {copy.adminMarketJudgementIncidentPaidResult}{' '}
        {incidentPaidText(market.judgementVersion, market.resolvedResult)} ·{' '}
        {copy.adminMarketJudgementIncidentCorrectedResult}{' '}
        <Text as="span" data-testid={`${testId}-result`}>
          {MARKET_RESULT_LABEL[request.correctedResult]}
        </Text>
      </Text>
      <Text whiteSpace="pre-wrap" wordBreak="break-word" lineClamp={3}>
        {request.description}
      </Text>
    </Stack>
  );
}
