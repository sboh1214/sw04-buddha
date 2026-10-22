'use client';

import {
  Alert,
  Badge,
  Button,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { type ReactNode } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMyModerationActions, useMyReports } from '@/hooks/use-reports';
import { type MyModerationAction, type MyReport } from '@/lib/api';
import { reportReasonLabel } from '@/lib/authored';
import { fillBusinessInfo } from '@/legal/business-info';
import {
  type ModerationPage,
  type NamedLink,
  REPORT_STATUS_PALETTE,
  actionReasonText,
  actionSubjectView,
  appealDeadline,
  moderationActionLabel,
  moderationRows,
  nicknameHoldShown,
  reportStatusLabel,
  reportTargetTypeLabel,
  reportTargetView,
} from '@/lib/moderation';
import { postReadErrorMessage } from '@/lib/posts';
import { Section, SessionEnded, useSessionEnded } from '../portfolio';

/**
 * 조치·신고 내역 (#50, ADR-0081; ADR-0069 decision 4 #50 — «본인이 받은 조치와 낸 신고의 처리 결과를
 * 여기서 본다»). Not a MY tab, so no tab names it: the page names itself (`h3` under MY's `h2`, the
 * sections `h4` under it). Two sections:
 *
 * - 받은 조치: each action an operator took on the member, newest first — its type, what it was
 *   about (their post or comment, or that they deleted it since; their profile), the reason (the
 *   report reason the operator picked and their explanation), when, its end when it has one, and
 *   its cancellation — with how to appeal: by the customer centre's email, once per action within
 *   14 days (#45-14), and each standing action's last day for it. A nickname reset not cancelled
 *   says, for the 30 days of its hold, that the nickname taken away cannot be used again (owner
 *   decision 2026-10-22, `nicknameHoldShown`) — never which it was (#37-3). Never who reported nor
 *   which operator acted (#45-13).
 * - 내가 한 신고: each of the member's reports, newest first — what it was about as the public sees
 *   it now, the reason and the description sent, when, and 접수 or the result, 조치함 or 기각, with
 *   when (#45-13). Not which action was taken: that is the member acted on's to read.
 *
 * Personal and client-only like every MY list: read with the member's cookie after hydration, under
 * the private `my-moderation` root, and nobody else's — the session decides whose.
 */
export function MyModeration() {
  const ended = useSessionEnded();
  if (ended) return <SessionEnded />;
  return (
    <Stack gap="6" data-testid="my-moderation">
      <Stack gap="1">
        <Heading as="h3" size="lg" data-testid="my-moderation-title">
          {copy.myModeration}
        </Heading>
        <Text textStyle="bodySm" color="fg.muted">
          {copy.myModerationHint}
        </Text>
      </Stack>
      <Section title={copy.myModerationActions} testId="my-moderation-actions" headingAs="h4">
        <ActionsBody />
      </Section>
      <Section title={copy.myModerationReports} testId="my-moderation-reports" headingAs="h4">
        <ReportsBody />
      </Section>
    </Stack>
  );
}

/** What a list body reads of its `useInfiniteQuery`. */
interface ListQuery<Row> {
  data: { pages: ModerationPage<Row>[] } | undefined;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
}

/**
 * One list's ladder, the other MY lists' (`AuthoredListBody`): a skeleton while the first page
 * loads, a first read that failed with 다시 시도, the empty line, the rows with 더 보기, and a
 * refresh that failed over rows that are kept.
 */
