'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  Field,
  HStack,
  Heading,
  Input,
  Link as ChakraLink,
  RadioGroup,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
} from '@chakra-ui/react';
import {
  type MarketEventType,
  OUTCOMES,
  formatCoin,
  isPublicMarketStatus,
  parseCoinAmount,
} from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { nicknameShown } from '@/lib/account-closure';
import { SEARCH_INPUT_MAX_LENGTH } from '@/lib/market-search';
import { listSection, listView } from '@/lib/query-client';
import {
  adminMarketKey,
  applyRelatedMarkets,
  refreshAfterMarketFormRefusal,
  useAdminMarket,
  useAdminRelatedMarkets,
  useAdminRelatedSearch,
  useCategories,
  useApplyMarket,
  useMarketFills,
} from '@/hooks/use-admin-markets';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import {
  type AdminMarket,
  type AdminRelatedMarket,
  type Category,
  type MarketSummary,
  type UpdateMarketBody,
  type UpdateMarketFields,
  api,
  isApiError,
  unwrap,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_EVENT_LABEL,
  MARKET_RESULT_LABEL,
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
  openItemsNotice,
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
import {
  relatedHint,
  relatedLinkErrorMessage,
  relatedPickState,
  relatedSearchSection,
  relatedSearchSubmit,
} from '@/lib/related-markets';
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
      <OpenItemsNotice market={data} />

      <Card.Root>
        <Card.Body>
          <DataList.Root orientation="horizontal" size="sm">
            <Item label={copy.adminMarketCategory}>{data.category.nameKo}</Item>
            {/* The stored spellings in entry order (#17), as the public detail draws them. */}
            <Item label={copy.adminMarketTags}>
              <Text as="span" data-testid="market-detail-tags">
                {data.tags.length === 0 ? '—' : data.tags.join(', ')}
              </Text>
            </Item>
            <Item label={copy.adminMarketDescription}>{data.description ?? '—'}</Item>
            <Item label={copy.adminMarketRules}>{data.rules || '—'}</Item>
            <Item label={copy.adminMarketSource}>{data.resolutionSource ?? '—'}</Item>
            <Item label={copy.adminMarketImageUrl}>{data.imageUrl ?? '—'}</Item>
            <Item label={copy.adminMarketCloseAt}>{formatKst(data.closeAt)}</Item>
            <Item label={copy.marketOpenAt}>{data.openAt ? formatKst(data.openAt) : '—'}</Item>
            {/* YES·NO·무효, or '—' before a judgement and on a cancelled market (ADR-0093 decision 1,
                item 10: a cancelled market has no result, never VOID). */}
            <Item label={copy.marketResolvedResult}>
              {data.resolvedResult === null ? '—' : MARKET_RESULT_LABEL[data.resolvedResult]}
            </Item>
            {data.resolvedAt && (
              <Item label={copy.marketResolvedAt}>{formatKst(data.resolvedAt)}</Item>
            )}
            {data.settledAt && (
              <Item label={copy.marketSettledAt}>{formatKst(data.settledAt)}</Item>
            )}
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

      {/* Keyed by the market: a title link in it opens another market's detail on this same
          route, and that one starts with its own empty search. */}
      <RelatedMarketsPanel key={data.id} market={data} />

      <TradeStatsPanel market={data} />
      <EventLog market={data} />
      <RecentFills market={data} />
    </Stack>
  );
}

/**
 * What the draft still needs before 열기 (#17, the open-items check): '열기 전에 채울 항목: 정산 규칙 ·
 * 태그 1~5개', from the server's `missingOpenItems` (`openItemsNotice`) — so a category hidden after
 * it was picked shows here too. Nothing once nothing is missing, and nothing on any other status.
 * Beside 열기 rather than in the form: it is what 열기 will refuse, and the form below is where each
 * item is filled in.
 */
