'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Table,
  Text,
} from '@chakra-ui/react';
import { MARKET_WORK_KINDS, type MarketWorkKind } from '@buddha/shared';
import NextLink from 'next/link';
import type { ReactNode } from 'react';
import { OperationsQueue } from '@/app/admin/operations/operations-queue';
import { LastErrorText } from '@/app/admin/operations/settlement-retry-dialog';
import { copy } from '@/copy';
import { useAdminMarketHeader } from '@/hooks/use-admin-markets';
import { useAdminMarketWork } from '@/hooks/use-admin-market-work';
import { adminMarketPath, attemptsText } from '@/lib/admin-operations';
import { type AdminMarketWorkEntry, isApiError } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE, marketIdParam } from '@/lib/market-admin';
import {
  MARKET_WORK_BASIS_TEXT,
  MARKET_WORK_CHANGES_SHOWN,
  MARKET_WORK_KIND_LABEL,
  MARKET_WORK_RETRY_OUTCOME_TEXT,
  marketWorkActorText,
  marketWorkChangeText,
  marketWorkChangesMoreText,
  marketWorkDetailsJson,
  marketWorkLabel,
  marketWorkPath,
  marketWorkRows,
  marketWorkSystemRule,
  retryErrorOf,
} from '@/lib/market-work';

const ENTRY = 'market-work-entry';

/**
 * 시장별 작업 이력 (#145 part 2, ADR-0164; 145-5, 145-6, 145-7, 145-12, 145-13, 145-16, 145-18): the
 * market's title and status (read once — the detail's poll while the payout runs is not this
 * screen's, ADR-0138), the kind links (전체 and 수정·중단·판정·지급·그 밖, `?kind=`), and the history
 * oldest first in the 운영 대기열 frame: per entry 시각 · 분류 · 작업 · 담당자 · 사유 —
 * - 작업: its name, a link's other market, a retry's result and its error (145-7), and the stored
 *   details under '자세히' (a native disclosure: no state, a keyboard opens it);
 * - 담당자: the admin by nickname, or 시스템 (145-6);
 * - 사유: the stored reason, else what stands for it (145-16) — the changes as '항목: 이전 → 새' (the
 *   first three, the rest under one '바뀐 항목 N개 더 보기'), a line saying none is taken, a retracted request's, or the system's rule; for the settlement
 *   step's failure record its attempts and last error as stored (145-6, 145-18).
 * Every admin's (ADR-0056 1-2); access is checked in the admin layout and by the API on every call.
 * A segment that cannot name a market, or a market the API does not know, is 찾을 수 없습니다.
 */
