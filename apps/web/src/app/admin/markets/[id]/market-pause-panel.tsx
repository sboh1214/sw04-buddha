'use client';

import { Alert, Badge, Button, Card, HStack, Stack, Text } from '@chakra-ui/react';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { type AdminMarket, type AdminMarketPause } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { type EventRow, PAUSE_REASON_LABEL, PAUSE_REVIEW_RESULT_LABEL } from '@/lib/market-admin';
import {
  PAUSE_DECISION_STATUS_LABEL,
  PAUSE_DECISION_UNAPPROVABLE_NOTE,
  PAUSE_PATH_LABEL,
  currentPause,
  isPauseDecisionRequester,
  pauseActorName,
  pauseDecisionLogRows,
  pauseDecisionUnapprovable,
  pauseDecisionUnavailable,
  pauseEndLabel,
  pauseOffer,
  pauseRows,
  pauseUnavailable,
  showsPausePanel,
} from '@/lib/market-pause';
import { type PauseDialogKind, PauseDialog } from './market-pause-dialogs';

/** What the panel opened: one of its dialogs (`offer` is the pause a 의미 변경 반려 suggests). */
export type PauseAction = PauseDialogKind;

/**
 * 거래 일시 중단 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4·13, decision 2 #172 items 14·15,
 * the owner's answers Q1·Q2 of 2026-11-02), on a market OPEN or PAUSED and on any that has a pause
 * or a next-path request (`showsPausePanel`): what it asks of the admin on screen
 * (`PausePanelBody`) and the dialog it opened, held for that admin (`useHeldForOperator`, ADR-0092
 * answer 1) — once `['me']` turns from A to B in place, it closes with what A picked and typed. A
 * write that went through takes its button away (the pause's, the request's, the decision's), so
 * focus comes back to what took its place (`usePauseRefocus`).
 */
export function MarketPausePanel({ market, readAt }: { market: AdminMarket; readAt: number }) {
  const operatorId = useOperatorId();
  const [action, setAction] = useHeldForOperator<PauseAction>();
  const refocus = usePauseRefocus(market, action);
  const close = (sent: boolean) => {
    if (sent) refocus.sent();
    setAction(null);
  };
  if (!showsPausePanel(market)) return null;
  return (
    <>
      <PausePanelBody
        market={market}
        readAt={readAt}
        operatorId={operatorId}
        onOpen={setAction}
        targets={refocus.targets}
      />
      {action !== null && (
        <PauseDialog kind={action} market={market} readAt={readAt} onClose={close} />
      )}
    </>
  );
}

/** The panel's headings focus comes back to once a write went through (`usePauseRefocus`). */
export interface PauseFocusTargets {
  title: RefObject<HTMLParagraphElement | null>;
  current: RefObject<HTMLParagraphElement | null>;
  pending: RefObject<HTMLParagraphElement | null>;
}

/**
 * Focus once a write went through (WCAG 2.4.3): the dialog closes and the button that opened it
 * goes with the market the write answered (a pause takes 거래 일시 중단 away, a request its own
 * button, a decision the request's), so the next draw of that market puts focus on the waiting
 * request's heading, else the current pause's, else the panel's own. Only when focus went with the
 * dialog: an admin who has moved on keeps it where it is.
 */
function usePauseRefocus(market: AdminMarket, action: PauseAction | null) {
  const title = useRef<HTMLParagraphElement>(null);
  const current = useRef<HTMLParagraphElement>(null);
  const pending = useRef<HTMLParagraphElement>(null);
  const sent = useRef<AdminMarket | null>(null);
  useEffect(() => {
    const from = sent.current;
    if (from === null || action !== null || from === market) return;
    sent.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (pending.current ?? current.current ?? title.current)?.focus();
  }, [action, market]);
  return {
    targets: { title, current, pending } satisfies PauseFocusTargets,
    sent: () => {
      sent.current = market;
    },
  };
}