function OpenItemsNotice({ market }: { market: AdminMarket }) {
  const notice = openItemsNotice(market);
  if (notice === undefined) return null;
  return (
    <Alert.Root status="warning" role="status" data-testid="market-open-items">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{notice}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
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
 * 열기 / 마감 / 판정 (PLAN 12, design 3.4, ADR-0046). Each is a Dialog except 열기, whose refusal —
 * the open-items check (#17: 정산 규칙, 카테고리, 태그 1~5개), which the draft's notice says
 * beforehand — is reversible from the form below and is named in its toast; the detail is read
 * again then, so the notice names what the server found, a category hidden meanwhile included. 열기
 * stays while there is no way to trade (owner decision #125 (a)): the market is listed, and its
 * detail says 거래 준비 중 in place of the order panel. There is no 무효: the admin void and its
 * cost refund went with #125 (N03 §6); VOID as a 판정 is #152's. The 판정 form lives in its own
 * component, mounted only while its dialog is open, so every opening starts from an empty form.
 * A judged market offers none of these: the 판정 is final. All three are the interim actions
 * #174 keeps on the new statuses (ADR-0047 result 3, ADR-0093 result 2) — 열기 until #21, 마감
 * until #114, 판정 until #152 — so a market in any other status (검수 중, 개장 예정, 거래 일시 중단,
 * 잠정 결과, 지급 중, 취소, …) offers none.
 *
 * Each names the admin on screen (`useOperatorId`, ADR-0092), so 열기, the buttons that open the
 * two dialogs and their confirmations wait for `GET /me`; the cookie of another account is refused
 * (`copy.sessionChanged`), the dialog closes and the session is asked again (`useSessionChanged`).
 * The open dialog is held for the admin who opened it (`useHeldForOperator`, ADR-0091 결정 3): once
 * `['me']` turns from A to B in place, before the session does (ADR-0090 결정 4-2), it closes with
 * the result picked and the note typed for A, which would otherwise be judged as B (ADR-0092,
 * owner decision 2026-10-26 17:21 answer 1).
 */
function TransitionButtons({ market }: { market: AdminMarket }) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const [confirm, setConfirm] = useHeldForOperator<'close' | 'resolve'>();
  const closeDialog = () => {
    setConfirm(null);
  };

  const onError = (error: unknown) => {
    if (sessionChanged(error)) setConfirm(null);
    toaster.create({ type: 'error', title: transitionErrorMessage(error) });
    // The screen's notice was the last read's: what the server refused for goes on it now.
    if (isApiError(error, 'OPEN_ITEMS_MISSING')) {
      void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
    }
  };

  const open = useMutation({
    mutationFn: async (expectedAccountId: string) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/open', {
          params: { path: { id: market.id } },
          body: { expectedAccountId },
        }),
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
    mutationFn: async (expectedAccountId: string) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/close', {
          params: { path: { id: market.id } },
          body: { expectedAccountId },
        }),
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
          disabled={operatorId === undefined}
          onClick={() => {
            if (operatorId !== undefined) open.mutate(operatorId);
          }}
          data-testid="market-open"
        >
          {copy.adminMarketOpen}
        </Button>
      )}
      {market.status === 'open' && (
        <Button
          size="sm"
          variant="outline"
          disabled={operatorId === undefined}
          onClick={() => setConfirm('close')}
          data-testid="market-close"
        >
          {copy.adminMarketClose}
        </Button>
      )}
      {canResolve(market.status) && (
        <Button
          size="sm"
          disabled={operatorId === undefined}
          onClick={() => setConfirm('resolve')}
          data-testid="market-resolve"
        >
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
        confirmDisabled={operatorId === undefined}
        onConfirm={() => {
          if (operatorId !== undefined) close.mutate(operatorId);
        }}
      >
        <Text>{copy.adminMarketCloseBody}</Text>
      </ConfirmDialog>
    </HStack>
  );
}

/**
 * 판정 (PLAN 12 정산 화면, ADR-0046): result by radio, note, evidence URL, and the confirmation
 * that says what the click does — the result is final at once, settlement starts right away,
 * and no change is possible afterwards (VOID is #152's judgement, not this dialog's). A stale
 * screen (another admin judged it first) meets the API's `status` refusal, which
 * `transitionErrorMessage` names. The answer is applied like every other transition
 * (`useApplyMarket`), so the status, the result and the 정산 단계 rows above are the server's the
 * moment the toast shows, whatever the refetch does.
 */
