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
  type AdminModerationAction,
  type AdminReport,
  type ModerationUser,
  type WarningSubject,
} from '@/lib/api';
import { reportReasonLabel } from '@/lib/authored';
import { formatKst } from '@/lib/datetime';
import {
  ADMIN_MODERATION_ACTIONS_PATH,
  ADMIN_REPORTS_PATH,
  REPORT_REASON_OPTIONS,
  REPORT_STATUS_PALETTE,
  RESTRICTION_TERM_OPTIONS,
  actionReasonDraft,
  actionReasonText,
  adminRestrictionEndText,
  adminTargetPath,
  adminUserModerationPath,
  cancelDialogBody,
  concernsOperator,
  dismissBatch,
  dismissBatchText,
  endChangeText,
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
  restrictionStanding,
  restrictionTermOf,
  shortenEndDraft,
} from '@/lib/moderation';
import { useSession } from '@/lib/use-session';

/**
 * The pieces every page of the admin 신고·조치 area shares (#50, ADR-0081): the area's own row of
 * links, an account's name, the lists of reports and of actions, and the two dialogs every action
 * goes through — one with the reason the member reads (a report reason and the operator's
 * explanation, owner decision 2026-10-22 on #51; a writing restriction's term too, #185), one with
 * the operators' own reason (a cancellation, a dismissal, a restriction's early lift and its 감경
 * with the new end, #185). Times are Korean time without a mark (ADR-0061 #60-8, `formatKst`).
 */

/**
 * The area's row: the queue and the action log. The place #187's repeated-link review list joins
 * when the community stack is put back together (ADR-0081 결과 5).
 */
const AREA_LINKS: readonly { href: string; label: string }[] = [
  { href: ADMIN_REPORTS_PATH, label: copy.adminReportQueue },
  { href: ADMIN_MODERATION_ACTIONS_PATH, label: copy.adminModerationActions },
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
 */
export function ActionRows({
  actions,
  showUser = false,
  onOpen,
}: {
  actions: readonly AdminModerationAction[];
  showUser?: boolean;
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
        const standing = restrictionStanding(action);
        return (
          <Stack
            as="li"
            key={action.id}
            gap="1"
            borderWidth="1px"
            borderRadius="l2"
            p="3"
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
                  {standing && (
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
                  {isCancellable(action) && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onOpen(cancelDialog(action))}
                      data-testid="moderation-action-cancel"
                    >
                      {copy.adminModerationCancel}
                    </Button>
                  )}
                </HStack>
              )}
            </HStack>
            <Line label={copy.moderationReason}>{reason.reason}</Line>
            {reason.note !== null && <Line label={copy.authoredHiddenNote}>{reason.note}</Line>}
            {action.aboutViewer && (
              <Text fontSize="sm" color="fg.muted" data-testid="moderation-action-withheld">
                {copy.adminModerationWithheldAction}
              </Text>
            )}
            <Line
              label={action.aboutViewer ? copy.moderationTakenAt : copy.adminModerationCreatedBy}
            >
              {operatorLineText(action.createdBy, action.createdAt, action.aboutViewer)}
            </Line>
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
                        action.aboutViewer
                          ? copy.adminModerationChangedAt
                          : copy.adminModerationChangedBy
                      }
                    >
                      {operatorLineText(change.createdBy, change.createdAt, action.aboutViewer)}
                    </Line>
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
                    action.aboutViewer
                      ? copy.moderationCancelledAt
                      : copy.adminModerationCancelledBy
                  }
                >
                  {operatorLineText(action.cancelledBy, action.cancelledAt, action.aboutViewer)}
                </Line>
                {action.cancelReason !== null && (
                  <Line label={copy.adminModerationCancelReason}>{action.cancelReason}</Line>
                )}
              </>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

// ---- dialogs -----------------------------------------------------------------------------------

/** A choice of what a warning is about, where the page offers one. */
export interface SubjectOption {
  value: string;
  label: string;
  subject: WarningSubject | null;
}

