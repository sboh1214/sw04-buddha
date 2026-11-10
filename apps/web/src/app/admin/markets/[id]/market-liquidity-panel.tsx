'use client';

import {
  Button,
  Card,
  DataList,
  Field,
  HStack,
  Heading,
  Input,
  Stack,
  Text,
} from '@chakra-ui/react';
import { type MarketLiquiditySettings, formatCoin } from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { nicknameShown } from '@/lib/account-closure';
import { type AdminMarket, api, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  LIQUIDITY_FIELDS,
  LIQUIDITY_HINT,
  LIQUIDITY_LABEL,
  type LiquidityField,
  type LiquidityText,
  canEditLiquidity,
  liquidityDraft,
  liquidityFailure,
  liquidityTexts,
  liquidityVersionChanged,
} from '@/lib/market-liquidity';
import { ReasonField, ReviewDialogShell } from './market-review-dialogs';

type LiquidityMarket = Pick<AdminMarket, 'status' | 'liquidity'>;

/** Admin-only settings; the chosen form is discarded when the operator changes. */
export function MarketLiquidityPanel({ market }: { market: AdminMarket }) {
  const operatorId = useOperatorId();
  const [editing, setEditing] = useHeldForOperator<true>();
  return (
    <>
      <LiquidityPanelBody market={market} operatorId={operatorId} onEdit={() => setEditing(true)} />
      {editing !== null && <LiquidityDialog market={market} onClose={() => setEditing(null)} />}
    </>
  );
}

export function LiquidityValues({
  settings,
  prefix,
}: {
  settings: MarketLiquiditySettings;
  prefix: string;
}) {
  return (
    <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
      {LIQUIDITY_FIELDS.map((field) => (
        <DataList.Item key={field} data-testid={`${prefix}-${field}`}>
          <DataList.ItemLabel>{LIQUIDITY_LABEL[field]}</DataList.ItemLabel>
          <DataList.ItemValue overflowWrap="anywhere">
            {field === 'budgetCoin' || field === 'maxLossCoin'
              ? formatCoin(BigInt(settings[field]))
              : settings[field]}
          </DataList.ItemValue>
        </DataList.Item>
      ))}
    </DataList.Root>
  );
}

