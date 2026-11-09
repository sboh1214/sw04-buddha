'use client';

import { Checkbox, Field, Input, RadioGroup, Stack, Text } from '@chakra-ui/react';
import {
  MARKET_PAUSE_PATHS,
  MARKET_PAUSE_REASONS,
  MARKET_PAUSE_REVIEW_RESULTS,
  type MarketPausePath,
  type MarketPauseReason,
  type MarketPauseReviewResult,
  pauseReasonNeedsPublishedAt,
  pauseReasonNeedsReview,
} from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, type MarketPauseDecisionPending, api, unwrap } from '@/lib/api';
import { PAUSE_REASON_LABEL, PAUSE_REVIEW_RESULT_LABEL } from '@/lib/market-admin';
import {
  PAUSE_PATH_LABEL,
  PAUSE_REASON_HINT,
  PAUSE_REVIEW_RESULT_HINT,
  type PauseField,
  type PausePreset,
  type PauseWrite,
  currentPause,
  pauseApprovalSuccess,
  pauseDecisionDraft,
  pauseDraft,
  pauseFailure,
  pauseOffer,
  publishedAtWait,
} from '@/lib/market-pause';
import { revertDraft } from '@/lib/market-review';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * The 거래 일시 중단's dialogs (#114, ADR-0102; ADR-0093 decision 1 #173 items 2–4, decision 3 '#114
 * 조기 결과의 공개 시각', the owner's answers Q1·Q2 of 2026-11-02): 거래 일시 중단 (one admin, at once:
 * a reason of the three, the note, and for an early result the publication instant in KST — opened
 * from a 의미 변경 반려 as 실질 기준 변경 with the 반려's 설명, `offer`), 재개·조기 마감 요청 (the path,
 * a 실질 기준 변경 pause's review result — 판정 불가 turns 재개 off — and the reason), then the waiting
 * request's 승인 (the reason), 반려 (the reason) and 철회 (the requester's: nothing to fill in).
 * Drawn in the review's frame (`ReviewDialogShell`), each confirm off until what it would send is
 * whole and until the admin on screen is known (`useOperatorId`, ADR-0092): every write names that
 * admin. Mounted only while the panel holds it for the admin who opened it (`useHeldForOperator`),
 * so what was picked and typed for A goes with it once `['me']` turns to B (ADR-0092 answer 1).
 * The request names the pause it was opened on (`pauseId`) and each decision the request it was
 * opened on (`usePinnedPause`, `usePinnedRequest`). A refusal stays in the dialog, under the field
 * it is about or above the buttons (`pauseFailure`); another account's cookie closes it with a
 * toast.
 * Sent, it closes with a toast and the market as the write committed it goes on screen
 * (`useApplyMarket`) — and the panel puts focus on what took the button's place (`onClose(true)`).
 */

export type PauseDialogKind = 'pause' | 'offer' | 'request' | 'approve' | 'reject' | 'retract';

export function PauseDialog({
  kind,
  market,
  readAt,
  onClose,
}: {
  kind: PauseDialogKind;
  market: AdminMarket;
  readAt: number;
  onClose: (sent: boolean) => void;
}) {
  switch (kind) {
    case 'pause':
      return <PauseMarketDialog market={market} preset={null} onClose={onClose} />;
    case 'offer':
      return (
        <PauseMarketDialog market={market} preset={pauseOffer(market, readAt)} onClose={onClose} />
      );
    case 'request':
      return <RequestPauseDecisionDialog market={market} onClose={onClose} />;
    case 'approve':
      return <ApprovePauseDecisionDialog market={market} onClose={onClose} />;
    case 'reject':
      return <RejectPauseDecisionDialog market={market} onClose={onClose} />;
    case 'retract':
      return <RetractPauseDecisionDialog market={market} onClose={onClose} />;
  }
}

/**
 * The pause a request dialog was opened on, kept from its first draw — a refetch while it is open
 * must not move it — with its reason, which says whether a review result is asked; sent as
 * `pauseId`, so a pause resumed and another made meanwhile gets no path its admin picked for the
 * old one (the server refuses it 'stale'). `changed` once the market's current pause is another
 * (or none): the dialog says so and its confirm stays off.
 */
