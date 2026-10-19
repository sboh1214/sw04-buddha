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
  NativeSelect,
  RadioGroup,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { PROPOSAL_REJECTION_REASONS } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';
import {
  Controller,
  type FieldValues,
  type UseFormSetError,
  useForm,
  useWatch,
} from 'react-hook-form';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { applyProposal, useAdminProposal } from '@/hooks/use-admin-proposals';
import { useCategories } from '@/hooks/use-markets';
import { type AdminProposal, type MarketSummary, api, isApiError, unwrap } from '@/lib/api';
import { CATEGORY_TRAIL_SEPARATOR } from '@/lib/category-label';
import { groupCategories } from '@/lib/category-tree';
import { formatKst } from '@/lib/datetime';
import {
  ADMIN_PROPOSALS_PATH,
  type AdminProposalField,
  type AdoptProposalFormValues,
  EMPTY_ADOPT_FORM,
  EMPTY_REJECT_FORM,
  type InternalMemoFormValues,
  PROPOSAL_REJECTION_REASON_LABEL,
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_PALETTE,
  type RejectProposalFormValues,
  adminProposalActions,
  adminProposalFailure,
  adminProposalKey,
  adoptProposalFormSchema,
  formatProposalDate,
  internalMemoFormSchema,
  proposalCategoryFitsDraft,
  proposalIdParam,
  rejectProposalFormSchema,
  toAdoptProposalBody,
  toRejectProposalBody,
} from '@/lib/proposals';
import { AdminMarketLine, MarketPicker } from './market-picker';

/**
 * 시장 제안 상세 (#77, ADR-0089; ADR-0069 decision 4 #77): what was proposed and by whom, the
 * record — who started the review, who decided it and when (검토 흐름·기록) — the result the proposer
 * reads, the operators' moves the status allows (`adminProposalActions`: 검토 시작 from 접수, 채택 from
 * 검토, 반려 from either; nothing once 채택, 반려 or 철회 — they are final), and the internal memo.
 * Times are KST like every admin screen (ADR-0063).
 *
 * Every move answers with the proposal as it committed, which goes on screen at once
 * (`applyProposal`). A move the status no longer allows — another operator decided it, the proposer
 * retracted it — is refused naming `status`, and the detail is read again so the buttons follow.
 */