function ResolveDialog({ market, onClose }: { market: AdminMarket; onClose: () => void }) {
  const apply = useApplyMarket(market.id);
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
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
    mutationFn: async ({ values, by }: { values: ResolveMarketFormOutput; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/resolve', {
          params: { path: { id: market.id } },
          body: toResolveMarketBody(values, by),
        }),
      ).data,
    onSuccess: async (resolved) => {
      toaster.create({ type: 'success', title: copy.adminMarketResolved });
      onClose();
      await apply(resolved);
    },
    onError: (error) => {
      // Another account's cookie judged nothing: the dialog closes with the toast (ADR-0092).
      if (sessionChanged(error)) onClose();
      toaster.create({ type: 'error', title: transitionErrorMessage(error) });
    },
  });

  const submit = handleSubmit((values) => {
    if (operatorId !== undefined) resolve.mutate({ values, by: operatorId });
  });

  return (
    <ConfirmDialog
      testId="market-resolve"
      open
      onClose={onClose}
      title={copy.adminMarketResolveTitle}
      confirmLabel={copy.adminMarketResolve}
      loading={resolve.isPending}
      confirmDisabled={operatorId === undefined}
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
  // The form is drawn for the admin on screen (ADR-0092 answer 1, `OperatorFieldset`): `['me']`
  // turning from A to B in place drops what A typed, and the open market's confirmation with it.
  const operatorId = useOperatorId();
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
          <EditMarketForm key={operatorId ?? ''} market={market} categories={categories.data} />
        )}
      </Card.Body>
    </Card.Root>
  );
}

function EditMarketForm({ market, categories }: { market: AdminMarket; categories: Category[] }) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  // The admin on screen, whom a save names (ADR-0092): 저장 waits for `GET /me`.
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const original = useMemo(() => marketToFormValues(market, categories), [market, categories]);
  const editable = isEditable(market.status);
  // An open market may not be edited down to no rules, nor to no tags (#17): the API refuses both.
  // One opened before #17 with no tags keeps its other fields editable (`marketFormSchema`).
  const openMarket = market.status === 'open';
  const schema = useMemo(
    () => marketFormSchema({ original, rulesRequired: openMarket, tagsRequired: openMarket }),
    [original, openMarket],
  );
  // The open market's confirmation goes with the form, which EditMarketCard draws again for each
  // admin on screen (`key`): a confirmation A opened never names B (ADR-0092 answer 1).
  const [pending, setPending] = useState<UpdateMarketFields | null>(null);

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
      sessionChanged(error);
      // A refused category also reads the select's list again (#17).
      const fieldError = marketFormError(error);
      if (fieldError) {
        setError(fieldError.field, { message: fieldError.message });
        void refreshAfterMarketFormRefusal(queryClient, fieldError.field);
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
    if (operatorId === undefined) return;
    await update.mutateAsync({ ...body, expectedAccountId: operatorId }).catch(() => undefined); // reported by onError
  });

  return (
    <>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <OperatorFieldset disabled={operatorId === undefined}>
          <Stack gap="3">
            <MarketFormFields
              form={form}
              categories={categories}
              disabled={!editable}
              // The row itself, so the 미리보기 of a market that has opened shows the price and volume
              // it TRADES at rather than an untraded card (market-preview.ts).
              base={market}
            />
            <Button
              type="submit"
              size="sm"
              alignSelf="flex-start"
              loading={isSubmitting || update.isPending}
              disabled={!editable || !isDirty || operatorId === undefined}
              data-testid="market-save"
            >
              {copy.save}
            </Button>
          </Stack>
        </OperatorFieldset>
      </form>

      <ConfirmDialog
        testId="market-edit"
        open={pending !== null}
        onClose={() => setPending(null)}
        title={copy.adminMarketEditOpenTitle}
        confirmLabel={copy.save}
        loading={update.isPending}
        confirmDisabled={operatorId === undefined}
        onConfirm={() => {
          if (pending && operatorId !== undefined) {
            update.mutate({ ...pending, expectedAccountId: operatorId });
          }
        }}
      >
        <Text>{copy.adminMarketEditOpenBody}</Text>
      </ConfirmDialog>
    </>
  );
}