export function LiquidityPanelBody({
  market,
  operatorId,
  onEdit,
}: {
  market: LiquidityMarket;
  operatorId: string | undefined;
  onEdit: () => void;
}) {
  const { current, openedVersion, history } = market.liquidity;
  const editable = canEditLiquidity(market.status);
  return (
    <Card.Root data-testid="market-liquidity">
      <Card.Body gap="4">
        <HStack justify="space-between" align="start" flexWrap="wrap">
          <Heading as="h3" size="md">
            {copy.marketLiquidityTitle}
          </Heading>
          {editable && (
            <Button
              size="sm"
              variant="outline"
              onClick={onEdit}
              disabled={operatorId === undefined}
              data-testid="market-liquidity-edit"
            >
              {copy.marketLiquidityEdit}
            </Button>
          )}
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          {copy.marketLiquidityIntro}
        </Text>
        <Stack gap="1">
          <Text fontWeight="medium" data-testid="market-liquidity-reference">
            {copy.marketLiquidityReference}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.marketLiquidityReferenceHint}
          </Text>
        </Stack>
        {current === null ? (
          <Text data-testid="market-liquidity-empty">
            {editable ? copy.marketLiquidityEmpty : copy.marketLiquidityMissing}
          </Text>
        ) : (
          <Stack gap="3">
            <Text fontWeight="medium" data-testid="market-liquidity-current-version">
              {copy.marketLiquidityCurrentVersion} {current.version}
            </Text>
            <LiquidityValues settings={current} prefix="liquidity-current" />
          </Stack>
        )}
        {openedVersion !== null && (
          <Text fontSize="sm" data-testid="market-liquidity-opened-version">
            {copy.marketLiquidityOpenedVersion} {openedVersion}
          </Text>
        )}
        {!editable && (
          <Text fontSize="sm" color="fg.muted" data-testid="market-liquidity-locked">
            {market.status === 'review' || market.status === 'scheduled'
              ? copy.marketLiquidityLocked
              : copy.marketLiquidityOpenedLocked}
          </Text>
        )}
        {history.length > 0 && (
          <Stack gap="3" data-testid="market-liquidity-history">
            <Heading as="h4" size="sm">
              {copy.marketLiquidityHistory}
            </Heading>
            {history.map((version) => (
              <Stack
                key={version.version}
                borderTopWidth="1px"
                pt="3"
                gap="2"
                data-testid={`market-liquidity-version-${version.version}`}
              >
                <Text fontWeight="medium">
                  {copy.marketLiquidityVersion} {version.version}
                </Text>
                <Text fontSize="sm" color="fg.muted">
                  {formatKst(version.createdAt)} · {nicknameShown(version.createdBy.nickname)}
                </Text>
                <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                  {version.reason}
                </Text>
                <LiquidityValues
                  settings={version}
                  prefix={`liquidity-history-${version.version}`}
                />
              </Stack>
            ))}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

interface LiquidityWrite {
  settings: MarketLiquiditySettings;
  baseVersion: number | null;
  reason: string;
  by: string;
}

/** The request names the original version; a later refetch never retargets the draft. */
export function LiquidityDialog({ market, onClose }: { market: AdminMarket; onClose: () => void }) {
  const operatorId = useOperatorId();
  const [base] = useState(() => market.liquidity.current);
  const [text, setText] = useState(() => liquidityTexts(base));
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState<LiquidityText | null>(null);
  const [fieldError, setFieldError] = useState<{
    field: LiquidityField | 'reason';
    message: string;
  } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const baseVersion = base?.version ?? null;
  const changed = liquidityVersionChanged(
    market.status,
    market.liquidity.current?.version ?? null,
    baseVersion,
  );
  const draft = liquidityDraft(text, reason, base);
  const mutation = useMutation({
    mutationFn: async ({ settings, baseVersion, reason, by }: LiquidityWrite) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/liquidity-settings', {
          params: { path: { id: market.id } },
          body: { settings, baseVersion, reason, expectedAccountId: by },
        }),
      ).data,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.marketLiquiditySaved });
      onClose();
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = liquidityFailure(error);
      if (failure.kind === 'toast') {
        toaster.create({ type: 'error', title: failure.message });
        onClose();
        return;
      }
      if (failure.kind === 'field') setFieldError(failure);
      else setRefusal(failure.message);
      if (failure.refresh)
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
    },
  });
  return (
    <ReviewDialogShell
      testId="market-liquidity-dialog"
      title={copy.marketLiquidityDialogTitle}
      body={copy.marketLiquidityDialogBody}
      confirmLabel={copy.save}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || changed || operatorId === undefined}
      refusal={
        changed
          ? copy.marketLiquidityStale
          : draft.unchanged
            ? copy.marketLiquidityUnchanged
            : refusal
      }
      onClose={onClose}
      onConfirm={() => {
        if (!draft.ready || draft.settings === null || changed || operatorId === undefined) return;
        setSent({ ...text });
        mutation.mutate({
          settings: draft.settings,
          baseVersion,
          reason: draft.reason,
          by: operatorId,
        });
      }}
    >
      <Stack gap="4">
        <Text fontSize="sm">{copy.marketLiquidityReference}</Text>
        <LiquidityFields
          text={text}
          onChange={(field, value) => setText((old) => ({ ...old, [field]: value }))}
          disabled={mutation.isPending || changed || operatorId === undefined}
          errorOf={(field) =>
            draft.errors[field] ??
            (sent?.[field] === text[field] && fieldError?.field === field
              ? fieldError.message
              : null)
          }
        />
        <ReasonField
          testId="market-liquidity-reason"
          label={copy.marketLiquidityReason}
          value={reason}
          onChange={setReason}
          disabled={mutation.isPending || changed}
          error={fieldError?.field === 'reason' ? fieldError.message : draft.reasonError}
        />
      </Stack>
    </ReviewDialogShell>
  );
}

export function LiquidityFields({
  text,
  onChange,
  disabled,
  errorOf,
}: {
  text: LiquidityText;
  onChange: (field: LiquidityField, value: string) => void;
  disabled: boolean;
  errorOf: (field: LiquidityField) => string | null;
}) {
  return LIQUIDITY_FIELDS.map((field) => (
    <Field.Root key={field} required invalid={errorOf(field) !== null}>
      <Field.Label>{LIQUIDITY_LABEL[field]}</Field.Label>
      <Input
        inputMode={field === 'b' ? 'decimal' : 'numeric'}
        value={text[field]}
        onChange={(event) => onChange(field, event.target.value)}
        disabled={disabled}
        data-testid={`market-liquidity-input-${field}`}
      />
      <Field.HelperText>{LIQUIDITY_HINT[field]}</Field.HelperText>
      <Field.ErrorText data-testid={`market-liquidity-error-${field}`}>
        {errorOf(field)}
      </Field.ErrorText>
    </Field.Root>
  ));
}