function usePinnedPause(market: AdminMarket) {
  const [pause] = useState(() => currentPause(market));
  return { pause, changed: pause === null || currentPause(market)?.id !== pause.id };
}

/**
 * The request a decision dialog was opened on: sent as `requestId` and kept from the dialog's first
 * draw, with its path (what the approval does) — so a request retracted and another made meanwhile
 * is decided by no confirmation its admin gave the old one. `changed` once the market's waiting
 * request is another (or none); the server refuses the old one regardless ('decided',
 * 'retracted').
 */
function usePinnedRequest(market: AdminMarket) {
  const [request] = useState(() => market.pause.pending);
  return {
    request,
    changed: request === null || market.pause.pending?.requestId !== request.requestId,
  };
}

/** What each write sends, taken from the dialog when its confirm is pressed; `by` is the admin. */
interface PauseVariables {
  reason: MarketPauseReason;
  note: string;
  resultPublishedAt: string | null;
  by: string;
}
interface RequestVariables {
  pauseId: string;
  path: MarketPausePath;
  reviewResult: MarketPauseReviewResult | null;
  reason: string;
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
 * One pause write: sent as the admin on screen, its refusal said where `pauseFailure` puts it — the
 * detail read again when the screen behind is out of date — and its answer applied. `success` is
 * the toast, or how to say it from the market the write answered with (the approval's).
 */
function usePauseWrite<V>(
  market: AdminMarket,
  onClose: (sent: boolean) => void,
  write: PauseWrite,
  success: string | ((fresh: AdminMarket) => string),
  send: (variables: V) => Promise<AdminMarket>,
) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [fieldError, setFieldError] = useState<{ field: PauseField; message: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({
        type: 'success',
        title: typeof success === 'string' ? success : success(fresh),
      });
      onClose(true);
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = pauseFailure(error, write);
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
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });
  const errorOf = (field: PauseField) => (fieldError?.field === field ? fieldError.message : null);
  return { mutation, errorOf, refusal };
}

/**
 * 거래 일시 중단's fields: the reason of the three, each a radio with its line of when it is the one
 * (MARKET_PAUSE_REASONS order; 실질 기준 변경's says a schedule moved earlier belongs here, Q2) — the
 * test id on the label element, so a click on it is the click that picks — then the note, and for
 * an early result the publication instant as a KST `datetime-local` (decision 3), its rule's
 * sentence under it as soon as it is broken (`pauseDraft`) or the server's refusal.
 */