function ListBody<Row extends { id: string }>({
  list,
  empty,
  testId,
  renderRow,
}: {
  list: ListQuery<Row>;
  empty: string;
  testId: string;
  renderRow: (row: Row) => ReactNode;
}) {
  if (list.isPending) return <Skeleton height="24" data-testid={`${testId}-pending`} />;
  if (list.isLoadingError) {
    return (
      <Stack gap="2" align="flex-start" data-testid={`${testId}-error`}>
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{postReadErrorMessage(list.error)}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
          {copy.retry}
        </Button>
      </Stack>
    );
  }
  const rows = moderationRows(list.data?.pages);
  if (rows.length === 0) return <EmptyState message={empty} data-testid={`${testId}-empty`} />;
  return (
    <Stack gap="3">
      {list.isRefetchError && (
        <Alert.Root status="warning" role="status">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <Stack as="ul" gap="3" listStyleType="none" data-testid={testId}>
        {rows.map((row) => (
          <li key={row.id}>{renderRow(row)}</li>
        ))}
      </Stack>
      {list.hasNextPage && (
        <Button
          alignSelf="center"
          size="sm"
          variant="ghost"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
          data-testid={`${testId}-more`}
        >
          {copy.loadMore}
        </Button>
      )}
    </Stack>
  );
}

function ActionsBody() {
  const list = useMyModerationActions();
  return (
    <Stack gap="4">
      <Text textStyle="bodySm" data-testid="my-moderation-appeal">
        {fillBusinessInfo(copy.myModerationAppeal)}
      </Text>
      <ListBody
        list={list}
        empty={copy.myModerationActionsEmpty}
        testId="my-actions-list"
        renderRow={(action) => <ActionItem action={action} />}
      />
    </Stack>
  );
}

function ReportsBody() {
  const list = useMyReports();
  return (
    <ListBody
      list={list}
      empty={copy.myModerationReportsEmpty}
      testId="my-reports-list"
      renderRow={(report) => <ReportItem report={report} />}
    />
  );
}

/** A label and its value on one line, wrapping at phone width. */
function Line({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <HStack gap="2" align="baseline" flexWrap="wrap" textStyle="bodySm" data-testid={testId}>
      <Text as="span" color="fg.muted" flexShrink="0">
        {label}
      </Text>
      <Text as="span" color="fg" wordBreak="break-word" minW="0" whiteSpace="pre-wrap">
        {children}
      </Text>
    </HStack>
  );
}

/** A post, a comment or a profile named, as a link when it leads somewhere. */
function Named({ named, testId }: { named: NamedLink; testId: string }) {
  if (named.href === null) {
    return (
      <Text as="span" wordBreak="break-word" data-testid={testId}>
        {named.text}
      </Text>
    );
  }
  return (
    <ChakraLink asChild color="brand.fg" wordBreak="break-word">
      <NextLink href={named.href as Route} data-testid={testId}>
        {named.text}
      </NextLink>
    </ChakraLink>
  );
}

function ItemCard({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <Stack
      as="article"
      gap="1.5"
      p="3"
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="card"
      data-testid={testId}
    >
      {children}
    </Stack>
  );
}

function ActionItem({ action }: { action: MyModerationAction }) {
  const format = useFormatDateTime();
  const subject = actionSubjectView(action.subject);
  const reason = actionReasonText(action.reason);
  const deadline = appealDeadline(action);
  return (
    <ItemCard testId={`my-action-${action.id}`}>
      <HStack gap="2" flexWrap="wrap">
        <Badge size="sm" variant="subtle" colorPalette="orange" data-testid="my-action-type">
          {moderationActionLabel(action.type)}
        </Badge>
        {action.cancelledAt !== null && (
          <Badge size="sm" variant="subtle" colorPalette="gray" data-testid="my-action-cancelled">
            {copy.moderationCancelled}
          </Badge>
        )}
        {subject !== null && <Named named={subject} testId="my-action-subject" />}
      </HStack>
      <Line label={copy.moderationReason} testId="my-action-reason">
        {reason.reason}
      </Line>
      {reason.note !== null && (
        <Line label={copy.authoredHiddenNote} testId="my-action-note">
          {reason.note}
        </Line>
      )}
      {nicknameHoldShown(action) && (
        <Text textStyle="bodySm" color="fg" data-testid="my-action-nickname-held">
          {copy.moderationNicknameHeld}
        </Text>
      )}
      <Line label={copy.moderationTakenAt}>{format(action.createdAt)}</Line>
      {action.endsAt !== null && (
        <Line label={copy.moderationEndsAt} testId="my-action-ends">
          {format(action.endsAt)}
        </Line>
      )}
      {action.cancelledAt !== null && (
        <Line label={copy.moderationCancelledAt}>{format(action.cancelledAt)}</Line>
      )}
      {deadline !== null && (
        <Line label={copy.moderationAppealDeadline} testId="my-action-appeal">
          {format(deadline)}
        </Line>
      )}
    </ItemCard>
  );
}

function ReportItem({ report }: { report: MyReport }) {
  const format = useFormatDateTime();
  return (
    <ItemCard testId={`my-report-${report.id}`}>
      <HStack gap="2" flexWrap="wrap">
        <Badge
          size="sm"
          variant="subtle"
          colorPalette={REPORT_STATUS_PALETTE[report.status]}
          data-testid="my-report-status"
        >
          {reportStatusLabel(report.status)}
        </Badge>
        <Badge size="sm" variant="outline" colorPalette="gray">
          {reportTargetTypeLabel(report.target.type)}
        </Badge>
        <Named named={reportTargetView(report.target)} testId="my-report-target" />
      </HStack>
      <Line label={copy.reportReasonLabel} testId="my-report-reason">
        {reportReasonLabel(report.reason)}
      </Line>
      {report.description !== null && (
        <Line label={copy.reportDescriptionLabel}>{report.description}</Line>
      )}
      <Line label={copy.reportFiledAt}>{format(report.createdAt)}</Line>
      {report.resolvedAt !== null && (
        <Line label={copy.reportResolvedAt} testId="my-report-resolved">
          {format(report.resolvedAt)}
        </Line>
      )}
    </ItemCard>
  );
}
