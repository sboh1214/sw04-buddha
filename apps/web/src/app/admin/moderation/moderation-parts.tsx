'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  HStack,
  Heading,
  Input,
  Link as ChakraLink,
  NativeSelect,
  Portal,
  RadioGroup,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import {
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH,
  type AccountRestrictionReason,
  type ReportReason,
  type WritingRestrictionDays,
} from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useId, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { type ModerationVariables, useModerate } from '@/hooks/use-admin-moderation';
import { screenAccountId } from '@/lib/admin-accounts';
import {
  type AccountRestrictionRequest,
  type AdminModerationAction,
  type AdminReport,
  type ModerationApproval,
  type ModerationUser,
  type WarningSubject,
} from '@/lib/api';
import { reportReasonLabel } from '@/lib/authored';
import { formatKst } from '@/lib/datetime';
import {
  ACCOUNT_RESTRICTION_REASON_OPTIONS,
  ACCOUNT_RESTRICTION_TERM_OPTIONS,
  ADMIN_ACCOUNT_REQUESTS_PATH,
  ADMIN_LINK_FLAGS_PATH,
  ADMIN_MODERATION_ACTIONS_PATH,
  ADMIN_REPORTS_PATH,
  APPROVAL_STATUS_PALETTE,
  REPORT_REASON_OPTIONS,
  REPORT_STATUS_PALETTE,
  RESTRICTION_TERM_OPTIONS,
  accountRequestChangeLabel,
  accountRequestMootNotice,
  accountRequestTargetText,
  accountRestrictionDraft,
  accountRestrictionReasonOf,
  actionReasonDraft,
  actionReasonText,
  adminActionAnchor,
  adminActionPath,
  adminRestrictionEndText,
  adminTargetPath,
  adminUserModerationPath,
  approvalStatusLabel,
  cancelDialogBody,
  concernsOperator,
  dismissBatch,
  dismissBatchText,
  endChangeText,
  isAccountRestriction,
  isCancellable,
  isRestriction,
  moderationActionLabel,
  moderationFailure,
  operatorLineText,
  recordReasonDraft,
  removedItemLabel,
  reportReasonOf,
  reportStatusLabel,
  reportTargetTypeLabel,
  requestStanding,
  restrictionStanding,
  restrictionTermLabel,
  restrictionTermOf,
  shortenEndDraft,
} from '@/lib/moderation';
import { useSession } from '@/lib/use-session';

/**
 * The pieces every page of the admin 신고·조치 area shares (#50, ADR-0081; #187's review list of
 * repeated links, ADR-0083): the area's own row of links, an account's name, the lists of reports and of actions, and the two dialogs every action
 * goes through — one with the reason the member reads (a report reason and the operator's
 * explanation, owner decision 2026-10-22 on #51; a writing restriction's term too, #185), one with
 * the operators' own reason (a cancellation, a dismissal, a restriction's early lift and its 감경
 * with the new end, #185). Times are Korean time without a mark (ADR-0061 #60-8, `formatKst`).
 *
 * 계정 제한 (#139, ADR-0085) goes through the same two: its request with the owner's eight reasons
 * and a required explanation (the action dialog's `reasons: 'account'`), the requests of its 감경,
 * early lift and cancellation, and the approval or rejection of each by another admin (the record
 * dialog, whose reason the approval request keeps — `approval`). The requests are listed by
 * `RequestRows`; an account restriction's row in `ActionRows` names who asked and who approved.
 */

/**
 * The area's row: the queue, the action log, #187's review list of repeated links, which joined
 * it when the community stack was put back together (ADR-0081 결과 5, ADR-0083 7-12), and the
 * account restriction requests (#139).
 */
const AREA_LINKS: readonly { href: string; label: string }[] = [
  { href: ADMIN_REPORTS_PATH, label: copy.adminReportQueue },
  { href: ADMIN_MODERATION_ACTIONS_PATH, label: copy.adminModerationActions },
  { href: ADMIN_LINK_FLAGS_PATH, label: copy.adminLinkFlags },
  { href: ADMIN_ACCOUNT_REQUESTS_PATH, label: copy.adminAccountRequests },
];

export function ModerationNav() {
  const pathname = usePathname();
  return (
    <HStack
      as="nav"
      aria-label={copy.adminModeration}
      gap="4"
      flexWrap="wrap"
      data-testid="moderation-nav"
    >
      {AREA_LINKS.map((link) => {
        const current = pathname === link.href;
        return (
          <ChakraLink
            key={link.href}
            asChild
            fontWeight={current ? 'semibold' : 'normal'}
            color={current ? 'fg' : 'fg.muted'}
          >
            <NextLink href={link.href as Route} aria-current={current ? 'page' : undefined}>
              {link.label}
            </NextLink>
          </ChakraLink>
        );
      })}
    </HStack>
  );
}

/** The admin on screen: the account every action names (`expectedAccountId`), once known. */
export function useOperatorId(): string | undefined {
  return screenAccountId(useSession());
}

/** An account as the moderation pages name it: its nickname and '운영자', a link to its page. */
export function UserName({ user, link = true }: { user: ModerationUser; link?: boolean }) {
  const name = (
    <HStack as="span" gap="1.5" display="inline-flex">
      <Text as="span" fontWeight="medium" wordBreak="break-word">
        {user.nickname}
      </Text>
      {user.role === 'admin' && (
        <Badge size="sm" variant="subtle" colorPalette="gray">
          {copy.postAuthorAdmin}
        </Badge>
      )}
    </HStack>
  );
  if (!link) return name;
  return (
    <ChakraLink asChild color="brand.fg">
      <NextLink href={adminUserModerationPath(user.id) as Route} data-testid="moderation-user-link">
        {name}
      </NextLink>
    </ChakraLink>
  );
}