export function MarketWorkHistory({ id, kind }: { id: string; kind: MarketWorkKind | undefined }) {
  const canonical = marketIdParam(id);
  const market = useAdminMarketHeader(id);
  const list = useAdminMarketWork(id, kind);
  if (canonical === undefined || (market.isError && isApiError(market.error, 'NOT_FOUND'))) {
    return (
      <Alert.Root status="error" role="alert" data-testid="market-work-not-found">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.adminMarketNotFound}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="5" data-testid="market-work" data-kind={kind ?? 'all'}>
      <Stack gap="1">
        {market.data === undefined && market.isError ? (
          // A failed header read other than 404 (5xx, network, busy): said, with 다시 시도 — this
          // observer never polls, so a skeleton would wait for a focus or a reload.
          <Stack gap="2" align="flex-start">
            <Alert.Root status="error" role="alert" data-testid="market-work-header-error">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={() => void market.refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : market.data === undefined ? (
          <Skeleton height="8" width="64" />
        ) : (
          <HStack gap="2" flexWrap="wrap" align="baseline">
            <Heading as="h3" size="lg" wordBreak="break-word">
              <ChakraLink asChild>
                <NextLink href={adminMarketPath(canonical)} data-testid="market-work-title">
                  {market.data.title}
                </NextLink>
              </ChakraLink>
            </Heading>
            <Badge
              colorPalette={MARKET_STATUS_PALETTE[market.data.status]}
              variant="subtle"
              data-testid="market-work-status"
            >
              {MARKET_STATUS_LABEL[market.data.status]}
            </Badge>
          </HStack>
        )}
      </Stack>
      <HStack gap="2" flexWrap="wrap" data-testid="market-work-kinds">
        <Choice
          href={marketWorkPath(canonical)}
          current={kind === undefined}
          testId="market-work-kind-all"
        >
          {copy.adminMarketWorkKindAll}
        </Choice>
        {MARKET_WORK_KINDS.map((each) => (
          <Choice
            key={each}
            href={marketWorkPath(canonical, each)}
            current={each === kind}
            testId={`market-work-kind-${each}`}
          >
            {MARKET_WORK_KIND_LABEL[each]}
          </Choice>
        ))}
      </HStack>
      <OperationsQueue
        prefix="market-work-history"
        title={copy.adminMarketWorkHistory}
        empty={copy.adminMarketWorkEmpty}
        list={list}
        count={rows.length}
        header={
          <Table.Row>
            <Table.ColumnHeader>{copy.adminMarketWorkColAt}</Table.ColumnHeader>
            <Table.ColumnHeader>{copy.adminMarketWorkColKind}</Table.ColumnHeader>
            <Table.ColumnHeader>{copy.adminMarketWorkColWork}</Table.ColumnHeader>
            <Table.ColumnHeader>{copy.adminMarketWorkColActor}</Table.ColumnHeader>
            <Table.ColumnHeader>{copy.adminMarketWorkColReason}</Table.ColumnHeader>
          </Table.Row>
        }
      >
        {rows.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </OperationsQueue>
    </Stack>
  );
}

/** A kind: a link drawn as a button, the current one solid and `aria-current`. */
function Choice({
  href,
  current,
  testId,
  children,
}: {
  href: ReturnType<typeof marketWorkPath>;
  current: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Button asChild size="xs" variant={current ? 'solid' : 'outline'}>
      <NextLink href={href} aria-current={current ? 'page' : undefined} data-testid={testId}>
        {children}
      </NextLink>
    </Button>
  );
}

function EntryRow({ entry }: { entry: AdminMarketWorkEntry }) {
  const prefix = `${ENTRY}-${entry.id}`;
  return (
    <Table.Row
      data-testid={prefix}
      data-kind={entry.kind}
      data-source={entry.source}
      data-type={entry.type}
    >
      <Table.Cell whiteSpace="nowrap" verticalAlign="top" data-testid={`${prefix}-at`}>
        {formatKst(entry.at)}
      </Table.Cell>
      <Table.Cell whiteSpace="nowrap" verticalAlign="top" data-testid={`${prefix}-kind`}>
        {MARKET_WORK_KIND_LABEL[entry.kind]}
      </Table.Cell>
      <Table.Cell minW="48" verticalAlign="top">
        <WorkCell entry={entry} prefix={prefix} />
      </Table.Cell>
      <Table.Cell whiteSpace="nowrap" verticalAlign="top" data-testid={`${prefix}-actor`}>
        {marketWorkActorText(entry.actor)}
      </Table.Cell>
      <Table.Cell minW="64" verticalAlign="top" data-testid={`${prefix}-reason`}>
        <ReasonCell entry={entry} prefix={prefix} />
      </Table.Cell>
    </Table.Row>
  );
}

/** 작업: the name, a link's other end, a retry's result and error, and the details. */
function WorkCell({ entry, prefix }: { entry: AdminMarketWorkEntry; prefix: string }) {
  const retryError = retryErrorOf(entry);
  return (
    <Stack gap="1" align="flex-start">
      <Text fontWeight="medium" data-testid={`${prefix}-label`}>
        {marketWorkLabel(entry)}
      </Text>
      {entry.relatedMarket !== null && (
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          <NextLink
            href={adminMarketPath(entry.relatedMarket.id)}
            data-testid={`${prefix}-related`}
          >
            {entry.relatedMarket.title}
          </NextLink>
        </ChakraLink>
      )}
      {entry.retryOutcome !== null && (
        <Text
          fontSize="sm"
          fontWeight="medium"
          color={entry.retryOutcome === 'settled' ? 'fg' : 'fg.error'}
          data-testid={`${prefix}-outcome`}
        >
          {MARKET_WORK_RETRY_OUTCOME_TEXT[entry.retryOutcome]}
        </Text>
      )}
      {retryError !== null && <LastErrorText error={retryError} testId={`${prefix}-error`} />}
      <EntryDetails entry={entry} testId={`${prefix}-details`} />
    </Stack>
  );
}

/**
 * The stored details under '자세히', closed at first: the rows the event log or the action's shape
 * reads, else one JSON line; nothing when there is nothing left to say.
 */
function EntryDetails({ entry, testId }: { entry: AdminMarketWorkEntry; testId: string }) {
  const rows = marketWorkRows(entry);
  const json = rows === undefined ? marketWorkDetailsJson(entry) : '';
  if ((rows === undefined || rows.length === 0) && json === '') return null;
  return (
    <details data-testid={testId}>
      <Box as="summary" cursor="pointer" fontSize="xs" color="fg.muted">
        {copy.adminMarketWorkDetails}
      </Box>
      <Stack gap="0" mt="1" fontSize="xs" color="fg.muted">
        {rows?.map((row) => (
          <Text key={row.label} whiteSpace="pre-wrap" wordBreak="break-word">
            <Text as="span" fontWeight="medium">
              {row.label}
            </Text>{' '}
            {row.value}
          </Text>
        ))}
        {json !== '' && (
          <Text fontFamily="mono" wordBreak="break-all">
            {json}
          </Text>
        )}
      </Stack>
    </details>
  );
}

/** 사유 by its basis (145-16); the step record's attempts and last error (145-6). */
function ReasonCell({ entry, prefix }: { entry: AdminMarketWorkEntry; prefix: string }) {
  if (entry.settlement !== null) {
    return (
      <Stack gap="1" align="flex-start">
        <Text fontSize="sm" data-testid={`${prefix}-attempts`}>
          {attemptsText(entry.settlement.settlementAttempts)}
        </Text>
        <LastErrorText error={entry.settlement.settlementLastError} testId={`${prefix}-error`} />
      </Stack>
    );
  }
  switch (entry.reasonBasis) {
    case 'recorded':
      return <ClampedText text={entry.reason ?? '—'} testId={`${prefix}-text`} />;
    case 'system':
      return (
        <Text fontSize="sm" data-testid={`${prefix}-rule`}>
          {marketWorkSystemRule(entry) ?? '—'}
        </Text>
      );
    case 'changed_items':
      return (
        <Stack gap="1" align="flex-start">
          <Basis text={MARKET_WORK_BASIS_TEXT.changed_items} testId={`${prefix}-basis`} />
          {entry.changes.length > 0 && <Changes changes={entry.changes} prefix={prefix} />}
        </Stack>
      );
    case 'actor_time':
    case 'retracted':
      return <Basis text={MARKET_WORK_BASIS_TEXT[entry.reasonBasis]} testId={`${prefix}-basis`} />;
  }
}

/**
 * The changes, '항목: 이전 → 새' each: the first three, and the rest under one disclosure saying how
 * many — a draft's creation sets every field, and a line each would make that one row a screen tall
 * (a hidden column's height too, where the table scrolls sideways). The folded ones are in the same
 * list, so the list's text is every change, open or not.
 */
function Changes({
  changes,
  prefix,
}: {
  changes: AdminMarketWorkEntry['changes'];
  prefix: string;
}) {
  const shown = changes.slice(0, MARKET_WORK_CHANGES_SHOWN);
  const folded = changes.slice(MARKET_WORK_CHANGES_SHOWN);
  return (
    <Stack as="ul" gap="1" listStyleType="none" data-testid={`${prefix}-changes`}>
      {shown.map((change) => (
        <ChangeItem key={change.field} change={change} />
      ))}
      {folded.length > 0 && (
        <li>
          <details data-testid={`${prefix}-changes-more`}>
            <MarkedSummary>
              <Text as="span" color="fg.muted">
                {marketWorkChangesMoreText(folded.length)}
              </Text>
            </MarkedSummary>
            <Stack as="ul" gap="1" mt="1" listStyleType="none">
              {folded.map((change) => (
                <ChangeItem key={change.field} change={change} />
              ))}
            </Stack>
          </details>
        </li>
      )}
    </Stack>
  );
}

function ChangeItem({ change }: { change: AdminMarketWorkEntry['changes'][number] }) {
  return (
    <li data-field={change.field}>
      <ClampedText text={marketWorkChangeText(change)} />
    </li>
  );
}

function Basis({ text, testId }: { text: string; testId: string }) {
  return (
    <Text fontSize="sm" color="fg.muted" data-testid={testId}>
      {text}
    </Text>
  );
}

/**
 * A text that may run to a rule's whole length: its first three lines, the whole once opened — the
 * 마지막 오류's disclosure (145-18), the text inside the summary so a closed one hides nothing else.
 *
 * The summary is a row with its own marker beside the first line: a `list-item` summary whose only
 * child is the clamped block would put the native marker on a line of its own above the text. The
 * marker is drawn (`::before`, inside an `aria-hidden` span), so the text and the name stay the text.
 */
function ClampedText({ text, testId }: { text: string; testId?: string }) {
  return (
    <details>
      <MarkedSummary>
        <Text
          as="span"
          display="block"
          flex="1"
          minW="0"
          whiteSpace="pre-wrap"
          wordBreak="break-word"
          lineClamp="3"
          // Its own disclosure only: a folded change sits inside the changes' open fold.
          css={{
            'details[open] > summary > &': { WebkitLineClamp: 'unset', overflow: 'visible' },
          }}
          data-testid={testId}
        >
          {text}
        </Text>
      </MarkedSummary>
    </details>
  );
}

/** A summary row: the drawn marker (▸, ▾ once open), then its text beside it. */
function MarkedSummary({ children }: { children: ReactNode }) {
  return (
    <Box
      as="summary"
      cursor="pointer"
      fontSize="sm"
      display="flex"
      alignItems="flex-start"
      gap="1"
      listStyleType="none"
      css={{ '&::-webkit-details-marker': { display: 'none' } }}
    >
      <Box
        as="span"
        aria-hidden="true"
        data-part="marker"
        flexShrink="0"
        _before={{ content: '"▸"' }}
        css={{ 'details[open] > summary > &::before': { content: '"▾"' } }}
      />
      {children}
    </Box>
  );
}
