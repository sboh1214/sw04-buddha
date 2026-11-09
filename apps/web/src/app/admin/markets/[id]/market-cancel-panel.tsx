'use client';

import { Alert, Badge, Button, Card, HStack, Stack, Text } from '@chakra-ui/react';
import { type RefObject, useEffect, useRef } from 'react';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { type AdminMarket } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  cancelLogRows,
  cancelRequestApprovable,
  cancelRequestOffered,
  isCancelRequester,
  showsCancelPanel,
} from '@/lib/market-cancel';
import { PAUSE_DECISION_STATUS_LABEL, pauseActorName } from '@/lib/market-pause';
import { type CancelDialogKind, CancelDialog } from './market-cancel-dialogs';

/**
 * 시장 취소 (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로'), on a SCHEDULED market and on
 * any that has a cancel request (`showsCancelPanel`): what it asks of the admin on screen
 * (`CancelPanelBody`) and the dialog it opened, held for that admin (`useHeldForOperator`, ADR-0092
 * answer 1). A write that went through takes its button away, so focus comes back to the waiting
 * request's heading, else the panel's own (as the pause panel's `usePauseRefocus`).
 */
export function MarketCancelPanel({ market }: { market: AdminMarket }) {
  const operatorId = useOperatorId();
  const [action, setAction] = useHeldForOperator<CancelDialogKind>();
  const refocus = useCancelRefocus(market, action);
  const close = (sent: boolean) => {
    if (sent) refocus.sent();
    setAction(null);
  };
  if (!showsCancelPanel(market)) return null;
  return (
    <>
      <CancelPanelBody
        market={market}
        operatorId={operatorId}
        onOpen={setAction}
        targets={refocus.targets}
      />
      {action !== null && <CancelDialog kind={action} market={market} onClose={close} />}
    </>
  );
}

/** The panel's headings focus comes back to once a write went through. */
export interface CancelFocusTargets {
  title: RefObject<HTMLParagraphElement | null>;
  pending: RefObject<HTMLParagraphElement | null>;
}

/**
 * Focus once a write went through (WCAG 2.4.3): the next draw of the market the write answered
 * puts focus on the waiting request's heading, else the panel's own — only when focus went with
 * the dialog.
 */
function useCancelRefocus(market: AdminMarket, action: CancelDialogKind | null) {
  const title = useRef<HTMLParagraphElement>(null);
  const pending = useRef<HTMLParagraphElement>(null);
  const sent = useRef<AdminMarket | null>(null);
  useEffect(() => {
    const from = sent.current;
    if (from === null || action !== null || from === market) return;
    sent.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (pending.current ?? title.current)?.focus();
  }, [action, market]);
  return {
    targets: { title, pending } satisfies CancelFocusTargets,
    sent: () => {
      sent.current = market;
    },
  };
}

/**
 * The panel as drawn for `operatorId` (undefined until `GET /me` answers):
 * - SCHEDULED with no request waiting: 시장 취소 요청;
 * - the waiting request, in any status: its reason (the cancel's public one), who asked and when;
 *   승인 and 반려 for any other admin (승인 only while the market is still SCHEDULED, with the note
 *   why not), off for its requester with the note why, and 철회 for the requester alone;
 * - the 시장 취소 기록, newest first, when the market has any request.
 * No button is live until the admin on screen is known.
 */
