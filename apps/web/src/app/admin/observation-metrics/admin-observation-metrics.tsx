'use client';

import { Alert, Badge, Button, Heading, Skeleton, Stack, Table, Text } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { copy } from '@/copy';
import { useAdminObservationMetrics } from '@/hooks/use-admin-observation-metrics';
import {
  OBSERVATION_TEST_ID,
  discussionPostsComments,
  formatElapsed,
  observationAsOf,
  observationCount,
  observationFraction,
  observationRatio,
  observationRowState,
  pendingEarlierLine,
  weekLabel,
} from '@/lib/admin-observation-metrics';
import { type AdminObservationMetrics as Metrics } from '@/lib/api';

/**
 * 관측 지표 (#96, ADR-0169; owner answers in ADR-0167, 96-7~96-9): the heading and the intro, then
 * a skeleton while the one read is out, that read's failure with 다시 시도 (`-error`), or the
 * screen — 기준 시각 and four sections, each its title, its one-line definition and a table of the
 * latest 12 KST weeks, newest first, in a ScrollArea (at 375px the table scrolls inside, never
 * the page): 첫 체결 전환 and 정산 후 재참여 (ratio, numerator / denominator — 95-7) under the note
 * that their two newest weeks are 진행 중, 유효 토론 (96-8's one cell, 쓴 계정, 토론이 있는 시장) and
 * 신고 처리 시간 (처리 건수, the median and 90th percentile, 대기), with the line for pending targets
 * older than the shown weeks under it. A '자료 없음' week writes it in every value cell and is never
 * 진행 중; a ratio over 0 is '—' (대상 없음). A refresh that failed over the numbers held keeps them
 * under a notice with 다시 시도 (`-stale`). Counts and durations only — no account, market, post or
 * report, no link, no export (95-10), no target or good/bad colour (95-11).
 */
export function AdminObservationMetrics() {
  const metrics = useAdminObservationMetrics();
  return (
    <Stack gap="5" data-testid={OBSERVATION_TEST_ID}>
      <Heading as="h3" size="lg">
        {copy.adminObservationMetrics}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminObservationIntro}
      </Text>
      {metrics.isPending ? (
        <Skeleton height="48" />
      ) : metrics.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid={`${OBSERVATION_TEST_ID}-error`}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void metrics.refetch()}
            data-testid={`${OBSERVATION_TEST_ID}-retry`}
          >
            {copy.retry}
          </Button>
        </Stack>
      ) : (
        <>
          {metrics.isRefetchError && (
            <Alert.Root status="warning" role="status" data-testid={`${OBSERVATION_TEST_ID}-stale`}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
              </Alert.Content>
              <Button size="xs" variant="outline" ml="auto" onClick={() => void metrics.refetch()}>
                {copy.retry}
              </Button>
            </Alert.Root>
          )}
          <ObservationTables data={metrics.data} />
        </>
      )}
    </Stack>
  );
}

/** The four sections of one answer. Exported for the node render test. */
export function ObservationTables({ data }: { data: Metrics }) {
  const { asOf } = data;
  const pendingEarlier = pendingEarlierLine(data.pendingTargetsEarlier);
  return (
    <Stack gap="8">
      <Text fontSize="sm" color="fg.muted" data-testid={`${OBSERVATION_TEST_ID}-as-of`}>
        {observationAsOf(asOf)}
      </Text>

      <Section
        slug="first-fill"
        title={copy.adminObservationFirstFill}
        hint={copy.adminObservationFirstFillHint}
        cohort
        columns={[copy.adminObservationColRatio, copy.adminObservationColFilledOfAccounts]}
      >
        {data.firstFill.map((row) => {
          const ratio = observationRatio(row.filled, row.accounts);
          return (
            <WeekRow
              key={row.week}
              slug="first-fill"
              row={row}
              asOf={asOf}
              values={[
                { text: ratio.text, label: ratio.label },
                { text: observationFraction(row.filled, row.accounts) },
              ]}
            />
          );
        })}
      </Section>

      <Section
        slug="after-settlement"
        title={copy.adminObservationAfterSettlement}
        hint={copy.adminObservationAfterSettlementHint}
        cohort
        columns={[copy.adminObservationColRatio, copy.adminObservationColReturnedOfPairs]}
      >
        {data.afterSettlement.map((row) => {
          const ratio = observationRatio(row.returned, row.pairs);
          return (
            <WeekRow
              key={row.week}
              slug="after-settlement"
              row={row}
              asOf={asOf}
              values={[
                { text: ratio.text, label: ratio.label },
                { text: observationFraction(row.returned, row.pairs) },
              ]}
            />
          );
        })}
      </Section>

      <Section
        slug="discussion"
        title={copy.adminObservationDiscussion}
        hint={copy.adminObservationDiscussionHint}
        columns={[
          copy.adminObservationColPostsComments,
          copy.adminObservationColAuthors,
          copy.adminObservationColMarkets,
        ]}
      >
        {data.discussion.map((row) => (
          <WeekRow
            key={row.week}
            slug="discussion"
            row={row}
            asOf={asOf}
            values={[
              { text: discussionPostsComments(row) },
              { text: observationCount(row.authors) },
              { text: observationCount(row.markets) },
            ]}
          />
        ))}
      </Section>

      <Section
        slug="report-handling"
        title={copy.adminObservationReportHandling}
        hint={copy.adminObservationReportHandlingHint}
        columns={[
          copy.adminObservationColCases,
          copy.adminObservationColMedian,
          copy.adminObservationColP90,
          copy.adminObservationColPending,
        ]}
        footer={
          pendingEarlier !== null && (
            <Text
              fontSize="sm"
              color="fg.muted"
              data-testid={`${OBSERVATION_TEST_ID}-pending-earlier`}
            >
              {pendingEarlier}
            </Text>
          )
        }
      >
        {data.reportHandling.map((row) => (
          <WeekRow
            key={row.week}
            slug="report-handling"
            row={row}
            asOf={asOf}
            values={[
              { text: observationCount(row.cases) },
              { text: formatElapsed(row.medianMs) },
              { text: formatElapsed(row.p90Ms) },
              { text: observationCount(row.pendingTargets) },
            ]}
          />
        ))}
      </Section>
    </Stack>
  );
}

