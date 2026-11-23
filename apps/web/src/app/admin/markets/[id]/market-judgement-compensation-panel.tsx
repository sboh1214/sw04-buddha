'use client';

import { Alert, Badge, Button, Card, HStack, Heading, Stack, Text } from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { type AdminMarket } from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import {
  COMPENSATION_STATUS_LABEL,
  type CompensationDecision,
  type CompensationState,
  compensationReviewUnavailable,
  compensationSummaryText,
  compensationUnrequestable,
  compensationUnrequestableNote,
  countText,
  showsJudgementCompensationPanel,
} from '@/lib/market-judgement-compensation';
import { JudgementCompensationDialog } from './market-judgement-compensation-dialogs';
import { JudgementCompensationRecipients } from './market-judgement-compensation-recipients';

/** What the panel opened: the request's dialog, or a decision's on the waiting request. */
export type CompensationAction = 'request' | CompensationDecision;

/** A Coin decimal string as the panel words it ('1,250 Coin'). */
const coinText = (amount: string) => formatCoin(parseCoinAmount(amount));

/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-1·144-2·144-4·144-7·144-12·144-16·144-19;
 * ADR-0120 decision 5) on the admin detail, under the 판정 오류 사건 it compensates, once one is
 * confirmed (`showsJudgementCompensationPanel`): what it asks of the admin on screen
 * (`MarketJudgementCompensationBody`) and the dialog it opened — 보상 요청, or the waiting request's
 * 보상 승인, 보상 반려 or 철회 — held for that admin (`useHeldForOperator`, ADR-0092 answer 1): once
 * `['me']` turns from A to B in place, the dialog closes with what A typed. Focus comes back to the
 * heading once a write went through and took its button away (WCAG 2.4.3).
 */
