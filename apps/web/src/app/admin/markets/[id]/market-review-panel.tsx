'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  HStack,
  Link as ChakraLink,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, api, isApiError, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_EVENT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  transitionErrorMessage,
} from '@/lib/market-admin';
import {
  REVIEW_EXCLUSION_NOTE,
  excludedAdmins,
  reviewActorName,
  reviewExclusion,
  reviewLogRows,
  scheduledCloseLapsed,
  showsExcludedAdmins,
} from '@/lib/market-review';
import { type ReviewDialogKind, ReviewDialog } from './market-review-dialogs';

/**
 * 검수 제출 (DRAFT → REVIEW, #78, ADR-0099), the one way out of a draft since the interim 열기 went
 * (#21, ADR-0100): one press, which locks the content (#172 item 6 (a)) and opens the review
 * request another admin decides. Off while the open-items check finds something missing — the
 * notice under the buttons says what — and until the admin on screen is known (ADR-0092). A
 * refusal is a transition's toast (`transitionErrorMessage`: OPEN_ITEMS_MISSING by its items, a
 * close already passed, a status another admin moved), and the detail is read again so the notice
 * says what the server found. Nothing on any other status.
 */
export function SubmitReviewButton({ market }: { market: AdminMarket }) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const submit = useMutation({
    mutationFn: async (expectedAccountId: string) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/submit', {
          params: { path: { id: market.id } },
          body: { expectedAccountId },
        }),
      ).data,
    onSuccess: async (submitted) => {
      toaster.create({ type: 'success', title: copy.adminMarketReviewSubmitted });
      await apply(submitted);
    },
    onError: (error) => {
      // Another account's cookie submitted nothing: `copy.sessionChanged`, and the session is
      // asked again (ADR-0092).
      sessionChanged(error);
      toaster.create({ type: 'error', title: transitionErrorMessage(error) });
      // The screen's notice and status were the last read's: what the server refused for goes on
      // them now.
      if (isApiError(error, 'OPEN_ITEMS_MISSING') || isApiError(error, 'VALIDATION_ERROR')) {
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });
  if (market.status !== 'draft') return null;
  return (
    <Button
      size="sm"
      loading={submit.isPending}
      disabled={operatorId === undefined || market.missingOpenItems.length > 0}
      onClick={() => {
        if (operatorId !== undefined) submit.mutate(operatorId);
      }}
      data-testid="market-review-submit"
    >
      {copy.adminMarketReviewSubmit}
    </Button>
  );
}

/**
 * 검수 (#78, ADR-0099; ADR-0093 decision 2 #172 items 4·5·6), in every status: what the review asks
 * of the admin on screen (`ReviewPanelBody`) and the dialog it opened, held for that admin
 * (`useHeldForOperator`, ADR-0092 answer 1) — once `['me']` turns from A to B in place, the dialog
 * closes with what A checked and typed.
 */
