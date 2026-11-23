import {
  Alert,
  Badge,
  Box,
  Card,
  DataList,
  Heading,
  HStack,
  Link as ChakraLink,
  Stack,
  Text,
} from '@chakra-ui/react';
import { JUDGEMENT_INCIDENT_STATUSES, type MarketStatus } from '@buddha/shared';
import { type ReactNode } from 'react';
import { DateTimeText } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { fillBusinessInfo } from '@/legal/business-info';
import { type Market } from '@/lib/api';
import { publicCompensationText } from '@/lib/judgement-correction';
import { JUDGING_RECORD_ANCHOR, ORDER_COLUMN_TOP } from '@/lib/market-detail';
import {
  MARKET_RESULT_LABEL,
  PAUSE_REASON_LABEL,
  PAUSE_REVIEW_RESULT_LABEL,
} from '@/lib/market-admin';
import { marketStatusLabel } from '@/lib/market-status';
import { RuleRow } from './rules-section';

export type JudgingRecordMarket = Pick<
  Market,
  | 'status'
  | 'judgementDelayed'
  | 'disputeUnderReview'
  | 'resolvedResult'
  | 'resolvedAt'
  | 'settledAt'
  | 'judgementTimeZone'
  | 'judgingRecord'
  | 'judgingRecordStale'
>;
type Judgement = Market['judgingRecord']['versions'][number];
type Pause = Market['judgingRecord']['pauses'][number];
type Correction = NonNullable<Market['judgingRecord']['correction']>;

/**
 * Whether the record carries 144-9's line — 결과 확정 뒤의 판정 오류는 고객센터 이메일로 — on a
 * market whose result is confirmed (RESOLVED, SETTLING or SETTLED: where an operator registers a
 * 판정 오류 사건, 144-8). The line is the only way a member reports one: no form in the app.
 */
export function showsPostPayoutReport(status: MarketStatus): boolean {
  return (JUDGEMENT_INCIDENT_STATUSES as readonly MarketStatus[]).includes(status);
}

/** 144-9's line with the customer centre's address (business info, ADR-0069 결과 3). */
export function postPayoutReportText(): string {
  return fillBusinessInfo(copy.judgingPostPayoutReport);
}

/**
 * Public allowlisted facts only. Both responsive copies read the same live market snapshot.
 *
 * Each copy carries `data-anchor` (`JUDGING_RECORD_ANCHOR`): the place `…#judging-record` opens,
 * which 거래·정산 이력's 정산 줄 links to (#124, ADR-0143). The detail scrolls to the copy its
 * width draws; the margin (the order column's own top) keeps the heading clear of the sticky
 * header.
 */