export function PauseFields({
  value,
  onValue,
  reasonError,
  note,
  onNote,
  noteError,
  publicNoteConfirmed,
  onPublicNoteConfirmed,
  publicNoteError,
  publishedLocal,
  onPublishedLocal,
  publishedAtError,
  disabled,
}: {
  value: string;
  onValue: (value: string) => void;
  reasonError: string | null;
  note: string;
  onNote: (value: string) => void;
  noteError: string | null;
  publicNoteConfirmed: boolean;
  onPublicNoteConfirmed: (confirmed: boolean) => void;
  publicNoteError: string | null;
  publishedLocal: string;
  onPublishedLocal: (value: string) => void;
  publishedAtError: string | null;
  disabled: boolean;
}) {
  const picked = MARKET_PAUSE_REASONS.find((reason) => reason === value);
  return (
    <Stack gap="4">
      <Field.Root invalid={reasonError !== null} required>
        {/* The group's accessible name is its own Label part (as the 판정 form's): zag emits
            `role="radiogroup"` with `aria-labelledby` pointing at that id. */}
        <RadioGroup.Root
          name="pause-reason"
          value={value === '' ? null : value}
          onValueChange={(details) => onValue(details.value ?? '')}
          disabled={disabled}
          colorPalette="brand"
        >
          <RadioGroup.Label fontWeight="medium" mb="1">
            {copy.adminMarketPauseReason}
          </RadioGroup.Label>
          <Stack gap="3">
            {MARKET_PAUSE_REASONS.map((reason) => (
              <RadioGroup.Item
                key={reason}
                value={reason}
                alignItems="flex-start"
                data-testid={`market-pause-reason-${reason}`}
              >
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemIndicator mt="0.5" />
                <Stack gap="0">
                  <RadioGroup.ItemText>{PAUSE_REASON_LABEL[reason]}</RadioGroup.ItemText>
                  <Text fontSize="sm" color="fg.muted">
                    {PAUSE_REASON_HINT[reason]}
                  </Text>
                </Stack>
              </RadioGroup.Item>
            ))}
          </Stack>
        </RadioGroup.Root>
        <Field.ErrorText data-testid="market-pause-reason-error">{reasonError}</Field.ErrorText>
      </Field.Root>
      <ReasonField
        testId="market-pause-note"
        label={copy.adminMarketPauseNote}
        hint={copy.adminMarketPauseNoteHint}
        value={note}
        onChange={onNote}
        error={noteError}
        disabled={disabled}
      />
      <Field.Root invalid={publicNoteError !== null} required>
        <Checkbox.Root
          checked={publicNoteConfirmed}
          onCheckedChange={(details) => onPublicNoteConfirmed(details.checked === true)}
          disabled={disabled}
          data-testid="market-pause-public-note-confirmed"
          alignItems="start"
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>{copy.adminMarketPausePublicNoteConfirm}</Checkbox.Label>
        </Checkbox.Root>
        <Field.ErrorText>{publicNoteError}</Field.ErrorText>
      </Field.Root>
      {picked !== undefined && pauseReasonNeedsPublishedAt(picked) && (
        <Field.Root invalid={publishedAtError !== null} required>
          <Field.Label>{copy.adminMarketPauseResultPublishedAt}</Field.Label>
          <Input
            type="datetime-local"
            value={publishedLocal}
            onChange={(event) => onPublishedLocal(event.target.value)}
            disabled={disabled}
            data-testid="market-pause-published-at"
          />
          <Field.HelperText>{copy.adminMarketPauseResultPublishedAtHint}</Field.HelperText>
          <Field.ErrorText data-testid="market-pause-published-at-error">
            {publishedAtError}
          </Field.ErrorText>
        </Field.Root>
      )}
    </Stack>
  );
}

/**
 * 거래 일시 중단 (OPEN → PAUSED, one admin, #173 item 2): the confirm waits for a reason, a note and,
 * for an early result, a publication instant not after now (`pauseDraft`, drawn again as that
 * minute comes — `publishedAtWait`). `preset` is what it opens with — the 의미 변경 반려's 실질 기준
 * 변경 and 설명 (`pauseOffer`), every field still the admin's to change.
 */
