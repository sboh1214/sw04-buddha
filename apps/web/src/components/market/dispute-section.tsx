'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  CloseButton,
  DataList,
  Dialog,
  Field,
  HStack,
  Heading,
  Input,
  Link as ChakraLink,
  Portal,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { DISPUTE_EVIDENCE_URL_MAX, DISPUTE_REASON_MAX } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, type RefObject, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { EmptyState } from '@/components/ui/empty-state';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useFileDispute, useMyDispute } from '@/hooks/use-disputes';
import { type CreateDisputeBody, type Dispute, type Market } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  type DisputeFormValues,
  EMPTY_DISPUTE_FORM,
  disputeErrorMessage,
  disputeFieldError,
  disputeFormSchema,
  disputeRefusalEndsDialog,
  disputeSectionView,
  disputeSectionWanted,
  toCreateDisputeBody,
} from '@/lib/dispute';
import { DISPUTE_STATUS_LABEL, DISPUTE_STATUS_PALETTE } from '@/lib/market-admin';

/**
 * 이의 제기 on the market detail (PLAN 11.3: `resolving`이면 결과·이의 마감시각·이의 제기 버튼;
 * PLAN 5.5; M5 design 5.3): what this visitor may do about the proposed result, and what they
 * already did.
 *
 * Nothing here decides anything. Which state to draw is `disputeSectionView` (lib/dispute.ts),
 * what the form accepts is `disputeFormSchema`, and what a refusal becomes is
 * `disputeFieldError` / `disputeErrorMessage` / `disputeRefusalEndsDialog` — all pure, because
 * this file cannot be executed by this app's test runner (`environment: 'node'`, no jsdom).
 *
 * The row is `useMyDispute`, a session-gated query like 내 포지션's, and the card walks the same
 * ladder (`sessionListSection`) so the two cards on one screen cannot disagree about the same
 * session. It renders NOTHING for most of a market's life: only a `resolving` market has
 * anything to object to, and a finished one keeps the card only for the account that filed.
 */

export interface DisputeSectionProps {
  /** The live market row the detail screen holds; `status` and `disputeUntil` drive the card. */
  market: Market;
  /**
   * The detail's own server instant — the ticks window end `MarketDetail` already passes to the
   * countdown and the trade panel — which the dispute deadline is measured against. Never
   * `Date.now()` in a render (a hydration mismatch on the page AC 2 measures, and a comparison
   * of two machines' clocks against a DATABASE deadline). It does not tick: the window is a day
   * long, the row re-evaluates on its own refetch, and the server's refusal closes the card on
   * the spot for the reader who pressed after the deadline (`disputeSectionView`).
   */
  now?: number;
}