/** A card with its heading, one level under the page's. */
export function Block({
  title,
  testId,
  aside,
  children,
}: {
  title: string;
  testId: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card.Root as="section" data-testid={testId}>
      <Card.Header>
        <HStack justify="space-between" gap="3" flexWrap="wrap">
          <Heading as="h4" size="md">
            {title}
          </Heading>
          {aside}
        </HStack>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}

/** A label and its value, wrapping at phone width. */
export function Line({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <HStack gap="2" align="baseline" flexWrap="wrap" fontSize="sm" data-testid={testId}>
      <Text as="span" color="fg.muted" flexShrink="0">
        {label}
      </Text>
      <Text as="span" wordBreak="break-word" minW="0" whiteSpace="pre-wrap">
        {children}
      </Text>
    </HStack>
  );
}

/** That the page is about the operator themselves: someone else processes it (decision 4 #50). */
export function OwnNotice() {
  return (
    <Alert.Root status="info" data-testid="moderation-own">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.adminModerationOwnNotice}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/** The page's read failed or found nothing. */
export function LoadFailedNotice({
  notFound,
  onRetry,
}: {
  notFound: boolean;
  onRetry: () => void;
}) {
  return (
    <Stack gap="2" align="flex-start" data-testid="moderation-load-failed">
      <Alert.Root status="error" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>
            {notFound ? copy.adminModerationNotFound : copy.errUnknown}
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>
      {!notFound && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {copy.retry}
        </Button>
      )}
    </Stack>
  );
}

/**
 * The reports on one target, newest first as the API gives them: the reporter (every admin reads
 * who reported, ADR-0056 1-2), the reason and description, when, and how it was processed — by
 * whom and when, and the dismissal's reason. On a report about the admin reading it
 * (`aboutViewer`) the reporter, the description and the operator who processed it are withheld —
 * the API sends none — and a line says so (owner decision 2026-10-21); the reason, the times and
 * the result stay.
 */
export function ReportRows({ reports }: { reports: readonly AdminReport[] }) {
  if (reports.length === 0) {
    return (
      <Text color="fg.muted" fontSize="sm">
        {copy.adminModerationNoReports}
      </Text>
    );
  }
  return (
    <Stack as="ul" gap="2" listStyleType="none" data-testid="moderation-reports">
      {reports.map((report) => (
        <Stack
          as="li"
          key={report.id}
          gap="1"
          borderWidth="1px"
          borderRadius="l2"
          p="3"
          data-testid={`moderation-report-${report.id}`}
        >
          <HStack gap="2" flexWrap="wrap">
            <Badge
              size="sm"
              variant="subtle"
              colorPalette={REPORT_STATUS_PALETTE[report.status]}
              data-testid="moderation-report-status"
            >
              {reportStatusLabel(report.status)}
            </Badge>
            <Text fontSize="sm" fontWeight="medium">
              {reportReasonLabel(report.reason)}
            </Text>
            <Text fontSize="sm" color="fg.muted">
              {formatKst(report.createdAt)}
            </Text>
          </HStack>
          {report.aboutViewer ? (
            <Text fontSize="sm" color="fg.muted" data-testid="moderation-report-withheld">
              {copy.adminModerationWithheldReport}
            </Text>
          ) : (
            report.reporter !== null && (
              <Line label={copy.adminModerationReporter}>
                <UserName user={report.reporter} />
              </Line>
            )
          )}
          {report.description !== null && (
            <Line label={copy.adminModerationReportDescription}>{report.description}</Line>
          )}
          {report.resolvedAt !== null && (
            <Line
              label={report.aboutViewer ? copy.reportResolvedAt : copy.adminModerationResolvedBy}
            >
              {operatorLineText(report.resolvedBy, report.resolvedAt, report.aboutViewer)}
            </Line>
          )}
          {report.dismissalReason !== null && (
            <Line label={copy.adminModerationDismissalReason}>{report.dismissalReason}</Line>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * Actions, newest first: the type, the member (`showUser`), what it was about (a link to its
 * page), the reason the member reads, the operator and the time, what a profile action took away
 * (kept for operators, #37-10), how many reports it resolved, and its cancellation. 조치 취소 on one
 * that stands, unless it is about the operator (decision 4 #50) — the server refuses it either way.
 * On an action taken on the admin reading it (`aboutViewer`) the operators who took and cancelled
 * it are withheld — the times alone, and a line that says so (owner decision 2026-10-21).
 *
 * A writing restriction (#185, ADR-0082) also shows its end as it stands now ('무기한' for none),
 * '진행 중' while it stands (`restrictionStanding`), and every change of its end — 감경 and 조기
 * 해제, the end before and after, the operators' reason, who and when (withheld as above). While it
 * stands, and unless it is about the operator, '조기 해제' and '감경' open their dialogs beside 조치
 * 취소. `onOpen` opens a dialog; without it the rows offer nothing.
 *
 * An account restriction (#139, ADR-0085) reads the same, and names who asked for each step and
 * who approved it (`ApprovalLines` — ADR-0085 7-1: the operator who asked is the action's, the
 * approval is another admin's, with their reason and time): its operator is '요청한 운영자', and
 * its approval, its cancellation's and each end change's follow. Its buttons ask: '조기 해제 요청',
 * '감경 요청' and '취소 요청' open the request dialogs — nothing changes until another admin approves
 * (ADR-0056 decision 1-7); the server refuses the writing restriction's direct routes for it.
 */
export function ActionRows({
  actions,
  showUser = false,
  anchors = false,
  onOpen,
}: {
  actions: readonly AdminModerationAction[];
  showUser?: boolean;
  /** Each row carries its element id (`adminActionAnchor`), where a request's link lands. */
  anchors?: boolean;
  onOpen?: (spec: DialogSpec) => void;
}) {
  const operatorId = useOperatorId();
  if (actions.length === 0) {
    return (
      <Text color="fg.muted" fontSize="sm">
        {copy.adminModerationNoActions}
      </Text>
    );
  }
  return (
    <Stack as="ul" gap="2" listStyleType="none" data-testid="moderation-actions">
      {actions.map((action) => {
        const reason = actionReasonText(action.reason);
        const own = concernsOperator(action.user.id, operatorId);
        const restriction = isRestriction(action.type);
        const account = isAccountRestriction(action.type);
        const standing = restrictionStanding(action);
        const viewer = action.aboutViewer;
        return (
          <Stack
            as="li"
            key={action.id}
            gap="1"
            borderWidth="1px"
            borderRadius="l2"
            p="3"
            id={anchors ? adminActionAnchor(action.id) : undefined}
            data-testid={`moderation-action-${action.id}`}
          >
            <HStack justify="space-between" align="start" gap="2" flexWrap="wrap">
              <HStack gap="2" flexWrap="wrap">
                <Badge
                  size="sm"
                  variant="subtle"
                  colorPalette="orange"
                  data-testid="moderation-action-type"
                >
                  {moderationActionLabel(action.type)}
                </Badge>
                {action.cancelledAt !== null && (
                  <Badge
                    size="sm"
                    variant="subtle"
                    colorPalette="gray"
                    data-testid="moderation-action-cancelled"
                  >
                    {copy.moderationCancelled}
                  </Badge>
                )}
                {standing && (
                  <Badge
                    size="sm"
                    variant="subtle"
                    colorPalette="orange"
                    data-testid="moderation-action-standing"
                  >
                    {copy.restrictionStanding}
                  </Badge>
                )}
                {showUser && <UserName user={action.user} />}
                {action.subject !== null && action.subject.type !== 'profile' && (
                  <ChakraLink asChild color="brand.fg" fontSize="sm">
                    <NextLink href={adminTargetPath(action.subject) as Route}>
                      {reportTargetTypeLabel(action.subject.type)}
                    </NextLink>
                  </ChakraLink>
                )}
              </HStack>
              {onOpen !== undefined && own === false && (
                <HStack gap="1.5" flexWrap="wrap">
                  {standing && !account && (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onOpen(liftDialog(action))}
                        data-testid="moderation-action-lift"
                      >
                        {copy.adminModerationLift}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onOpen(shortenDialog(action))}
                        data-testid="moderation-action-shorten"
                      >
                        {copy.adminModerationShorten}
                      </Button>
                    </>
                  )}
                  {standing && account && (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onOpen(accountLiftDialog(action))}
                        data-testid="moderation-action-lift-request"
                      >
                        {copy.adminModerationAccountLift}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onOpen(accountShortenDialog(action))}
                        data-testid="moderation-action-shorten-request"
                      >
                        {copy.adminModerationAccountShorten}
                      </Button>
                    </>
                  )}
                  {isCancellable(action) &&
                    (account ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onOpen(accountCancelDialog(action))}
                        data-testid="moderation-action-cancel-request"
                      >
                        {copy.adminModerationAccountCancel}
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onOpen(cancelDialog(action))}
                        data-testid="moderation-action-cancel"
                      >
                        {copy.adminModerationCancel}
                      </Button>
                    ))}
                </HStack>
              )}
            </HStack>
            <Line label={copy.moderationReason}>{reason.reason}</Line>
            {reason.note !== null && <Line label={copy.authoredHiddenNote}>{reason.note}</Line>}
            {viewer && (
              <Text fontSize="sm" color="fg.muted" data-testid="moderation-action-withheld">
                {copy.adminModerationWithheldAction}
              </Text>
            )}
            <Line
              label={
                viewer
                  ? copy.moderationTakenAt
                  : account
                    ? copy.adminModerationRequestedBy
                    : copy.adminModerationCreatedBy
              }
            >
              {operatorLineText(action.createdBy, action.createdAt, viewer)}
            </Line>
            {action.approval !== null && (
              <ApprovalLines
                approval={action.approval}
                aboutViewer={viewer}
                labels={{
                  by: copy.adminModerationApprovedBy,
                  at: copy.adminModerationApprovedAt,
                  reason: copy.adminModerationApprovalReason,
                }}
                testId="moderation-action-approval"
              />
            )}
            {(restriction || action.endsAt !== null) && (
              <Line label={copy.moderationEndsAt} testId="moderation-action-ends">
                {adminRestrictionEndText(action.endsAt)}
              </Line>
            )}
            {action.endChanges.length > 0 && (
              <Stack as="ul" gap="1.5" listStyleType="none" data-testid="moderation-end-changes">
                {action.endChanges.map((change) => (
                  <Stack
                    as="li"
                    key={`${change.kind}-${change.createdAt}`}
                    gap="0.5"
                    ps="3"
                    borderStartWidth="2px"
                    borderColor="border.subtle"
                    data-testid="moderation-end-change"
                  >
                    <Text fontSize="sm" fontWeight="medium">
                      {endChangeText(change)}
                    </Text>
                    <Line label={copy.adminModerationEndChangeReason}>{change.reason}</Line>
                    <Line
                      label={
                        viewer
                          ? copy.adminModerationChangedAt
                          : change.approval !== null
                            ? copy.adminModerationRequestedBy
                            : copy.adminModerationChangedBy
                      }
                    >
                      {operatorLineText(change.createdBy, change.createdAt, viewer)}
                    </Line>
                    {change.approval !== null && (
                      <ApprovalLines
                        approval={change.approval}
                        aboutViewer={viewer}
                        labels={{
                          by: copy.adminModerationApprovedBy,
                          at: copy.adminModerationApprovedAt,
                          reason: copy.adminModerationApprovalReason,
                        }}
                        testId="moderation-end-change-approval"
                      />
                    )}
                  </Stack>
                ))}
              </Stack>
            )}
            {action.removed !== null && (
              <Line label={removedItemLabel(action.removed)} testId="moderation-action-removed">
                {action.removed.item === 'nickname' ? (
                  action.removed.nickname
                ) : action.removed.item === 'bio' ? (
                  action.removed.bio
                ) : (
                  <ChakraLink
                    href={action.removed.imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    color="brand.fg"
                  >
                    {copy.adminModerationImage}
                  </ChakraLink>
                )}
              </Line>
            )}
            {action.reportCount > 0 && (
              <Line label={copy.adminModerationResolvedReports}>
                {`${String(action.reportCount)}${copy.adminCountUnitReports}`}
              </Line>
            )}
            {action.cancelledAt !== null && (
              <>
                <Line
                  label={
                    viewer
                      ? copy.moderationCancelledAt
                      : account
                        ? copy.adminModerationCancelRequestedBy
                        : copy.adminModerationCancelledBy
                  }
                >
                  {operatorLineText(action.cancelledBy, action.cancelledAt, viewer)}
                </Line>
                {action.cancelReason !== null && (
                  <Line label={copy.adminModerationCancelReason}>{action.cancelReason}</Line>
                )}
                {action.cancelApproval !== null && (
                  <ApprovalLines
                    approval={action.cancelApproval}
                    aboutViewer={viewer}
                    labels={{
                      by: copy.adminModerationCancelApprovedBy,
                      at: copy.adminModerationCancelApprovedAt,
                      reason: copy.adminModerationCancelApprovalReason,
                    }}
                    testId="moderation-action-cancel-approval"
                  />
                )}
              </>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

/**
 * Another admin's approval of an account restriction's step (#139, ADR-0056 decision 1-7): who
 * approved and when — the time alone for the admin the restriction is on (`aboutViewer`, owner
 * decision 2026-10-21) — and their reason, which operators alone read.
 */
function ApprovalLines({
  approval,
  aboutViewer,
  labels,
  testId,
}: {
  approval: ModerationApproval;
  aboutViewer: boolean;
  labels: { by: string; at: string; reason: string };
  testId: string;
}) {
  return (
    <Stack gap="1" data-testid={testId}>
      <Line label={aboutViewer ? labels.at : labels.by}>
        {operatorLineText(approval.decidedBy, approval.decidedAt, aboutViewer)}
      </Line>
      <Line label={labels.reason}>{approval.reason}</Line>
    </Stack>
  );
}

/**
 * Account restriction requests (#139, ADR-0085): each with what it asks — a restriction (its
 * term, the reason and the explanation the member will read, what it is about) or a change of one
 * (a 감경's end, the reason for operators) — the member (`showUser`), who asked and when, and, once
 * decided, the decision with who, when and why. Withheld on one about the admin reading it
 * (`aboutViewer`): the asking and deciding admins, the times alone, and a line that says so.
 *
 * What the reader may do (`requestStanding`): decide — '승인' and '거절', or '거절' alone while the
 * request is moot (`moot`: the restriction outgrew it since — ADR-0085 7-3, the approval would be
 * refused — said by a notice that asks for the rejection, `accountRequestMootNotice`); nothing on
 * their own request, which another admin decides (ADR-0056 decision 1-7, a line says so); nothing
 * on one about themselves (decision 4 #50 «다른 운영자만»). Neither of those two is asked to reject
 * a moot one: the notice is the deciding admin's. `onOpen` opens a decision's dialog; without it
 * the rows offer nothing.
 */
export function RequestRows({
  requests,
  showUser = false,
  onOpen,
  empty,
}: {
  requests: readonly AccountRestrictionRequest[];
  showUser?: boolean;
  onOpen?: (spec: DialogSpec) => void;
  empty: string;
}) {
  const operatorId = useOperatorId();
  if (requests.length === 0) {
    return (
      <Text color="fg.muted" fontSize="sm" data-testid="account-requests-empty">
        {empty}
      </Text>
    );
  }
  return (
    <Stack as="ul" gap="2" listStyleType="none" data-testid="account-requests">
      {requests.map((request) => {
        const standing = requestStanding(request, operatorId);
        const mootNotice = accountRequestMootNotice(request, standing);
        const viewer = request.aboutViewer;
        return (
          <Stack
            as="li"
            key={request.id}
            gap="1"
            borderWidth="1px"
            borderRadius="l2"
            p="3"
            data-testid={`account-request-${request.id}`}
          >
            <HStack justify="space-between" align="start" gap="2" flexWrap="wrap">
              <HStack gap="2" flexWrap="wrap">
                <Badge
                  size="sm"
                  variant="subtle"
                  colorPalette="orange"
                  data-testid="account-request-change"
                >
                  {accountRequestChangeLabel(request.change)}
                </Badge>
                <Badge
                  size="sm"
                  variant="subtle"
                  colorPalette={APPROVAL_STATUS_PALETTE[request.status]}
                  data-testid="account-request-status"
                >
                  {approvalStatusLabel(request.status)}
                </Badge>
                {showUser && <UserName user={request.user} />}
                {request.apply?.subject != null && request.apply.subject.type !== 'profile' && (
                  <ChakraLink asChild color="brand.fg" fontSize="sm">
                    <NextLink href={adminTargetPath(request.apply.subject) as Route}>
                      {reportTargetTypeLabel(request.apply.subject.type)}
                    </NextLink>
                  </ChakraLink>
                )}
              </HStack>
              {onOpen !== undefined && standing === 'decide' && (
                <HStack gap="1.5" flexWrap="wrap">
                  {request.moot === null && (
                    <Button
                      size="xs"
                      variant="outline"
                      colorPalette="no"
                      onClick={() => onOpen(approveDialog(request))}
                      data-testid="account-request-approve"
                    >
                      {copy.adminAccountRequestApprove}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onOpen(rejectDialog(request))}
                    data-testid="account-request-reject"
                  >
                    {copy.adminAccountRequestReject}
                  </Button>
                </HStack>
              )}
            </HStack>
            <RequestDetails request={request} />
            {viewer && (
              <Text fontSize="sm" color="fg.muted" data-testid="account-request-withheld">
                {copy.adminAccountRequestAboutMe}
              </Text>
            )}
            <Line
              label={viewer ? copy.adminAccountRequestRequestedAt : copy.adminModerationRequestedBy}
            >
              {operatorLineText(request.requestedBy, request.requestedAt, viewer)}
            </Line>
            {standing === 'requester' && (
              <Text fontSize="sm" color="fg.muted" data-testid="account-request-own">
                {copy.adminAccountRequestOwn}
              </Text>
            )}
            {mootNotice !== null && (
              <Alert.Root status="warning" size="sm" data-testid="account-request-moot">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{mootNotice}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
            {request.decidedAt !== null && (
              <>
                <Line
                  label={
                    viewer ? copy.adminAccountRequestDecidedAt : copy.adminAccountRequestDecidedBy
                  }
                >
                  {operatorLineText(request.decidedBy, request.decidedAt, viewer)}
                </Line>
                {request.decisionReason !== null && (
                  <Line label={copy.adminAccountRequestDecisionReason}>
                    {request.decisionReason}
                  </Line>
                )}
              </>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

/**
 * What a request asks for: an `apply`'s term, reason and the explanation the member will read —
 * which is its request's reason too (ADR-0085 7-5), so it is said once — or a change's: the
 * restriction it changes as it stands now (when it was given and its end now, linked to its row on
 * the member's page, and its reason — a member can have several, 7-12), a 감경's end asked for,
 * and the reason (operators only).
 */
function RequestDetails({ request }: { request: AccountRestrictionRequest }) {
  if (request.apply !== null) {
    const reason = actionReasonText(request.apply.reason);
    return (
      <>
        <Line label={copy.adminModerationTerm} testId="account-request-term">
          {restrictionTermLabel(request.apply.days)}
        </Line>
        <Line label={copy.moderationReason}>{reason.reason}</Line>
        {reason.note !== null && <Line label={copy.adminModerationNoteLabel}>{reason.note}</Line>}
      </>
    );
  }
  const target = request.target;
  const targetReason = target === null ? null : actionReasonText(target.reason);
  return (
    <>
      {target !== null && request.actionId !== null && (
        <Line label={copy.adminAccountRequestTarget} testId="account-request-target">
          <ChakraLink asChild color="brand.fg">
            <NextLink href={adminActionPath(request.user.id, request.actionId) as Route}>
              {accountRequestTargetText(target)}
            </NextLink>
          </ChakraLink>
        </Line>
      )}
      {targetReason !== null && (
        <Line label={copy.adminAccountRequestTargetReason} testId="account-request-target-reason">
          {targetReason.note === null
            ? targetReason.reason
            : `${targetReason.reason} · ${targetReason.note}`}
        </Line>
      )}
      {request.endsAt !== null && (
        <Line label={copy.adminAccountRequestEndsAt} testId="account-request-ends">
          {formatKst(request.endsAt)}
        </Line>
      )}
      <Line label={copy.adminAccountRequestReason}>{request.requestReason}</Line>
    </>
  );
}

// ---- dialogs -----------------------------------------------------------------------------------

/** A choice of what a warning is about, where the page offers one. */
export interface SubjectOption {
  value: string;
  label: string;
  subject: WarningSubject | null;
}

/** What an action dialog hands its `build`: the reason picked among the dialog's `R`. */
export interface ActionInput<R> {
  reason: R;
  note: string | null;
  subject: WarningSubject | null;
  /** The term picked; null for 무기한 and for a dialog that asks none. */
  days: WritingRestrictionDays | null;
  expectedAccountId: string;
}

/** What every action dialog has, whatever its reasons. */
interface ActionSpecBase {
  title: string;
  body: string;
  success: string;
  testId: string;
  subjects?: readonly SubjectOption[];
  /** The subjects' label: a warning's ('경고의 대상') unless said. */
  subjectLabel?: string;
  /** A restriction's term is asked (its dialog's term options). */
  term?: boolean;
}

/**
 * The dialog an action waits in. `action`: the reason the member reads — a report reason and the
 * explanation (required with '기타') — and, for a warning or a writing restriction, what it is
 * about (`subjects`, under `subjectLabel`), and for a writing restriction its term (`term`: 1, 3, 7
 * or 30 days or 무기한, one required — #185). `account`: an account restriction's request (#139),
 * an action dialog that takes one of its own eight reasons and an explanation required whatever the
 * reason, and its term among ACCOUNT_RESTRICTION_TERM_OPTIONS. `record`: the operators' own reason,
 * never shown to the member — a cancellation, a dismissal, a restriction's early lift and its 감경,
 * which also takes the new end (`end`, Korean time, earlier than the end now and still to come) —
 * and an account restriction's requests and decisions, whose reason an approval request keeps
 * (`approval`: held to its length as well, `recordReasonDraft`).
 */
export type DialogSpec =
  | (ActionSpecBase & {
      kind: 'action';
      build: (input: ActionInput<ReportReason>) => ModerationVariables;
    })
  | (ActionSpecBase & {
      kind: 'account';
      build: (
        input: ActionInput<AccountRestrictionReason> & { note: string },
      ) => ModerationVariables;
    })
  | {
      kind: 'record';
      title: string;
      body: string;
      success: string;
      testId: string;
      details?: ReactNode;
      /** A 감경's new end is asked, earlier than `currentEndsAt` (null: 무기한). */
      end?: { currentEndsAt: string | null };
      /** The reason is an approval request's or its decision's (#139). */
      approval?: boolean;
      build: (input: {
        reason: string;
        /** The new end a 감경 asked for (ISO); null for a dialog that asks none. */
        endsAt: string | null;
        expectedAccountId: string;
      }) => ModerationVariables;
    };

/**
 * One action's dialog, pinned while the request runs. Its rules are said under the fields once a
 * send was tried; a refusal under the field it is about or in the dialog, which stays
 * (`moderationFailure`) — the hook re-reads the area either way, so the page under it shows what
 * is so. Sent, it closes with a toast. Nothing is sent while the admin on screen is unknown.
 */
export function ModerationDialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }) {
  const id = useId();
  const moderate = useModerate();
  const operatorId = useOperatorId();
  // The reason's `<select>` as picked ('' for none), read by the dialog's reasons when sent.
  const [reasonValue, setReasonValue] = useState('');
  const [text, setText] = useState('');
  const [subjectValue, setSubjectValue] = useState(
    spec.kind === 'record' ? '' : (spec.subjects?.[0]?.value ?? ''),
  );
  // A restriction's term: none picked until the operator picks one (no default term).
  const [termValue, setTermValue] = useState('');
  // A 감경's new end as typed (`datetime-local`, Korean time) and what was wrong with it when sent.
  const [endLocal, setEndLocal] = useState('');
  const [endError, setEndError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [fieldError, setFieldError] = useState<{
    field: 'note' | 'reason' | 'endsAt';
    message: string;
  } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = moderate.isPending;
  const account = spec.kind === 'account';
  const reasonOptions = account ? ACCOUNT_RESTRICTION_REASON_OPTIONS : REPORT_REASON_OPTIONS;
  const termOptions = account ? ACCOUNT_RESTRICTION_TERM_OPTIONS : RESTRICTION_TERM_OPTIONS;
  const reportDraft = actionReasonDraft({ reason: reportReasonOf(reasonValue), note: text });
  const accountDraft = accountRestrictionDraft({
    reason: accountRestrictionReasonOf(reasonValue),
    note: text,
  });
  const action = account ? accountDraft : reportDraft;
  const record = recordReasonDraft(text, spec.kind === 'record' && spec.approval === true);
  const term = restrictionTermOf(termValue, termOptions);
  const reasonError = spec.kind !== 'record' && tried ? action.reasonError : null;
  const termError =
    spec.kind !== 'record' && spec.term === true && tried && term === undefined
      ? copy.errModerationTermRequired
      : null;
  const textError =
    (fieldError !== null && fieldError.field !== 'endsAt' ? fieldError.message : null) ??
    (tried ? (spec.kind === 'record' ? record.error : action.noteError) : null);
  const endFieldError = fieldError?.field === 'endsAt' ? fieldError.message : endError;

  const submit = () => {
    setTried(true);
    setFieldError(null);
    setRefusal(null);
    setEndError(null);
    if (operatorId === undefined) return;
    let variables: ModerationVariables;
    if (spec.kind !== 'record') {
      if (action.reasonError !== null || action.noteError !== null) return;
      if (spec.term === true && term === undefined) return;
      const subject =
        spec.subjects?.find((option) => option.value === subjectValue)?.subject ?? null;
      const days = term?.days ?? null;
      if (spec.kind === 'account') {
        if (accountDraft.reason === null) return;
        variables = spec.build({
          reason: accountDraft.reason,
          note: accountDraft.note,
          subject,
          days,
          expectedAccountId: operatorId,
        });
      } else {
        if (reportDraft.reason === null) return;
        variables = spec.build({
          reason: reportDraft.reason,
          note: reportDraft.note,
          subject,
          days,
          expectedAccountId: operatorId,
        });
      }
    } else {
      let endsAt: string | null = null;
      if (spec.end !== undefined) {
        const draft = shortenEndDraft(endLocal, spec.end.currentEndsAt);
        if (draft.error !== null) {
          setEndError(draft.error);
          return;
        }
        endsAt = draft.endsAt;
      }
      if (record.error !== null) return;
      variables = spec.build({ reason: record.reason, endsAt, expectedAccountId: operatorId });
    }
    void moderate
      .mutateAsync(variables)
      .then(() => {
        toaster.create({ type: 'success', title: spec.success });
        onClose();
      })
      .catch((error: unknown) => {
        const failure = moderationFailure(error);
        if (failure.kind === 'field') setFieldError(failure);
        else setRefusal(failure.message);
      });
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(details) => {
        if (!details.open && !pending) onClose();
      }}
      lazyMount
      unmountOnExit
      closeOnInteractOutside={!pending}
      closeOnEscape={!pending}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content data-testid={spec.testId}>
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (!pending) submit();
              }}
            >
              <Dialog.Header>
                <Dialog.Title>{spec.title}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="4">
                  <Dialog.Description color="fg">{spec.body}</Dialog.Description>
                  {spec.kind === 'record' && spec.details}
                  {spec.kind !== 'record' && spec.subjects !== undefined && (
                    <RadioGroup.Root
                      name={`${id}-subject`}
                      value={subjectValue}
                      onValueChange={(details) => setSubjectValue(details.value ?? '')}
                      disabled={pending}
                      colorPalette="brand"
                      size="sm"
                    >
                      <RadioGroup.Label fontWeight="medium" mb="1">
                        {spec.subjectLabel ?? copy.adminModerationWarnSubject}
                      </RadioGroup.Label>
                      <HStack gap="4" flexWrap="wrap">
                        {spec.subjects.map((option) => (
                          <RadioGroup.Item
                            key={option.value}
                            value={option.value}
                            data-testid={`moderation-subject-${option.value}`}
                          >
                            <RadioGroup.ItemHiddenInput />
                            <RadioGroup.ItemIndicator />
                            <RadioGroup.ItemText>{option.label}</RadioGroup.ItemText>
                          </RadioGroup.Item>
                        ))}
                      </HStack>
                    </RadioGroup.Root>
                  )}
                  {spec.kind !== 'record' && spec.term === true && (
                    <Field.Root invalid={termError !== null} required>
                      <RadioGroup.Root
                        name={`${id}-term`}
                        value={termValue}
                        onValueChange={(details) => setTermValue(details.value ?? '')}
                        disabled={pending}
                        colorPalette="brand"
                        size="sm"
                      >
                        <RadioGroup.Label fontWeight="medium" mb="1">
                          {copy.adminModerationTerm}
                        </RadioGroup.Label>
                        <HStack gap="4" flexWrap="wrap">
                          {termOptions.map((option) => (
                            <RadioGroup.Item
                              key={option.value}
                              value={option.value}
                              data-testid={`moderation-term-${option.value}`}
                            >
                              <RadioGroup.ItemHiddenInput />
                              <RadioGroup.ItemIndicator />
                              <RadioGroup.ItemText>{option.label}</RadioGroup.ItemText>
                            </RadioGroup.Item>
                          ))}
                        </HStack>
                      </RadioGroup.Root>
                      <Field.ErrorText data-testid="moderation-term-error">
                        {termError}
                      </Field.ErrorText>
                    </Field.Root>
                  )}
                  {spec.kind === 'record' && spec.end !== undefined && (
                    <Field.Root invalid={endFieldError !== null} required>
                      <Field.Label>{copy.adminModerationShortenEndLabel}</Field.Label>
                      <Input
                        type="datetime-local"
                        size="sm"
                        value={endLocal}
                        onChange={(event) => {
                          setEndLocal(event.target.value);
                          setEndError(null);
                          setFieldError(null);
                        }}
                        disabled={pending}
                        data-testid="moderation-end"
                      />
                      <Field.HelperText>
                        {`${copy.moderationEndsAt} ${adminRestrictionEndText(spec.end.currentEndsAt)}`}
                      </Field.HelperText>
                      <Field.ErrorText data-testid="moderation-end-error">
                        {endFieldError}
                      </Field.ErrorText>
                    </Field.Root>
                  )}
                  {spec.kind !== 'record' && (
                    <Field.Root invalid={reasonError !== null} required>
                      <Field.Label>{copy.adminModerationReasonLabel}</Field.Label>
                      <NativeSelect.Root size="sm" disabled={pending}>
                        <NativeSelect.Field
                          value={reasonValue}
                          onChange={(event) => setReasonValue(event.target.value)}
                          data-testid="moderation-reason"
                        >
                          <option value="">{copy.adminModerationReasonPlaceholder}</option>
                          {reasonOptions.map((option) => (
                            <option key={option.code} value={option.code}>
                              {option.label}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                      <Field.ErrorText>{reasonError}</Field.ErrorText>
                    </Field.Root>
                  )}
                  <Field.Root
                    invalid={textError !== null}
                    required={spec.kind === 'record' || account}
                  >
                    <Field.Label>
                      {spec.kind !== 'record'
                        ? copy.adminModerationNoteLabel
                        : copy.adminModerationRecordLabel}
                    </Field.Label>
                    <Textarea
                      value={text}
                      onChange={(event) => {
                        setText(event.target.value);
                        setFieldError(null);
                      }}
                      rows={3}
                      maxLength={
                        (spec.kind !== 'record'
                          ? MODERATION_NOTE_MAX_LENGTH
                          : MODERATION_REASON_MAX_LENGTH) * 2
                      }
                      disabled={pending}
                      data-testid={spec.kind === 'record' ? 'moderation-record' : 'moderation-note'}
                    />
                    <Field.HelperText>
                      {spec.kind === 'record'
                        ? copy.adminModerationRecordHint
                        : account
                          ? copy.adminModerationAccountNoteHint
                          : copy.adminModerationNoteHint}
                    </Field.HelperText>
                    <Field.ErrorText data-testid="moderation-text-error">
                      {textError}
                    </Field.ErrorText>
                  </Field.Root>
                  {refusal !== null && (
                    <Alert.Root status="error" role="alert" data-testid="moderation-error">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Description>{refusal}</Alert.Description>
                      </Alert.Content>
                    </Alert.Root>
                  )}
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={onClose}
                  data-testid="moderation-cancel"
                >
                  {copy.cancel}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  colorPalette="no"
                  loading={pending}
                  disabled={operatorId === undefined}
                  data-testid="moderation-submit"
                >
                  {copy.adminModerationSubmit}
                </Button>
              </Dialog.Footer>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** The cancellation of `action`, with the operators' reason. */
export function cancelDialog(action: AdminModerationAction): DialogSpec {
  return {
    kind: 'record',
    title: copy.adminModerationCancelTitle,
    body: cancelDialogBody(action),
    success: copy.adminModerationCancelDone,
    testId: 'moderation-cancel-dialog',
    details: (
      <Text fontSize="sm" fontWeight="medium">
        {moderationActionLabel(action.type)} · {action.user.nickname} ·{' '}
        {formatKst(action.createdAt)}
      </Text>
    ),
    build: ({ reason, expectedAccountId }) => ({
      kind: 'cancel',
      actionId: action.id,
      body: { reason, expectedAccountId },
    }),
  };
}

/** The action a lift or a 감경 is about, above its dialog's fields: type, member, time and end. */
function RestrictionSummary({ action }: { action: AdminModerationAction }) {
  return (
    <Text fontSize="sm" fontWeight="medium">
      {moderationActionLabel(action.type)} · {action.user.nickname} · {formatKst(action.createdAt)}{' '}
      · {copy.moderationEndsAt} {adminRestrictionEndText(action.endsAt)}
    </Text>
  );
}

/**
 * A writing restriction on `user` (#185, ADR-0082): the reason the member reads, its term — 1, 3,
 * 7 or 30 days or 무기한, none picked until the operator picks one — and what it is about
 * (`subjects`, a warning's choices: the item's pending reports are resolved by it).
 */
export function restrictDialog(
  user: ModerationUser,
  subjects: readonly SubjectOption[],
): DialogSpec {
  return {
    kind: 'action',
    title: copy.adminModerationRestrictTitle,
    body: copy.adminModerationRestrictBody,
    success: copy.adminModerationRestricted,
    testId: 'moderation-restrict-dialog',
    subjects,
    subjectLabel: copy.adminModerationRestrictSubject,
    term: true,
    build: ({ reason, note, subject, days, expectedAccountId }) => ({
      kind: 'restrict',
      userId: user.id,
      body: { reason, note, subject, days, expectedAccountId },
    }),
  };
}

/** A standing restriction's early lift (조기 해제, #45-12), with the operators' reason. */
export function liftDialog(action: AdminModerationAction): DialogSpec {
  return {
    kind: 'record',
    title: copy.adminModerationLiftTitle,
    body: copy.adminModerationLiftBody,
    success: copy.adminModerationLifted,
    testId: 'moderation-lift-dialog',
    details: <RestrictionSummary action={action} />,
    build: ({ reason, expectedAccountId }) => ({
      kind: 'lift',
      actionId: action.id,
      body: { reason, expectedAccountId },
    }),
  };
}

/**
 * A standing restriction's 감경 (#45-14: «종료 시각을 앞당기는 기능», 무기한 to a term included): the
 * new end in Korean time and the operators' reason.
 */
export function shortenDialog(action: AdminModerationAction): DialogSpec {
  return {
    kind: 'record',
    title: copy.adminModerationShortenTitle,
    body: copy.adminModerationShortenBody,
    success: copy.adminModerationShortened,
    testId: 'moderation-shorten-dialog',
    details: <RestrictionSummary action={action} />,
    end: { currentEndsAt: action.endsAt },
    build: ({ reason, endsAt, expectedAccountId }) => ({
      kind: 'shorten',
      actionId: action.id,
      // The dialog sends nothing until the end reads (`shortenEndDraft`).
      body: { endsAt: endsAt ?? '', reason, expectedAccountId },
    }),
  };
}

/**
 * A request to restrict `user`'s account (계정 제한, #139, ADR-0085): one of the owner's eight
 * reasons and the explanation the member will read — required whatever the reason (ADR-0069
 * decision 1 #57-12), the request's reason to the approving admin as well (7-5) — its term (1, 3, 7
 * or 30 days or 무기한, none picked until the operator picks one, 7-2) and what it is about
 * (`subjects`, a warning's choices: the item's pending reports are resolved once it is approved,
 * 7-7). Nothing is in force until another admin approves it.
 */
export function accountRestrictDialog(
  user: ModerationUser,
  subjects: readonly SubjectOption[],
): DialogSpec {
  return {
    kind: 'account',
    title: copy.adminModerationAccountRestrictTitle,
    body: copy.adminModerationAccountRestrictBody,
    success: copy.adminModerationAccountRequested,
    testId: 'moderation-account-restrict-dialog',
    subjects,
    subjectLabel: copy.adminModerationRestrictSubject,
    term: true,
    build: ({ reason, note, subject, days, expectedAccountId }) => ({
      kind: 'account-restrict',
      userId: user.id,
      body: { reason, note, subject, days, expectedAccountId },
    }),
  };
}

/** A request to lift a standing account restriction early, with the operators' reason (#139). */
export function accountLiftDialog(action: AdminModerationAction): DialogSpec {
  return {
    kind: 'record',
    approval: true,
    title: copy.adminModerationAccountLiftTitle,
    body: copy.adminModerationAccountLiftBody,
    success: copy.adminModerationAccountLiftRequested,
    testId: 'moderation-account-lift-dialog',
    details: <RestrictionSummary action={action} />,
    build: ({ reason, expectedAccountId }) => ({
      kind: 'account-lift',
      actionId: action.id,
      body: { reason, expectedAccountId },
    }),
  };
}

/**
 * A request to bring a standing account restriction's end forward (감경, #45-14 «계정 제한이면 다른
 * 운영자의 승인»): the new end in Korean time and the operators' reason. Checked as a writing
 * restriction's 감경 is when sent, and again when it is approved — the end may have passed by then
 * (the request's `moot`).
 */
export function accountShortenDialog(action: AdminModerationAction): DialogSpec {
  return {
    kind: 'record',
    approval: true,
    title: copy.adminModerationAccountShortenTitle,
    body: copy.adminModerationAccountShortenBody,
    success: copy.adminModerationAccountShortenRequested,
    testId: 'moderation-account-shorten-dialog',
    details: <RestrictionSummary action={action} />,
    end: { currentEndsAt: action.endsAt },
    build: ({ reason, endsAt, expectedAccountId }) => ({
      kind: 'account-shorten',
      actionId: action.id,
      // The dialog sends nothing until the end reads (`shortenEndDraft`).
      body: { endsAt: endsAt ?? '', reason, expectedAccountId },
    }),
  };
}

/**
 * A request to cancel an account restriction (#50's 조치 취소, which for it needs another admin's
 * approval too — one ended already included, ADR-0085 7-4), with the operators' reason.
 */
export function accountCancelDialog(action: AdminModerationAction): DialogSpec {
  return {
    kind: 'record',
    approval: true,
    title: copy.adminModerationAccountCancelTitle,
    body: cancelDialogBody(action),
    success: copy.adminModerationAccountCancelRequested,
    testId: 'moderation-account-cancel-dialog',
    details: <RestrictionSummary action={action} />,
    build: ({ reason, expectedAccountId }) => ({
      kind: 'account-cancel',
      actionId: action.id,
      body: { reason, expectedAccountId },
    }),
  };
}

/** The request a decision is about, above its dialog's reason: what it asks, and for whom. */
function RequestSummary({ request }: { request: AccountRestrictionRequest }) {
  return (
    <Stack gap="1">
      <Text fontSize="sm" fontWeight="medium">
        {accountRequestChangeLabel(request.change)} · {request.user.nickname} ·{' '}
        {formatKst(request.requestedAt)}
      </Text>
      <RequestDetails request={request} />
    </Stack>
  );
}

/**
 * The approval of `request` by an admin who neither asked for it nor is the member (ADR-0056
 * decision 1-7), with their reason: what it asks is done at once — an `apply` from now, its term
 * counted from now (ADR-0085 7-1).
 */
export function approveDialog(request: AccountRestrictionRequest): DialogSpec {
  return {
    kind: 'record',
    approval: true,
    title: copy.adminAccountRequestApproveTitle,
    body:
      request.change === 'apply'
        ? copy.adminAccountRequestApproveApplyBody
        : copy.adminAccountRequestApproveBody,
    success: copy.adminAccountRequestApproved,
    testId: 'account-request-approve-dialog',
    details: <RequestSummary request={request} />,
    build: ({ reason, expectedAccountId }) => ({
      kind: 'approve',
      requestId: request.id,
      body: { reason, expectedAccountId },
    }),
  };
}

/**
 * The rejection of `request`, with the deciding admin's reason: nothing is done — the way a
 * request not wanted any more, or one the restriction outgrew, is closed (ADR-0085 7-3).
 */
export function rejectDialog(request: AccountRestrictionRequest): DialogSpec {
  return {
    kind: 'record',
    approval: true,
    title: copy.adminAccountRequestRejectTitle,
    body: copy.adminAccountRequestRejectBody,
    success: copy.adminAccountRequestRejected,
    testId: 'account-request-reject-dialog',
    details: <RequestSummary request={request} />,
    build: ({ reason, expectedAccountId }) => ({
      kind: 'reject',
      requestId: request.id,
      body: { reason, expectedAccountId },
    }),
  };
}

/**
 * The dismissal (기각) of the pending reports on screen, with the operators' reason: the oldest
 * DISMISS_REPORTS_MAX of them at most (`dismissBatch`), the dialog saying so when more wait — the
 * page, read again after it, offers 신고 기각 for the rest.
 */
export function dismissDialog(reports: readonly AdminReport[]): DialogSpec {
  const batch = dismissBatch(reports);
  const partial = dismissBatchText(batch);
  return {
    kind: 'record',
    title: copy.adminModerationDismissTitle,
    body: copy.adminModerationDismissBody,
    success: copy.adminModerationDismissed,
    testId: 'moderation-dismiss-dialog',
    details: (
      <Stack gap="2">
        {partial !== null && (
          <Text fontSize="sm" fontWeight="medium" data-testid="moderation-dismiss-partial">
            {partial}
          </Text>
        )}
        <Stack as="ul" gap="1" fontSize="sm" ps="5" listStyleType="disc">
          {batch.reports.map((report) => (
            <li key={report.id}>
              {[
                reportReasonLabel(report.reason),
                ...(report.reporter === null ? [] : [report.reporter.nickname]),
                formatKst(report.createdAt),
              ].join(' · ')}
            </li>
          ))}
        </Stack>
      </Stack>
    ),
    build: ({ reason, expectedAccountId }) => ({
      kind: 'dismiss',
      body: { reportIds: batch.reports.map((report) => report.id), reason, expectedAccountId },
    }),
  };
}
