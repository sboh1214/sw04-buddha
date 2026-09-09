'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  HStack,
  Link as ChakraLink,
  NativeSelect,
  Portal,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { DISPUTE_STATUSES, type DisputeStatus, type DisputeVerdict } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import NextLink from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useAdminDisputes, useReviewDispute } from '@/hooks/use-admin-disputes';
import { useAdminMarket } from '@/hooks/use-admin-markets';
import {
  type AdminDisputeFilters,
  type DisputeGroup,
  type ReviewDisputeFormValues,
  groupDisputesByMarket,
  reviewDisputeFormSchema,
  reviewErrorMessage,
  toReviewDisputeBody,
} from '@/lib/admin-disputes';
import { type AdminDispute } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  DISPUTE_STATUS_LABEL,
  DISPUTE_STATUS_PALETTE,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
} from '@/lib/market-admin';
import { listSection } from '@/lib/query-client';

/**
 * PLAN 12 이의 목록 (design 5.6): the flat, newest-first pages grouped by market, each dispute
 * with its 수용 / 기각. Accepting one changes nothing on the market — the admin goes to the
 * market detail's 결과 변경 for that (PLAN 12: 명시적 두 단계), and the dialog says so.
 *
 * The status filter is screen state (as the market list's is); the market filter is the URL's
 * alone — it arrives from the detail's 이의 row and is left by the 전체 시장 link — so the two
 * cannot disagree about which list is on screen.
 */