/**
 * 정산 단계 (ADR-0046, D7): what the worker has done with a judged market, read-only. One row
 * per settlement step, in the order the worker runs them; nothing at all before the result is
 * confirmed or for a cancelled market (the API answers an empty list then, and an empty table
 * would only say so).
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
 * 관련 시장 (#65, ADR-0068): the markets linked to this one, and a title search to link another.
 * Only an admin links (N03 §1), in any status of either market, with no reason and no second admin
 * (ADR-0061 decision 1, item 19; decision 3, the #65 rows). A link is two-way: the other market's
 * detail shows this one too, which the hint says, with what a reader does not see — a cancelled
 * market and one whose result is 무효, besides the drafts and reviews no public page shows
 * (ADR-0093 decision 3, the #174 row) — and that a link changes neither market.
 *
 * The list is every link whatever the other market's status or result (a draft, a cancelled
 * or a 무효 market included, each with its badge), the latest first, each with when and by whom — the
 * linking admin's nickname, not the account id (owner decision 2026-10-17). Each row unlinks behind
 * a confirmation: unlinking takes the market off two public details at once. Linking is one press:
 * it is undone by the unlink beside it. Both writes answer the links as they now stand, which go on screen at once
 * (`applyRelatedMarkets`); a repeated link or an unlink of nothing changes nothing on the server.
 * The search is the admin list's (`GET /admin/markets?q=`, every status), so the market on screen
 * is among the results — marked 이 시장 — and so is any it is linked with already (연결됨). Its box
 * holds what the API takes as a term (`SEARCH_INPUT_MAX_LENGTH`), and 찾기 on the term already
 * searched asks again (`relatedSearchSubmit`) — the way back from a search that failed. A newly
 * submitted term shows a skeleton until its own answer arrives, never the last term's rows with
 * their 연결 (`relatedSearchSection`, Codex review on #214).
 *
 * Both lists take the other lists' ladder (`listSection`): a refresh that failed after rows exist
 * keeps them under a notice with 다시 시도, instead of passing for current — an empty list that
 * could not be re-read after a link made from the other market's page would otherwise go on
 * saying 연결된 관련 시장이 없습니다 (review on #65).
 *
 * The unlink's confirmation is held for the admin who opened it (`useHeldForOperator`): it closes
 * once `['me']` turns from A to B in place (ADR-0092 answer 1). The search is not: it reads the
 * same markets for every admin and sends nothing as one — a 연결 is its own press, on B's screen.
 */
