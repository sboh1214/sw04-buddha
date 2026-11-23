'use client';

import { Alert, Box, Field, Stack, Text, Textarea } from '@chakra-ui/react';
import { APPROVAL_REASON_MAX_LENGTH } from '@buddha/shared';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { invalidateMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { attemptsText, settlementRetryFailure } from '@/lib/admin-operations';
import { type AdminSettlementRetryResult, api, unwrap } from '@/lib/api';
import { ReviewDialogShell } from '../markets/[id]/market-review-dialogs';

/**
 * 정산 다시 시도 (#145, ADR-0163; 145-7 "1인, 사유 필수", 145-14 "지급 중(SETTLING)만"; ADR-0093
 * 결정 1 #173 14항): one admin writes a reason and runs one payout attempt at once — the worker's
 * own core with the same checks as its per-minute retry, so nothing here can change an amount or
 * skip a check; the body is the reason and the admin on screen alone. The reason is required,
 * 1..500 after trimming (the confirm stays off until then, and the server checks it again). Drawn
 * in the review's frame (`ReviewDialogShell`), its field in an `OperatorFieldset` and the confirm
 * off until the admin on screen is known (`useOperatorId`, ADR-0092): the attempt names that admin.
 * Mounted only while the failures list holds it for the admin who opened it (`useHeldForOperator`),
 * so what was typed for A goes with it once `['me']` turns to B (ADR-0092 answer 1).
 *
 * An attempt that ran answers 200 with its outcome (145-7 결과): `settled` closes with a toast and
 * the row leaves; `failed` keeps the dialog open over the error the step now holds — as stored, its
 * first two lines with the rest on expand (145-18) — and its attempt count, and the lists behind
 * are read again either way (`invalidateMarket`, which holds 운영 대기열's prefix). A refused click is
 * no attempt (`settlementRetryFailure`): a market no longer 지급 중 closes with a toast and a fresh
 * read, another account's cookie closes with a toast, the reason is said under its field, and the
 * rest above the buttons — the worker's run holding the market's lock among them (TRANSACTION_BUSY,
 * nothing recorded).
 */

/** What the failures list opened the dialog on. */
export interface SettlementRetryTarget {
  id: string;
  title: string;
}

/** What one attempt sends, taken when the confirm is pressed; `by` is the admin on screen. */
export interface SettlementRetryVariables {
  reason: string;
  by: string;
}

type RetryFailed = Extract<AdminSettlementRetryResult, { outcome: 'failed' }>;

/** What the dialog shows and does for a mutation's outcome: the node-testable half. */
export interface SettlementRetryView {
  /** The attempt ran and settled, or the market is no longer 지급 중: the dialog goes. */
  close: () => void;
  /** The attempt ran and failed: the dialog stays over the step's error and attempts. */
  showFailed: (result: RetryFailed | null) => void;
  setFieldError: (message: string | null) => void;
  setRefusal: (message: string | null) => void;
  /** Asks for the session again on another account's cookie (`useSessionChanged`). */
  sessionChanged: (error: unknown) => boolean;
}

/** `POST /admin/markets/:id/settlement-retries` with the reason and the admin on screen. */
export async function postSettlementRetry(
  marketId: string,
  { reason, by }: SettlementRetryVariables,
): Promise<AdminSettlementRetryResult> {
  return unwrap(
    await api.POST('/api/v1/admin/markets/{id}/settlement-retries', {
      params: { path: { id: marketId } },
      body: { reason, expectedAccountId: by },
    }),
  ).data;
}

/**
 * The attempt as mutation options (as `updateTimeZoneOptions` is): `send` is the POST, `view` what
 * the dialog does with each outcome. Every outcome but a field's or an alert that needs nothing
 * read reads the market again — and with it 운영 대기열's lists (`invalidateMarket`).
 */
export function settlementRetryOptions(
  queryClient: QueryClient,
  marketId: string,
  send: (variables: SettlementRetryVariables) => Promise<AdminSettlementRetryResult>,
  view: SettlementRetryView,
) {
  const refresh = () => invalidateMarket(queryClient, marketId);
  return {
    mutationFn: send,
    onMutate: () => {
      view.setFieldError(null);
      view.setRefusal(null);
      view.showFailed(null);
    },
    onSuccess: async (result: AdminSettlementRetryResult) => {
      if (result.outcome === 'settled') {
        toaster.create({ type: 'success', title: copy.adminSettlementRetryDone });
        view.close();
      } else {
        view.showFailed(result);
      }
      await refresh();
    },
    onError: async (error: Error) => {
      view.sessionChanged(error);
      const failure = settlementRetryFailure(error);
      if (failure.kind === 'not_settling') {
        toaster.create({ type: 'info', title: copy.adminSettlementRetryNotSettling });
        view.close();
        await refresh();
        return;
      }
      if (failure.kind === 'toast') {
        // Another account's cookie: the page drops this dialog once the session names the admin
        // really signed in, so the refusal is a toast that outlives it.
        toaster.create({ type: 'error', title: failure.message });
        view.close();
        return;
      }
      if (failure.kind === 'field') {
        view.setFieldError(failure.message);
        return;
      }
      view.setRefusal(failure.message);
      if (failure.refresh) await refresh();
    },
  };
}

export function SettlementRetryDialog({
  market,
  onClose,
}: {
  market: SettlementRetryTarget;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failed, setFailed] = useState<RetryFailed | null>(null);
  const mutation = useMutation(
    settlementRetryOptions(
      queryClient,
      market.id,
      (variables) => postSettlementRetry(market.id, variables),
      { close: onClose, showFailed: setFailed, setFieldError, setRefusal, sessionChanged },
    ),
  );
  const trimmed = reason.trim();
  const ready = trimmed.length >= 1 && trimmed.length <= APPROVAL_REASON_MAX_LENGTH;
  return (
    <ReviewDialogShell
      testId="settlement-retry-dialog"
      title={copy.adminSettlementRetryTitle}
      body={copy.adminSettlementRetryHint}
      confirmLabel={copy.adminSettlementRetry}
      pending={mutation.isPending}
      confirmDisabled={!ready || operatorId === undefined}
      refusal={refusal}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId === undefined) return;
        mutation.mutate({ reason: trimmed, by: operatorId });
      }}
    >
      <Stack gap="4">
        <Text fontWeight="semibold" wordBreak="break-word" data-testid="settlement-retry-market">
          {market.title}
        </Text>
        <OperatorFieldset disabled={operatorId === undefined}>
          <Field.Root invalid={fieldError !== null} required>
            <Field.Label>{copy.adminMarketReviewReason}</Field.Label>
            <Textarea
              rows={3}
              value={reason}
              maxLength={APPROVAL_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
              disabled={mutation.isPending}
              data-testid="settlement-retry-reason"
            />
            <Field.ErrorText data-testid="settlement-retry-reason-error">
              {fieldError}
            </Field.ErrorText>
          </Field.Root>
        </OperatorFieldset>
        {failed !== null && (
          <Alert.Root status="warning" role="status" data-testid="settlement-retry-failed">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{copy.adminSettlementRetryFailed}</Alert.Title>
              <Alert.Description>
                <Stack gap="1">
                  {failed.settlementAttempts !== null && (
                    <Text data-testid="settlement-retry-failed-attempts">
                      {attemptsText(failed.settlementAttempts)}
                    </Text>
                  )}
                  {failed.settlementLastError !== null && (
                    <LastErrorText
                      error={failed.settlementLastError}
                      testId="settlement-retry-failed-error"
                    />
                  )}
                </Stack>
              </Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
      </Stack>
    </ReviewDialogShell>
  );
}

/**
 * The step's last error as stored (145-18 "저장된 글 그대로 두 줄까지 보이고 펼칠 수 있다"): under
 * '마지막 오류', its first two lines, and the whole text once opened — a native disclosure, so it
 * needs no state and a keyboard opens it. The text is inside the summary: a closed disclosure hides
 * everything else.
 */
export function LastErrorText({ error, testId }: { error: string; testId: string }) {
  return (
    <details data-testid={testId}>
      <Box as="summary" cursor="pointer" fontSize="sm">
        <Text as="span" fontWeight="medium">
          {copy.adminOperationsLastError}
        </Text>
        <Text
          as="span"
          display="block"
          fontFamily="mono"
          whiteSpace="pre-wrap"
          wordBreak="break-word"
          lineClamp="2"
          css={{ 'details[open] &': { WebkitLineClamp: 'unset', overflow: 'visible' } }}
          data-testid={`${testId}-text`}
        >
          {error}
        </Text>
      </Box>
    </details>
  );
}
