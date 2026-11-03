'use client';

import { Field, Input, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminJudgementDelay, type AdminMarket, api, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  type JudgementDelayField,
  currentJudgementDelayRecord,
  judgementDelayDefaults,
  judgementDelayDraft,
  judgementDelayDraftWait,
  judgementDelayFailure,
} from '@/lib/market-judgement-delay';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * 지연 기록 등록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·11·13, decision 3 '#142 지연 사유',
 * the owner's answers of 2026-11-03 (1)·(4)): one admin, at once, no approval — any admin, the
 * registrant of a waiting judgement included — the 지연 사유 (the one public sentence, 1..500) and
 * the 다음 검토 시각 as a KST `datetime-local`, after now and within JUDGEMENT_DELAY_REVIEW_MAX_DAYS
 * days (`judgementDelayDraft`, drawn again as either bound moves — `judgementDelayDraftWait`; the
 * server checks both again on its database clock). It opens with the current record's reason, which
 * it shows with its time: a change is a new record, never an edit. Drawn in the review's frame
 * (`ReviewDialogShell`), the confirm off until both are good and until the admin on screen is known
 * (`useOperatorId`, ADR-0092): the record names that admin. Mounted only while the section holds it
 * for the admin who opened it (`useHeldForOperator`), so what was typed for A goes with it once
 * `['me']` turns to B (ADR-0092 answer 1). A refusal stays in the dialog, under the field it is
 * about or above the buttons (`judgementDelayFailure`); another account's cookie closes it with a
 * toast. Sent, it closes with a toast and the market as the record committed it goes on screen
 * (`useApplyMarket`) — the new record current, the earlier ones its history — and the section puts
 * focus on the current record (`onClose(true)`).
 */

/** What the section opened: the record dialog. */
export type JudgementDelayAction = 'record';

/** What a record sends, taken from the dialog when its confirm is pressed; `by` is the admin. */
interface RecordVariables {
  reason: string;
  nextReviewAt: string;
  by: string;
}

export function JudgementDelayDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: (sent: boolean) => void;
}) {
  const operatorId = useOperatorId();
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  // The current record as the dialog opened: what it shows and starts the reason from.
  const [opened] = useState(() => ({
    current: currentJudgementDelayRecord(market),
    ...judgementDelayDefaults(market),
  }));
  const [reasonText, setReasonText] = useState(opened.reasonText);
  const [nextLocal, setNextLocal] = useState(opened.nextLocal);
  const [sentLocal, setSentLocal] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{
    field: JudgementDelayField;
    message: string;
  } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const draft = judgementDelayDraft(reasonText, nextLocal);
  // `judgementDelayDraft` reads the clock as the dialog draws, and both of the time's bounds move
  // with it: while one is ahead — a good time turning past, one too far coming within the bound —
  // draw again once it has come, so the sentence and the confirm follow by themselves.
  const [drawn, setDrawn] = useState(0);
  const moving =
    draft.nextReviewAt !== null ||
    draft.nextReviewError === copy.errMarketJudgementDelayNextReviewTooFar;
  useEffect(() => {
    if (!moving) return;
    const wait = judgementDelayDraftWait(nextLocal, Date.now()) ?? 0;
    const timer = setTimeout(() => setDrawn((count) => count + 1), wait);
    return () => clearTimeout(timer);
  }, [moving, nextLocal, drawn]);

  const mutation = useMutation({
    mutationFn: async ({ reason, nextReviewAt, by }: RecordVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/judgement-delays', {
          params: { path: { id: market.id } },
          body: { reason, nextReviewAt, expectedAccountId: by },
        }),
      ).data,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminMarketJudgementDelayRecorded });
      onClose(true);
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = judgementDelayFailure(error);
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
  const errorOf = (field: JudgementDelayField) =>
    fieldError?.field === field ? fieldError.message : null;
  // The server's refusal of the time holds while the field holds what was sent; the rule's own
  // sentence comes first once the admin types again. The reason's empty field is said once sent.
  const serverAtError = sentLocal === nextLocal ? errorOf('nextReviewAt') : null;
  const reasonError =
    errorOf('reason') ?? (sentLocal !== null || reasonText !== '' ? draft.reasonError : null);
  return (
    <ReviewDialogShell
      testId="market-judgement-delay-dialog"
      title={copy.adminMarketJudgementDelayTitle}
      body={copy.adminMarketJudgementDelayBody}
      confirmLabel={copy.adminMarketJudgementDelayConfirm}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined}
      refusal={refusal}
      onClose={() => onClose(false)}
      onConfirm={() => {
        if (operatorId === undefined || draft.nextReviewAt === null) return;
        setSentLocal(nextLocal);
        mutation.mutate({ reason: draft.reason, nextReviewAt: draft.nextReviewAt, by: operatorId });
      }}
    >
      <JudgementDelayFields
        current={opened.current}
        reason={reasonText}
        onReason={setReasonText}
        reasonError={reasonError}
        nextLocal={nextLocal}
        onNextLocal={setNextLocal}
        nextReviewError={draft.nextReviewError ?? serverAtError}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/**
 * 지연 기록 등록's fields: the current record it replaces as current (its reason and next review
 * time, none before a first record), the 지연 사유 — the public sentence, its hint saying what not
 * to write (no name, no expected result, no correction not yet approved: ADR-0105 keeps those
 * private) — and the 다음 검토 시각 as a KST `datetime-local`, its rule's sentence under it as soon
 * as it is broken (`judgementDelayDraft`) or the server's refusal.
 */
export function JudgementDelayFields({
  current,
  reason,
  onReason,
  reasonError,
  nextLocal,
  onNextLocal,
  nextReviewError,
  disabled,
}: {
  current: Pick<AdminJudgementDelay, 'reason' | 'nextReviewAt'> | null;
  reason: string;
  onReason: (value: string) => void;
  reasonError: string | null;
  nextLocal: string;
  onNextLocal: (value: string) => void;
  nextReviewError: string | null;
  disabled: boolean;
}) {
  return (
    <Stack gap="4">
      {current !== null && (
        <Text
          fontSize="sm"
          color="fg.muted"
          whiteSpace="pre-wrap"
          wordBreak="break-word"
          data-testid="market-judgement-delay-dialog-current"
        >
          <Text as="span" fontWeight="medium">
            {copy.adminMarketJudgementDelayCurrent}
          </Text>{' '}
          {current.reason} · {copy.adminMarketJudgementDelayNextReviewAt}{' '}
          {formatKst(current.nextReviewAt)}
        </Text>
      )}
      <ReasonField
        testId="market-judgement-delay-reason"
        label={copy.adminMarketJudgementDelayReason}
        hint={copy.adminMarketJudgementDelayReasonHint}
        value={reason}
        onChange={onReason}
        error={reasonError}
        disabled={disabled}
      />
      <Field.Root invalid={nextReviewError !== null} required>
        <Field.Label>{copy.adminMarketJudgementDelayNextReviewAt}</Field.Label>
        <Input
          type="datetime-local"
          value={nextLocal}
          onChange={(event) => onNextLocal(event.target.value)}
          disabled={disabled}
          data-testid="market-judgement-delay-next-review"
        />
        <Field.HelperText>{copy.adminMarketJudgementDelayNextReviewHint}</Field.HelperText>
        <Field.ErrorText data-testid="market-judgement-delay-next-review-error">
          {nextReviewError}
        </Field.ErrorText>
      </Field.Root>
    </Stack>
  );
}