export function AdminProposalDetail({ id }: { id: string }) {
  const proposal = useAdminProposal(id);

  if (proposalIdParam(id) === undefined || isApiError(proposal.error, 'NOT_FOUND')) {
    return (
      <Stack gap="4">
        <BackLink />
        <Alert.Root status="error" role="alert" data-testid="admin-proposal-not-found">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errProposalNotFound}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    );
  }
  if (proposal.isPending) return <Skeleton height="64" />;
  if (proposal.data === undefined) {
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

  const data = proposal.data;
  const actions = adminProposalActions(data.status);
  return (
    <Stack gap="4" data-testid="admin-proposal-detail" data-status={data.status}>
      <BackLink />
      {proposal.isRefetchError && (
        <Alert.Root status="warning" role="status" data-testid="admin-proposal-stale">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void proposal.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      <ContentCard proposal={data} />
      <RecordCard proposal={data} />
      {(data.rejection !== null || data.adoption !== null) && <ResultCard proposal={data} />}
      {(actions.review || actions.adopt || actions.reject) && (
        <Card.Root data-testid="admin-proposal-actions">
          <Card.Header>
            <Text fontWeight="semibold">{copy.adminProposalActions}</Text>
          </Card.Header>
          <Card.Body>
            <Stack gap="6">
              {actions.review && <StartReview proposal={data} />}
              {/* Keyed on the status: a form whose proposal moved starts over. */}
              {actions.adopt && <AdoptForm key={`adopt-${data.status}`} proposal={data} />}
              {actions.reject && <RejectForm key={`reject-${data.status}`} proposal={data} />}
            </Stack>
          </Card.Body>
        </Card.Root>
      )}
      <InternalMemoCard proposal={data} />
    </Stack>
  );
}

function BackLink() {
  return (
    <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
      <NextLink href={ADMIN_PROPOSALS_PATH}>{copy.adminProposalBack}</NextLink>
    </ChakraLink>
  );
}

function Item({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <DataList.Item data-testid={testId}>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue whiteSpace="pre-wrap" wordBreak="break-word">
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}

/** What was proposed, by whom: the proposer named as every admin record names an account. */
function ContentCard({ proposal }: { proposal: AdminProposal }) {
  return (
    <Card.Root data-testid="admin-proposal-content">
      <Card.Header>
        <Stack gap="2">
          <Badge
            alignSelf="flex-start"
            colorPalette={PROPOSAL_STATUS_PALETTE[proposal.status]}
            variant="subtle"
            data-testid="admin-proposal-status"
          >
            {PROPOSAL_STATUS_LABEL[proposal.status]}
          </Badge>
          <Heading as="h3" size="md" wordBreak="break-word">
            {proposal.question}
          </Heading>
        </Stack>
      </Card.Header>
      <Card.Body>
        <DataList.Root orientation="horizontal" size="sm">
          <Item label={copy.adminProposalProposer} testId="admin-proposal-proposer">
            {proposal.proposer.nickname}
          </Item>
          <Item label={copy.proposalDeadline}>{formatProposalDate(proposal.deadline)}</Item>
          <Item label={copy.proposalYesCondition}>{proposal.yesCondition}</Item>
          <Item label={copy.proposalExpectedSources}>{proposal.expectedSources}</Item>
          <Item label={copy.proposalBackground}>
            {proposal.background ?? copy.adminProposalNoBackground}
          </Item>
          <Item label={copy.proposalCategory}>
            {proposal.category?.nameKo ?? copy.adminProposalNoCategory}
          </Item>
        </DataList.Root>
      </Card.Body>
    </Card.Root>
  );
}

/** 검토 흐름·기록 (ADR-0069 decision 4 #77): each step's time and operator. */
function RecordCard({ proposal }: { proposal: AdminProposal }) {
  const decided = proposal.status === 'adopted' || proposal.status === 'rejected';
  return (
    <Card.Root data-testid="admin-proposal-record">
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminProposalRecord}</Text>
      </Card.Header>
      <Card.Body>
        <DataList.Root orientation="horizontal" size="sm">
          <Item label={copy.proposalStatusSubmitted}>
            {formatKst(proposal.createdAt)} · {proposal.proposer.nickname}
          </Item>
          {proposal.reviewStartedAt !== null && (
            <Item label={copy.proposalReviewStartedAt} testId="admin-proposal-record-review">
              {formatKst(proposal.reviewStartedAt)} · {proposal.reviewStartedBy?.nickname ?? ''}
            </Item>
          )}
          {decided && proposal.decidedAt !== null && (
            <Item
              label={PROPOSAL_STATUS_LABEL[proposal.status]}
              testId="admin-proposal-record-decided"
            >
              {formatKst(proposal.decidedAt)} · {proposal.decidedBy?.nickname ?? ''}
            </Item>
          )}
          {proposal.retractedAt !== null && (
            <Item label={copy.proposalStatusRetracted} testId="admin-proposal-record-retracted">
              {formatKst(proposal.retractedAt)}
            </Item>
          )}
        </DataList.Root>
      </Card.Body>
    </Card.Root>
  );
}

/** What the proposer reads of the decision, and the market, in any status (drafts included). */
function ResultCard({ proposal }: { proposal: AdminProposal }) {
  const { rejection, adoption } = proposal;
  return (
    <Card.Root data-testid="admin-proposal-result">
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminProposalResult}</Text>
      </Card.Header>
      <Card.Body>
        <DataList.Root orientation="horizontal" size="sm">
          {rejection !== null && (
            <>
              <Item label={copy.proposalRejectionReason}>
                {PROPOSAL_REJECTION_REASON_LABEL[rejection.reason]}
              </Item>
              <Item label={copy.adminProposalRejectExplanation}>{rejection.explanation}</Item>
              {rejection.duplicateMarket !== null && (
                <Item label={copy.proposalDuplicateMarket}>
                  <AdminMarketLine market={rejection.duplicateMarket} />
                </Item>
              )}
            </>
          )}
          {adoption !== null && (
            <>
              <Item label={copy.proposalAdoptionMemo}>{adoption.memo ?? '—'}</Item>
              <Item label={copy.proposalMarket} testId="admin-proposal-market">
                {adoption.market === null ? (
                  copy.adminProposalNoMarket
                ) : (
                  <AdminMarketLine market={adoption.market} />
                )}
              </Item>
            </>
          )}
        </DataList.Root>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * Reports a refused move: the message as a toast, the field it is about under that field, and
 * — when the proposal moved under the screen — the detail read again.
 */
function useReportFailure<Values extends FieldValues>(
  proposal: AdminProposal,
  setError?: UseFormSetError<Values>,
  fields: Partial<Record<AdminProposalField, keyof Values & string>> = {},
) {
  const queryClient = useQueryClient();
  return (error: unknown) => {
    const failure = adminProposalFailure(error);
    toaster.create({ type: 'error', title: failure.message });
    const name = failure.field === undefined ? undefined : fields[failure.field];
    if (setError !== undefined && name !== undefined) {
      setError(name as Parameters<UseFormSetError<Values>>[0], { message: failure.message });
    }
    if (failure.refresh) {
      void queryClient.invalidateQueries({ queryKey: adminProposalKey(proposal.id) });
    }
  };
}

/** 접수 → 검토: one press, recorded with the operator and the time. */
function StartReview({ proposal }: { proposal: AdminProposal }) {
  const queryClient = useQueryClient();
  const report = useReportFailure(proposal);
  const review = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/admin/proposals/{id}/review', {
          params: { path: { id: proposal.id } },
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminProposalReviewStarted });
      await applyProposal(queryClient, fresh);
    },
    onError: report,
  });
  return (
    <Button
      alignSelf="flex-start"
      size="sm"
      loading={review.isPending}
      onClick={() => review.mutate()}
      data-testid="admin-proposal-review"
    >
      {copy.adminProposalStartReview}
    </Button>
  );
}