export function MarketJudgingRecord({
  market,
  testId,
}: {
  market: JudgingRecordMarket | undefined;
  testId: string;
}) {
  const record = market?.judgingRecord;
  const zone = market?.judgementTimeZone ?? null;
  return (
    <Card.Root
      data-testid={testId}
      data-anchor={JUDGING_RECORD_ANCHOR}
      scrollMarginTop={ORDER_COLUMN_TOP}
    >
      <Card.Header>
        <Stack gap="2">
          <Heading as="h2" size="md">
            {copy.marketJudgingRecord}
          </Heading>
          <Text fontSize="sm" data-testid={`${testId}-principle`}>
            {copy.judgingPrinciple}
          </Text>
          {market && (
            <Text fontSize="sm" data-testid={`${testId}-status`}>
              {copy.judgingCurrentStatus}:{' '}
              <Badge variant="subtle">{marketStatusLabel(market)}</Badge>
            </Text>
          )}
          {market && showsPostPayoutReport(market.status) && (
            <Text fontSize="sm" color="fg.muted" data-testid={`${testId}-report`}>
              {postPayoutReportText()}
            </Text>
          )}
        </Stack>
      </Card.Header>
      <Card.Body>
        {market?.judgingRecordStale ? (
          <Text color="fg.muted" data-testid={`${testId}-stale`}>
            {copy.judgingRecordStale}
          </Text>
        ) : (
          <Stack gap="6">
            {record?.payoutDelayed && (
              <Alert.Root status="warning" data-testid={`${testId}-payout-delay`}>
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>{copy.judgingPayoutDelayed}</Alert.Title>
                  <Alert.Description>{copy.judgingPayoutDelayedHint}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
            {market && (market.resolvedAt !== null || market.settledAt !== null) && (
              <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
                {market.resolvedAt !== null && (
                  <TimeRow
                    label={copy.judgingResolvedAt}
                    iso={market.resolvedAt}
                    zone={zone}
                    id={`${testId}-resolved-at`}
                  />
                )}
                {market.settledAt !== null && (
                  <TimeRow
                    label={copy.judgingSettledAt}
                    iso={market.settledAt}
                    zone={zone}
                    id={`${testId}-settled-at`}
                  />
                )}
              </DataList.Root>
            )}
            {record?.cancellation && (
              <Stack gap="2" data-testid={`${testId}-cancellation`}>
                <Heading as="h3" size="sm">
                  {copy.judgingCancelled}
                </Heading>
                <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                  {record.cancellation.reason}
                </Text>
                <Text fontSize="sm">
                  {copy.judgingCancelledAt}:{' '}
                  <DateTimeText
                    iso={record.cancellation.cancelledAt}
                    judgementTimeZone={zone}
                    testId={`${testId}-cancelled-at`}
                  />
                </Text>
              </Stack>
            )}
            {record?.correction && (
              <CorrectionEntry value={record.correction} zone={zone} id={`${testId}-correction`} />
            )}
            {!record || record.versions.length === 0 ? (
              <Stack gap="2" data-testid={`${testId}-empty`}>
                {market?.resolvedResult != null && (
                  <Text>
                    {copy.judgingResult}: {MARKET_RESULT_LABEL[market.resolvedResult]}
                  </Text>
                )}
                <Text color="fg.muted">
                  {market?.status === 'cancelled'
                    ? copy.judgingCancelledNoJudgement
                    : market?.resolvedResult != null
                      ? copy.judgingLegacyNoGrounds
                      : copy.judgingNoVersion}
                </Text>
              </Stack>
            ) : (
              record.versions.map((version, index) =>
                index === 0 ? (
                  <JudgementEntry
                    key={version.version}
                    value={version}
                    zone={zone}
                    id={`${testId}-version-${String(version.version)}`}
                    current
                  />
                ) : (
                  <Box
                    as="details"
                    key={version.version}
                    borderTopWidth="1px"
                    pt="3"
                    data-testid={`${testId}-previous-${String(version.version)}`}
                  >
                    <Box as="summary" cursor="pointer" fontWeight="medium">
                      {copy.judgingPastVersion} v{version.version} ·{' '}
                      {MARKET_RESULT_LABEL[version.result]}
                    </Box>
                    <Box pt="3">
                      <JudgementEntry
                        value={version}
                        zone={zone}
                        id={`${testId}-version-${String(version.version)}`}
                      />
                    </Box>
                  </Box>
                ),
              )
            )}
            {record && (
              <Stack gap="3" data-testid={`${testId}-disputes`}>
                <Heading as="h3" size="sm">
                  {copy.judgingDisputes}
                </Heading>
                <Text fontSize="sm">
                  {record.disputes.total === 0
                    ? copy.judgingDisputeEmpty
                    : `${copy.judgingDisputeCount}: ${record.disputes.total.toLocaleString('ko-KR')}`}
                </Text>
                {record.disputes.byVersion.map((item) => (
                  <Stack key={item.judgementVersion} gap="1">
                    <Text fontWeight="medium" fontSize="sm">
                      v{item.judgementVersion} · {copy.judgingDisputeCount}{' '}
                      {item.total.toLocaleString('ko-KR')}
                    </Text>
                    <HStack gap="2" flexWrap="wrap">
                      {Object.entries(DISPUTE_LABELS).map(([status, label]) => (
                        <Badge key={status} variant="outline">
                          {label}{' '}
                          {item.counts[status as keyof typeof DISPUTE_LABELS].toLocaleString(
                            'ko-KR',
                          )}
                        </Badge>
                      ))}
                    </HStack>
                  </Stack>
                ))}
                {record.disputes.decisions.length > 0 && (
                  <Stack gap="2">
                    <Text fontSize="sm" fontWeight="medium">
                      {copy.judgingDecisionReasons}
                    </Text>
                    {record.disputes.decisions.map((decision, index) => (
                      <Stack key={index} gap="1" borderStartWidth="2px" ps="3">
                        <Text fontSize="sm">
                          v{decision.judgementVersion} · {DISPUTE_LABELS[decision.decision]} ·{' '}
                          {copy.judgingOperator}
                        </Text>
                        <Text fontSize="sm" whiteSpace="pre-wrap" overflowWrap="anywhere">
                          {decision.reason}
                        </Text>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Stack>
            )}
            {record && record.pauses.length > 0 && (
              <Stack gap="4" data-testid={`${testId}-pauses`}>
                <Heading as="h3" size="sm">
                  {copy.judgingPauseHistory}
                </Heading>
                {record.pauses.map((pause, index) => (
                  <PauseEntry
                    key={index}
                    value={pause}
                    zone={zone}
                    id={`${testId}-pause-${String(index)}`}
                  />
                ))}
              </Stack>
            )}
            {record && record.delays.length > 0 && (
              <Stack gap="4" data-testid={`${testId}-delays`}>
                <Heading as="h3" size="sm">
                  {copy.judgingDelayHistory}
                </Heading>
                {record.delays.map((delay, index) => (
                  <Stack key={index} gap="2" borderStartWidth="2px" ps="3">
                    <Text fontSize="sm" fontWeight="medium">
                      {delay.current ? copy.judgingCurrentDelay : copy.judgingPreviousDelay}
                    </Text>
                    <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                      {delay.reason}
                    </Text>
                    <Text fontSize="sm">
                      {copy.judgingNextReviewAt}:{' '}
                      <DateTimeText
                        iso={delay.nextReviewAt}
                        judgementTimeZone={zone}
                        testId={`${testId}-delay-${String(index)}-next`}
                      />
                    </Text>
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

const DISPUTE_LABELS = {
  pending: copy.judgingDisputePending,
  dismissed: copy.judgingDisputeDismissed,
  accepted: copy.judgingDisputeAccepted,
  retracted: copy.judgingDisputeRetracted,
  closed_by_correction: copy.judgingDisputeCorrected,
} as const;

function TimeRow({
  label,
  iso,
  zone,
  id,
}: {
  label: string;
  iso: string;
  zone: string | null;
  id: string;
}) {
  return (
    <RuleRow label={label} testId={id}>
      <DateTimeText iso={iso} judgementTimeZone={zone} testId={id} />
    </RuleRow>
  );
}
function TextRow({ label, children, id }: { label: string; children: ReactNode; id: string }) {
  return (
    <RuleRow label={label} testId={id}>
      <Box whiteSpace="pre-wrap" overflowWrap="anywhere">
        {children}
      </Box>
    </RuleRow>
  );
}

function JudgementEntry({
  value,
  zone,
  id,
  current = false,
}: {
  value: Judgement;
  zone: string | null;
  id: string;
  current?: boolean;
}) {
  return (
    <Stack gap="3" data-testid={id}>
      <HStack gap="2" flexWrap="wrap">
        <Heading as="h3" size="sm">
          {current ? copy.judgingCurrentVersion : copy.judgingPastVersion} v{value.version}
        </Heading>
        <Badge
          variant="subtle"
          colorPalette={value.result === 'YES' ? 'yes' : value.result === 'NO' ? 'no' : 'gray'}
        >
          {MARKET_RESULT_LABEL[value.result]}
        </Badge>
        <Text fontSize="sm" color="fg.muted">
          {copy.judgingOperator}
        </Text>
      </HStack>
      <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
        <TextRow label={copy.judgingResult} id={`${id}-result`}>
          {MARKET_RESULT_LABEL[value.result]}
        </TextRow>
        <TextRow label={copy.judgingSource} id={`${id}-source`}>
          {value.source ? (
            <Stack gap="1">
              <Text fontSize="sm">
                {value.source.priority === 0
                  ? copy.judgingPrimarySource
                  : `${copy.judgingFallbackSource} ${String(value.source.priority)}`}
              </Text>
              <ChakraLink
                href={value.source.url}
                target="_blank"
                rel="noopener noreferrer"
                overflowWrap="anywhere"
              >
                {value.source.name || value.source.url}
              </ChakraLink>
            </Stack>
          ) : (
            copy.judgingNoSource
          )}
        </TextRow>
        {value.fallbackReason !== null && (
          <TextRow label={copy.judgingFallbackReason} id={`${id}-fallback`}>
            {value.fallbackReason}
          </TextRow>
        )}
        {value.voidReason !== null && (
          <TextRow label={copy.judgingVoidReason} id={`${id}-void`}>
            {value.voidReason}
          </TextRow>
        )}
        {value.correctionReason !== null && (
          <TextRow label={copy.judgingCorrectionReason} id={`${id}-correction`}>
            {value.correctionReason}
          </TextRow>
        )}
        <TextRow label={copy.judgingEvidence} id={`${id}-evidence`}>
          <Stack gap="1">
            {value.evidence.links.map((url) => (
              <ChakraLink
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                overflowWrap="anywhere"
              >
                {url}
              </ChakraLink>
            ))}
          </Stack>
        </TextRow>
        <TimeRow
          label={copy.judgingCollectedAt}
          iso={value.evidence.collectedAt}
          zone={zone}
          id={`${id}-collected-at`}
        />
        <TextRow label={copy.judgingDescription} id={`${id}-description`}>
          {value.description}
        </TextRow>
        <TextRow label={copy.judgingRuleVersion} id={`${id}-rule-version`}>
          {value.ruleVersion === null ? copy.judgingNoRuleVersion : `v${String(value.ruleVersion)}`}
        </TextRow>
        <TimeRow
          label={copy.judgingPublishedAt}
          iso={value.publishedAt}
          zone={zone}
          id={`${id}-published-at`}
        />
        <TimeRow
          label={copy.judgingDisputeDeadline}
          iso={value.disputeDeadline}
          zone={zone}
          id={`${id}-dispute-deadline`}
        />
      </DataList.Root>
    </Stack>
  );
}

/**
 * 판정 정정 (#144, ADR-0165; 144-5, #173 item 13): the market's confirmed 판정 오류 사건 above the
 * versions — it now answers what the result is — the corrected result, the original one with the
 * paid version, 144-5's fact that the payout followed the original and nothing paid is taken back,
 * what went wrong with its evidence and collection instant, and when the error was confirmed. The
 * paid version keeps its name '현재 판정' below (144-19 (나)). No operator, no reviewer's reason.
 * Its 보상 (#144 part 2, ADR-0166; 144-6, 144-15): the status, the 대상 count and the Coin paid in
 * all (`publicCompensationText`) — no account, nickname or one account's amount.
 */
function CorrectionEntry({
  value,
  zone,
  id,
}: {
  value: Correction;
  zone: string | null;
  id: string;
}) {
  return (
    <Stack gap="3" data-testid={id}>
      <HStack gap="2" flexWrap="wrap">
        <Heading as="h3" size="sm">
          {copy.judgingCorrection}
        </Heading>
        <Badge
          variant="subtle"
          colorPalette={value.result === 'YES' ? 'yes' : value.result === 'NO' ? 'no' : 'gray'}
        >
          {MARKET_RESULT_LABEL[value.result]}
        </Badge>
      </HStack>
      <Text fontSize="sm" data-testid={`${id}-no-clawback`}>
        {copy.judgingCorrectionNoClawback}
      </Text>
      <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
        <TextRow label={copy.judgingCorrectedResult} id={`${id}-result`}>
          {MARKET_RESULT_LABEL[value.result]}
        </TextRow>
        <TextRow label={copy.judgingOriginalResult} id={`${id}-original`}>
          {`${MARKET_RESULT_LABEL[value.originalResult]} (v${String(value.judgementVersion)})`}
        </TextRow>
        <TextRow label={copy.judgingCorrectionDescription} id={`${id}-description`}>
          {value.description}
        </TextRow>
        <TextRow label={copy.judgingEvidence} id={`${id}-evidence`}>
          <Stack gap="1">
            {value.evidence.links.map((url) => (
              <ChakraLink
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                overflowWrap="anywhere"
              >
                {url}
              </ChakraLink>
            ))}
          </Stack>
        </TextRow>
        <TimeRow
          label={copy.judgingCollectedAt}
          iso={value.evidence.collectedAt}
          zone={zone}
          id={`${id}-collected-at`}
        />
        <TimeRow
          label={copy.judgingCorrectionConfirmedAt}
          iso={value.confirmedAt}
          zone={zone}
          id={`${id}-confirmed-at`}
        />
        <TextRow label={copy.judgingCompensation} id={`${id}-compensation`}>
          <Box as="span" data-status={value.compensation.status}>
            {publicCompensationText(value.compensation)}
          </Box>
        </TextRow>
      </DataList.Root>
    </Stack>
  );
}

function PauseEntry({ value, zone, id }: { value: Pause; zone: string | null; id: string }) {
  const endedLabel =
    value.endKind === 'resumed'
      ? copy.judgingResumedAt
      : value.endKind === 'early_closed'
        ? copy.judgingEarlyClosedAt
        : copy.judgingClosedAt;
  return (
    <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm" data-testid={id}>
      <TextRow label={copy.judgingPauseReason} id={`${id}-reason`}>
        {PAUSE_REASON_LABEL[value.reason]}
      </TextRow>
      {value.note !== null && (
        <TextRow label={copy.judgingPauseNote} id={`${id}-note`}>
          {value.note}
        </TextRow>
      )}
      <TimeRow label={copy.judgingPausedAt} iso={value.pausedAt} zone={zone} id={`${id}-started`} />
      {value.resultPublishedAt !== null && (
        <TimeRow
          label={copy.judgingResultPublishedAt}
          iso={value.resultPublishedAt}
          zone={zone}
          id={`${id}-result-published`}
        />
      )}
      {value.reviewResult !== null && (
        <TextRow label={copy.judgingPauseReview} id={`${id}-review`}>
          {PAUSE_REVIEW_RESULT_LABEL[value.reviewResult]}
        </TextRow>
      )}
      {value.endedAt !== null ? (
        <TimeRow label={endedLabel} iso={value.endedAt} zone={zone} id={`${id}-ended`} />
      ) : (
        <Text fontSize="sm">{copy.judgingStillPaused}</Text>
      )}
    </DataList.Root>
  );
}
