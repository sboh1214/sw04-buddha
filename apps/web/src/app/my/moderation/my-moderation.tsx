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
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useMyModerationActions, useMyReports } from '@/hooks/use-reports';
import { type MyModerationAction, type MyReport } from '@/lib/api';
import { reportReasonLabel } from '@/lib/authored';
import {
  type ModerationPage,
  type NamedLink,
  REPORT_STATUS_PALETTE,
  actionReasonText,
  actionSubjectView,
  appealDeadlineView,
  appealEmailRequired,
  appealGuidanceText,
  isRestriction,
  moderationActionLabel,
  moderationRows,
  myEndChangeView,
  nicknameHoldShown,
  reportStatusLabel,
  reportTargetTypeLabel,
  reportTargetView,
  restrictionStanding,
} from '@/lib/moderation';
import { MY_SETTINGS_PATH } from '@/lib/my';
import { postReadErrorMessage } from '@/lib/posts';
import { listSection } from '@/lib/query-client';
import { restrictionEndText } from '@/lib/restriction';
import { Section, SessionEnded, useSessionEnded } from '../portfolio';

/**
 * 조치·신고 내역 (#50, ADR-0081; ADR-0069 decision 4 #50 — «본인이 받은 조치와 낸 신고의 처리 결과를
 * 여기서 본다»). Not a MY tab, so no tab names it: the page names itself (`h3` under MY's `h2`, the
 * sections `h4` under it). Two sections:
 *
 * - 받은 조치: above the list, once, how to appeal (#186, ADR-0084; owner decision 2026-10-22 답 4)
 *   — by the customer centre's email, saying which action from the sign-up email, once per action
 *   within 14 days, the action standing while reviewed and the answer by email (#45-14); under it,
 *   for an account on a Kakao or Naver placeholder address alone, that an appeal needs an email
 *   registered in MY 설정 first, with the way there (owner decision 2026-10-22 (2차) 3) — then
 *   each action an operator took on the member, newest first: its type, what it was about (their
 *   post or comment, or that they deleted it since; their profile), the reason (the report reason
 *   the operator picked and their explanation), when, its end when it has one, its cancellation,
 *   and on each one standing its '이의 기한' — or, once that has passed, '이의 기한이 지났습니다.'
 *   with it (답 1·2, `appealDeadlineView`). A nickname reset not cancelled says, for the 30 days of
 *   its hold, that the nickname taken away cannot be used again (owner decision 2026-10-22,
 *   `nicknameHoldShown`) — never which it was (#37-3). A writing restriction (#185, ADR-0082) says
 *   its end — '무기한' for none — as it stands now, and '진행 중' while it stands
 *   (`restrictionStanding`); one an operator lifted early or shortened says '조기 해제됨' or '감경됨'
 *   and the end it was given under the changed one (`myEndChangeView`, owner decision 2026-10-23
 *   answer 4 — never the reason); a cancelled one says no end, only '취소됨' and when it was
 *   cancelled (answer 10). Never who reported nor which operator acted (#45-13).
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

/**
 * What a list body reads of its `useInfiniteQuery`. `isFetchNextPageError`, `isFetchingNextPage` and
 * `failureReason` are what the failed-더 보기 notice reads (`LoadMoreFailed`, owner decision
 * 2026-10-20 7 — every 더 보기 list, MY's too).
 */
interface ListQuery<Row> {
  data: { pages: ModerationPage<Row>[] } | undefined;
  error: unknown;
  failureReason: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
}

/**
 * One list's ladder, the other MY lists' (`AuthoredListBody`, `listSection`): a skeleton while the
 * first page loads, a first read that failed with 다시 시도, the empty line, the rows with 더 보기,
 * a 더 보기 that failed said right above the button with the first read's words (`LoadMoreFailed`,
 * owner decision 2026-10-20 7), and a refresh that failed over rows that are kept — never a 더 보기
 * that failed taken for one (`refreshFailed`, lib/query-client.ts).
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
  const rows = moderationRows(list.data?.pages);
  const section = listSection(list, rows.length);
  if (section.body === 'pending') {
    return <Skeleton height="24" data-testid={`${testId}-pending`} />;
  }
  if (section.body === 'failed') {
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
  return (
    <Stack gap="3">
      {section.stale && (
        <Alert.Root status="warning" role="status">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {section.body === 'empty' ? (
        <EmptyState message={empty} data-testid={`${testId}-empty`} />
      ) : (
        <Stack as="ul" gap="3" listStyleType="none" data-testid={testId}>
          {rows.map((row) => (
            <li key={row.id}>{renderRow(row)}</li>
          ))}
        </Stack>
      )}
      {list.hasNextPage && (
        <>
          {/* A 더 보기 that failed: the rows stay, and this says why nothing came — an unreachable
              server told apart, as the first read's failure is — above the button that asks
              again (owner decision 2026-10-20 7, as every 더 보기 list). */}
          <LoadMoreFailed
            list={list}
            message={postReadErrorMessage(list.error)}
            data-testid={`${testId}-more-failed`}
          />
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
        </>
      )}
    </Stack>
  );
}