/**
 * The panel as drawn for `operatorId` (undefined until `GET /me` answers), read at `readAt` (the
 * query's `dataUpdatedAt`, what a close is judged at):
 * - OPEN: 거래 일시 중단 while the close is ahead (`pauseUnavailable`), or why not — and in its
 *   place, after a 의미 변경 반려 not followed by a pause, the offer to pause as 실질 기준 변경 with
 *   the 반려's 설명 (`pauseOffer`, #172 item 15);
 * - PAUSED: the current pause — its reason, note, who paused and when, an early result's
 *   publication instant — and 재개·조기 마감 요청 while one may be asked (`pauseDecisionUnavailable`),
 *   or why not;
 * - the waiting request, in any status: its path, review result and reason, who asked and when; 승인
 *   and 반려 for any other admin (승인 only while it can still be approved,
 *   `pauseDecisionUnapprovable`, with the note why not — the market closed at its close, or another
 *   pause), off for its requester with the note why, and 철회 for the requester alone;
 * - the 일시 중단 기록, newest first: each pause with how it ended (재개, 조기 마감, 예정 마감 — or 진행
 *   중) and its requests.
 * No button is live until the admin on screen is known. `targets` are what focus comes back to.
 */
export function PausePanelBody({
  market,
  readAt,
  operatorId,
  onOpen,
  targets,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: PauseAction) => void;
  targets?: PauseFocusTargets;
}) {
  const current = currentPause(market);
  return (
    <Card.Root data-testid="market-pause" data-status={market.status}>
      <Card.Header>
        <Stack gap="1">
          <Text
            ref={targets?.title}
            tabIndex={-1}
            fontWeight="semibold"
            data-testid="market-pause-title"
          >
            {copy.adminMarketPause}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketPauseIntro}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap="5">
          {market.status === 'open' && (
            <PauseStart market={market} readAt={readAt} operatorId={operatorId} onOpen={onOpen} />
          )}
          {current !== null && (
            <CurrentPause pause={current} headingRef={targets?.current}>
              <DecisionStart
                market={market}
                readAt={readAt}
                operatorId={operatorId}
                onOpen={onOpen}
              />
            </CurrentPause>
          )}
          <PendingDecision
            market={market}
            readAt={readAt}
            operatorId={operatorId}
            onOpen={onOpen}
            headingRef={targets?.pending}
          />
          <PauseHistory market={market} />
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * 거래 일시 중단 on an OPEN market: the button, or the 의미 변경 반려's offer in its place, or — past
 * the close by `readAt` — why there is none.
 */
function PauseStart({
  market,
  readAt,
  operatorId,
  onOpen,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: PauseAction) => void;
}) {
  const unavailable = pauseUnavailable(market, readAt);
  if (unavailable === 'closed') {
    return (
      <Text
        fontSize="sm"
        color="fg.muted"
        data-testid="market-pause-unavailable"
        data-reason={unavailable}
      >
        {copy.adminMarketPauseUnavailableClosed}
      </Text>
    );
  }
  if (unavailable !== null) return null;
  if (pauseOffer(market, readAt) !== null) {
    return (
      <Alert.Root status="warning" role="status" data-testid="market-pause-offer">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.adminMarketPauseOffer}</Alert.Description>
        </Alert.Content>
        <Button
          size="xs"
          ml="auto"
          disabled={operatorId === undefined}
          onClick={() => onOpen('offer')}
          data-testid="market-pause-offer-pause"
        >
          {copy.adminMarketPause}
        </Button>
      </Alert.Root>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      colorPalette="orange"
      alignSelf="flex-start"
      disabled={operatorId === undefined}
      onClick={() => onOpen('pause')}
      data-testid="market-pause-start"
    >
      {copy.adminMarketPause}
    </Button>
  );
}

/** A heading inside the panel; one focus may come back to (`headingRef`) takes it from script. */
function PanelHeading({
  children,
  headingRef,
  testId,
}: {
  children: string;
  headingRef?: RefObject<HTMLParagraphElement | null>;
  testId?: string;
}) {
  return (
    <Text
      ref={headingRef}
      tabIndex={headingRef === undefined ? undefined : -1}
      fontWeight="medium"
      fontSize="sm"
      data-testid={testId}
    >
      {children}
    </Text>
  );
}

/** One labelled value of the panel's small print, its value under `testId`. */
function Line({ label, children, testId }: { label: string; children: string; testId: string }) {
  return (
    <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
      <Text as="span" fontWeight="medium">
        {label}
      </Text>{' '}
      <Text as="span" data-testid={testId}>
        {children}
      </Text>
    </Text>
  );
}