export function DisputeSection({ market, now }: DisputeSectionProps) {
  // The row is asked for only where the card could draw it — never on an open market, whose
  // detail is the app's most visited screen and would otherwise cost a private request a visit.
  const mine = useMyDispute(market.id, disputeSectionWanted(market.status));
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const file = useFileDispute(market.id, () => {
    // Fires BEFORE the cache work (`useFileDispute` awaits it after), so the toast and the
    // closing dialog are instant while the button stays disabled until the row has landed.
    //
    // It does not fire at all when the account changed under the request (`disputeAnswerScope`),
    // so this toast can never tell somebody they filed an objection they did not file. The
    // dialog then stays open with the reader's own typed text, which is what the card behind it
    // says too: their own row is still null, so the section reads `canFile`.
    toaster.create({ type: 'success', title: copy.disputeFiled });
    setOpen(false);
  });
  // The reason field, focused when the dialog opens: the dialog's first tabbable is otherwise
  // its close button, and the one thing a reader opened it to do is type.
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  const view = disputeSectionView({
    market,
    now,
    query: mine,
    dispute: mine.data,
    refusal: file.error,
  });
  if (view.kind === 'hidden') return null;

  return (
    <Card.Root data-testid="dispute-section">
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.disputeTitle}
        </Heading>
      </Card.Header>
      <Card.Body>
        {view.kind === 'signedOut' ? (
          <EmptyState
            message={copy.disputeLoginToFile}
            action={
              <Button asChild size="sm" variant="outline" data-testid="dispute-login">
                {/* Back to the market they were reading, which is the whole reason the prompt
                    is here rather than a bare link to /login (the 내 포지션 precedent). */}
                <NextLink href={{ pathname: '/login', query: { next: pathname } }}>
                  {copy.login}
                </NextLink>
              </Button>
            }
          />
        ) : view.kind === 'pending' ? (
          <Skeleton height="10" />
        ) : view.kind === 'failed' ? (
          <Stack gap="2" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={() => void mine.refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : view.kind === 'filed' ? (
          <Stack gap="3">
            {/* Above the row, never in place of it: the row is real and the review it shows
                is worth keeping on screen (the 내 포지션 shape). */}
            {view.stale && (
              <Alert.Root status="warning" role="status" data-testid="dispute-stale">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
                </Alert.Content>
                <Button size="xs" variant="outline" ml="auto" onClick={() => void mine.refetch()}>
                  {copy.retry}
                </Button>
              </Alert.Root>
            )}
            <FiledDispute dispute={view.dispute} />
          </Stack>
        ) : view.kind === 'windowClosed' ? (
          <Text color="fg.muted" data-testid="dispute-window-closed">
            {copy.disputeWindowClosed}
          </Text>
        ) : view.kind === 'notResolving' ? (
          <Text color="fg.muted" data-testid="dispute-not-resolving">
            {copy.disputeNotResolving}
          </Text>
        ) : (
          <Stack gap="3" align="flex-start">
            <Text>{copy.disputeIntro}</Text>
            <DataList.Root orientation="horizontal" size="sm">
              <DataList.Item>
                <DataList.ItemLabel>{copy.disputeWindowUntil}</DataList.ItemLabel>
                <DataList.ItemValue data-testid="dispute-window-until">
                  {formatKst(view.disputeUntil)}
                </DataList.ItemValue>
              </DataList.Item>
            </DataList.Root>
            <Button
              aria-haspopup="dialog"
              onClick={() => {
                setOpen(true);
              }}
              data-testid="dispute-open"
            >
              {copy.disputeOpen}
            </Button>
          </Stack>
        )}
      </Card.Body>

      {/* Mounted only while open (`lazyMount unmountOnExit`), so the form inside starts blank on
          every opening and a closed dialog answers no test id. Pinned while the request runs:
          Cancel, Esc and the backdrop all wait, since dismissing it mid-flight would leave the
          request running against a card that no longer shows it (the admin ConfirmDialog rule).
          `role="dialog"`, not `alertdialog`: this is a form to fill, not a confirmation. */}
      <Dialog.Root
        open={open}
        onOpenChange={(details) => {
          if (!details.open && !file.isPending) setOpen(false);
        }}
        role="dialog"
        lazyMount
        unmountOnExit
        closeOnInteractOutside={!file.isPending}
        closeOnEscape={!file.isPending}
        initialFocusEl={() => reasonRef.current}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content data-testid="dispute-dialog">
              <DisputeForm
                submitting={file.isPending}
                reasonRef={reasonRef}
                onCancel={() => {
                  setOpen(false);
                }}
                submit={(body) => file.mutateAsync(body)}
                onRefused={(error) => {
                  if (disputeRefusalEndsDialog(error)) setOpen(false);
                }}
              />
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Card.Root>
  );
}

/**
 * 이의 접수됨 · <status> — the account's own row, read-only. The status is a badge AND a word
 * (PLAN 11.2: never colour alone), and the admin's note appears once there is one, which is
 * the whole reason a finished market keeps this card: 기각 with its reason is the answer the
 * filer is waiting for.
 */
function FiledDispute({ dispute }: { dispute: Dispute }) {
  return (
    <Stack gap="3" data-testid="dispute-filed">
      <HStack gap="2" flexWrap="wrap">
        <Text fontWeight="medium">{copy.disputeFiledState}</Text>
        <Badge
          colorPalette={DISPUTE_STATUS_PALETTE[dispute.status]}
          variant="subtle"
          data-testid="dispute-status"
        >
          {DISPUTE_STATUS_LABEL[dispute.status]}
        </Badge>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        <Item label={copy.disputeReason}>
          <Stack gap="1">
            {/* The reason was typed in a textarea, so its line breaks are its own. */}
            <Text whiteSpace="pre-wrap" data-testid="dispute-filed-reason">
              {dispute.reason}
            </Text>
            {dispute.evidenceUrl !== null && (
              <ChakraLink
                href={dispute.evidenceUrl}
                target="_blank"
                rel="noopener noreferrer"
                colorPalette="brand"
                color="colorPalette.fg"
                wordBreak="break-all"
                data-testid="dispute-filed-evidence"
              >
                {dispute.evidenceUrl}
              </ChakraLink>
            )}
          </Stack>
        </Item>
        <Item label={copy.disputeFiledAt}>{formatKst(dispute.createdAt)}</Item>
        {dispute.adminNote !== null && dispute.adminNote !== '' && (
          <Item label={copy.disputeAdminNote}>
            <Text whiteSpace="pre-wrap" data-testid="dispute-admin-note">
              {dispute.adminNote}
            </Text>
          </Item>
        )}
      </DataList.Root>
    </Stack>
  );
}

interface DisputeFormProps {
  submitting: boolean;
  reasonRef: RefObject<HTMLTextAreaElement | null>;
  onCancel: () => void;
  /** `useFileDispute.mutateAsync`: rejects with the refusal after the cache was corrected. */
  submit: (body: CreateDisputeBody) => Promise<unknown>;
  /** Told about every refusal that is not a field error, after it has been toasted. */
  onRefused: (error: unknown) => void;
}

/**
 * The dialog's body: reason (required) and evidence URL (optional), a react-hook-form with the
 * zod resolver like every form in this app. Mounted inside the dialog's content, so it is a
 * fresh form on every opening — no `reset` on close to forget, and no cancelled text or lit
 * error reappearing next time.
 */
function DisputeForm({ submitting, reasonRef, onCancel, submit, onRefused }: DisputeFormProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<DisputeFormValues>({
    resolver: zodResolver(disputeFormSchema),
    defaultValues: EMPTY_DISPUTE_FORM,
  });
  // `register` owns a ref of its own; the dialog's initial-focus ref rides beside it.
  const { ref: registerReason, ...reasonField } = register('reason');

  const onSubmit = handleSubmit(async (values) => {
    try {
      await submit(toCreateDisputeBody(values));
    } catch (error) {
      // `useFileDispute.onError` has already corrected whichever cache the refusal contradicts.
      // A refusal ABOUT a field goes under that field, where a 375px screen can see it; the rest
      // is a toast, and whether the dialog survives it is `disputeRefusalEndsDialog`'s call.
      const fieldError = disputeFieldError(error);
      if (fieldError !== undefined) {
        setError(fieldError.field, { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: disputeErrorMessage(error) });
      onRefused(error);
    }
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate>
      <Dialog.Header>
        <Dialog.Title>{copy.disputeTitle}</Dialog.Title>
        <Dialog.CloseTrigger asChild>
          <CloseButton
            size="sm"
            aria-label={copy.cancel}
            disabled={submitting}
            data-testid="dispute-close"
          />
        </Dialog.CloseTrigger>
      </Dialog.Header>
      <Dialog.Body>
        <Stack gap="4">
          <Text color="fg.muted">{copy.disputeIntro}</Text>
          <Field.Root invalid={errors.reason !== undefined} required disabled={submitting}>
            <Field.Label>{copy.disputeReason}</Field.Label>
            <Textarea
              rows={4}
              maxLength={DISPUTE_REASON_MAX}
              data-testid="dispute-reason"
              {...reasonField}
              ref={(element) => {
                registerReason(element);
                reasonRef.current = element;
              }}
            />
            <Field.HelperText>{copy.disputeReasonHint}</Field.HelperText>
            <Field.ErrorText>{errors.reason?.message}</Field.ErrorText>
          </Field.Root>
          <Field.Root invalid={errors.evidenceUrl !== undefined} disabled={submitting}>
            <Field.Label>{copy.disputeEvidence}</Field.Label>
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              maxLength={DISPUTE_EVIDENCE_URL_MAX}
              data-testid="dispute-evidence"
              {...register('evidenceUrl')}
            />
            <Field.ErrorText>{errors.evidenceUrl?.message}</Field.ErrorText>
          </Field.Root>
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={submitting}
          onClick={onCancel}
          data-testid="dispute-cancel"
        >
          {copy.cancel}
        </Button>
        <Button type="submit" size="sm" loading={submitting} data-testid="dispute-submit">
          {copy.disputeSubmit}
        </Button>
      </Dialog.Footer>
    </form>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue>{children}</DataList.ItemValue>
    </DataList.Item>
  );
}