/**
 * The actions received, under how to appeal them: the guidance once, above the list and outside
 * its ladder, so it is there while the list is read, when it could not be read and when it holds
 * nothing (owner decision 2026-10-22 답 4, #186) — the way to appeal does not wait on the list.
 * Under it, for a placeholder address alone, the email to register first (`AppealEmailRequired`,
 * (2차) 3) — read from `GET /me`, not from the list either. Each standing action's card gives its
 * own deadline (`ActionItem`). The email is the business info's, filled in (`appealGuidanceText`);
 * Korean breaks at spaces and the address anywhere, as the footer's same address does, so neither
 * runs past a phone's edge.
 */
function ActionsBody() {
  const list = useMyModerationActions();
  return (
    <Stack gap="4">
      <Stack gap="2">
        <Text
          textStyle="bodySm"
          wordBreak="keep-all"
          overflowWrap="anywhere"
          data-testid="my-moderation-appeal"
        >
          {appealGuidanceText()}
        </Text>
        <AppealEmailRequired />
      </Stack>
      <ListBody
        list={list}
        empty={copy.myModerationActionsEmpty}
        testId="my-actions-list"
        renderRow={(action) => <ActionItem action={action} />}
      />
    </Stack>
  );
}

/**
 * Under the guidance, for an account on a Kakao or Naver placeholder address alone: an appeal needs
 * an email registered in MY 설정 first, and the way there (owner decision 2026-10-22 (2차) 3, #186) —
 * operators take appeals from the account's current email only (답 5), and none can be sent from
 * the placeholder. Decided by `GET /me`'s email (`appealEmailRequired`): nothing while it is read or
 * when it could not be. The link is MY 설정, whose 계정 card registers the address.
 */
function AppealEmailRequired() {
  const { data: me } = useMe();
  if (!appealEmailRequired(me)) return null;
  return (
    <Stack gap="1" align="flex-start" data-testid="my-moderation-appeal-email">
      <Text textStyle="bodySm" wordBreak="keep-all" overflowWrap="anywhere">
        {copy.appealEmailRequired}
      </Text>
      <ChakraLink asChild color="brand.fg" textStyle="bodySm">
        <NextLink href={MY_SETTINGS_PATH} data-testid="my-moderation-appeal-email-settings">
          {copy.appealEmailRequiredOpen}
        </NextLink>
      </ChakraLink>
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

/**
 * A label and its value on one line, wrapping at phone width. `testId` names the line and, with
 * '-label' and '-value', its two halves.
 */
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
      <Text
        as="span"
        color="fg.muted"
        flexShrink="0"
        data-testid={testId === undefined ? undefined : `${testId}-label`}
      >
        {label}
      </Text>
      <Text
        as="span"
        color="fg"
        wordBreak="break-word"
        minW="0"
        whiteSpace="pre-wrap"
        data-testid={testId === undefined ? undefined : `${testId}-value`}
      >
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
  const restriction = isRestriction(action.type);
  const endChange = myEndChangeView(action);
  const appeal = appealDeadlineView(action);
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
        {restrictionStanding(action) && (
          <Badge size="sm" variant="subtle" colorPalette="orange" data-testid="my-action-standing">
            {copy.restrictionStanding}
          </Badge>
        )}
        {endChange !== null && (
          <Badge size="sm" variant="subtle" colorPalette="gray" data-testid="my-action-end-change">
            {endChange.label}
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
      <Line label={copy.moderationTakenAt} testId="my-action-taken">
        {format(action.createdAt)}
      </Line>
      {/* A cancelled restriction ended at its cancellation, which '취소한 때' says: its end as
          given (kept as given, ADR-0082) would read as an end still to come, or '무기한'. */}
      {(restriction || action.endsAt !== null) && action.cancelledAt === null && (
        <Line label={copy.moderationEndsAt} testId="my-action-ends">
          {restrictionEndText(action.endsAt, format)}
        </Line>
      )}
      {/* Lifted early or shortened: the end it was given, under the changed one (owner decision
          2026-10-23 answer 4) — never the reason, which is the operators'. */}
      {endChange !== null && (
        <Line label={copy.moderationOriginalEndsAt} testId="my-action-original-ends">
          {restrictionEndText(endChange.originalEndsAt, format)}
        </Line>
      )}
      {action.cancelledAt !== null && (
        <Line label={copy.moderationCancelledAt}>{format(action.cancelledAt)}</Line>
      )}
      {/* Its appeal deadline alone — the guidance is once above the list (owner decision
          2026-10-22 답 4) — and once that has passed, the owner's sentence with it (답 2). */}
      {appeal !== null && (
        <Line
          label={
            appeal.passed ? copy.moderationAppealDeadlinePassed : copy.moderationAppealDeadline
          }
          testId="my-action-appeal"
        >
          {format(appeal.deadline)}
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