export function MarketReviewPanel({ market, readAt }: { market: AdminMarket; readAt: number }) {
  const operatorId = useOperatorId();
  const [dialog, setDialog] = useHeldForOperator<ReviewDialogKind>();
  return (
    <>
      <ReviewPanelBody market={market} readAt={readAt} operatorId={operatorId} onOpen={setDialog} />
      {dialog !== null && (
        <ReviewDialog kind={dialog} market={market} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

/**
 * The panel as drawn for `operatorId` (undefined until `GET /me` answers):
 * - 검수 중: who submitted it and when, that the content is locked; the exclusion note when the
 *   admin on screen created it, edited it or submitted it (`reviewExclusion`, the server's
 *   precedence) with 승인 and 반려 off — the server refuses them anyway; 초안으로 되돌리기 for
 *   anyone; the markets with the same YES condition and event deadline (the 중복 aid, each to its
 *   admin detail).
 * - 개장 예정: that it opens by itself at its scheduled open (#21, ADR-0100) and the content is
 *   locked — or, read still 개장 예정 once its close had passed (`scheduledCloseLapsed` at `readAt`;
 *   the detail re-reads it at the close, `scheduledMarketPollDelay`), the warning that it will not
 *   open and goes back to a draft to fix its times; 예정 개장 시각 변경 and 초안으로 되돌리기 for
 *   anyone.
 * - 초안 and 검수 중: 승인·반려할 수 없는 관리자 — the creator, every editor, the submitter — one row per
 *   account, '(나)' after the admin on screen.
 * - every status: the 검수 기록, newest first — who, when, which record, the status change and what
 *   it says (reason, 반려 사유, checklist, the times of a reschedule); 검수 기록이 없습니다 for a
 *   market never submitted.
 * No button is live until the admin on screen is known.
 */
export function ReviewPanelBody({
  market,
  readAt,
  operatorId,
  onOpen,
}: {
  market: AdminMarket;
  /** When `market` was read (the query's `dataUpdatedAt`): what `scheduledCloseLapsed` judges. */
  readAt: number;
  operatorId: string | undefined;
  onOpen: (kind: ReviewDialogKind) => void;
}) {
  const { review, status } = market;
  const exclusion = status === 'review' ? reviewExclusion(review, operatorId) : null;
  const revertable = status === 'review' || status === 'scheduled';
  const closeLapsed = scheduledCloseLapsed(market, readAt);
  return (
    <Card.Root data-testid="market-review" data-status={status}>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminMarketReview}</Text>
      </Card.Header>
      <Card.Body>
        <Stack gap="5">
          {status === 'review' && review.pending !== null && (
            <Alert.Root status="info" role="status" data-testid="market-review-pending">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  {copy.adminMarketReviewPendingBy}{' '}
                  <Text as="span" fontWeight="medium" data-testid="market-review-pending-by">
                    {reviewActorName(review.pending.requestedBy)}
                  </Text>{' '}
                  · {copy.adminMarketReviewPendingAt}{' '}
                  <Text as="span" data-testid="market-review-pending-at">
                    {formatKst(review.pending.requestedAt)}
                  </Text>
                </Alert.Description>
                <Text fontSize="sm">{copy.adminMarketReviewPendingNote}</Text>
              </Alert.Content>
            </Alert.Root>
          )}
          {status === 'scheduled' && !closeLapsed && (
            <Alert.Root status="info" role="status" data-testid="market-review-scheduled">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketReviewScheduledNote}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          {closeLapsed && (
            <Alert.Root status="warning" role="status" data-testid="market-review-close-passed">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketReviewCloseLapsed}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          {exclusion !== null && exclusion !== undefined && (
            <Alert.Root
              status="warning"
              role="status"
              data-testid="market-review-exclusion"
              data-exclusion={exclusion}
            >
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{REVIEW_EXCLUSION_NOTE[exclusion]}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          {revertable && (
            <HStack gap="2" flexWrap="wrap" data-testid="market-review-actions">
              {status === 'review' && (
                <>
                  <Button
                    size="sm"
                    disabled={operatorId === undefined || exclusion !== null}
                    onClick={() => onOpen('approve')}
                    data-testid="market-review-approve"
                  >
                    {copy.adminMarketReviewApprove}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={operatorId === undefined || exclusion !== null}
                    onClick={() => onOpen('reject')}
                    data-testid="market-review-reject"
                  >
                    {copy.adminMarketReviewReject}
                  </Button>
                </>
              )}
              {status === 'scheduled' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={operatorId === undefined}
                  onClick={() => onOpen('reschedule')}
                  data-testid="market-review-reschedule"
                >
                  {copy.adminMarketReviewReschedule}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={operatorId === undefined}
                onClick={() => onOpen('revert')}
                data-testid="market-review-revert"
              >
                {copy.adminMarketReviewRevert}
              </Button>
            </HStack>
          )}
          {status === 'review' && <SameConditionList market={market} />}
          {showsExcludedAdmins(status) && (
            <ExcludedAdminsList market={market} operatorId={operatorId} />
          )}
          <ReviewLog market={market} />
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** A heading inside the panel. */
function PanelHeading({ children }: { children: string }) {
  return (
    <Text fontWeight="medium" fontSize="sm">
      {children}
    </Text>
  );
}

/**
 * 같은 조건의 진행 중인 시장 (#172 item 4, 중복): the other markets from 검수 중 until the result is
 * confirmed with exactly the same YES condition and event deadline (`review.sameCondition`), each
 * its title to its admin detail and its status badge. An aid: the reviewer still decides.
 */
function SameConditionList({ market }: { market: AdminMarket }) {
  const rows = market.review.sameCondition;
  return (
    <Stack gap="2" data-testid="market-review-same-condition">
      <PanelHeading>{copy.adminMarketReviewSameCondition}</PanelHeading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketReviewSameConditionHint}
      </Text>
      {rows.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-review-same-condition-empty">
          {copy.adminMarketReviewSameConditionEmpty}
        </Text>
      ) : (
        <Stack gap="1">
          {rows.map((row) => (
            <HStack
              key={row.id}
              gap="2"
              flexWrap="wrap"
              data-testid={`market-review-same-condition-${row.id}`}
            >
              <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
                <NextLink href={`/admin/markets/${row.id}`}>{row.title}</NextLink>
              </ChakraLink>
              <Badge colorPalette={MARKET_STATUS_PALETTE[row.status]} variant="subtle">
                {MARKET_STATUS_LABEL[row.status]}
              </Badge>
            </HStack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** 승인·반려할 수 없는 관리자 (#172 item 5): one row per account, its places joined (`excludedAdmins`). */
function ExcludedAdminsList({
  market,
  operatorId,
}: {
  market: AdminMarket;
  operatorId: string | undefined;
}) {
  const rows = excludedAdmins(market.review, operatorId);
  return (
    <Stack gap="2" data-testid="market-review-excluded">
      <PanelHeading>{copy.adminMarketReviewExcluded}</PanelHeading>
      <Stack as="ul" gap="1" listStyleType="none">
        {rows.map((row) => (
          <Text
            as="li"
            key={row.id}
            fontSize="sm"
            data-testid={`market-review-excluded-${row.id}`}
            data-viewer={row.viewer ? 'true' : undefined}
          >
            <Text as="span" fontWeight="medium">
              {row.name}
              {row.viewer ? ` ${copy.adminMarketReviewViewer}` : ''}
            </Text>{' '}
            <Text as="span" color="fg.muted">
              · {row.roles}
            </Text>
          </Text>
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * 검수 기록 (`review.log`, newest first): each entry its record's name, who (by nickname), when in
 * KST, then its rows (`reviewLogRows`). `market-review-log-<n>` counts from the newest, and carries
 * the record's type in `data-type`.
 */
function ReviewLog({ market }: { market: AdminMarket }) {
  const log = market.review.log;
  return (
    <Stack gap="2" data-testid="market-review-log">
      <PanelHeading>{copy.adminMarketReviewLog}</PanelHeading>
      {log.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-review-log-empty">
          {copy.adminMarketReviewLogEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {log.map((entry, index) => (
            <Stack
              key={`${entry.at}-${entry.type}-${String(index)}`}
              gap="0.5"
              data-testid={`market-review-log-${String(index)}`}
              data-type={entry.type}
            >
              <HStack gap="2" flexWrap="wrap">
                <Badge variant="subtle" data-testid={`market-review-log-${String(index)}-type`}>
                  {MARKET_EVENT_LABEL[entry.type]}
                </Badge>
                <Text
                  fontSize="sm"
                  fontWeight="medium"
                  data-testid={`market-review-log-${String(index)}-actor`}
                >
                  {reviewActorName(entry.actor)}
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {formatKst(entry.at)}
                </Text>
              </HStack>
              <Stack
                gap="0"
                fontSize="sm"
                color="fg.muted"
                data-testid={`market-review-log-${String(index)}-rows`}
              >
                {reviewLogRows(entry, MARKET_STATUS_LABEL, formatKst).map((row) => (
                  <Text key={row.label} whiteSpace="pre-wrap" wordBreak="break-word">
                    <Text as="span" fontWeight="medium">
                      {row.label}
                    </Text>{' '}
                    {row.value}
                  </Text>
                ))}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