function RelatedMarketsPanel({ market }: { market: AdminMarket }) {
  const queryClient = useQueryClient();
  // The admin on screen, whom a link and an unlink name (ADR-0092): both wait for `GET /me`.
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const links = useAdminRelatedMarkets(market.id);
  const linkedIds = useMemo(() => new Set((links.data ?? []).map((row) => row.id)), [links.data]);
  const [unlinking, setUnlinking] = useHeldForOperator<AdminRelatedMarket>();
  const [input, setInput] = useState('');
  const [term, setTerm] = useState<string | undefined>(undefined);
  const search = useAdminRelatedSearch(term);
  const results = search.data?.pages.flatMap((page) => page.items) ?? [];
  const linkRows = links.data ?? [];
  const linksSection = listSection(links, linkRows.length);
  const searchSection = relatedSearchSection(search, results.length);

  const onError = (error: unknown) => {
    if (sessionChanged(error)) setUnlinking(null);
    toaster.create({ type: 'error', title: relatedLinkErrorMessage(error) });
  };

  const link = useMutation({
    mutationFn: async ({ relatedId, by }: { relatedId: string; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/related', {
          params: { path: { id: market.id } },
          body: { marketId: relatedId, expectedAccountId: by },
        }),
      ).data,
    onSuccess: async (fresh, { relatedId }) => {
      toaster.create({ type: 'success', title: copy.adminRelatedLinked });
      await applyRelatedMarkets(queryClient, market.id, relatedId, fresh);
    },
    onError,
  });

  const unlink = useMutation({
    mutationFn: async ({ relatedId, by }: { relatedId: string; by: string }) =>
      unwrap(
        await api.DELETE('/api/v1/admin/markets/{id}/related/{relatedMarketId}', {
          params: {
            path: { id: market.id, relatedMarketId: relatedId },
            // A DELETE has no body: the admin on screen rides in the query.
            query: { expectedAccountId: by },
          },
        }),
      ).data,
    onSuccess: async (fresh, { relatedId }) => {
      toaster.create({ type: 'success', title: copy.adminRelatedUnlinked });
      setUnlinking(null);
      await applyRelatedMarkets(queryClient, market.id, relatedId, fresh);
    },
    onError,
  });

  return (
    <Card.Root data-testid="admin-related-markets">
      <Card.Header>
        <Stack gap="1">
          <Text fontWeight="semibold">{copy.adminRelatedMarkets}</Text>
          <Text fontSize="sm" color="fg.muted">
            {relatedHint()}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap="5">
          <Stack gap="3">
            {linksSection.stale && (
              <RefreshFailedNotice
                testId="admin-related-stale"
                onRetry={() => void links.refetch()}
              />
            )}
            {linksSection.body === 'pending' ? (
              <Skeleton height="12" />
            ) : linksSection.body === 'failed' ? (
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errUnknown}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
            ) : linksSection.body === 'empty' ? (
              <Text color="fg.muted" data-testid="admin-related-empty">
                {copy.adminRelatedEmpty}
              </Text>
            ) : (
              <Stack gap="2" data-testid="admin-related-list">
                {linkRows.map((row) => (
                  <HStack
                    key={row.id}
                    justify="space-between"
                    borderWidth="1px"
                    borderRadius="l2"
                    p="3"
                    gap="3"
                    flexWrap="wrap"
                    data-testid={`admin-related-${row.id}`}
                  >
                    <RelatedMarketLine market={row}>
                      <Text fontSize="xs" color="fg.muted">
                        {copy.adminRelatedLinkedAt} {formatKst(row.linkedAt)} ·{' '}
                        {/* Who linked it, by nickname (owner decision 2026-10-17). */}
                        <Text as="span" data-testid={`admin-related-linked-by-${row.id}`}>
                          {nicknameShown(row.linkedBy.nickname)}
                        </Text>
                      </Text>
                    </RelatedMarketLine>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={operatorId === undefined}
                      onClick={() => setUnlinking(row)}
                      data-testid={`admin-related-unlink-${row.id}`}
                    >
                      {copy.adminRelatedUnlink}
                    </Button>
                  </HStack>
                ))}
              </Stack>
            )}
          </Stack>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              const next = relatedSearchSubmit(input, term);
              if (next.refetch) void search.refetch();
              else setTerm(next.term);
            }}
            noValidate
          >
            <Field.Root>
              <Field.Label>{copy.adminRelatedSearchLabel}</Field.Label>
              <HStack gap="2" w="full">
                <Input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={copy.adminRelatedSearchPlaceholder}
                  // The API's bound on a term: a pasted title past it would read as no term.
                  maxLength={SEARCH_INPUT_MAX_LENGTH}
                  autoComplete="off"
                  data-testid="admin-related-search-input"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  data-testid="admin-related-search-submit"
                >
                  {copy.adminRelatedSearchSubmit}
                </Button>
              </HStack>
            </Field.Root>
          </form>

          {term !== undefined && (
            <Stack gap="3">
              {searchSection.stale && (
                <RefreshFailedNotice
                  testId="admin-related-search-stale"
                  onRetry={() => void search.refetch()}
                />
              )}
              {searchSection.body === 'pending' ? (
                <Skeleton height="12" />
              ) : searchSection.body === 'failed' ? (
                <Alert.Root status="error" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{copy.errUnknown}</Alert.Description>
                  </Alert.Content>
                </Alert.Root>
              ) : searchSection.body === 'empty' ? (
                <Text color="fg.muted" data-testid="admin-related-search-empty">
                  {copy.adminRelatedSearchEmpty}
                </Text>
              ) : (
                <Stack gap="2" data-testid="admin-related-search-results">
                  {results.map((row) => {
                    const state = relatedPickState(row.id, market.id, linkedIds);
                    return (
                      <HStack
                        key={row.id}
                        justify="space-between"
                        borderWidth="1px"
                        borderRadius="l2"
                        p="3"
                        gap="3"
                        flexWrap="wrap"
                        data-testid={`admin-related-result-${row.id}`}
                      >
                        <RelatedMarketLine market={row} />
                        {state === 'linkable' ? (
                          <Button
                            size="sm"
                            loading={link.isPending && link.variables?.relatedId === row.id}
                            disabled={link.isPending || operatorId === undefined}
                            onClick={() => {
                              if (operatorId !== undefined) {
                                link.mutate({ relatedId: row.id, by: operatorId });
                              }
                            }}
                            data-testid={`admin-related-link-${row.id}`}
                          >
                            {copy.adminRelatedLink}
                          </Button>
                        ) : (
                          <Badge variant="subtle" data-testid={`admin-related-state-${row.id}`}>
                            {state === 'self'
                              ? copy.adminRelatedThisMarket
                              : copy.adminRelatedAlreadyLinked}
                          </Badge>
                        )}
                      </HStack>
                    );
                  })}
                  {searchSection.more && (
                    <>
                      <LoadMoreFailed
                        list={search}
                        message={copy.errUnknown}
                        data-testid="admin-related-search-more-failed"
                      />
                      <Button
                        alignSelf="center"
                        size="sm"
                        variant="ghost"
                        loading={search.isFetchingNextPage}
                        onClick={() => void search.fetchNextPage()}
                        data-testid="admin-related-search-more"
                      >
                        {copy.loadMore}
                      </Button>
                    </>
                  )}
                </Stack>
              )}
            </Stack>
          )}
        </Stack>

        <ConfirmDialog
          testId="admin-related-unlink"
          open={unlinking !== null}
          onClose={() => setUnlinking(null)}
          title={copy.adminRelatedUnlinkTitle}
          confirmLabel={copy.adminRelatedUnlink}
          loading={unlink.isPending}
          confirmDisabled={operatorId === undefined}
          onConfirm={() => {
            if (unlinking && operatorId !== undefined) {
              unlink.mutate({ relatedId: unlinking.id, by: operatorId });
            }
          }}
        >
          <Stack gap="2">
            <Text fontWeight="medium">{unlinking?.title}</Text>
            <Text>{copy.adminRelatedUnlinkBody}</Text>
          </Stack>
        </ConfirmDialog>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The notice above a list whose refresh failed after it had rows (`listSection`'s `stale`): the
 * rows stay, and this says they are the last ones read, with 다시 시도 — the reading RecentFills
 * and the card above already take (`adminMarketRefreshFailed`). Exported with `RelatedMarketLine`
 * for the admin theme screen (#81), whose market panel is this one's twin (its `ConfirmDialog` is
 * the shared one, components/ui/confirm-dialog.tsx, since #77).
 */
export function RefreshFailedNotice({ testId, onRetry }: { testId: string; onRetry: () => void }) {
  return (
    <Alert.Root status="warning" role="status" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
      </Alert.Content>
      <Button size="xs" variant="outline" ml="auto" onClick={onRetry}>
        {copy.retry}
      </Button>
    </Alert.Root>
  );
}

/** One market in the 관련 시장 panel: its title (to its admin detail) and its status. */
export function RelatedMarketLine({
  market,
  children,
}: {
  market: MarketSummary;
  children?: ReactNode;
}) {
  return (
    <Stack gap="0.5" minW="0">
      <HStack gap="2" flexWrap="wrap">
        <ChakraLink asChild fontWeight="semibold">
          <NextLink href={`/admin/markets/${market.id}`}>{market.title}</NextLink>
        </ChakraLink>
        <Badge colorPalette={MARKET_STATUS_PALETTE[market.status]} variant="subtle">
          {MARKET_STATUS_LABEL[market.status]}
        </Badge>
      </HStack>
      {children}
    </Stack>
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
  // A payload read whole with nothing worth a row (the payout's start, `{source: 'job'}`).
  if (rows?.length === 0) return null;
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

/**
 * Newest fills, anonymous (PLAN 7.1). Read from the public route, which answers NOT_FOUND for a
 * draft and a market in review (ADR-0093 decision 1, item 12), so it waits for the market to be
 * public; neither has traded.
 */
function RecentFills({ market }: { market: AdminMarket }) {
  const hidden = !isPublicMarketStatus(market.status);
  const fills = useMarketFills(market.id, !hidden);
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
        {view === 'stale' && !hidden && (
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
        {hidden ? (
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