export function MarketJudgementCompensationPanel({ market }: { market: AdminMarket }) {
  const operatorId = useOperatorId();
  const [action, setAction] = useHeldForOperator<CompensationAction>();
  const heading = useRef<HTMLHeadingElement>(null);
  const closed = useRef<{ market: AdminMarket } | null>(null);
  useEffect(() => {
    const from = closed.current;
    // Wait for the market the write answered: the button goes with it.
    if (from === null || action !== null || from.market === market) return;
    closed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    heading.current?.focus();
  }, [action, market]);
  if (!showsJudgementCompensationPanel(market)) return null;
  return (
    <>
      <MarketJudgementCompensationBody
        market={market}
        operatorId={operatorId}
        onOpen={setAction}
        headingRef={heading}
      />
      {action !== null && (
        <JudgementCompensationDialog
          kind={action}
          market={market}
          onClose={(sent) => {
            if (sent) closed.current = { market };
            setAction(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The panel as drawn for `operatorId` (undefined until `GET /me` answers), the market's confirmed
 * incident's compensation:
 * - the held line while the market is ledger-held (#93: nothing is asked or approved then);
 * - what a request would list now (`preview`: the count, the total, how many are closed and how
 *   many need a ledger check) until one is paid;
 * - 보상 요청, off with the note why while none is taken (a hold, one waiting, none owed), gone
 *   once one is paid (144-2);
 * - the waiting request: its count and total, the members' reason (144-12), the internal reason,
 *   who asked and when. Its requester sees no 보상 승인 or 보상 반려 — another admin decides it
 *   (#171) — and alone may retract it. For anyone else both are drawn: 보상 승인 off with the note
 *   why for the paid version's registrant (144-4), on a held market, and while an account needs a
 *   ledger check (144-16, the whole approval); 보상 반려 always on (a 정리 목적의 반려);
 * - the payout: who approved it and when, how many accounts were paid how much, how many closed;
 * - 대상 계정 보기: the per-account list (`JudgementCompensationRecipients`);
 * - the log of every request, the newest first, and how each ended.
 */
export function MarketJudgementCompensationBody({
  market,
  operatorId,
  onOpen,
  headingRef,
}: {
  market: AdminMarket;
  operatorId: string | undefined;
  onOpen: (action: CompensationAction) => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const compensation = market.judgementIncident.compensation;
  const [listed, setListed] = useState(false);
  if (compensation === null) return null;
  const unrequestable = compensationUnrequestable(compensation);
  const note = unrequestable === null ? null : compensationUnrequestableNote(unrequestable);
  return (
    <Card.Root
      data-testid="market-judgement-compensation"
      data-held={compensation.held}
      data-unrequestable={unrequestable ?? undefined}
    >
      <Card.Header>
        <Heading
          ref={headingRef}
          tabIndex={headingRef === undefined ? undefined : -1}
          size="md"
          data-testid="market-judgement-compensation-title"
        >
          {copy.adminMarketJudgementCompensation}
        </Heading>
      </Card.Header>
      <Card.Body>
        <Stack gap="4">
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketJudgementCompensationIntro}
          </Text>
          {compensation.held && (
            <Note testId="market-judgement-compensation-held">
              {copy.adminMarketJudgementCompensationHeld}
            </Note>
          )}
          <Preview compensation={compensation} />
          {compensation.paid === null && (
            <Stack gap="2" align="flex-start">
              <Button
                size="sm"
                disabled={operatorId === undefined || unrequestable !== null}
                onClick={() => onOpen('request')}
                data-testid="market-judgement-compensation-request"
              >
                {copy.adminMarketJudgementCompensationRequest}
              </Button>
              {note !== null && (
                <Text
                  fontSize="sm"
                  color="fg.muted"
                  data-testid="market-judgement-compensation-unrequestable"
                  data-reason={unrequestable ?? undefined}
                >
                  {note}
                </Text>
              )}
            </Stack>
          )}
          {compensation.pending !== null && (
            <PendingRequest market={market} operatorId={operatorId} onOpen={onOpen} />
          )}
          <PaidCompensation compensation={compensation} />
          <Stack gap="2" align="flex-start">
            <Button
              size="sm"
              variant="outline"
              aria-expanded={listed}
              onClick={() => setListed((shown) => !shown)}
              data-testid="market-judgement-compensation-recipients-toggle"
            >
              {listed
                ? copy.adminMarketJudgementCompensationRecipientsHide
                : copy.adminMarketJudgementCompensationRecipientsShow}
            </Button>
            {listed && <JudgementCompensationRecipients marketId={market.id} />}
          </Stack>
          <CompensationLog compensation={compensation} />
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** One labelled value of the panel's small print, its value under `testId`. */
function Line({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <Text as="div" fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
      <Text as="span" fontWeight="medium">
        {label}
      </Text>{' '}
      <Text as="span" data-testid={testId}>
        {children}
      </Text>
    </Text>
  );
}

/** A warning note of the panel's, under `testId`. */
function Note({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <Alert.Root status="warning" role="status" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/**
 * 지금 계산한 보상: '대상 계정 {n}개 · 총 {coin}', then '탈퇴 {k}개' (recorded '탈퇴로 지급 못 함' at
 * the approval, 144-7) and '원장 확인 필요 {b}개' (144-16) when there are any.
 */
function Preview({ compensation }: { compensation: CompensationState }) {
  const preview = compensation.preview;
  if (preview === null || preview.accountCount === 0) return null;
  const parts = [
    compensationSummaryText(preview.accountCount, coinText(preview.totalCoin)),
    ...(preview.closedCount > 0
      ? [countText(copy.adminMarketJudgementCompensationClosedCount, preview.closedCount)]
      : []),
    ...(preview.blockedCount > 0
      ? [countText(copy.adminMarketJudgementCompensationBlockedCount, preview.blockedCount)]
      : []),
  ];
  return (
    <Line
      label={copy.adminMarketJudgementCompensationPreview}
      testId="market-judgement-compensation-preview"
    >
      {parts.join(' · ')}
    </Line>
  );
}

function PendingRequest({
  market,
  operatorId,
  onOpen,
}: {
  market: AdminMarket;
  operatorId: string | undefined;
  onOpen: (action: CompensationAction) => void;
}) {
  const compensation = market.judgementIncident.compensation;
  const pending = compensation?.pending ?? null;
  if (pending === null) return null;
  const approve = compensationReviewUnavailable(market, 'approve', operatorId);
  const reject = compensationReviewUnavailable(market, 'reject', operatorId);
  const own = approve === 'own';
  const blockedCount = compensation?.preview?.blockedCount ?? 0;
  const at = 'market-judgement-compensation-pending';
  return (
    <Stack
      gap="3"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={at}
      data-request={pending.requestId}
    >
      <Text fontWeight="medium" fontSize="sm">
        {copy.adminMarketJudgementCompensationPending}
      </Text>
      <Stack gap="1">
        <Text fontSize="sm" data-testid={`${at}-summary`}>
          {compensationSummaryText(pending.accountCount, coinText(pending.totalCoin))}
        </Text>
        <Line label={copy.adminMarketJudgementCompensationUserReason} testId={`${at}-user-reason`}>
          {pending.userReason}
        </Line>
        <Line label={copy.adminMarketJudgementCompensationReason} testId={`${at}-reason`}>
          {pending.reason}
        </Line>
        <Line label={copy.adminMarketJudgementCompensationRequestedBy} testId={`${at}-by`}>
          {nicknameShown(pending.requestedBy.nickname)} · {formatKst(pending.requestedAt)}
        </Line>
      </Stack>
      {own && (
        <Note testId="market-judgement-compensation-own-note">
          {copy.adminMarketJudgementCompensationOwnNote}
        </Note>
      )}
      {approve === 'registrant' && (
        <Note testId="market-judgement-compensation-registrant-note">
          {copy.adminMarketJudgementCompensationRegistrantNote}
        </Note>
      )}
      {approve === 'blocked' && (
        <Note testId="market-judgement-compensation-blocked-note">
          {countText(copy.adminMarketJudgementCompensationBlockedNote, blockedCount)}
        </Note>
      )}
      <HStack gap="2" flexWrap="wrap">
        {own ? (
          <Button
            size="sm"
            variant="outline"
            disabled={operatorId === undefined}
            onClick={() => onOpen('retract')}
            data-testid="market-judgement-compensation-retract"
          >
            {copy.adminMarketJudgementCompensationRetract}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={operatorId === undefined || approve !== null}
              onClick={() => onOpen('approve')}
              data-testid="market-judgement-compensation-approve"
              data-unavailable={approve ?? undefined}
            >
              {copy.adminMarketJudgementCompensationApprove}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={operatorId === undefined || reject !== null}
              onClick={() => onOpen('reject')}
              data-testid="market-judgement-compensation-reject"
            >
              {copy.adminMarketJudgementCompensationReject}
            </Button>
          </>
        )}
      </HStack>
    </Stack>
  );
}

/** The approved request and its payout (at most one, 144-2). */
function PaidCompensation({ compensation }: { compensation: CompensationState }) {
  const paid = compensation.paid;
  if (paid === null) return null;
  const at = 'market-judgement-compensation-paid';
  return (
    <Stack
      gap="1"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={at}
      data-request={paid.requestId}
    >
      <Text fontWeight="medium" fontSize="sm">
        {copy.adminMarketJudgementCompensationPaid}
      </Text>
      <Text fontSize="sm" data-testid={`${at}-summary`}>
        {[
          countText(copy.adminMarketJudgementCompensationPaidSummary, paid.accountCount)
            .replace('{m}', paid.paidCount.toLocaleString('ko-KR'))
            .replace('{coin}', coinText(paid.paidCoin)),
          ...(paid.closedCount > 0
            ? [countText(copy.adminMarketJudgementCompensationClosedUnpaid, paid.closedCount)]
            : []),
        ].join(' · ')}
      </Text>
      <Line label={copy.adminMarketJudgementCompensationUserReason} testId={`${at}-user-reason`}>
        {paid.userReason}
      </Line>
      <Line label={copy.adminMarketJudgementCompensationRequestedBy} testId={`${at}-requested-by`}>
        {nicknameShown(paid.requestedBy.nickname)} · {formatKst(paid.requestedAt)}
      </Line>
      <Line label={copy.adminMarketJudgementCompensationApprovedBy} testId={`${at}-approved-by`}>
        {nicknameShown(paid.approvedBy.nickname)} · {formatKst(paid.approvedAt)}
      </Line>
    </Stack>
  );
}

/**
 * 보상 요청 기록 (`compensation.log`, newest first, the waiting one included): each its status, who
 * asked and when, its count and total, and — once decided — who decided it, when and why, or when
 * it was retracted. `market-judgement-compensation-log-<n>` counts from the newest and carries the
 * status in `data-status`.
 */
function CompensationLog({ compensation }: { compensation: CompensationState }) {
  const { log } = compensation;
  return (
    <Stack gap="2" data-testid="market-judgement-compensation-log">
      <Text fontWeight="medium" fontSize="sm">
        {copy.adminMarketJudgementCompensationLog}
      </Text>
      {log.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-judgement-compensation-log-empty">
          {copy.adminMarketJudgementCompensationLogEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {log.map((entry, index) => {
            const at = `market-judgement-compensation-log-${String(index)}`;
            return (
              <Stack key={entry.requestId} gap="0.5" data-testid={at} data-status={entry.status}>
                <HStack gap="2" flexWrap="wrap">
                  <Badge variant="subtle" data-testid={`${at}-status`}>
                    {COMPENSATION_STATUS_LABEL[entry.status]}
                  </Badge>
                  <Text fontSize="sm" fontWeight="medium" data-testid={`${at}-by`}>
                    {nicknameShown(entry.requestedBy.nickname)}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    {formatKst(entry.requestedAt)}
                  </Text>
                </HStack>
                <Stack gap="0" fontSize="sm" color="fg.muted">
                  <Text>
                    {compensationSummaryText(entry.accountCount, coinText(entry.totalCoin))}
                  </Text>
                  {entry.decidedBy !== null && entry.decidedAt !== null && (
                    <Text data-testid={`${at}-decided`}>
                      {copy.adminMarketJudgementCompensationDecidedBy}{' '}
                      {nicknameShown(entry.decidedBy.nickname)} · {formatKst(entry.decidedAt)}
                    </Text>
                  )}
                  {entry.decisionReason !== null && (
                    <Text whiteSpace="pre-wrap" wordBreak="break-word" data-testid={`${at}-reason`}>
                      {copy.adminMarketJudgementCompensationDecisionReason} {entry.decisionReason}
                    </Text>
                  )}
                  {entry.retractedAt !== null && (
                    <Text data-testid={`${at}-retracted`}>
                      {copy.adminMarketJudgementCompensationRetractedAt}{' '}
                      {formatKst(entry.retractedAt)}
                    </Text>
                  )}
                </Stack>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
