'use client';

import {
  Alert,
  Box,
  Button,
  Dialog,
  Field,
  Portal,
  RadioGroup,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { REPORT_DESCRIPTION_MAX_LENGTH, type ReportReason } from '@buddha/shared';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { usePostWriter } from '@/hooks/use-posts';
import { type ReportSubject, isStaleReportRefusal, useReport } from '@/hooks/use-reports';
import {
  REPORT_REASON_OPTIONS,
  type ReportItem,
  reportButtonName,
  reportDialogTitle,
  reportDraft,
  reportFailure,
  reportItemName,
  reportLengthText,
  reportReasonOf,
} from '@/lib/moderation';
import { loginPathBackTo, loginPathBackToPage } from '@/lib/next-path';
import { postPath } from '@/lib/posts';
import { profilePath } from '@/lib/profile';
import { useSession } from '@/lib/use-session';

/** Where a visitor comes back to after the login a press sent them to: the page they were on. */
function backPathOf(subject: ReportSubject): string {
  return subject.type === 'profile' ? profilePath(subject.publicId) : postPath(subject.postId);
}

/**
 * 신고 (#50, ADR-0081; ADR-0069 decision 2 #45-10, decision 3 #37-10): the button beside a
 * published post, a published 댓글 or 대댓글 and on a profile — and on every post card and comment card
 * of the community list, a market detail's 토론 (#47, ADR-0081 결과 5) and a profile's tabs (owner
 * decision 2026-10-21 답 12, `CardReportButton`) — and the dialog it opens.
 *
 * Who sees it is decided in the browser, once `GET /me` has answered (the server's HTML names
 * nobody): nothing on the reader's own post, comment or profile — they cannot report it (#45-10);
 * a visitor's press goes to the login page and back to this page, as the like button's does (owner
 * decision 2026-10-20 for likes — ADR-0081 7-2), and nothing is remembered for after it; an account
 * whose `GET /me` failed gets nothing, since the report must name it (`expectedAccountId`). A
 * placeholder has no button at all (its caller draws none): a hidden or deleted item takes no
 * report.
 *
 * The dialog: under its title, what it reports (owner decision 2026-10-22 답 4: «카드·글 화면·댓글에서
 * 연 신고 창 → 그 글·댓글의 제목이나 첫 줄을 한 줄로 보임»; (2차) 4: the profile's, the member's current
 * nickname) — the post's title or the first line of its text, the comment's first line
 * (`reportItemName`, a cut one ending in '…'), the nickname the profile shows — on one line that the
 * width cuts with an ellipsis — wherever it was opened: a card, the post page, a comment, the
 * profile; a screen reader hears it with the title, as the dialog's name (`aria-labelledby`: the
 * title, then the line — #51's dialog's way, ADR-0080 7-19). Then the eight reasons in the owner's
 * order as one radio group (one reason, #50 «하나»), the description — optional, needed with '기타',
 * 500 characters (#45-10) — and above them the note that disagreeing or a wrong forecast is not a
 * reason (#45-10 «틀린 전망 … 신고 화면에서 안내한다»), which is the dialog's description, so a screen
 * reader says it with the title. Sent, it closes with the receipt (#45-13: «접수 확인»), which says
 * where the result will be. A refusal is said under the description (its rules) or in the dialog,
 * which keeps what was typed; one that finds the item a placeholder now closes it, with a toast, as
 * the page reads the item again — the post page, and the lists whose cards carry the button
 * (`reportOptions`, `isStaleReportRefusal`).
 * The outcome is said from the write's promise, not from per-call callbacks: that read can take
 * this button away with its observer (ADR-0074's lesson).
 */
export function ReportButton({
  subject,
  item,
  authorPublicId,
  backPath,
  name,
  raised = false,
}: {
  subject: ReportSubject;
  /**
   * What the dialog names under its title (`reportItemName`): the post's title and the start of
   * its text, the comment's text, the profile's current nickname.
   */
  item: ReportItem;
  /** The public id of whoever wrote it or owns the profile; null for a withdrawn member's. */
  authorPublicId: string | null;
  /**
   * Where a visitor's login comes back to: the page the button is on. By default the reported
   * post's or profile's page; a card passes its list's, query and all (the community list's
   * filters, a profile's tab — built by the screen from what it parsed, `loginPathBackToPage`; a
   * 토론 card, its market detail's path).
   */
  backPath?: string;
  /**
   * The accessible name, where one page repeats the button per item: a card's names the item and
   * ends with '신고' (`reportButtonName`). By default the words on screen.
   */
  name?: string;
  /** Above a card's link overlay (`CardReportButton`). */
  raised?: boolean;
}) {
  const router = useRouter();
  const writer = usePostWriter();
  const [open, setOpen] = useState(false);
  // A card's overlay link covers the card; the button sits above it, so a press reports.
  const lift = raised ? ({ position: 'relative', zIndex: '1' } as const) : {};

  if (writer.pending || writer.failed) return null;
  if (!writer.signedIn) {
    return (
      <Button
        size="xs"
        variant="ghost"
        color="fg.muted"
        {...lift}
        aria-label={name}
        onClick={() =>
          router.push(
            (backPath === undefined
              ? loginPathBackTo(backPathOf(subject))
              : loginPathBackToPage(backPath)) as Route,
          )
        }
        data-testid="report-open"
      >
        {copy.reportAction}
      </Button>
    );
  }
  const accountId = writer.accountId;
  if (accountId === undefined || writer.publicId === undefined) return null;
  if (authorPublicId !== null && authorPublicId === writer.publicId) return null;

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        color="fg.muted"
        {...lift}
        aria-label={name}
        onClick={() => setOpen(true)}
        data-testid="report-open"
      >
        {copy.reportAction}
      </Button>
      {open && (
        <ReportDialog
          subject={subject}
          item={item}
          accountId={accountId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ReportDialog({
  subject,
  item,
  accountId,
  onClose,
}: {
  subject: ReportSubject;
  item: ReportItem;
  accountId: string;
  onClose: () => void;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const itemId = `${id}-item`;
  const { refetch: refetchSession } = useSession();
  const report = useReport(() => void refetchSession());
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [description, setDescription] = useState('');
  // The rules are said once a send was tried, and the length always once it is over.
  const [tried, setTried] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const draft = reportDraft({ reason, description });
  const pending = report.isPending;
  const reasonError = tried ? draft.reasonError : null;
  const descriptionError =
    fieldError ??
    (tried || draft.length > REPORT_DESCRIPTION_MAX_LENGTH ? draft.descriptionError : null);

  const submit = () => {
    setTried(true);
    setFieldError(null);
    setRefusal(null);
    if (draft.reason === null || draft.reasonError !== null || draft.descriptionError !== null) {
      return;
    }
    void report
      .mutateAsync({
        subject,
        reason: draft.reason,
        description: draft.description,
        expectedAccountId: accountId,
      })
      .then(() => {
        toaster.create({ type: 'success', title: copy.reportSubmitted });
        onClose();
      })
      .catch((error: unknown) => {
        const failure = reportFailure(error, subject.type);
        if (failure.kind === 'field') {
          setFieldError(failure.message);
          return;
        }
        if (isStaleReportRefusal(error)) {
          toaster.create({ type: 'error', title: failure.message });
          onClose();
          return;
        }
        setRefusal(failure.message);
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
      ids={{ title: titleId }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content aria-labelledby={`${titleId} ${itemId}`} data-testid="report-dialog">
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (!pending) submit();
              }}
            >
              <Dialog.Header>
                <Dialog.Title>{reportDialogTitle(subject.type)}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="4">
                  <Text
                    id={itemId}
                    color="fg"
                    fontWeight="medium"
                    truncate
                    minW="0"
                    data-testid="report-dialog-item"
                  >
                    {reportItemName(item)}
                  </Text>
                  <Stack gap="1.5">
                    <Dialog.Description color="fg" data-testid="report-not-a-reason">
                      {copy.reportNotAReason}
                    </Dialog.Description>
                    <Text textStyle="bodySm" color="fg.muted">
                      {copy.reportProcessNote}
                    </Text>
                  </Stack>
                  <Field.Root invalid={reasonError !== null} required>
                    <RadioGroup.Root
                      name={`${id}-reason`}
                      value={reason}
                      onValueChange={(details) => {
                        setReason(reportReasonOf(details.value ?? ''));
                        setFieldError(null);
                      }}
                      disabled={pending}
                      colorPalette="brand"
                      size="sm"
                      data-testid="report-reasons"
                    >
                      <RadioGroup.Label fontWeight="medium" mb="1">
                        {copy.reportReasonLabel}
                      </RadioGroup.Label>
                      <Stack gap="2">
                        {REPORT_REASON_OPTIONS.map((option) => (
                          <RadioGroup.Item
                            key={option.code}
                            value={option.code}
                            data-testid={`report-reason-${option.code}`}
                          >
                            <RadioGroup.ItemHiddenInput />
                            <RadioGroup.ItemIndicator />
                            <RadioGroup.ItemText>{option.label}</RadioGroup.ItemText>
                          </RadioGroup.Item>
                        ))}
                      </Stack>
                    </RadioGroup.Root>
                    <Field.ErrorText data-testid="report-reason-error">
                      {reasonError}
                    </Field.ErrorText>
                  </Field.Root>
                  <Field.Root invalid={descriptionError !== null}>
                    <Field.Label>{copy.reportDescriptionLabel}</Field.Label>
                    <Textarea
                      value={description}
                      onChange={(event) => {
                        setDescription(event.target.value);
                        setFieldError(null);
                      }}
                      placeholder={copy.reportDescriptionPlaceholder}
                      rows={3}
                      // UTF-16 units: twice the code points, so emoji are never cut short; the
                      // count below is the rule and keeps counting past it.
                      maxLength={REPORT_DESCRIPTION_MAX_LENGTH * 2}
                      disabled={pending}
                      data-testid="report-description"
                    />
                    <Field.HelperText>
                      <Box as="span" display="block">
                        {copy.reportDescriptionHint}
                      </Box>
                      <Box as="span" display="block" data-testid="report-length">
                        {reportLengthText(draft.length)}
                      </Box>
                    </Field.HelperText>
                    <Field.ErrorText data-testid="report-description-error">
                      {descriptionError}
                    </Field.ErrorText>
                  </Field.Root>
                  {refusal !== null && (
                    <Alert.Root status="error" role="alert" data-testid="report-error">
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
                  data-testid="report-cancel"
                >
                  {copy.cancel}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  colorPalette="no"
                  loading={pending}
                  data-testid="report-submit"
                >
                  {copy.reportSubmit}
                </Button>
              </Dialog.Footer>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * 신고 on a card (owner decision 2026-10-21: «'신고' 자리 → 모든 글 카드에도(커뮤니티 목록·시장 토론·프로필
 * 글·댓글 탭; 내 것과 자리표시는 뺌)»): the same button, decided the same way (none on the reader's
 * own, none for a reader `GET /me` has not answered; a visitor's press goes to the login page and
 * back to the list), in a card that opens its post as a whole. The card's link covers it
 * (`LinkBox`/`LinkOverlay`) and raises only links above itself, so this lifts the button the same way
 * — a press reports, it never opens the post — and the button is the overlay link's sibling, never
 * inside it (an interactive element nested in a link is announced and focused as part of it). Its
 * accessible name is the item's, then '신고' (`reportButtonName`, ADR-0080 7-19's way) — the item
 * as the dialog it opens names it: a list repeats it on every card. The cards that hold it list
 * published items only; a placeholder is never one of them.
 */
export function CardReportButton(
  props: Omit<Parameters<typeof ReportButton>[0], 'raised' | 'name'>,
) {
  return <ReportButton {...props} name={reportButtonName(props.item)} raised />;
}
