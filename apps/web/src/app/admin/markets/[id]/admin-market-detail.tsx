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
  Link as ChakraLink,
  Portal,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { type MarketEventType, formatP, parsePAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import NextLink from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
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
  canEditLiquidity,
  canVoid,
  compactJson,
  formatBp,
  formatQuantity,
  formatYesPrice,
  isAwaitingSettlement,
  isClosingSoon,
  isEditable,
  marketIdParam,
  marketEventRows,
  marketFormError,
  transitionErrorMessage,
} from '@/lib/market-admin';
import {
  AFTER_SAVE_RESET,
  FOLLOW_SERVER_RESET,
  type MarketFormValues,
  type VoidMarketFormValues,
  marketFormSchema,
  marketToFormValues,
  toUpdateMarketBody,
  voidMarketFormSchema,
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
          {isAwaitingSettlement(data.status) && (
            <Badge colorPalette="brand" variant="solid">
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
            {data.disputeUntil && (
              <Item label={copy.marketDisputeUntil}>{formatKst(data.disputeUntil)}</Item>
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

      {/* Keyed by status, not updatedAt: a transition is the admin's own act and changes which
          fields may be edited, so the form restarts from the server's values then. updatedAt
          moves on every trade too, and a refetch in the background (a window focus past
          staleTime, a socket update) must not throw away what the admin is typing — inside,
          EditMarketForm takes fresh server values only for fields that hold no edits. */}
      <EditMarketCard key={data.status} market={data} />

      <LmsrPanel market={data} />
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
 * 열기 / 마감 / 무효 (PLAN 12, design 3.4). Each is a Dialog except 열기, whose only refusal
 * — blank rules — is reversible from the form below and is named in its toast. The void
 * reason is a form like every other (zodResolver), reset when the dialog closes either way,
 * so a cancelled dialog does not reopen with the old text and its error lit. Resolve and
 * dispute handling are M5.
 */
function TransitionButtons({ market }: { market: AdminMarket }) {
  const apply = useApplyMarket(market.id);
  const [confirm, setConfirm] = useState<'close' | 'void' | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<VoidMarketFormValues>({
    resolver: zodResolver(voidMarketFormSchema),
    defaultValues: { reason: '' },
  });
  const closeDialog = () => {
    setConfirm(null);
    reset();
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

  const voidMarket = useMutation({
    mutationFn: async (body: VoidMarketFormValues) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/void', {
          params: { path: { id: market.id } },
          body,
        }),
      ).data,
    onSuccess: async (voided) => {
      toaster.create({ type: 'success', title: copy.adminMarketVoided });
      closeDialog();
      await apply(voided);
    },
    onError,
  });

  // The schema's trimmed output is what goes on the wire (the API trims and bounds the same).
  const submitVoid = handleSubmit((values) => voidMarket.mutate(values));

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
      {canVoid(market.status) && (
        <Button
          size="sm"
          variant="outline"
          colorPalette="no"
          onClick={() => setConfirm('void')}
          data-testid="market-void"
        >
          {copy.adminMarketVoid}
        </Button>
      )}

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

      <ConfirmDialog
        testId="market-void"
        open={confirm === 'void'}
        onClose={closeDialog}
        title={copy.adminMarketVoidTitle}
        confirmLabel={copy.adminMarketVoid}
        loading={voidMarket.isPending}
        onConfirm={() => void submitVoid()}
        destructive
      >
        <Stack gap="3">
          <Text>{copy.adminMarketVoidBody}</Text>
          <Field.Root invalid={!!errors.reason} required>
            <Field.Label>{copy.adminMarketVoidReason}</Field.Label>
            <Textarea rows={3} data-testid="market-void-reason" {...register('reason')} />
            <Field.ErrorText>{errors.reason?.message}</Field.ErrorText>
          </Field.Root>
        </Stack>
      </ConfirmDialog>
    </HStack>
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
  // so a refetch that moved only LMSR state or updatedAt (every trade) changes nothing, and
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
    const body = toUpdateMarketBody(values, original, market.status);
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
            lmsrDisabled={!canEditLiquidity(market.status)}
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

function LmsrPanel({ market }: { market: AdminMarket }) {
  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminMarketLmsr}</Text>
      </Card.Header>
      <Card.Body>
        <DataList.Root orientation="horizontal" size="sm" data-testid="market-lmsr">
          <Item label={copy.lmsrQYes}>{formatQuantity(market.qYes)}</Item>
          <Item label={copy.lmsrQNo}>{formatQuantity(market.qNo)}</Item>
          <Item label={copy.adminMarketLiquidity}>{formatQuantity(market.liquidityB)}</Item>
          <Item label={copy.lmsrReserve}>{formatP(parsePAmount(market.reserveP))}</Item>
          <Item label={copy.lmsrPrice}>{formatYesPrice(market.lastPrice)}</Item>
          <Item label={copy.probability}>{formatBp(market.pYesBp)}</Item>
          <Item label={copy.lmsrNetCollected}>{formatP(parsePAmount(market.netCollectedP))}</Item>
          <Item label={copy.lmsrOpenInterestYes}>{String(market.openInterest.yes)}</Item>
          <Item label={copy.lmsrOpenInterestNo}>{String(market.openInterest.no)}</Item>
          <Item label={copy.marketTradeCount}>{String(market.tradeCount)}</Item>
          <Item label={copy.marketTraderCount}>{String(market.traderCount)}</Item>
          <Item label={copy.marketVolume}>{formatP(parsePAmount(market.volumeP))}</Item>
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
 * The known payloads (void summary, rules diff, open/close instants) as Korean rows; the
 * create body and anything unexpected stay one JSON line (`marketEventRows`).
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
                <Text>{formatP(parsePAmount(fill.amountP))}</Text>
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
  destructive?: boolean;
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
  destructive = false,
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
                colorPalette={destructive ? 'no' : undefined}
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