/**
 * 검토 → 채택 (final): the memo the proposer reads, and the market — none, a draft made from the
 * proposal (its category: the one picked, else the proposal's where a market may sit — a leaf or a
 * parent with no leaves, `proposalCategoryFitsDraft`; its close time: the one typed in KST, else
 * 00:00 of the proposal's date in Korea), or an existing market picked by title. The press asks for
 * confirmation first: a 채택 is never undone, and it opens nothing and grants nothing.
 */
function AdoptForm({ proposal }: { proposal: AdminProposal }) {
  const queryClient = useQueryClient();
  const categories = useCategories();
  const tree = useMemo(() => groupCategories(categories.data ?? []), [categories.data]);
  const [picked, setPicked] = useState<MarketSummary | null>(null);
  const [confirming, setConfirming] = useState<AdoptProposalFormValues | null>(null);
  // Whether the proposal's wish can be the blank option: not a parent that has leaves (ADR-0041).
  const wishFits = proposalCategoryFitsDraft(proposal.category, tree);
  const schema = useMemo(() => adoptProposalFormSchema(wishFits), [wishFits]);
  const {
    control,
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors },
  } = useForm<AdoptProposalFormValues>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY_ADOPT_FORM,
  });
  const market = useWatch({ control, name: 'market' });
  const report = useReportFailure<AdoptProposalFormValues>(proposal, setError, {
    categoryId: 'categoryId',
    closeAt: 'closeAt',
    marketId: 'marketId',
  });

  const adopt = useMutation({
    mutationFn: async (values: AdoptProposalFormValues) =>
      unwrap(
        await api.POST('/api/v1/admin/proposals/{id}/adopt', {
          params: { path: { id: proposal.id } },
          body: toAdoptProposalBody(values),
        }),
      ).data,
    onSuccess: async (fresh, values) => {
      toaster.create({ type: 'success', title: copy.adminProposalAdopted });
      setConfirming(null);
      await applyProposal(queryClient, fresh, { marketCreated: values.market === 'draft' });
    },
    onError: (error) => {
      setConfirming(null);
      report(error);
    },
  });

  const submit = handleSubmit((values) => setConfirming(values));

  return (
    <form onSubmit={(event) => void submit(event)} noValidate data-testid="admin-proposal-adopt">
      <Stack gap="3">
        <Heading as="h4" size="sm">
          {copy.adminProposalAdopt}
        </Heading>
        <Field.Root invalid={!!errors.memo}>
          <Field.Label>{copy.adminProposalAdoptMemo}</Field.Label>
          <Textarea rows={2} data-testid="admin-proposal-adopt-memo" {...register('memo')} />
          <Field.ErrorText>{errors.memo?.message}</Field.ErrorText>
        </Field.Root>
        <Controller
          name="market"
          control={control}
          render={({ field }) => (
            // The group's accessible name is its own Label part (admin-market-detail.tsx).
            <RadioGroup.Root
              name={field.name}
              value={field.value}
              onValueChange={(details) => {
                if (
                  details.value === 'none' ||
                  details.value === 'draft' ||
                  details.value === 'existing'
                ) {
                  field.onChange(details.value);
                }
              }}
              colorPalette="brand"
            >
              <RadioGroup.Label fontWeight="medium" mb="1">
                {copy.adminProposalMarketChoice}
              </RadioGroup.Label>
              <Stack gap="2">
                {(
                  [
                    ['none', copy.adminProposalMarketNone],
                    ['draft', copy.adminProposalMarketDraft],
                    ['existing', copy.adminProposalMarketExisting],
                  ] as const
                ).map(([value, text]) => (
                  <RadioGroup.Item
                    key={value}
                    value={value}
                    data-testid={`admin-proposal-adopt-market-${value}`}
                  >
                    <RadioGroup.ItemHiddenInput onBlur={field.onBlur} />
                    <RadioGroup.ItemIndicator />
                    <RadioGroup.ItemText>{text}</RadioGroup.ItemText>
                  </RadioGroup.Item>
                ))}
              </Stack>
            </RadioGroup.Root>
          )}
        />
        {market === 'draft' && (
          <HStack gap="2" align="start" flexWrap="wrap">
            <Field.Root invalid={!!errors.categoryId} maxW="64">
              <Field.Label>{copy.adminProposalDraftCategory}</Field.Label>
              <NativeSelect.Root>
                <NativeSelect.Field
                  data-testid="admin-proposal-draft-category"
                  {...register('categoryId')}
                >
                  <option value="">
                    {proposal.category !== null && wishFits
                      ? `${copy.adminProposalDraftCategoryFromProposal} (${proposal.category.nameKo})`
                      : copy.adminMarketCategoryPlaceholder}
                  </option>
                  {/* The market form's options (market-form-fields.tsx): a market is filed under a
                      leaf, and under a parent only when it has none (ADR-0041). The proposal's own
                      wish is the blank option above only where a market may sit; a wished parent
                      that has leaves is named below the list instead, and a leaf is picked. */}
                  {tree.flatMap(({ category: parent, children }) =>
                    children.length === 0
                      ? [
                          <option key={parent.id} value={String(parent.id)}>
                            {parent.nameKo}
                          </option>,
                        ]
                      : children.map((leaf) => (
                          <option key={leaf.id} value={String(leaf.id)}>
                            {`${parent.nameKo}${CATEGORY_TRAIL_SEPARATOR}${leaf.nameKo}`}
                          </option>
                        )),
                  )}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              {proposal.category !== null && !wishFits && (
                <Field.HelperText data-testid="admin-proposal-draft-category-wish">
                  {`${copy.adminProposalDraftCategoryFromProposal}: ${proposal.category.nameKo}. ${copy.adminProposalDraftCategoryPickLeaf}`}
                </Field.HelperText>
              )}
              <Field.ErrorText>{errors.categoryId?.message}</Field.ErrorText>
            </Field.Root>
            <Field.Root invalid={!!errors.closeAt} maxW="64">
              <Field.Label>{copy.adminProposalDraftCloseAt}</Field.Label>
              <Input
                type="datetime-local"
                data-testid="admin-proposal-draft-close-at"
                {...register('closeAt')}
              />
              <Field.HelperText>{copy.adminProposalDraftCloseAtHint}</Field.HelperText>
              <Field.ErrorText>{errors.closeAt?.message}</Field.ErrorText>
            </Field.Root>
          </HStack>
        )}
        {market === 'existing' && (
          <MarketPicker
            label={copy.adminProposalExistingMarket}
            picked={picked}
            onPick={(next) => {
              setPicked(next);
              setValue('marketId', next?.id ?? '', { shouldValidate: next !== null });
            }}
            error={errors.marketId?.message}
            testId="admin-proposal-adopt-picker"
          />
        )}
        <Button
          type="submit"
          size="sm"
          alignSelf="flex-start"
          data-testid="admin-proposal-adopt-submit"
        >
          {copy.adminProposalAdopt}
        </Button>
      </Stack>
      <ConfirmDialog
        testId="admin-proposal-adopt"
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={copy.adminProposalAdoptTitle}
        confirmLabel={copy.adminProposalAdopt}
        loading={adopt.isPending}
        onConfirm={() => {
          if (confirming !== null) adopt.mutate(confirming);
        }}
      >
        <Stack gap="2">
          <Text fontWeight="medium">{proposal.question}</Text>
          <Text>{copy.adminProposalAdoptBody}</Text>
          {/* Only a draft is opened on the market screen: no draft without that choice. */}
          {confirming?.market === 'draft' && <Text>{copy.adminProposalAdoptDraftBody}</Text>}
        </Stack>
      </ConfirmDialog>
    </form>
  );
}