/**
 * One metric: its title, definition, the cohort note on the two cohort tables, and its table —
 * 주, the metric's own columns, 상태.
 */
function Section({
  slug,
  title,
  hint,
  cohort = false,
  columns,
  footer,
  children,
}: {
  slug: string;
  title: string;
  hint: string;
  cohort?: boolean;
  columns: string[];
  footer?: ReactNode;
  children: ReactNode;
}) {
  const id = `${OBSERVATION_TEST_ID}-${slug}`;
  return (
    <Stack gap="3" as="section" aria-labelledby={`${id}-title`}>
      <Stack gap="1">
        <Heading as="h4" size="md" id={`${id}-title`}>
          {title}
        </Heading>
        <Text fontSize="sm" color="fg.muted" data-testid={`${id}-hint`}>
          {hint}
        </Text>
        {cohort && (
          <Text fontSize="sm" color="fg.muted" data-testid={`${id}-note`}>
            {copy.adminObservationCohortNote}
          </Text>
        )}
      </Stack>
      <Table.ScrollArea borderWidth="1px" borderRadius="l2">
        <Table.Root size="sm" data-testid={id}>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader whiteSpace="nowrap">
                {copy.adminObservationColWeek}
              </Table.ColumnHeader>
              {columns.map((column) => (
                <Table.ColumnHeader key={column} textAlign="end" whiteSpace="nowrap">
                  {column}
                </Table.ColumnHeader>
              ))}
              <Table.ColumnHeader whiteSpace="nowrap">
                {copy.adminObservationColStatus}
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>{children}</Table.Body>
        </Table.Root>
      </Table.ScrollArea>
      {footer}
    </Stack>
  );
}

/** A value cell: its text, and what a reader hears for a bare '—' (대상 없음). */
interface ValueCell {
  text: string;
  label?: string | undefined;
}

/**
 * One week: its label, the value cells — every one '자료 없음' on a week with no data, the column
 * count kept — and 상태: '진행 중', '자료 없음', or nothing on a closed week. `data-in-progress` and
 * `data-no-data` carry the two flags as the answer has them.
 */
function WeekRow({
  slug,
  row,
  asOf,
  values,
}: {
  slug: string;
  row: { week: string; inProgress: boolean; noData: boolean };
  asOf: string;
  values: ValueCell[];
}) {
  const state = observationRowState(row);
  const noData = state === 'noData';
  return (
    <Table.Row
      data-testid={`${OBSERVATION_TEST_ID}-${slug}-${row.week}`}
      data-in-progress={String(state === 'inProgress')}
      data-no-data={String(noData)}
    >
      <Table.Cell whiteSpace="nowrap">{weekLabel(row.week, asOf)}</Table.Cell>
      {values.map((value, index) => (
        <Table.Cell
          // The columns are fixed per table: the position is the key.
          key={index}
          textAlign="end"
          whiteSpace="nowrap"
          fontVariantNumeric="tabular-nums"
          color={noData ? 'fg.muted' : undefined}
          aria-label={noData ? undefined : value.label}
          title={noData ? undefined : value.label}
        >
          {noData ? copy.adminObservationNoData : value.text}
        </Table.Cell>
      ))}
      <Table.Cell
        whiteSpace="nowrap"
        data-testid={`${OBSERVATION_TEST_ID}-${slug}-${row.week}-state`}
      >
        {state === 'inProgress' ? (
          <Badge size="sm">{copy.adminObservationInProgress}</Badge>
        ) : state === 'noData' ? (
          <Text as="span" color="fg.muted">
            {copy.adminObservationNoData}
          </Text>
        ) : null}
      </Table.Cell>
    </Table.Row>
  );
}
