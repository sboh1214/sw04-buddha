'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  Dialog,
  Field,
  HStack,
  Heading,
  Input,
  Link as ChakraLink,
  Portal,
  RadioGroup,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { type MarketEventType, OUTCOMES, formatCoin, parseCoinAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import NextLink from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { listView } from '@/lib/query-client';
import {
  useAdminMarket,
  useCategories,
  useApplyMarket,
  useMarketFills,
} from '@/hooks/use-admin-markets';
import {
  type AdminMarket,
  type Category,
  type UpdateMarketBody,
  api,
  isApiError,
  unwrap,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_EVENT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  canResolve,
  compactJson,
  formatBp,
  formatYesPrice,
  isAwaitingResolution,
  isAwaitingSettlement,
  isClosingSoon,
  isEditable,
  marketIdParam,
  marketEventRows,
  marketFormError,
  settlementStepViews,
  transitionErrorMessage,
} from '@/lib/market-admin';
import {
  AFTER_SAVE_RESET,
  FOLLOW_SERVER_RESET,
  type MarketFormValues,
  type ResolveMarketFormOutput,
  type ResolveMarketFormValues,
  marketFormSchema,
  marketToFormValues,
  resolveMarketFormSchema,
  toResolveMarketBody,
  toUpdateMarketBody,
} from '@/lib/market-form';
import { MarketFormFields } from '../market-form-fields';

export function AdminMarketDetail({ id }: { id: string }) {
  // A malformed id (not a uuid) would be a 400 from the API, which reads as "try again";
  // it is a wrong address, so it is 찾을 수 없습니다 without a request (marketIdParam).
  const validId = marketIdParam(id) !== undefined;
  // Keyed on the canonical id inside the hook, not on the segment as typed: an upper-case
  // URL would otherwise read a key that `market.id` — what every child below writes
  // through — does not name (A-M3-29).
  const market = useAdminMarket(id);

  // The alerts keep the way back too: without it, a wrong address leaves only the layout nav.
  if (!validId || (market.isError && isApiError(market.error, 'NOT_FOUND'))) {
    return (
      <Stack gap="4">
        <BackLink />
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketNotFound}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    );
  }
  if (market.isPending) return <Skeleton height="48" />;
  // Only the FIRST load failing leaves nothing to show. A refetch in the background that
  // fails (a passing 503 on a window focus, say) keeps the cached row — react-query keeps
  // `data` on a refetch error — and must keep this screen with it: replacing the page would
  // unmount the edit form and the input it holds. That case is a notice above the content.
  if (market.isLoadingError) {
    return (
      <Stack gap="4">
        <BackLink />
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    );
  }

  const data = market.data;
  return (
    <Stack gap="4">
      <BackLink />
      {market.isRefetchError && (
        <Alert.Root status="warning" role="status" data-testid="market-refresh-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Stack gap="1">
        <HStack gap="2" flexWrap="wrap" align="baseline">
          <Heading as="h3" size="lg" data-testid="market-detail-title">
            {data.title}
          </Heading>
          <Badge
            colorPalette={MARKET_STATUS_PALETTE[data.status]}
            variant="subtle"
            data-testid="market-detail-status"
          >
            {MARKET_STATUS_LABEL[data.status]}
          </Badge>
          {isClosingSoon(data) && (
            <Badge colorPalette="orange" variant="solid">
              {copy.adminMarketClosingSoon}
            </Badge>
          )}
          {isAwaitingResolution(data.status) && (
            <Badge colorPalette="brand" variant="solid" data-testid="market-detail-awaiting">
              {copy.adminMarketAwaitingResolution}
            </Badge>
          )}
          {isAwaitingSettlement(data.status) && (
            <Badge colorPalette="brand" variant="solid" data-testid="market-detail-awaiting">
              {copy.adminMarketAwaitingSettlement}
            </Badge>
          )}
        </HStack>
        <Text fontSize="sm" color="fg.muted" fontFamily="mono">
          {data.slug}
        </Text>
      </Stack>

      <TransitionButtons market={data} />

      <Card.Root>
        <Card.Body>
          <DataList.Root orientation="horizontal" size="sm">
            <Item label={copy.adminMarketCategory}>{data.category.nameKo}</Item>
            <Item label={copy.adminMarketDescription}>{data.description ?? '—'}</Item>
            <Item label={copy.adminMarketRules}>{data.rules || '—'}</Item>
            <Item label={copy.adminMarketSource}>{data.resolutionSource ?? '—'}</Item>
            <Item label={copy.adminMarketImageUrl}>{data.imageUrl ?? '—'}</Item>
            <Item label={copy.adminMarketCloseAt}>{formatKst(data.closeAt)}</Item>
            <Item label={copy.marketOpenAt}>{data.openAt ? formatKst(data.openAt) : '—'}</Item>
            <Item label={copy.marketResolvedResult}>
              {data.resolvedResult === null
                ? '—'
                : data.resolvedResult === 'YES'
                  ? copy.yes
                  : copy.no}
            </Item>
            {data.resolvedAt && (
              <Item label={copy.marketResolvedAt}>{formatKst(data.resolvedAt)}</Item>
            )}
            {data.settledAt && (
              <Item label={copy.marketSettledAt}>{formatKst(data.settledAt)}</Item>
            )}
            {data.voidedAt && <Item label={copy.marketVoidedAt}>{formatKst(data.voidedAt)}</Item>}
            <Item label={copy.marketCreatedAt}>{formatKst(data.createdAt)}</Item>
            <Item label={copy.marketUpdatedAt}>{formatKst(data.updatedAt)}</Item>
            <Item label={copy.marketCreatedBy}>
              <Text fontFamily="mono" fontSize="xs">
                {data.createdBy}
              </Text>
            </Item>
          </DataList.Root>
        </Card.Body>
      </Card.Root>

      <SettlementStepsPanel market={data} />

      {/* Keyed by status, not updatedAt: a transition is the admin's own act and changes which
          fields may be edited, so the form restarts from the server's values then. updatedAt
          moves on every trade too, and a refetch in the background (a window focus past
          staleTime, a socket update) must not throw away what the admin is typing — inside,
          EditMarketForm takes fresh server values only for fields that hold no edits. */}
      <EditMarketCard key={data.status} market={data} />

      <TradeStatsPanel market={data} />
      <EventLog market={data} />
      <RecentFills market={data} />
    </Stack>
  );
}

function BackLink() {
  return (
    <ChakraLink
      asChild
      fontSize="sm"
      colorPalette="brand"
      color="colorPalette.fg"
      alignSelf="flex-start"
    >
      <NextLink href="/admin/markets">← {copy.adminBackToMarkets}</NextLink>
    </ChakraLink>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue whiteSpace="pre-wrap" wordBreak="break-word">
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}

/**
 * 열기 / 마감 / 판정 (PLAN 12, design 3.4, ADR-0046). Each is a Dialog except 열기, whose only
 * refusal — blank rules — is reversible from the form below and is named in its toast. 열기
 * stays while there is no way to trade (owner decision #125 (a)): the market is listed, and its
 * detail says 거래 준비 중 in place of the order panel. There is no 무효: the admin void and its
 * cost refund went with #125 (N03 §6); VOID as a 판정 is #152's. The 판정 form lives in its own
 * component, mounted only while its dialog is open, so every opening starts from an empty form.
 * A judged market offers none of these: the 판정 is final (#26 decides what may undo one).
 */
function TransitionButtons({ market }: { market: AdminMarket }) {
  const apply = useApplyMarket(market.id);
  const [confirm, setConfirm] = useState<'close' | 'resolve' | null>(null);
  const closeDialog = () => {
    setConfirm(null);
  };

  const onError = (error: unknown) =>
    toaster.create({ type: 'error', title: transitionErrorMessage(error) });

  const open = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/open', { params: { path: { id: market.id } } }),
      ).data,
    // The answer is the market as the transition committed it (the same shape GET returns):
    // it goes on the screen now, so a refetch that fails cannot leave the old status under a
    // toast that says otherwise.
    onSuccess: async (opened) => {
      toaster.create({ type: 'success', title: copy.adminMarketOpened });
      await apply(opened);
    },
    onError,
  });

  const close = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/close', { params: { path: { id: market.id } } }),
      ).data,
    onSuccess: async (closed) => {
      toaster.create({ type: 'success', title: copy.adminMarketClosed });
      setConfirm(null);
      await apply(closed);
    },
    onError,
  });

  return (
    <HStack gap="2" flexWrap="wrap">
      {market.status === 'draft' && (
        <Button
          size="sm"
          loading={open.isPending}
          onClick={() => open.mutate()}
          data-testid="market-open"
        >
          {copy.adminMarketOpen}
        </Button>
      )}
      {market.status === 'open' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConfirm('close')}
          data-testid="market-close"
        >
          {copy.adminMarketClose}
        </Button>
      )}
      {canResolve(market.status) && (
        <Button size="sm" onClick={() => setConfirm('resolve')} data-testid="market-resolve">
          {copy.adminMarketResolve}
        </Button>
      )}

      {confirm === 'resolve' && <ResolveDialog market={market} onClose={closeDialog} />}

      <ConfirmDialog
        testId="market-close"
        open={confirm === 'close'}
        onClose={closeDialog}
        title={copy.adminMarketCloseTitle}
        confirmLabel={copy.adminMarketClose}
        loading={close.isPending}
        onConfirm={() => close.mutate()}
      >
        <Text>{copy.adminMarketCloseBody}</Text>
      </ConfirmDialog>
    </HStack>
  );
}