/**
 * 접수 or 검토 → 반려 (final): a reason from the owner's list and the explanation the proposer reads;
 * a 중복 names the existing market, picked by title. Confirmed first: a 반려 is never undone.
 */
function RejectForm({ proposal }: { proposal: AdminProposal }) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<MarketSummary | null>(null);
  const [confirming, setConfirming] = useState<RejectProposalFormValues | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors },
  } = useForm<RejectProposalFormValues>({
    resolver: zodResolver(rejectProposalFormSchema),
    defaultValues: EMPTY_REJECT_FORM,
  });
  const reason = useWatch({ control, name: 'reason' });
  const report = useReportFailure<RejectProposalFormValues>(proposal, setError, {
    duplicateMarketId: 'duplicateMarketId',
  });

  const reject = useMutation({
    mutationFn: async (values: RejectProposalFormValues) =>
      unwrap(
        await api.POST('/api/v1/admin/proposals/{id}/reject', {
          params: { path: { id: proposal.id } },
          body: toRejectProposalBody(values),
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminProposalRejected });
      setConfirming(null);
      await applyProposal(queryClient, fresh);
    },
    onError: (error) => {
      setConfirming(null);
      report(error);
    },
  });

  const submit = handleSubmit((values) => setConfirming(values));

  return (
    <form onSubmit={(event) => void submit(event)} noValidate data-testid="admin-proposal-reject">
      <Stack gap="3">
        <Heading as="h4" size="sm">
          {copy.adminProposalReject}
        </Heading>
        <Field.Root invalid={!!errors.reason} required maxW="64">
          <Field.Label>{copy.proposalRejectionReason}</Field.Label>
          <NativeSelect.Root>
            <NativeSelect.Field
              placeholder={copy.adminProposalRejectReasonPlaceholder}
              data-testid="admin-proposal-reject-reason"
              {...register('reason')}
            >
              {PROPOSAL_REJECTION_REASONS.map((value) => (
                <option key={value} value={value}>
                  {PROPOSAL_REJECTION_REASON_LABEL[value]}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Field.ErrorText>{errors.reason?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root invalid={!!errors.explanation} required>
          <Field.Label>{copy.adminProposalRejectExplanation}</Field.Label>
          <Textarea
            rows={3}
            data-testid="admin-proposal-reject-explanation"
            {...register('explanation')}
          />
          <Field.ErrorText>{errors.explanation?.message}</Field.ErrorText>
        </Field.Root>
        {reason === 'duplicate' && (
          <MarketPicker
            label={copy.adminProposalDuplicateMarket}
            picked={picked}
            onPick={(next) => {
              setPicked(next);
              setValue('duplicateMarketId', next?.id ?? '', { shouldValidate: next !== null });
            }}
            error={errors.duplicateMarketId?.message}
            testId="admin-proposal-reject-picker"
          />
        )}
        <Button
          type="submit"
          size="sm"
          variant="outline"
          alignSelf="flex-start"
          data-testid="admin-proposal-reject-submit"
        >
          {copy.adminProposalReject}
        </Button>
      </Stack>
      <ConfirmDialog
        testId="admin-proposal-reject"
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={copy.adminProposalRejectTitle}
        confirmLabel={copy.adminProposalReject}
        loading={reject.isPending}
        onConfirm={() => {
          if (confirming !== null) reject.mutate(confirming);
        }}
      >
        <Stack gap="2">
          <Text fontWeight="medium">{proposal.question}</Text>
          <Text>{copy.adminProposalRejectBody}</Text>
        </Stack>
      </ConfirmDialog>
    </form>
  );
}

/**
 * The operators' internal memo, in any status (never shown to the proposer). The form follows the
 * server's memo while it is untouched, so another operator's save shows on the next read.
 */
function InternalMemoCard({ proposal }: { proposal: AdminProposal }) {
  const queryClient = useQueryClient();
  const values = useMemo(() => ({ memo: proposal.internalMemo ?? '' }), [proposal.internalMemo]);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<InternalMemoFormValues>({
    resolver: zodResolver(internalMemoFormSchema),
    defaultValues: values,
    values,
    resetOptions: { keepDirtyValues: true },
  });
  const report = useReportFailure(proposal);
  const save = useMutation({
    mutationFn: async (memo: string) =>
      unwrap(
        await api.PUT('/api/v1/admin/proposals/{id}/internal-memo', {
          params: { path: { id: proposal.id } },
          body: { memo: memo.trim() === '' ? null : memo.trim() },
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminProposalInternalMemoSaved });
      reset({ memo: fresh.internalMemo ?? '' });
      await applyProposal(queryClient, fresh);
    },
    onError: report,
  });
  const submit = handleSubmit((form) => save.mutate(form.memo));

  return (
    <Card.Root data-testid="admin-proposal-internal-memo">
      <Card.Header>
        <Stack gap="1">
          <Text fontWeight="semibold">{copy.adminProposalInternalMemo}</Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminProposalInternalMemoHint}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <Stack gap="3">
            <Field.Root invalid={!!errors.memo}>
              <Field.Label srOnly>{copy.adminProposalInternalMemo}</Field.Label>
              <Textarea
                rows={3}
                data-testid="admin-proposal-internal-memo-input"
                {...register('memo')}
              />
              <Field.ErrorText>{errors.memo?.message}</Field.ErrorText>
            </Field.Root>
            <Button
              type="submit"
              size="sm"
              alignSelf="flex-start"
              loading={save.isPending}
              disabled={!isDirty}
              data-testid="admin-proposal-internal-memo-save"
            >
              {copy.save}
            </Button>
          </Stack>
        </form>
      </Card.Body>
    </Card.Root>
  );
}