export function CancelPanelBody({
  market,
  operatorId,
  onOpen,
  targets,
}: {
  market: AdminMarket;
  operatorId: string | undefined;
  onOpen: (action: CancelDialogKind) => void;
  targets?: CancelFocusTargets;
}) {
  return (
    <Card.Root data-testid="market-cancel" data-status={market.status}>
      <Card.Header>
        <Stack gap="1">
          <Text
            ref={targets?.title}
            tabIndex={-1}
            fontWeight="semibold"
            data-testid="market-cancel-title"
          >
            {copy.adminMarketCancel}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketCancelIntro}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap="5">
          {cancelRequestOffered(market) && (
            <Button
              size="sm"
              variant="outline"
              colorPalette="red"
              alignSelf="flex-start"
              disabled={operatorId === undefined}
              onClick={() => onOpen('request')}
              data-testid="market-cancel-request"
            >
              {copy.adminMarketCancelRequest}
            </Button>
          )}
          <PendingCancel
            market={market}
            operatorId={operatorId}
            onOpen={onOpen}
            headingRef={targets?.pending}
          />
          <CancelHistory market={market} />
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** The waiting request (`cancel.pending`), in any status, and what may be done with it. */
function PendingCancel({
  market,
  operatorId,
  onOpen,
  headingRef,
}: {
  market: AdminMarket;
  operatorId: string | undefined;
  onOpen: (action: CancelDialogKind) => void;
  headingRef?: RefObject<HTMLParagraphElement | null>;
}) {
  const pending = market.cancel.pending;
  if (pending === null) return null;
  const requester = isCancelRequester(pending, operatorId);
  const approvable = cancelRequestApprovable(market);
  return (
    <Stack gap="3" borderWidth="1px" borderRadius="l2" p="3" data-testid="market-cancel-pending">
      <Text
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
        fontWeight="medium"
        fontSize="sm"
        data-testid="market-cancel-pending-title"
      >
        {copy.adminMarketCancelPending}
      </Text>
      <Text fontSize="sm">
        {copy.adminMarketPauseRequestedBy}{' '}
        <Text as="span" fontWeight="medium" data-testid="market-cancel-pending-by">
          {pauseActorName(pending.requestedBy)}
        </Text>{' '}
        · {copy.adminMarketPauseRequestedAt}{' '}
        <Text as="span" data-testid="market-cancel-pending-at">
          {formatKst(pending.requestedAt)}
        </Text>
      </Text>
      <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
        <Text as="span" fontWeight="medium">
          {copy.adminMarketCancelReason}
        </Text>{' '}
        <Text as="span" data-testid="market-cancel-pending-reason">
          {pending.reason}
        </Text>
      </Text>
      {requester === true && (
        <Alert.Root status="warning" role="status" data-testid="market-cancel-requester-note">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketPauseExcludedRequester}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {!approvable && (
        <Alert.Root status="warning" role="status" data-testid="market-cancel-pending-status">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketCancelPendingNotScheduled}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <HStack gap="2" flexWrap="wrap" data-testid="market-cancel-actions">
        <Button
          size="sm"
          colorPalette="red"
          disabled={operatorId === undefined || requester !== false || !approvable}
          onClick={() => onOpen('approve')}
          data-testid="market-cancel-approve"
        >
          {copy.adminMarketPauseApprove}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={operatorId === undefined || requester !== false}
          onClick={() => onOpen('reject')}
          data-testid="market-cancel-reject"
        >
          {copy.adminMarketPauseReject}
        </Button>
        {requester === true && (
          <Button
            size="sm"
            variant="outline"
            disabled={operatorId === undefined}
            onClick={() => onOpen('retract')}
            data-testid="market-cancel-retract"
          >
            {copy.adminMarketPauseRetract}
          </Button>
        )}
      </HStack>
    </Stack>
  );
}

/**
 * 시장 취소 기록 (`cancel.log`, newest first): each request with its status, who asked and when and
 * its rows (`cancelLogRows`); nothing while there is none. `market-cancel-log-<n>` counts from the
 * newest, with the status in `data-status`.
 */
function CancelHistory({ market }: { market: AdminMarket }) {
  const { log } = market.cancel;
  if (log.length === 0) return null;
  return (
    <Stack gap="2" data-testid="market-cancel-history">
      <Text fontWeight="medium" fontSize="sm">
        {copy.adminMarketCancelHistory}
      </Text>
      {log.map((entry, index) => {
        const at = `market-cancel-log-${String(index)}`;
        return (
          <Stack
            key={entry.requestId}
            gap="0.5"
            ps="3"
            borderStartWidth="2px"
            data-testid={at}
            data-status={entry.status}
          >
            <HStack gap="2" flexWrap="wrap">
              <Badge variant="outline" data-testid={`${at}-status`}>
                {PAUSE_DECISION_STATUS_LABEL[entry.status]}
              </Badge>
              <Text fontSize="sm" fontWeight="medium" data-testid={`${at}-by`}>
                {pauseActorName(entry.requestedBy)}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {formatKst(entry.requestedAt)}
              </Text>
            </HStack>
            <Stack gap="0" fontSize="sm" color="fg.muted" data-testid={`${at}-rows`}>
              {cancelLogRows(entry, formatKst).map((row) => (
                <Text key={row.label} whiteSpace="pre-wrap" wordBreak="break-word">
                  <Text as="span" fontWeight="medium">
                    {row.label}
                  </Text>{' '}
                  {row.value}
                </Text>
              ))}
            </Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}
