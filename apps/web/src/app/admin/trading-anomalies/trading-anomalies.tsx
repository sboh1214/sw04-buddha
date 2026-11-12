'use client';

import { RELEASE_SETTING_STATUS_LABELS, uuidSchema } from '@buddha/shared';
import {
  Alert,
  Badge,
  Button,
  Field,
  Heading,
  HStack,
  Input,
  Link,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { copy } from '@/copy';
import { useTradingAnomalies } from '@/hooks/use-trading-anomalies';
import type { TradingAnomalyCandidate, TradingAnomalyReport } from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import { adminUserModerationPath } from '@/lib/moderation';

const kindLabel = (kind: TradingAnomalyCandidate['kind']) =>
  kind === 'human_pair' ? copy.anomalyPair : copy.anomalyRoundTrip;
const count = (value: string) => BigInt(value).toLocaleString('ko-KR');

function Leg({
  leg,
  candidate,
}: {
  leg: TradingAnomalyCandidate['evidence'][number]['first'];
  candidate: TradingAnomalyCandidate;
}) {
  const actor = candidate.actors.find((row) => row.userId === leg.userId);
  return (
    <Stack gap="1" fontSize="sm" overflowWrap="anywhere">
      {actor && (
        <Link asChild>
          <NextLink href={adminUserModerationPath(actor.userId) as Route}>
            {nicknameShown(actor.nickname)}
          </NextLink>
        </Link>
      )}
      <Text>
        {formatKst(leg.at)} · {leg.outcome} · {leg.side === 'buy' ? copy.buy : copy.sell}
      </Text>
      <Text>
        {copy.anomalyPrice}: {leg.priceCoin} · {copy.anomalyQuantity}: {count(leg.qty)}
      </Text>
      <Text>
        {copy.anomalyFillId}: {leg.fillId}
      </Text>
      <Text>
        {copy.anomalyOrderId}: {leg.orderId}
      </Text>
    </Stack>
  );
}

export function AnomalyCard({ candidate }: { candidate: TradingAnomalyCandidate }) {
  return (
    <Stack
      gap="3"
      p="4"
      borderWidth="1px"
      borderRadius="l2"
      minW="0"
      data-testid="anomaly-candidate"
    >
      <Badge alignSelf="start">{kindLabel(candidate.kind)}</Badge>
      <Link asChild fontWeight="medium" overflowWrap="anywhere">
        <NextLink href={`/admin/markets/${candidate.market.id}`}>{candidate.market.title}</NextLink>
      </Link>
      <HStack flexWrap="wrap">
        {candidate.actors.map((actor) => (
          <Link asChild key={actor.userId}>
            <NextLink href={adminUserModerationPath(actor.userId) as Route}>
              {nicknameShown(actor.nickname)}
            </NextLink>
          </Link>
        ))}
        {candidate.outcome && <Badge>{candidate.outcome}</Badge>}
      </HStack>
      <Text>
        {copy.anomalyCandidateCount}: {count(candidate.count)} · {copy.anomalyMatchedQuantity}:{' '}
        {count(candidate.quantity)}
      </Text>
      <Text fontSize="sm">
        {copy.anomalyCandidateRange}: {formatKst(candidate.windowStartedAt)} –{' '}
        {formatKst(candidate.windowEndedAt)}
      </Text>
      <details>
        <summary>
          {copy.anomalyEvidence} ({candidate.evidence.length} / {count(candidate.evidenceTotal)})
        </summary>
        <Stack gap="4" pt="3">
          {candidate.evidenceTruncated && (
            <Text color="orange.fg" data-testid="anomaly-evidence-partial">
              {copy.anomalyEvidencePartial}
            </Text>
          )}
          {candidate.evidence.map((item) => (
            <Stack
              key={`${item.first.fillId}:${item.second.fillId}`}
              gap="2"
              borderTopWidth="1px"
              pt="3"
            >
              <Text fontWeight="medium">
                {copy.anomalyMatchedQuantity}: {count(item.matchedQty)}
              </Text>
              <Text fontSize="sm">{copy.anomalyFirstLeg}</Text>
              <Leg leg={item.first} candidate={candidate} />
              <Text fontSize="sm">{copy.anomalySecondLeg}</Text>
              <Leg leg={item.second} candidate={candidate} />
            </Stack>
          ))}
        </Stack>
      </details>
    </Stack>
  );
}

/** Pages only the received snapshot; does not request another page with a new clock/settings. */
export function AnomalyReport({ report }: { report: TradingAnomalyReport }) {
  const [visible, setVisible] = useState(20);
  const ready = new Set(
    report.signals.filter((signal) => signal.status === 'ready').map((signal) => signal.kind),
  );
  const candidates = report.candidates.filter((candidate) => ready.has(candidate.kind));
  const partial =
    report.source.truncated || report.signals.some((signal) => signal.candidatesTruncated);
  return (
    <Stack gap="5" data-testid="anomaly-report">
      <Stack gap="1" fontSize="sm">
        <Text>
          {copy.anomalyAsOf}: {formatKst(report.asOf)}
        </Text>
        {report.rangeStartedAt && (
          <Text>
            {copy.anomalyRange}: {formatKst(report.rangeStartedAt)} – {formatKst(report.asOf)}
          </Text>
        )}
        <Text>{copy.anomalySnapshotHint}</Text>
        <Text>
          {copy.anomalyScanned}: {report.source.scannedFills.toLocaleString('ko-KR')} /{' '}
          {report.source.limit.toLocaleString('ko-KR')}
        </Text>
      </Stack>
      {report.signals.map((signal) => (
        <Stack
          key={signal.kind}
          gap="2"
          borderWidth="1px"
          borderRadius="l2"
          p="4"
          data-testid={`anomaly-signal-${signal.kind}`}
        >
          <Heading as="h4" size="md">
            {kindLabel(signal.kind)}
          </Heading>
          <Text>
            {signal.kind === 'human_pair' ? copy.anomalyPairHint : copy.anomalyRoundTripHint}
          </Text>
          <Text fontWeight="medium">
            {signal.status === 'ready'
              ? copy.anomalyReady
              : signal.status === 'undecided'
                ? copy.anomalyUndecided
                : copy.anomalyInvalid}
          </Text>
          {signal.status === 'invalid' && <Text>{copy.anomalyInvalidHint}</Text>}
          {(
            [
              ['count', copy.anomalyCountSetting],
              ['windowSeconds', copy.anomalyWindowSetting],
              ['lookbackSeconds', copy.anomalyLookbackSetting],
            ] as const
          ).map(([field, label]) => (
            <Text key={field} fontSize="sm">
              {label}: {signal.settings[field].value?.toLocaleString('ko-KR') ?? copy.anomalyUnset}
              {' · '}
              {RELEASE_SETTING_STATUS_LABELS[signal.settings[field].status]}
            </Text>
          ))}
          {signal.rangeStartedAt && (
            <Text fontSize="sm">
              {copy.anomalyRange}: {formatKst(signal.rangeStartedAt)} – {formatKst(report.asOf)}
            </Text>
          )}
          {signal.status === 'ready' && (
            <Text>
              {copy.anomalyObserved}: {count(signal.observedCandidates)}
            </Text>
          )}
        </Stack>
      ))}
      <Link asChild>
        <NextLink href="/admin/settings">{copy.adminReleaseSettings}</NextLink>
      </Link>
      {partial && (
        <Alert.Root status="warning" data-testid="anomaly-partial">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{copy.anomalyPartial}</Alert.Title>
            <Alert.Description>{copy.anomalyPartialHint}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {candidates.length === 0 && (
        <Text data-testid="anomaly-empty">
          {ready.size === 0
            ? copy.anomalyUnavailableEmpty
            : !report.source.complete || partial
              ? copy.anomalyPartialEmpty
              : copy.anomalyEmpty}
        </Text>
      )}
      {candidates.slice(0, visible).map((candidate) => (
        <AnomalyCard key={candidate.id} candidate={candidate} />
      ))}
      {candidates.length > visible && (
        <Button
          variant="outline"
          alignSelf="start"
          onClick={() => setVisible((current) => current + 20)}
        >
          {copy.anomalyMore}
        </Button>
      )}
    </Stack>
  );
}

export function TradingAnomaliesScreen() {
  const [input, setInput] = useState('');
  const [marketId, setMarketId] = useState('');
  const [invalid, setInvalid] = useState(false);
  const query = useTradingAnomalies(marketId);
  return (
    <Stack gap="5">
      <Heading as="h3" size="xl">
        {copy.adminTradingAnomalies}
      </Heading>
      <Text>{copy.anomalyPurpose}</Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = input.trim();
          if (next && !uuidSchema.safeParse(next).success) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          if (next === marketId) void query.refetch({ cancelRefetch: true });
          else setMarketId(next);
        }}
      >
        <Stack gap="3">
          <Field.Root invalid={invalid}>
            <Field.Label>{copy.anomalyMarketFilter}</Field.Label>
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              autoComplete="off"
            />
            <Field.HelperText>{copy.anomalyMarketFilterHint}</Field.HelperText>
            {invalid && <Field.ErrorText>{copy.anomalyInvalidMarket}</Field.ErrorText>}
          </Field.Root>
          <HStack flexWrap="wrap">
            <Button type="submit" variant="outline" loading={query.isFetching}>
              {copy.anomalyApplyFilter}
            </Button>
            <Button
              onClick={() => void query.refetch({ cancelRefetch: true })}
              loading={query.isFetching}
            >
              {copy.anomalyRecalculate}
            </Button>
          </HStack>
        </Stack>
      </form>
      {query.isError && (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {query.data ? copy.anomalyRefreshFailed : copy.errUnknown}
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {query.isPending && <Skeleton height="24" />}
      {query.data && <AnomalyReport key={`${marketId}:${query.data.asOf}`} report={query.data} />}
    </Stack>
  );
}