function PauseMarketDialog({
  market,
  preset,
  onClose,
}: {
  market: AdminMarket;
  preset: PausePreset | null;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const [value, setValue] = useState<string>(preset?.reason ?? '');
  const [noteText, setNoteText] = useState(preset?.note ?? '');
  const [publicNoteConfirmed, setPublicNoteConfirmed] = useState(false);
  const [publishedLocal, setPublishedLocal] = useState('');
  const [sentLocal, setSentLocal] = useState<string | null>(null);
  const draft = pauseDraft(value, noteText, publishedLocal);
  // `pauseDraft` reads the clock as the dialog draws: while 'after now' is said, draw again once
  // the minute typed has come, so the sentence goes and the confirm comes on by themselves. No
  // wait left (the minute came between the draw and this effect) is a draw again at once: that
  // draw no longer says 'after now', so no timer follows it.
  const [drawn, setDrawn] = useState(0);
  const afterNow = draft.publishedAtError === copy.errMarketPausePublishedAtAfter;
  useEffect(() => {
    if (!afterNow) return;
    const wait = publishedAtWait(publishedLocal, Date.now()) ?? 0;
    const timer = setTimeout(() => setDrawn((count) => count + 1), wait);
    return () => clearTimeout(timer);
  }, [afterNow, publishedLocal, drawn]);
  const { mutation, errorOf, refusal } = usePauseWrite(
    market,
    onClose,
    'pause',
    copy.adminMarketPaused,
    async ({ reason, note, resultPublishedAt, by }: PauseVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/pause', {
          params: { path: { id: market.id } },
          body: {
            reason,
            note,
            publicNoteConfirmed: true,
            resultPublishedAt,
            expectedAccountId: by,
          },
        }),
      ).data,
  );
  // The server's refusal of the instant holds while the field holds what was sent; the rule's own
  // sentence comes first once the admin types again.
  const serverAtError = sentLocal === publishedLocal ? errorOf('resultPublishedAt') : null;
  return (
    <ReviewDialogShell
      testId="market-pause-dialog"
      title={copy.adminMarketPauseTitle}
      body={copy.adminMarketPauseBody}
      confirmLabel={copy.adminMarketPause}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || !publicNoteConfirmed || operatorId === undefined}
      refusal={refusal}
      onClose={() => onClose(false)}
      onConfirm={() => {
        if (operatorId === undefined || draft.reason === null || !publicNoteConfirmed) return;
        setSentLocal(publishedLocal);
        mutation.mutate({
          reason: draft.reason,
          note: draft.note,
          resultPublishedAt: draft.resultPublishedAt,
          by: operatorId,
        });
      }}
    >
      <PauseFields
        value={value}
        onValue={setValue}
        reasonError={errorOf('pauseReason')}
        note={noteText}
        onNote={setNoteText}
        noteError={errorOf('note')}
        publicNoteConfirmed={publicNoteConfirmed}
        onPublicNoteConfirmed={setPublicNoteConfirmed}
        publicNoteError={errorOf('publicNoteConfirmed')}
        publishedLocal={publishedLocal}
        onPublishedLocal={setPublishedLocal}
        publishedAtError={draft.publishedAtError ?? serverAtError}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/**
 * 재개·조기 마감 요청's fields, for a pause of `pauseReason`: the path, then — for a 실질 기준 변경
 * pause alone — the review result, each choice with its line (Q1); 판정 불가 turns 재개 off and says
 * the judgement applies the VOID rule after the close (#173 item 4); then the reason. The review
 * result has no error line: the confirm waits for one where it is asked, and the server's refusal
 * of it is the dialog's alert (`pauseFailure`).
 */