export function AdminDisputes({ filters }: { filters: AdminDisputeFilters }) {
  const [status, setStatus] = useState<DisputeStatus | ''>(filters.status ?? '');
  const marketId = filters.marketId;
  const disputes = useAdminDisputes({ ...(status ? { status } : {}), marketId });
  // The filtered market's title for the chip: the rows carry it too, but a market with no
  // dispute under this status has no row to take it from, and the id alone is unreadable.
  const market = useAdminMarket(marketId ?? '');

  const rows = disputes.data?.pages.flatMap((page) => page.items) ?? [];
  const groups = groupDisputesByMarket(rows);
  // The fills list's ladder: a refetch that fails keeps the rows and says so above them, and
  // says so above an EMPTY list too, where "이의가 없습니다" would otherwise assert as current
  // what could not be refreshed (`listSection`).
  const section = listSection(disputes, rows.length);

  return (
    <Stack gap="4">
      <HStack gap="4" flexWrap="wrap">
        {/* A Field, not a Text beside the select: only the label's `htmlFor` gives the select
            an accessible name. Horizontal and shrink-wrapped, so it reads as the one-line filter
            it was and leaves the row for the market chip. */}
        <Field.Root orientation="horizontal" w="auto" gap="2">
          <Field.Label flex="0 0 auto">{copy.adminDisputeStatusFilter}</Field.Label>
          <NativeSelect.Root maxW="40" size="sm">
            <NativeSelect.Field
              value={status}
              onChange={(event) => setStatus(event.target.value as DisputeStatus | '')}
              data-testid="dispute-status-filter"
            >
              <option value="">{copy.adminDisputeStatusAll}</option>
              {DISPUTE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {DISPUTE_STATUS_LABEL[value]}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Field.Root>
        {marketId !== undefined && (
          <HStack gap="2" flexWrap="wrap" data-testid="dispute-market-filter">
            <Text fontSize="sm" fontWeight="medium" flexShrink="0">
              {copy.adminDisputeMarketFilter}
            </Text>
            {market.data ? (
              <ChakraLink asChild fontSize="sm" fontWeight="semibold">
                <NextLink href={`/admin/markets/${marketId}`}>{market.data.title}</NextLink>
              </ChakraLink>
            ) : (
              <Text fontSize="sm" fontFamily="mono">
                {marketId}
              </Text>
            )}
            <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
              <NextLink href="/admin/disputes">{copy.adminDisputeAllMarkets}</NextLink>
            </ChakraLink>
          </HStack>
        )}
      </HStack>

      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid="admin-disputes-stale">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void disputes.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}

      {section.body === 'pending' ? (
        <Skeleton height="24" />
      ) : section.body === 'failed' ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : section.body === 'empty' ? (
        <Text color="fg.muted" data-testid="admin-disputes-empty">
          {copy.adminNoDisputes}
        </Text>
      ) : (
        <Stack gap="3">
          {groups.map((group) => (
            <MarketGroup key={group.marketId} group={group} />
          ))}
          {disputes.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={disputes.isFetchingNextPage}
              onClick={() => void disputes.fetchNextPage()}
              data-testid="admin-disputes-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/** One market's heading — title, status, the proposed result — and its disputes beneath. */
function MarketGroup({ group }: { group: DisputeGroup }) {
  return (
    <Card.Root data-testid={`admin-dispute-market-${group.marketId}`}>
      <Card.Header>
        <HStack gap="2" flexWrap="wrap" align="baseline">
          <ChakraLink asChild fontWeight="semibold">
            <NextLink href={`/admin/markets/${group.marketId}`}>{group.marketTitle}</NextLink>
          </ChakraLink>
          <Badge colorPalette={MARKET_STATUS_PALETTE[group.marketStatus]} variant="subtle">
            {MARKET_STATUS_LABEL[group.marketStatus]}
          </Badge>
          <Text fontSize="sm" color="fg.muted">
            {copy.marketResolvedResult}{' '}
            {group.resolvedResult === null
              ? '—'
              : group.resolvedResult === 'YES'
                ? copy.yes
                : copy.no}
          </Text>
        </HStack>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          {group.disputes.map((dispute) => (
            <DisputeRow key={dispute.id} dispute={dispute} />
          ))}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * One dispute with its two verdict buttons. Both stay live after a review: a verdict is
 * revisable (accepted ↔ rejected, never back to open — `dispute.service` `review`), and the
 * note can only be rewritten by reviewing again. The dialog is mounted only while open, so a
 * cancelled one does not reopen with the old text, and its form starts from the note on
 * file — re-reviewing must not silently blank what the filer already saw.
 */
function DisputeRow({ dispute }: { dispute: AdminDispute }) {
  const [verdict, setVerdict] = useState<DisputeVerdict | null>(null);
  return (
    <Stack
      gap="1.5"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`admin-dispute-${dispute.id}`}
    >
      <HStack gap="2" flexWrap="wrap" align="baseline">
        <Text fontSize="xs" color="fg.muted">
          {copy.adminDisputeFiledBy}
        </Text>
        <Text fontWeight="semibold">{dispute.nickname}</Text>
        <Badge
          colorPalette={DISPUTE_STATUS_PALETTE[dispute.status]}
          variant="subtle"
          data-testid={`admin-dispute-status-${dispute.id}`}
        >
          {DISPUTE_STATUS_LABEL[dispute.status]}
        </Badge>
        <Text fontSize="xs" color="fg.muted">
          {copy.adminDisputeFiledAt} {formatKst(dispute.createdAt)}
        </Text>
      </HStack>
      <Text whiteSpace="pre-wrap" wordBreak="break-word" fontSize="sm">
        {dispute.reason}
      </Text>
      {dispute.evidenceUrl !== null && (
        <Text fontSize="sm" wordBreak="break-all">
          {copy.adminMarketResolveEvidence}{' '}
          {/* An address the filer typed, on the admin's screen: a new tab that cannot reach
              back into this one (`noopener`) and does not announce where it came from. */}
          <ChakraLink
            href={dispute.evidenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            colorPalette="brand"
            color="colorPalette.fg"
          >
            {dispute.evidenceUrl}
          </ChakraLink>
        </Text>
      )}
      {dispute.adminNote !== null && dispute.adminNote !== '' && (
        <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
          <Text as="span" color="fg.muted">
            {copy.adminDisputeReviewNote}
          </Text>{' '}
          {dispute.adminNote}
        </Text>
      )}
      {dispute.reviewedAt !== null && (
        <Text fontSize="xs" color="fg.muted">
          {copy.adminDisputeReviewedAt} {formatKst(dispute.reviewedAt)}
        </Text>
      )}
      <HStack gap="2" pt="1">
        <Button
          size="xs"
          variant="outline"
          colorPalette="brand"
          onClick={() => setVerdict('accepted')}
          data-testid={`admin-dispute-accept-${dispute.id}`}
        >
          {copy.adminDisputeAccept}
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setVerdict('rejected')}
          data-testid={`admin-dispute-reject-${dispute.id}`}
        >
          {copy.adminDisputeReject}
        </Button>
      </HStack>
      {verdict !== null && (
        <ReviewDialog dispute={dispute} verdict={verdict} onClose={() => setVerdict(null)} />
      )}
    </Stack>
  );
}

/**
 * The 수용 / 기각 confirmation with its note (design 5.6). The same shape as the market
 * detail's transition dialogs: `alertdialog`, pinned while the request runs — Cancel, Esc and
 * the backdrop all wait, since dismissing it mid-flight would leave the request running
 * against a screen that no longer shows it. The note is a form (zodResolver) like the void
 * reason, so an over-long one is refused under the field rather than by a toast.
 */
function ReviewDialog({
  dispute,
  verdict,
  onClose,
}: {
  dispute: AdminDispute;
  verdict: DisputeVerdict;
  onClose: () => void;
}) {
  const review = useReviewDispute();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ReviewDisputeFormValues>({
    resolver: zodResolver(reviewDisputeFormSchema),
    defaultValues: { adminNote: dispute.adminNote ?? '' },
  });
  const loading = review.isPending;

  // The cache write lives in the hook (`applyReviewedDispute`); the toast and the dialog are
  // this screen's, and the dialog is pinned open until the answer, so both callbacks land.
  const submit = handleSubmit((values) => {
    review.mutate(
      { id: dispute.id, body: toReviewDisputeBody(verdict, values) },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.adminDisputeReviewed });
          onClose();
        },
        onError: (error) => toaster.create({ type: 'error', title: reviewErrorMessage(error) }),
      },
    );
  });

  const accepting = verdict === 'accepted';
  return (
    <Dialog.Root
      open
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
              <Dialog.Title>
                {accepting ? copy.adminDisputeAcceptTitle : copy.adminDisputeRejectTitle}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Text>{accepting ? copy.adminDisputeAcceptBody : copy.adminDisputeRejectBody}</Text>
                <Field.Root invalid={!!errors.adminNote}>
                  <Field.Label>{copy.adminDisputeReviewNote}</Field.Label>
                  <Textarea rows={3} data-testid="dispute-review-note" {...register('adminNote')} />
                  <Field.ErrorText>{errors.adminNote?.message}</Field.ErrorText>
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={onClose}
                data-testid="dispute-review-cancel"
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                colorPalette={accepting ? 'brand' : undefined}
                loading={loading}
                onClick={() => void submit()}
                data-testid="dispute-review-confirm"
              >
                {accepting ? copy.adminDisputeAccept : copy.adminDisputeReject}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