/**
 * The dialog an action waits in. `action`: the reason the member reads — a report reason and the
 * explanation (required with '기타') — and, for a warning or a writing restriction, what it is
 * about (`subjects`, under `subjectLabel`), and for a writing restriction its term (`term`: 1, 3, 7
 * or 30 days or 무기한, one required — #185). `record`: the operators' own reason, never shown to
 * the member — a cancellation, a dismissal, a restriction's early lift and its 감경, which also
 * takes the new end (`end`, Korean time, earlier than the end now and still to come).
 */
export type DialogSpec =
  | {
      kind: 'action';
      title: string;
      body: string;
      success: string;
      testId: string;
      subjects?: readonly SubjectOption[];
      /** The subjects' label: a warning's ('경고의 대상') unless said. */
      subjectLabel?: string;
      /** A writing restriction's term is asked (RESTRICTION_TERM_OPTIONS). */
      term?: boolean;
      build: (input: {
        reason: ReportReason;
        note: string | null;
        subject: WarningSubject | null;
        /** The term picked; null for 무기한 and for a dialog that asks none. */
        days: WritingRestrictionDays | null;
        expectedAccountId: string;
      }) => ModerationVariables;
    }
  | {
      kind: 'record';
      title: string;
      body: string;
      success: string;
      testId: string;
      details?: ReactNode;
      /** A 감경's new end is asked, earlier than `currentEndsAt` (null: 무기한). */
      end?: { currentEndsAt: string | null };
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
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [text, setText] = useState('');
  const [subjectValue, setSubjectValue] = useState(
    spec.kind === 'action' ? (spec.subjects?.[0]?.value ?? '') : '',
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
  const action = actionReasonDraft({ reason, note: text });
  const record = recordReasonDraft(text);
  const term = restrictionTermOf(termValue);
  const reasonError = spec.kind === 'action' && tried ? action.reasonError : null;
  const termError =
    spec.kind === 'action' && spec.term === true && tried && term === undefined
      ? copy.errModerationTermRequired
      : null;
  const textError =
    (fieldError !== null && fieldError.field !== 'endsAt' ? fieldError.message : null) ??
    (tried ? (spec.kind === 'action' ? action.noteError : record.error) : null);
  const endFieldError = fieldError?.field === 'endsAt' ? fieldError.message : endError;

  const submit = () => {
    setTried(true);
    setFieldError(null);
    setRefusal(null);
    setEndError(null);
    if (operatorId === undefined) return;
    let variables: ModerationVariables;
    if (spec.kind === 'action') {
      if (action.reason === null || action.reasonError !== null || action.noteError !== null)
        return;
      if (spec.term === true && term === undefined) return;
      const subject =
        spec.subjects?.find((option) => option.value === subjectValue)?.subject ?? null;
      variables = spec.build({
        reason: action.reason,
        note: action.note,
        subject,
        days: term?.days ?? null,
        expectedAccountId: operatorId,
      });
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
                  {spec.kind === 'action' && spec.subjects !== undefined && (
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
                  {spec.kind === 'action' && spec.term === true && (
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
                          {RESTRICTION_TERM_OPTIONS.map((option) => (
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
                  {spec.kind === 'action' && (
                    <Field.Root invalid={reasonError !== null} required>
                      <Field.Label>{copy.adminModerationReasonLabel}</Field.Label>
                      <NativeSelect.Root size="sm" disabled={pending}>
                        <NativeSelect.Field
                          value={reason ?? ''}
                          onChange={(event) => setReason(reportReasonOf(event.target.value))}
                          data-testid="moderation-reason"
                        >
                          <option value="">{copy.adminModerationReasonPlaceholder}</option>
                          {REPORT_REASON_OPTIONS.map((option) => (
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
                  <Field.Root invalid={textError !== null} required={spec.kind === 'record'}>
                    <Field.Label>
                      {spec.kind === 'action'
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
                        (spec.kind === 'action'
                          ? MODERATION_NOTE_MAX_LENGTH
                          : MODERATION_REASON_MAX_LENGTH) * 2
                      }
                      disabled={pending}
                      data-testid={spec.kind === 'action' ? 'moderation-note' : 'moderation-record'}
                    />
                    <Field.HelperText>
                      {spec.kind === 'action'
                        ? copy.adminModerationNoteHint
                        : copy.adminModerationRecordHint}
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