export function PauseDecisionFields({
  pauseReason,
  path,
  onPath,
  pathError,
  review,
  onReview,
  resumeOff,
  reason,
  onReason,
  reasonError,
  disabled,
}: {
  pauseReason: MarketPauseReason;
  path: string;
  onPath: (value: string) => void;
  pathError: string | null;
  review: string;
  onReview: (value: string) => void;
  resumeOff: boolean;
  reason: string;
  onReason: (value: string) => void;
  reasonError: string | null;
  disabled: boolean;
}) {
  return (
    <Stack gap="4">
      <Text fontSize="sm" color="fg.muted" data-testid="market-pause-request-pause-reason">
        {copy.adminMarketPauseReason} {PAUSE_REASON_LABEL[pauseReason]}
      </Text>
      {pauseReasonNeedsReview(pauseReason) && (
        <Field.Root required>
          <RadioGroup.Root
            name="pause-review-result"
            value={review === '' ? null : review}
            onValueChange={(details) => onReview(details.value ?? '')}
            disabled={disabled}
            colorPalette="brand"
          >
            <RadioGroup.Label fontWeight="medium" mb="1">
              {copy.adminMarketPauseRequestReview}
            </RadioGroup.Label>
            <Text fontSize="sm" color="fg.muted" mb="2">
              {copy.adminMarketPauseRequestReviewHint}
            </Text>
            <Stack gap="3">
              {MARKET_PAUSE_REVIEW_RESULTS.map((result) => (
                <RadioGroup.Item
                  key={result}
                  value={result}
                  alignItems="flex-start"
                  data-testid={`market-pause-request-review-${result}`}
                >
                  <RadioGroup.ItemHiddenInput />
                  <RadioGroup.ItemIndicator mt="0.5" />
                  <Stack gap="0">
                    <RadioGroup.ItemText>{PAUSE_REVIEW_RESULT_LABEL[result]}</RadioGroup.ItemText>
                    <Text fontSize="sm" color="fg.muted">
                      {PAUSE_REVIEW_RESULT_HINT[result]}
                    </Text>
                  </Stack>
                </RadioGroup.Item>
              ))}
            </Stack>
          </RadioGroup.Root>
        </Field.Root>
      )}
      <Field.Root invalid={pathError !== null} required>
        <RadioGroup.Root
          name="pause-path"
          value={path === '' ? null : path}
          onValueChange={(details) => onPath(details.value ?? '')}
          disabled={disabled}
          colorPalette="brand"
        >
          <RadioGroup.Label fontWeight="medium" mb="1">
            {copy.adminMarketPauseRequestPath}
          </RadioGroup.Label>
          <Stack gap="2" direction="row" flexWrap="wrap" columnGap="6">
            {MARKET_PAUSE_PATHS.map((option) => (
              <RadioGroup.Item
                key={option}
                value={option}
                disabled={option === 'resume' && resumeOff}
                data-testid={`market-pause-request-path-${option}`}
              >
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemIndicator />
                <RadioGroup.ItemText>{PAUSE_PATH_LABEL[option]}</RadioGroup.ItemText>
              </RadioGroup.Item>
            ))}
          </Stack>
        </RadioGroup.Root>
        {resumeOff && (
          <Text fontSize="sm" color="fg.muted" data-testid="market-pause-request-early-close-only">
            {copy.pauseReviewNotJudgeableHint}
          </Text>
        )}
        <Field.ErrorText data-testid="market-pause-request-path-error">{pathError}</Field.ErrorText>
      </Field.Root>
      <ReasonField
        testId="market-pause-request-reason"
        label={copy.adminMarketPauseRequestReason}
        hint={copy.adminMarketPauseDecisionHint}
        value={reason}
        onChange={onReason}
        error={reasonError}
        disabled={disabled}
      />
    </Stack>
  );
}

/**
 * 재개·조기 마감 요청 (PAUSED, #173 item 2): the confirm waits for a path the pause's reason allows
 * and a reason (`pauseDecisionDraft`). Picking 판정 불가 drops a 재개 picked before it. It names the
 * pause it was opened on (`pauseId`); refused for another ('stale'), it says to ask again.
 */
function RequestPauseDecisionDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const pinned = usePinnedPause(market);
  // The panel offers the request on a lasting pause alone; opened on none, `changed` keeps the
  // confirm off and says so, and the fields are drawn as a pause that takes no review result.
  const pauseReason = pinned.pause?.reason ?? 'ledger_failure';
  const [path, setPath] = useState('');
  const [review, setReview] = useState('');
  const [reasonText, setReasonText] = useState('');
  const draft = pauseDecisionDraft(pauseReason, path, review, reasonText);
  const { mutation, errorOf, refusal } = usePauseWrite(
    market,
    onClose,
    'request',
    copy.adminMarketPauseRequested,
    async ({ pauseId, path, reviewResult, reason, by }: RequestVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/pause-decisions', {
          params: { path: { id: market.id } },
          body: { pauseId, path, reviewResult, reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-pause-request-dialog"
      title={copy.adminMarketPauseRequestTitle}
      body={copy.adminMarketPauseRequestBody}
      confirmLabel={copy.adminMarketPauseRequest}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || pinned.changed}
      refusal={refusal ?? (pinned.changed ? copy.adminMarketPauseChanged : null)}
      onClose={() => onClose(false)}
      onConfirm={() => {
        const pauseId = pinned.pause?.id;
        if (operatorId === undefined || pauseId === undefined || draft.path === null) return;
        mutation.mutate({
          pauseId,
          path: draft.path,
          reviewResult: draft.reviewResult,
          reason: draft.reason,
          by: operatorId,
        });
      }}
    >
      <PauseDecisionFields
        pauseReason={pauseReason}
        path={path}
        onPath={setPath}
        pathError={errorOf('path')}
        review={review}
        onReview={(value) => {
          setReview(value);
          if (value === 'not_judgeable' && path === 'resume') setPath('');
        }}
        resumeOff={draft.resumeOff}
        reason={reasonText}
        onReason={setReasonText}
        reasonError={errorOf('reason')}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/** What the request a decision dialog decides asks for: its path and review result. */
function PinnedRequestLine({
  request,
  testId,
}: {
  request: MarketPauseDecisionPending | null;
  testId: string;
}) {
  if (request === null) return null;
  const review = request.reviewResult;
  return (
    <Text fontSize="sm" color="fg.muted" data-testid={testId}>
      {copy.adminMarketPauseRequestPath} {PAUSE_PATH_LABEL[request.path]}
      {review === null
        ? ''
        : ` · ${copy.adminMarketPauseRequestReview} ${PAUSE_REVIEW_RESULT_LABEL[review]}`}
    </Text>
  );
}

/**
 * 승인 (an admin other than the requester, #173 item 2): the market resumes or closes early at
 * once, as the request asks — the body says which. The confirm waits for a reason (`revertDraft`:
 * 1..500 trimmed); the toast says what the market became.
 */
function ApprovePauseDecisionDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const decided = usePinnedRequest(market);
  const { mutation, errorOf, refusal } = usePauseWrite(
    market,
    onClose,
    'decision',
    (fresh) => pauseApprovalSuccess(fresh.status),
    async ({ requestId, reason, by }: DecideVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/pause-decisions/{requestId}/approve', {
          params: { path: { id: market.id, requestId } },
          body: { reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-pause-approve-dialog"
      title={copy.adminMarketPauseApproveTitle}
      body={
        decided.request?.path === 'early_close'
          ? copy.adminMarketPauseApproveEarlyCloseBody
          : copy.adminMarketPauseApproveResumeBody
      }
      confirmLabel={copy.adminMarketPauseApprove}
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
        <PinnedRequestLine request={decided.request} testId="market-pause-approve-request" />
        <ReasonField
          testId="market-pause-approve-reason"
          label={copy.adminMarketPauseApproveReason}
          hint={copy.adminMarketPauseDecisionHint}
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
 * 반려 (an admin other than the requester, in any status — a request still waiting at the close
 * ends so): nothing changes. The confirm waits for a reason.
 */
function RejectPauseDecisionDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const decided = usePinnedRequest(market);
  const { mutation, errorOf, refusal } = usePauseWrite(
    market,
    onClose,
    'decision',
    copy.adminMarketPauseRejected,
    async ({ requestId, reason, by }: DecideVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/pause-decisions/{requestId}/reject', {
          params: { path: { id: market.id, requestId } },
          body: { reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-pause-reject-dialog"
      title={copy.adminMarketPauseRejectTitle}
      body={copy.adminMarketPauseRejectBody}
      confirmLabel={copy.adminMarketPauseReject}
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
        <PinnedRequestLine request={decided.request} testId="market-pause-reject-request" />
        <ReasonField
          testId="market-pause-reject-reason"
          label={copy.adminMarketPauseRejectReason}
          hint={copy.adminMarketPauseDecisionHint}
          value={reasonText}
          onChange={setReasonText}
          error={errorOf('reason')}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

/** 철회 (the requester's alone, any status): nothing to fill in, the confirm says what it does. */
function RetractPauseDecisionDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const decided = usePinnedRequest(market);
  const { mutation, refusal } = usePauseWrite(
    market,
    onClose,
    'decision',
    copy.adminMarketPauseRetracted,
    async ({ requestId, by }: RetractVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/pause-decisions/{requestId}/retract', {
          params: { path: { id: market.id, requestId } },
          body: { expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-pause-retract-dialog"
      title={copy.adminMarketPauseRetractTitle}
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
      <PinnedRequestLine request={decided.request} testId="market-pause-retract-request" />
    </ReviewDialogShell>
  );
}