/** Label/value rows in the panel's small print, one line each. */
function Rows({ rows, testId }: { rows: readonly EventRow[]; testId: string }) {
  return (
    <Stack gap="0" fontSize="sm" color="fg.muted" data-testid={testId}>
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
 * The pause lasting now: its reason, the note saying what happened, who paused and when, and for an
 * early result when it was published — then what comes next (`children`).
 */
function CurrentPause({
  pause,
  headingRef,
  children,
}: {
  pause: AdminMarketPause;
  headingRef?: RefObject<HTMLParagraphElement | null>;
  children: ReactNode;
}) {
  return (
    <Stack gap="3" borderWidth="1px" borderRadius="l2" p="3" data-testid="market-pause-current">
      <PanelHeading headingRef={headingRef} testId="market-pause-current-title">
        {copy.adminMarketPauseCurrent}
      </PanelHeading>
      <Stack gap="1">
        <Line label={copy.adminMarketPauseReason} testId="market-pause-current-reason">
          {PAUSE_REASON_LABEL[pause.reason]}
        </Line>
        <Line label={copy.adminMarketPauseNote} testId="market-pause-current-note">
          {pause.note}
        </Line>
        <Line label={copy.adminMarketPausedBy} testId="market-pause-current-by">
          {pauseActorName(pause.pausedBy)}
        </Line>
        <Line label={copy.adminMarketPausedAt} testId="market-pause-current-at">
          {formatKst(pause.pausedAt)}
        </Line>
        {pause.resultPublishedAt !== null && (
          <Line
            label={copy.adminMarketPauseResultPublishedAt}
            testId="market-pause-current-published-at"
          >
            {formatKst(pause.resultPublishedAt)}
          </Line>
        )}
      </Stack>
      {children}
    </Stack>
  );
}

/**
 * 재개·조기 마감 요청 on a PAUSED market while one may be asked, or — past the close by `readAt` —
 * why not. Nothing while one waits: the waiting request below says it.
 */
function DecisionStart({
  market,
  readAt,
  operatorId,
  onOpen,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: PauseAction) => void;
}) {
  const unavailable = pauseDecisionUnavailable(market, readAt);
  if (unavailable === null) {
    return (
      <Button
        size="sm"
        alignSelf="flex-start"
        disabled={operatorId === undefined}
        onClick={() => onOpen('request')}
        data-testid="market-pause-request"
      >
        {copy.adminMarketPauseRequest}
      </Button>
    );
  }
  if (unavailable !== 'closed') return null;
  return (
    <Text
      fontSize="sm"
      color="fg.muted"
      data-testid="market-pause-request-unavailable"
      data-reason={unavailable}
    >
      {copy.adminMarketPauseRequestUnavailableClosed}
    </Text>
  );
}

/**
 * The waiting request (`pause.pending`), in any status, and what may be done with it: the decider
 * reads the path, the review result and the reason before deciding. 승인 is off with the note why
 * while it cannot be approved (`pauseDecisionUnapprovable`).
 */
function PendingDecision({
  market,
  readAt,
  operatorId,
  onOpen,
  headingRef,
}: {
  market: AdminMarket;
  readAt: number;
  operatorId: string | undefined;
  onOpen: (action: PauseAction) => void;
  headingRef?: RefObject<HTMLParagraphElement | null>;
}) {
  const pending = market.pause.pending;
  if (pending === null) return null;
  const requester = isPauseDecisionRequester(pending, operatorId);
  const unapprovable = pauseDecisionUnapprovable(market, pending, readAt);
  const approvable = unapprovable === null;
  return (
    <Stack gap="3" borderWidth="1px" borderRadius="l2" p="3" data-testid="market-pause-pending">
      <PanelHeading headingRef={headingRef} testId="market-pause-pending-title">
        {copy.adminMarketPausePending}
      </PanelHeading>
      <Text fontSize="sm">
        {copy.adminMarketPauseRequestedBy}{' '}
        <Text as="span" fontWeight="medium" data-testid="market-pause-pending-by">
          {pauseActorName(pending.requestedBy)}
        </Text>{' '}
        · {copy.adminMarketPauseRequestedAt}{' '}
        <Text as="span" data-testid="market-pause-pending-at">
          {formatKst(pending.requestedAt)}
        </Text>
      </Text>
      <Stack gap="1">
        <Line label={copy.adminMarketPauseRequestPath} testId="market-pause-pending-path">
          {PAUSE_PATH_LABEL[pending.path]}
        </Line>
        {pending.reviewResult !== null && (
          <Line label={copy.adminMarketPauseRequestReview} testId="market-pause-pending-review">
            {PAUSE_REVIEW_RESULT_LABEL[pending.reviewResult]}
          </Line>
        )}
        <Line label={copy.adminMarketPauseRequestReason} testId="market-pause-pending-reason">
          {pending.reason}
        </Line>
      </Stack>
      {requester === true && (
        <Alert.Root status="warning" role="status" data-testid="market-pause-requester-note">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketPauseExcludedRequester}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {unapprovable !== null && (
        <Alert.Root
          status="warning"
          role="status"
          data-testid={`market-pause-pending-${unapprovable}`}
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{PAUSE_DECISION_UNAPPROVABLE_NOTE[unapprovable]}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <HStack gap="2" flexWrap="wrap" data-testid="market-pause-actions">
        <Button
          size="sm"
          disabled={operatorId === undefined || requester !== false || !approvable}
          onClick={() => onOpen('approve')}
          data-testid="market-pause-approve"
        >
          {copy.adminMarketPauseApprove}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={operatorId === undefined || requester !== false}
          onClick={() => onOpen('reject')}
          data-testid="market-pause-reject"
        >
          {copy.adminMarketPauseReject}
        </Button>
        {requester === true && (
          <Button
            size="sm"
            variant="outline"
            disabled={operatorId === undefined}
            onClick={() => onOpen('retract')}
            data-testid="market-pause-retract"
          >
            {copy.adminMarketPauseRetract}
          </Button>
        )}
      </HStack>
    </Stack>
  );
}

/**
 * 일시 중단 기록 (`pause.history`, newest first): each pause with how it ended in its badge (or 진행
 * 중), its rows (`pauseRows`), then its requests from `pause.log`, newest first, each with its
 * status, who asked and when and its rows (`pauseDecisionLogRows`).
 * `market-pause-history-<n>` counts from the newest and carries how it ended in `data-end`;
 * `market-pause-history-<n>-log-<m>` its requests, with the status in `data-status`.
 */
function PauseHistory({ market }: { market: AdminMarket }) {
  const { history, log } = market.pause;
  return (
    <Stack gap="2" data-testid="market-pause-history">
      <PanelHeading>{copy.adminMarketPauseHistory}</PanelHeading>
      {history.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-pause-history-empty">
          {copy.adminMarketPauseHistoryEmpty}
        </Text>
      ) : (
        <Stack gap="4">
          {history.map((pause, index) => {
            const at = `market-pause-history-${String(index)}`;
            const requests = log.filter((entry) => entry.pauseId === pause.id);
            return (
              <Stack key={pause.id} gap="2" data-testid={at} data-end={pause.endKind ?? 'ongoing'}>
                <HStack gap="2" flexWrap="wrap">
                  <Badge variant="subtle" data-testid={`${at}-end`}>
                    {pauseEndLabel(pause)}
                  </Badge>
                  <Text fontSize="sm" fontWeight="medium">
                    {PAUSE_REASON_LABEL[pause.reason]}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    {formatKst(pause.pausedAt)}
                  </Text>
                </HStack>
                <Rows rows={pauseRows(pause, formatKst)} testId={`${at}-rows`} />
                {requests.map((entry, position) => {
                  const entryAt = `${at}-log-${String(position)}`;
                  return (
                    <Stack
                      key={entry.requestId}
                      gap="0.5"
                      ps="3"
                      borderStartWidth="2px"
                      data-testid={entryAt}
                      data-status={entry.status}
                    >
                      <HStack gap="2" flexWrap="wrap">
                        <Badge variant="outline" data-testid={`${entryAt}-status`}>
                          {PAUSE_DECISION_STATUS_LABEL[entry.status]}
                        </Badge>
                        <Text fontSize="sm" fontWeight="medium" data-testid={`${entryAt}-by`}>
                          {pauseActorName(entry.requestedBy)}
                        </Text>
                        <Text fontSize="xs" color="fg.muted">
                          {formatKst(entry.requestedAt)}
                        </Text>
                      </HStack>
                      <Rows
                        rows={pauseDecisionLogRows(entry, formatKst)}
                        testId={`${entryAt}-rows`}
                      />
                    </Stack>
                  );
                })}
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