/**
 * 판정 (PLAN 12 정산 화면, ADR-0046): result by radio, note, evidence URL, and the confirmation
 * that says what the click does — the result is final at once, settlement starts right away,
 * and neither a change nor a void is possible afterwards. A stale screen (another admin judged
 * it first) meets the API's `status` refusal, which `transitionErrorMessage` names. The answer
 * is applied like every other transition (`useApplyMarket`), so the status, the result and the
 * 정산 단계 rows above are the server's the moment the toast shows, whatever the refetch does.
 */
function ResolveDialog({ market, onClose }: { market: AdminMarket; onClose: () => void }) {
  const apply = useApplyMarket(market.id);
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResolveMarketFormValues, unknown, ResolveMarketFormOutput>({
    resolver: zodResolver(resolveMarketFormSchema),
    defaultValues: { note: '', evidenceUrl: '' },
  });

  const resolve = useMutation({
    mutationFn: async (values: ResolveMarketFormOutput) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/resolve', {
          params: { path: { id: market.id } },
          body: toResolveMarketBody(values),
        }),
      ).data,
    onSuccess: async (resolved) => {
      toaster.create({ type: 'success', title: copy.adminMarketResolved });
      onClose();
      await apply(resolved);
    },
    onError: (error) => toaster.create({ type: 'error', title: transitionErrorMessage(error) }),
  });

  const submit = handleSubmit((values) => resolve.mutate(values));

  return (
    <ConfirmDialog
      testId="market-resolve"
      open
      onClose={onClose}
      title={copy.adminMarketResolveTitle}
      confirmLabel={copy.adminMarketResolve}
      loading={resolve.isPending}
      onConfirm={() => void submit()}
    >
      <Stack gap="3">
        <Text>{copy.adminMarketResolveBody}</Text>
        <Field.Root invalid={!!errors.result} required>
          <Controller
            name="result"
            control={control}
            render={({ field }) => (
              // The group's accessible name is its own Label part: zag emits `role="radiogroup"`
              // with `aria-labelledby` pointing at that id, so a `Field.Label` here would leave
              // the group unnamed.
              <RadioGroup.Root
                name={field.name}
                value={field.value ?? null}
                onValueChange={(details) => {
                  if (details.value === 'YES' || details.value === 'NO')
                    field.onChange(details.value);
                }}
                colorPalette="brand"
              >
                <RadioGroup.Label fontWeight="medium" mb="1">
                  {copy.adminMarketResolveResult}
                </RadioGroup.Label>
                <HStack gap="6">
                  {/* The test id rides on the Item — the label element that carries the hidden
                      input — so a click on it is the click that selects. */}
                  {OUTCOMES.map((outcome) => (
                    <RadioGroup.Item
                      key={outcome}
                      value={outcome}
                      data-testid={`market-resolve-${outcome.toLowerCase()}`}
                    >
                      <RadioGroup.ItemHiddenInput onBlur={field.onBlur} />
                      <RadioGroup.ItemIndicator />
                      <RadioGroup.ItemText>
                        {outcome === 'YES' ? copy.yes : copy.no}
                      </RadioGroup.ItemText>
                    </RadioGroup.Item>
                  ))}
                </HStack>
              </RadioGroup.Root>
            )}
          />
          <Field.ErrorText>{errors.result?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root invalid={!!errors.note}>
          <Field.Label>{copy.adminMarketResolveNote}</Field.Label>
          <Textarea rows={3} data-testid="market-resolve-note" {...register('note')} />
          <Field.ErrorText>{errors.note?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root invalid={!!errors.evidenceUrl}>
          <Field.Label>{copy.adminMarketResolveEvidence}</Field.Label>
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder={copy.adminMarketResolveEvidencePlaceholder}
            data-testid="market-resolve-evidence"
            {...register('evidenceUrl')}
          />
          <Field.ErrorText>{errors.evidenceUrl?.message}</Field.ErrorText>
        </Field.Root>
      </Stack>
    </ConfirmDialog>
  );
}

/**
 * 수정 (design 3.4). The categories are only the select's options, so their load is gated
 * here (as 시장 만들기 does) and the rest of the page does not depend on it. Inputs follow the
 * status: everything while draft, the text fields, close time and category while open, nothing
 * otherwise. Saving an open market first shows PLAN 12's "경고 후 허용" dialog. The body is the
 * diff against the loaded values, so an untouched field — a past close time on a draft
 * included — is never sent.
 */
function EditMarketCard({ market }: { market: AdminMarket }) {
  const categories = useCategories();
  const editable = isEditable(market.status);

  return (
    <Card.Root>
      <Card.Header>
        <HStack justify="space-between" flexWrap="wrap" gap="2">
          <Text fontWeight="semibold">{copy.adminMarketEdit}</Text>
          {!editable && (
            <Text fontSize="sm" color="fg.muted">
              {copy.adminMarketEditLocked}
            </Text>
          )}
        </HStack>
      </Card.Header>
      <Card.Body>
        {/* As above: only a first load that failed has no list to offer; a refetch that
            failed keeps the cached categories, and with them the form and its input. */}
        {categories.isPending ? (
          <Skeleton height="24" />
        ) : categories.isLoadingError ? (
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        ) : (
          <EditMarketForm market={market} categories={categories.data} />
        )}
      </Card.Body>
    </Card.Root>
  );
}

function EditMarketForm({ market, categories }: { market: AdminMarket; categories: Category[] }) {
  const apply = useApplyMarket(market.id);
  const original = useMemo(() => marketToFormValues(market, categories), [market, categories]);
  const editable = isEditable(market.status);
  const rulesRequired = market.status === 'open';
  const schema = useMemo(
    () => marketFormSchema({ original, rulesRequired }),
    [original, rulesRequired],
  );
  const [pending, setPending] = useState<UpdateMarketBody | null>(null);

  // `values` follows the server: react-hook-form deep-compares it with what it last applied,
  // so a refetch that moved only trade stats or updatedAt changes nothing, and
  // one that changed a form field resets under FOLLOW_SERVER_RESET — fields the admin has
  // edited keep their input. A save resets explicitly (onSuccess), from the row the API
  // answered with. The resolver reads the schema memoised on the newest `original`.
  const form = useForm<MarketFormValues>({
    resolver: zodResolver(schema),
    values: original,
    resetOptions: FOLLOW_SERVER_RESET,
  });
  const {
    handleSubmit,
    reset,
    setError,
    formState: { isSubmitting, isDirty },
  } = form;

  const update = useMutation({
    mutationFn: async (body: UpdateMarketBody) =>
      unwrap(
        await api.PATCH('/api/v1/admin/markets/{id}', {
          params: { path: { id: market.id } },
          body,
        }),
      ).data,
    onSuccess: async (saved) => {
      toaster.create({ type: 'success', title: copy.adminMarketSaved });
      setPending(null);
      // The answer is the saved row (the same shape GET returns): the form restarts from it
      // now, clean, with the trimmed values the API kept. Explicit options — a bare reset()
      // would inherit FOLLOW_SERVER_RESET and keep the just-saved fields as "dirty" input.
      reset(marketToFormValues(saved, categories), AFTER_SAVE_RESET);
      // Same row on the card above the form, whatever the refetch does.
      await apply(saved);
    },
    onError: (error) => {
      setPending(null);
      const fieldError = marketFormError(error);
      if (fieldError) {
        setError(fieldError.field, { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: transitionErrorMessage(error) });
    },
  });

  const submit = handleSubmit(async (values) => {
    const body = toUpdateMarketBody(values, original);
    if (Object.keys(body).length === 0) {
      toaster.create({ type: 'info', title: copy.adminMarketNoChanges });
      return;
    }
    if (market.status === 'open') {
      setPending(body);
      return;
    }
    await update.mutateAsync(body).catch(() => undefined); // reported by onError
  });

  return (
    <>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Stack gap="3">
          <MarketFormFields
            form={form}
            categories={categories}
            disabled={!editable}
            // The row itself, so the 미리보기 of a market past draft shows the price and volume it
            // TRADES at rather than an untraded card.
            base={market}
          />
          <Button
            type="submit"
            size="sm"
            alignSelf="flex-start"
            loading={isSubmitting || update.isPending}
            disabled={!editable || !isDirty}
            data-testid="market-save"
          >
            {copy.save}
          </Button>
        </Stack>
      </form>

      <ConfirmDialog
        testId="market-edit"
        open={pending !== null}
        onClose={() => setPending(null)}
        title={copy.adminMarketEditOpenTitle}
        confirmLabel={copy.save}
        loading={update.isPending}
        onConfirm={() => {
          if (pending) update.mutate(pending);
        }}
      >
        <Text>{copy.adminMarketEditOpenBody}</Text>
      </ConfirmDialog>
    </>
  );
}

/**
 * 정산 단계 (ADR-0046, D7): what the worker has done with a judged market, read-only. One row
 * per settlement step, in the order the worker runs them; nothing at all before the 판정 or for
 * a voided market (the API answers an empty list then, and an empty table would only say so).
 *
 * A failed step is the one state that needs the admin, so it is the one drawn as a SOLID badge
 * (`no`, measured AA in theme/contrast.test.ts) — and it is never colour alone: the badge says
 * 실패 and the row carries the error. The worker retries it on its per-minute scan without a
 * cap; the 정산 대기 badge above stays until every step is 완료.
 *
 * In a ScrollArea so the five columns scroll sideways inside the card at 375px rather than
 * widening the page; the error cell wraps rather than stretching the table.
 */
function SettlementStepsPanel({ market }: { market: AdminMarket }) {
  const steps = settlementStepViews(market.settlementSteps);
  if (steps.length === 0) return null;
  return (
    <Card.Root data-testid="market-settlement-steps">
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminSettlementSteps}</Text>
      </Card.Header>
      <Card.Body>
        <Table.ScrollArea>
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{copy.adminSettlementStepColumn}</Table.ColumnHeader>
                <Table.ColumnHeader>{copy.adminSettlementStepStatus}</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">
                  {copy.adminSettlementStepAttempts}
                </Table.ColumnHeader>
                <Table.ColumnHeader>{copy.adminSettlementStepCompletedAt}</Table.ColumnHeader>
                <Table.ColumnHeader>{copy.adminSettlementStepLastError}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {steps.map((row) => (
                <Table.Row
                  key={row.step}
                  data-testid={`market-settlement-step-${row.step}`}
                  data-status={row.failed ? 'failed' : undefined}
                >
                  <Table.Cell whiteSpace="nowrap">{row.label}</Table.Cell>
                  <Table.Cell>
                    <Badge
                      colorPalette={row.palette}
                      variant={row.failed ? 'solid' : 'subtle'}
                      data-testid={`market-settlement-step-${row.step}-status`}
                    >
                      {row.statusLabel}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                    {row.attempts}
                  </Table.Cell>
                  <Table.Cell whiteSpace="nowrap">{row.completedAt}</Table.Cell>
                  <Table.Cell
                    minW="48"
                    fontFamily="mono"
                    fontSize="xs"
                    whiteSpace="pre-wrap"
                    wordBreak="break-word"
                  >
                    {row.lastError}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * 거래 현황: what fills and positions say about this market. The direct AMM's own state (q, b,
 * 준비금) and its probability went with #125; 순 수취 and 미결제 stay because they are read off the
 * fills and the positions, not the curve. 현재가 is 체결 없음 until the first fill (N02 §5).
 */
function TradeStatsPanel({ market }: { market: AdminMarket }) {
  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminMarketTradeStats}</Text>
      </Card.Header>
      <Card.Body>
        <DataList.Root orientation="horizontal" size="sm" data-testid="market-trade-stats">
          <Item label={copy.tradeStatsLastPrice}>{formatYesPrice(market.lastPrice)}</Item>
          <Item label={copy.tradeStatsNetCollected}>
            {formatCoin(parseCoinAmount(market.netCollectedCoin))}
          </Item>
          <Item label={copy.tradeStatsOpenInterestYes}>{String(market.openInterest.yes)}</Item>
          <Item label={copy.tradeStatsOpenInterestNo}>{String(market.openInterest.no)}</Item>
          <Item label={copy.marketTradeCount}>{String(market.tradeCount)}</Item>
          <Item label={copy.marketTraderCount}>{String(market.traderCount)}</Item>
          <Item label={copy.marketVolume}>{formatCoin(parseCoinAmount(market.volumeCoin))}</Item>
        </DataList.Root>
      </Card.Body>
    </Card.Root>
  );
}

function EventLog({ market }: { market: AdminMarket }) {
  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminMarketEvents}</Text>
      </Card.Header>
      <Card.Body>
        {market.events.length === 0 ? (
          <Text color="fg.muted">{copy.adminNoEvents}</Text>
        ) : (
          <Stack gap="2">
            {market.events.map((event) => (
              <Stack key={event.id} gap="0.5" data-testid={`market-event-${event.id}`}>
                <HStack gap="2" flexWrap="wrap">
                  <Badge variant="subtle">{MARKET_EVENT_LABEL[event.type]}</Badge>
                  <Text fontSize="xs" color="fg.muted" fontFamily="mono">
                    {event.actorId ?? copy.eventSystem}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    {formatKst(event.createdAt)}
                  </Text>
                </HStack>
                <EventPayload type={event.type} payload={event.payload} />
              </Stack>
            ))}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The known payloads (rules diff, open/close instants, 판정, 정산) as Korean rows; the create
 * body and anything unexpected stay one JSON line (`marketEventRows`).
 */
function EventPayload({ type, payload }: { type: MarketEventType; payload: unknown }) {
  if (payload === null || payload === undefined) return null;
  const rows = marketEventRows(type, payload);
  if (rows === undefined) {
    return (
      <Text fontSize="xs" fontFamily="mono" color="fg.muted" wordBreak="break-all">
        {compactJson(payload)}
      </Text>
    );
  }
  return (
    <Stack gap="0" fontSize="xs" color="fg.muted" data-testid="market-event-rows">
      {rows.map((row) => (
        <Text key={row.label} whiteSpace="pre-wrap" wordBreak="break-word">
          <Text as="span" fontWeight="medium">
            {row.label}
          </Text>{' '}
          {row.value}
        </Text>
      ))}
    </Stack>
  );
}

/** Newest fills, anonymous (PLAN 7.1). Waits for the market to leave draft (public 404). */
function RecentFills({ market }: { market: AdminMarket }) {
  const fills = useMarketFills(market.id, market.status !== 'draft');
  // The public twin's ladder, and the same fourth state: a refetch that fails keeps the rows and
  // reports `isRefetchError`, which `isLoadingError` alone folds into an ordinary list. Here as
  // there, the refetch is the only path a new fill arrives by — and the card above already draws
  // `adminMarketRefreshFailed` for exactly this, so saying nothing here was the odd one out.
  const view = listView(fills);
  const rows = fills.data ?? [];
  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminMarketFills}</Text>
      </Card.Header>
      <Card.Body>
        {view === 'stale' && market.status !== 'draft' && (
          <Alert.Root status="warning" role="status" data-testid="admin-market-fills-stale" mb="3">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
            </Alert.Content>
            <Button size="xs" variant="outline" ml="auto" onClick={() => void fills.refetch()}>
              {copy.retry}
            </Button>
          </Alert.Root>
        )}
        {market.status === 'draft' ? (
          <Text color="fg.muted">{copy.adminNoFills}</Text>
        ) : view === 'pending' ? (
          <Skeleton height="12" />
        ) : view === 'failed' ? (
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        ) : rows.length === 0 ? (
          <Text color="fg.muted">{copy.adminNoFills}</Text>
        ) : (
          <Stack gap="1">
            {rows.map((fill) => (
              <HStack
                key={fill.id}
                gap="3"
                flexWrap="wrap"
                fontSize="sm"
                data-testid={`market-fill-${fill.id}`}
              >
                <Text color="fg.muted" minW="40">
                  {formatKst(fill.createdAt)}
                </Text>
                <Badge colorPalette={fill.outcome === 'YES' ? 'yes' : 'no'} variant="subtle">
                  {fill.outcome === 'YES' ? copy.yes : copy.no}
                </Badge>
                <Text>{fill.side === 'buy' ? copy.buy : copy.sell}</Text>
                <Text>
                  {copy.fillQty} {String(fill.qty)}
                </Text>
                <Text>{formatCoin(parseCoinAmount(fill.amountCoin))}</Text>
                <Text color="fg.muted">
                  {copy.fillAvgPrice} {formatBp(fill.priceAvgBp)}
                </Text>
              </HStack>
            ))}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

interface ConfirmDialogProps {
  /** Prefix of the two buttons' test ids: `<testId>-confirm` and `<testId>-cancel`. */
  testId: string;
  open: boolean;
  onClose: () => void;
  title: string;
  confirmLabel: string;
  loading: boolean;
  onConfirm: () => void;
  children: ReactNode;
}

/**
 * The one confirmation shape the transitions and the open-market edit share. Mounted only
 * while open (three of these live on the page; a closed one must not answer a test id), and
 * pinned while the mutation runs: Cancel, Esc and the backdrop all wait, since dismissing it
 * mid-flight would leave the request running against a screen that no longer shows it.
 */
function ConfirmDialog({
  testId,
  open,
  onClose,
  title,
  confirmLabel,
  loading,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (!details.open && !loading) onClose();
      }}
      role="alertdialog"
      lazyMount
      unmountOnExit
      closeOnInteractOutside={!loading}
      closeOnEscape={!loading}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>{children}</Dialog.Body>
            <Dialog.Footer>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={onClose}
                data-testid={`${testId}-cancel`}
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                loading={loading}
                onClick={onConfirm}
                data-testid={`${testId}-confirm`}
              >
                {confirmLabel}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
