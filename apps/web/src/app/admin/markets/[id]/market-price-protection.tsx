'use client';

import { Button, DataList, Field, HStack, Input, Stack, Text } from '@chakra-ui/react';
import { PRICE_PROTECTION_TICKS_MAX, PRICE_PROTECTION_TICKS_MIN } from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, api, unwrap } from '@/lib/api';
import { priceProtectionText } from '@/lib/market-admin';
import {
  type PriceProtectionField,
  canChangePriceProtection,
  priceProtectionDraft,
  priceProtectionFailure,
} from '@/lib/market-price-protection';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

/**
 * 가격 보호 폭 (#119, ADR-0112; ADR-0107 결정 1 #177 2항), one row of the admin detail: the width an
 * immediate order's limit is narrowed by — the market's own, copied at its creation and stored by
 * the review's submission (ADR-0093 #172 6항); a draft created with none shows the release
 * setting's now; 미정 while there is none — and, on an OPEN or PAUSED market, 변경, whose dialog
 * is held for the admin who opened it (`useHeldForOperator`).
 * Keyed by the market where it is drawn, so a dialog never names the next market.
 */
export function PriceProtectionItem({ market }: { market: AdminMarket }) {
  const operatorId = useOperatorId();
  const [open, setOpen] = useHeldForOperator<true>();
  const changeable = canChangePriceProtection(market.status);
  return (
    <DataList.Item data-testid="market-detail-price-protection">
      <DataList.ItemLabel>{copy.adminMarketPriceProtection}</DataList.ItemLabel>
      <DataList.ItemValue>
        <HStack gap="2" flexWrap="wrap">
          <Text as="span" data-testid="market-detail-price-protection-value">
            {priceProtectionText(market.priceProtectionTicks)}
          </Text>
          {changeable && (
            <Button
              size="xs"
              variant="outline"
              disabled={operatorId === undefined}
              onClick={() => setOpen(true)}
              data-testid="market-price-protection-change"
            >
              {copy.adminMarketPriceProtectionChange}
            </Button>
          )}
        </HStack>
        {open !== null && changeable && (
          <PriceProtectionDialog market={market} onClose={() => setOpen(null)} />
        )}
      </DataList.ItemValue>
    </DataList.Item>
  );
}

/** What the change sends, taken from the dialog when its confirm is pressed; `by` is the admin. */
interface ChangeVariables {
  priceProtectionTicks: number;
  reason: string;
  by: string;
}

/**
 * 가격 보호 폭 변경 (one admin, with the reason; OPEN or PAUSED): the width the market holds, the new
 * one and the reason. The confirm waits until the width is a whole number of ticks in range and
 * not the one held, and a reason is typed (`priceProtectionDraft`). A refusal stays in the dialog
 * under its field or above the buttons (`priceProtectionFailure`); another account's cookie
 * closes it with a toast. Sent, it closes with a toast and the market as the change committed it
 * goes on screen — the next immediate order takes the new width, resting ones keep theirs.
 */
export function PriceProtectionDialog({
  market,
  onClose,
}: {
  market: AdminMarket;
  onClose: () => void;
}) {
  const operatorId = useOperatorId();
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [ticksText, setTicksText] = useState(() =>
    market.priceProtectionTicks === null ? '' : String(market.priceProtectionTicks),
  );
  const [reasonText, setReasonText] = useState('');
  const [sentText, setSentText] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{
    field: PriceProtectionField;
    message: string;
  } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const draft = priceProtectionDraft(ticksText, reasonText, market.priceProtectionTicks);
  const mutation = useMutation({
    mutationFn: async ({ priceProtectionTicks, reason, by }: ChangeVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/price-protection', {
          params: { path: { id: market.id } },
          body: { priceProtectionTicks, reason, expectedAccountId: by },
        }),
      ).data,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminMarketPriceProtectionChanged });
      onClose();
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = priceProtectionFailure(error);
      if (failure.kind === 'toast') {
        toaster.create({ type: 'error', title: failure.message });
        onClose();
        return;
      }
      if (failure.kind === 'field') setFieldError(failure);
      else setRefusal(failure.message);
      if (failure.refresh) {
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });
  const errorOf = (field: PriceProtectionField) =>
    fieldError?.field === field ? fieldError.message : null;
  // The server's refusal of the width holds while the field holds what was sent; the draft's own
  // sentence comes first once the admin types again.
  const ticksError =
    draft.ticksError ?? (sentText === ticksText ? errorOf('priceProtectionTicks') : null);
  return (
    <ReviewDialogShell
      testId="market-price-protection-dialog"
      title={copy.adminMarketPriceProtectionChangeTitle}
      body={copy.adminMarketPriceProtectionChangeBody}
      confirmLabel={copy.adminMarketPriceProtectionChange}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined}
      refusal={refusal}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId === undefined || draft.ticks === null) return;
        setSentText(ticksText);
        mutation.mutate({
          priceProtectionTicks: draft.ticks,
          reason: draft.reason,
          by: operatorId,
        });
      }}
    >
      <Stack gap="4">
        <Text fontSize="sm" color="fg.muted" data-testid="market-price-protection-current">
          {copy.adminMarketPriceProtectionCurrent}{' '}
          {priceProtectionText(market.priceProtectionTicks)}
        </Text>
        <Field.Root invalid={ticksError !== null} required>
          <Field.Label>{copy.adminMarketPriceProtectionNew}</Field.Label>
          <Input
            type="number"
            inputMode="numeric"
            min={PRICE_PROTECTION_TICKS_MIN}
            max={PRICE_PROTECTION_TICKS_MAX}
            step={1}
            value={ticksText}
            onChange={(event) => setTicksText(event.target.value)}
            disabled={mutation.isPending}
            data-testid="market-price-protection-ticks"
          />
          <Field.HelperText>{copy.adminMarketPriceProtectionNewHint}</Field.HelperText>
          <Field.ErrorText data-testid="market-price-protection-ticks-error">
            {ticksError}
          </Field.ErrorText>
        </Field.Root>
        <ReasonField
          testId="market-price-protection-reason"
          label={copy.adminMarketReviewReason}
          value={reasonText}
          onChange={setReasonText}
          error={errorOf('reason')}
          disabled={mutation.isPending}
        />
      </Stack>
    </ReviewDialogShell>
  );
}
