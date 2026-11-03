'use client';

import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  NativeSelect,
  Portal,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import {
  APPROVAL_REASON_MAX_LENGTH,
  MARKET_REJECT_REASONS,
  MARKET_REVIEW_CHECKLIST,
  type MarketRejectReason,
  type MarketReviewChecklistItem,
} from '@buddha/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { adminMarketKey, useApplyMarket } from '@/hooks/use-admin-markets';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { type AdminMarket, api, unwrap } from '@/lib/api';
import { formatKst, isoToKstLocal } from '@/lib/datetime';
import { REJECT_REASON_LABEL, REVIEW_CHECK_LABEL } from '@/lib/market-admin';
import {
  REVIEW_CHECK_HINT,
  type ReviewField,
  approveDraft,
  rejectDraft,
  rescheduleDraft,
  revertDraft,
  reviewFailure,
  reviewWriteSuccess,
} from '@/lib/market-review';

/**
 * The 개설 검수's four dialogs (#78, ADR-0099; ADR-0093 decision 2 #172 items 4·5·6): 승인 (every
 * checklist item, each a checkbox with its line of what to confirm, and the reason), 반려 (a reason
 * from the list and the 설명 the creator reads), 초안으로 되돌리기 (the reason) and 예정 개장 시각 변경
 * (the new time in KST and the reason). Each confirm stays off until what it would send is whole —
 * the server's own rules (lib/market-review.ts) — and until the admin on screen is known
 * (`useOperatorId`, ADR-0092): every write names that admin. Mounted only while the panel holds
 * it for the admin who opened it (`useHeldForOperator`), so what was checked and typed for A goes
 * with it once `['me']` turns to B (ADR-0092 answer 1). A refusal stays in the dialog, under the
 * field it is about or above the buttons (`reviewFailure`); another account's cookie closes it with
 * a toast.
 * Sent, it closes with a toast and the market as the write committed it goes on screen
 * (`useApplyMarket`). An approval or a reschedule that found the scheduled open come opened the
 * market in the same write (#21, ADR-0100): its toast says so (`reviewWriteSuccess`).
 */

export type ReviewDialogKind = 'approve' | 'reject' | 'revert' | 'reschedule';

export function ReviewDialog({
  kind,
  market,
  onClose,
}: {
  kind: ReviewDialogKind;
  market: AdminMarket;
  onClose: () => void;
}) {
  switch (kind) {
    case 'approve':
      return <ApproveDialog market={market} onClose={onClose} />;
    case 'reject':
      return <RejectDialog market={market} onClose={onClose} />;
    case 'revert':
      return <RevertDialog market={market} onClose={onClose} />;
    case 'reschedule':
      return <RescheduleDialog market={market} onClose={onClose} />;
  }
}

/** A refusal said under one of the dialog's fields. */
type FieldError = { field: ReviewField; message: string } | null;

/**
 * The submission a 승인 or 반려 dialog was opened on (Codex review of #78): its request, sent as
 * `requestId` and kept from the dialog's first draw — a refetch while it is open must not move it
 * — so a market sent back and submitted again meanwhile is decided by no confirmation its admin
 * gave the old content. `changed` once the market's pending request is another (or none): the
 * dialog says so and its confirm stays off; the server refuses the old one regardless.
 */
function useReviewedRequest(market: AdminMarket): { requestId: string | null; changed: boolean } {
  const [requestId] = useState(() => market.review.pending?.requestId ?? null);
  return {
    requestId,
    changed: requestId === null || market.review.pending?.requestId !== requestId,
  };
}

/** What each write sends, taken from the dialog when its confirm is pressed; `by` is the admin. */
interface ApproveVariables {
  requestId: string;
  checklist: MarketReviewChecklistItem[];
  reason: string;
  by: string;
}
interface RejectVariables {
  requestId: string;
  rejectReason: MarketRejectReason;
  reason: string;
  by: string;
}
interface RevertVariables {
  reason: string;
  by: string;
}
interface RescheduleVariables {
  scheduledOpenAt: string;
  reason: string;
  by: string;
}

/**
 * One review write: sent as the admin on screen, its refusal said where `reviewFailure` puts it —
 * the detail read again when the screen behind is out of date (a status another admin moved, an
 * exclusion, the open-items check, a scheduled open another admin set) — and its answer applied.
 * `success` is the toast, or how to say it from the market the write answered with (#21).
 */
function useReviewWrite<V>(
  market: AdminMarket,
  onClose: () => void,
  success: string | ((fresh: AdminMarket) => string),
  send: (variables: V) => Promise<AdminMarket>,
) {
  const apply = useApplyMarket(market.id);
  const queryClient = useQueryClient();
  const sessionChanged = useSessionChanged();
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onMutate: () => {
      setFieldError(null);
      setRefusal(null);
    },
    onSuccess: async (fresh) => {
      toaster.create({
        type: 'success',
        title: typeof success === 'string' ? success : success(fresh),
      });
      onClose();
      await apply(fresh);
    },
    onError: (error) => {
      sessionChanged(error);
      const failure = reviewFailure(error);
      if (failure.kind === 'toast') {
        // Another account's cookie: the page drops this dialog once the session names the admin
        // really signed in, so the refusal is a toast that outlives it.
        toaster.create({ type: 'error', title: failure.message });
        onClose();
        return;
      }
      if (failure.kind === 'field')
        setFieldError({ field: failure.field, message: failure.message });
      else setRefusal(failure.message);
      if (failure.refresh) {
        void queryClient.invalidateQueries({ queryKey: adminMarketKey(market.id) });
      }
    },
  });
  const errorOf = (field: ReviewField) => (fieldError?.field === field ? fieldError.message : null);
  return { mutation, errorOf, refusal };
}

/**
 * The frame every review dialog shares: the title, what the write does, the fields, a refusal above
 * the buttons, 취소 and the confirm. Pinned while the write runs — 취소, Esc and the backdrop wait, as
 * `ConfirmDialog`'s do. `testId` names the content, `-confirm`, `-cancel` and `-refusal`. The 규칙
 * 보충's dialogs (#80, market-supplement-dialogs.tsx) are drawn in it too.
 */
export function ReviewDialogShell({
  testId,
  title,
  body,
  confirmLabel,
  pending,
  confirmDisabled,
  refusal,
  onClose,
  onConfirm,
  children,
}: {
  testId: string;
  title: string;
  body: string;
  confirmLabel: string;
  pending: boolean;
  confirmDisabled: boolean;
  refusal: string | null;
  onClose: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
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
          <Dialog.Content data-testid={testId}>
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (!pending && !confirmDisabled) onConfirm();
              }}
            >
              <Dialog.Header>
                <Dialog.Title>{title}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="4">
                  <Dialog.Description color="fg">{body}</Dialog.Description>
                  {children}
                  {refusal !== null && (
                    <Alert.Root status="error" role="alert" data-testid={`${testId}-refusal`}>
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
                  data-testid={`${testId}-cancel`}
                >
                  {copy.cancel}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  loading={pending}
                  disabled={confirmDisabled}
                  data-testid={`${testId}-confirm`}
                >
                  {confirmLabel}
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
 * A reason (or a 반려's 설명): required, at most APPROVAL_REASON_MAX_LENGTH characters, recorded in
 * the 검수 기록 with the admin and the time — or, under another `hint`, where the 규칙 보충's reasons
 * go (#80). `testId` names the textarea and `-error` its refusal.
 */
export function ReasonField({
  testId,
  label,
  value,
  onChange,
  error,
  disabled,
  hint = copy.adminMarketReviewReasonHint,
}: {
  testId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <Field.Root invalid={error !== null} required>
      <Field.Label>{label}</Field.Label>
      <Textarea
        rows={3}
        value={value}
        maxLength={APPROVAL_REASON_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        data-testid={testId}
      />
      <Field.HelperText>{hint}</Field.HelperText>
      <Field.ErrorText data-testid={`${testId}-error`}>{error}</Field.ErrorText>
    </Field.Root>
  );
}

/**
 * 승인's fields: every checklist item in MARKET_REVIEW_CHECKLIST order, a checkbox whose label is the
 * item's name with its line of what to confirm under it (#172 item 4) — the test id on the label
 * element, so a click on it is the click that checks — then the reason.
 */
export function ApproveFields({
  checked,
  onToggle,
  reason,
  onReason,
  reasonError,
  checklistError,
  disabled,
}: {
  checked: readonly MarketReviewChecklistItem[];
  onToggle: (item: MarketReviewChecklistItem, on: boolean) => void;
  reason: string;
  onReason: (value: string) => void;
  reasonError: string | null;
  checklistError: string | null;
  disabled: boolean;
}) {
  return (
    <Stack gap="4">
      <Stack gap="2" data-testid="market-review-checklist">
        <Text fontWeight="medium">{copy.adminMarketReviewChecklist}</Text>
        <Text fontSize="sm" color="fg.muted">
          {copy.adminMarketReviewChecklistHint}
        </Text>
        {MARKET_REVIEW_CHECKLIST.map((item) => (
          <Checkbox.Root
            key={item}
            checked={checked.includes(item)}
            onCheckedChange={(details) => onToggle(item, details.checked === true)}
            disabled={disabled}
            colorPalette="brand"
            alignItems="flex-start"
            data-testid={`market-review-check-${item}`}
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control mt="0.5" />
            <Stack gap="0">
              <Checkbox.Label>{REVIEW_CHECK_LABEL[item]}</Checkbox.Label>
              <Text fontSize="sm" color="fg.muted">
                {REVIEW_CHECK_HINT[item]}
              </Text>
            </Stack>
          </Checkbox.Root>
        ))}
        {checklistError !== null && (
          <Text fontSize="sm" color="fg.error" data-testid="market-review-checklist-error">
            {checklistError}
          </Text>
        )}
      </Stack>
      <ReasonField
        testId="market-review-approve-reason"
        label={copy.adminMarketReviewReason}
        value={reason}
        onChange={onReason}
        error={reasonError}
        disabled={disabled}
      />
    </Stack>
  );
}

/**
 * 승인 (REVIEW → SCHEDULED, and on to OPEN at once when the scheduled open has passed — #21,
 * ADR-0100): the confirm waits for every item and a reason (`approveDraft`).
 */
function ApproveDialog({ market, onClose }: { market: AdminMarket; onClose: () => void }) {
  const operatorId = useOperatorId();
  const [checked, setChecked] = useState<MarketReviewChecklistItem[]>([]);
  const [reasonText, setReasonText] = useState('');
  const draft = approveDraft(checked, reasonText);
  const reviewed = useReviewedRequest(market);
  const { mutation, errorOf, refusal } = useReviewWrite(
    market,
    onClose,
    (approved) => reviewWriteSuccess('approve', approved.status),
    async ({ requestId, checklist, reason, by }: ApproveVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/approve', {
          params: { path: { id: market.id } },
          body: { requestId, checklist, reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-review-approve-dialog"
      title={copy.adminMarketReviewApproveTitle}
      body={copy.adminMarketReviewApproveBody}
      confirmLabel={copy.adminMarketReviewApprove}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || reviewed.changed}
      refusal={refusal ?? (reviewed.changed ? copy.adminMarketReviewRequestChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        const { requestId } = reviewed;
        if (operatorId === undefined || requestId === null) return;
        mutation.mutate({
          requestId,
          checklist: draft.checklist,
          reason: draft.reason,
          by: operatorId,
        });
      }}
    >
      <ApproveFields
        checked={checked}
        onToggle={(item, on) =>
          setChecked((held) => (on ? [...held, item] : held.filter((other) => other !== item)))
        }
        reason={reasonText}
        onReason={setReasonText}
        reasonError={errorOf('reason')}
        checklistError={errorOf('checklist')}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/** 반려's fields: the reason from the list (the checklist's names and 기타), then the 설명. */
export function RejectFields({
  value,
  onValue,
  description,
  onDescription,
  reasonError,
  descriptionError,
  disabled,
}: {
  value: string;
  onValue: (value: string) => void;
  description: string;
  onDescription: (value: string) => void;
  reasonError: string | null;
  descriptionError: string | null;
  disabled: boolean;
}) {
  return (
    <Stack gap="4">
      <Field.Root invalid={reasonError !== null} required>
        <Field.Label>{copy.adminMarketReviewRejectReason}</Field.Label>
        <NativeSelect.Root disabled={disabled}>
          <NativeSelect.Field
            value={value}
            onChange={(event) => onValue(event.target.value)}
            placeholder={copy.adminMarketReviewRejectReasonPlaceholder}
            data-testid="market-review-reject-reason"
          >
            {MARKET_REJECT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {REJECT_REASON_LABEL[reason]}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
        <Field.ErrorText data-testid="market-review-reject-reason-error">
          {reasonError}
        </Field.ErrorText>
      </Field.Root>
      <ReasonField
        testId="market-review-reject-description"
        label={copy.adminMarketReviewRejectDescription}
        value={description}
        onChange={onDescription}
        error={descriptionError}
        disabled={disabled}
      />
    </Stack>
  );
}

/** 반려 (REVIEW → DRAFT): the confirm waits for a reason picked and a 설명 (`rejectDraft`). */
function RejectDialog({ market, onClose }: { market: AdminMarket; onClose: () => void }) {
  const operatorId = useOperatorId();
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const draft = rejectDraft(value, description);
  const reviewed = useReviewedRequest(market);
  const { mutation, errorOf, refusal } = useReviewWrite(
    market,
    onClose,
    copy.adminMarketReviewRejected,
    async ({ requestId, rejectReason, reason, by }: RejectVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/reject', {
          params: { path: { id: market.id } },
          body: { requestId, rejectReason, reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-review-reject-dialog"
      title={copy.adminMarketReviewRejectTitle}
      body={copy.adminMarketReviewRejectBody}
      confirmLabel={copy.adminMarketReviewReject}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined || reviewed.changed}
      refusal={refusal ?? (reviewed.changed ? copy.adminMarketReviewRequestChanged : null)}
      onClose={onClose}
      onConfirm={() => {
        const { requestId } = reviewed;
        if (operatorId === undefined || requestId === null || draft.rejectReason === null) return;
        mutation.mutate({
          requestId,
          rejectReason: draft.rejectReason,
          reason: draft.reason,
          by: operatorId,
        });
      }}
    >
      <RejectFields
        value={value}
        onValue={setValue}
        description={description}
        onDescription={setDescription}
        reasonError={errorOf('rejectReason')}
        descriptionError={errorOf('reason')}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/**
 * 초안으로 되돌리기 (REVIEW or SCHEDULED → DRAFT), open to every admin, the creator too (#172 item 6):
 * what it does in each status — in review the submitter's own retracts the request and anyone
 * else's rejects it with this reason; from scheduled the market leaves the public screens — and the
 * reason (`revertDraft`).
 */
function RevertDialog({ market, onClose }: { market: AdminMarket; onClose: () => void }) {
  const operatorId = useOperatorId();
  const [reasonText, setReasonText] = useState('');
  const draft = revertDraft(reasonText);
  const { mutation, errorOf, refusal } = useReviewWrite(
    market,
    onClose,
    copy.adminMarketReviewReverted,
    async ({ reason, by }: RevertVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/revert', {
          params: { path: { id: market.id } },
          body: { reason, expectedAccountId: by },
        }),
      ).data,
  );
  return (
    <ReviewDialogShell
      testId="market-review-revert-dialog"
      title={copy.adminMarketReviewRevertTitle}
      body={
        market.status === 'scheduled'
          ? copy.adminMarketReviewRevertScheduledBody
          : copy.adminMarketReviewRevertReviewBody
      }
      confirmLabel={copy.adminMarketReviewRevert}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined}
      refusal={refusal}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId !== undefined) mutation.mutate({ reason: draft.reason, by: operatorId });
      }}
    >
      <ReasonField
        testId="market-review-revert-reason"
        label={copy.adminMarketReviewReason}
        value={reasonText}
        onChange={setReasonText}
        error={errorOf('reason')}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}

/**
 * 예정 개장 시각 변경's fields: the market's scheduled open and close as they stand, the new time as a
 * KST `datetime-local` like the form's — the order rule's sentence under it as soon as it is broken
 * (`rescheduleDraft`), or the server's refusal — then the reason.
 */
export function RescheduleFields({
  market,
  local,
  onLocal,
  atError,
  reason,
  onReason,
  reasonError,
  disabled,
}: {
  market: Pick<AdminMarket, 'scheduledOpenAt' | 'closeAt'>;
  local: string;
  onLocal: (value: string) => void;
  atError: string | null;
  reason: string;
  onReason: (value: string) => void;
  reasonError: string | null;
  disabled: boolean;
}) {
  return (
    <Stack gap="4">
      <Text fontSize="sm" color="fg.muted" data-testid="market-review-reschedule-current">
        {copy.adminMarketScheduledOpenAt}{' '}
        {market.scheduledOpenAt === null ? '—' : formatKst(market.scheduledOpenAt)} ·{' '}
        {copy.adminMarketCloseAt} {formatKst(market.closeAt)}
      </Text>
      <Field.Root invalid={atError !== null} required>
        <Field.Label>{copy.adminMarketReviewRescheduleAt}</Field.Label>
        <Input
          type="datetime-local"
          value={local}
          onChange={(event) => onLocal(event.target.value)}
          disabled={disabled}
          data-testid="market-review-reschedule-at"
        />
        <Field.HelperText>{copy.adminMarketReviewRescheduleAtHint}</Field.HelperText>
        <Field.ErrorText data-testid="market-review-reschedule-at-error">{atError}</Field.ErrorText>
      </Field.Root>
      <ReasonField
        testId="market-review-reschedule-reason"
        label={copy.adminMarketReviewReason}
        value={reason}
        onChange={onReason}
        error={reasonError}
        disabled={disabled}
      />
    </Stack>
  );
}

/**
 * 예정 개장 시각 변경 (SCHEDULED, no new review; ADR-0093 decision 3 '#21 앞당긴 개장'): the field
 * opens on the time the market holds, and the confirm waits until it moves to an ordered instant
 * and a reason is typed (`rescheduleDraft`). A refusal of the time — the order, or 'unchanged'
 * after another admin's change — goes under the field while the field holds the time it was sent
 * with. A time at or before now opens the market in the same write (#21, ADR-0100), and the toast
 * says so.
 */
function RescheduleDialog({ market, onClose }: { market: AdminMarket; onClose: () => void }) {
  const operatorId = useOperatorId();
  const [local, setLocal] = useState(() =>
    market.scheduledOpenAt === null ? '' : isoToKstLocal(market.scheduledOpenAt),
  );
  const [reasonText, setReasonText] = useState('');
  const [sentLocal, setSentLocal] = useState<string | null>(null);
  const draft = rescheduleDraft(local, reasonText, market);
  const { mutation, errorOf, refusal } = useReviewWrite(
    market,
    onClose,
    (moved) => reviewWriteSuccess('reschedule', moved.status),
    async ({ scheduledOpenAt, reason, by }: RescheduleVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/markets/{id}/reschedule', {
          params: { path: { id: market.id } },
          body: { scheduledOpenAt, reason, expectedAccountId: by },
        }),
      ).data,
  );
  // The server's refusal of the time holds while the field holds what was sent; the rule's own
  // sentence comes first once the admin types again.
  const serverAtError = sentLocal === local ? errorOf('scheduledOpenAt') : null;
  return (
    <ReviewDialogShell
      testId="market-review-reschedule-dialog"
      title={copy.adminMarketReviewRescheduleTitle}
      body={copy.adminMarketReviewRescheduleBody}
      confirmLabel={copy.adminMarketReviewReschedule}
      pending={mutation.isPending}
      confirmDisabled={!draft.ready || operatorId === undefined}
      refusal={refusal}
      onClose={onClose}
      onConfirm={() => {
        if (operatorId === undefined || draft.scheduledOpenAt === null) return;
        setSentLocal(local);
        mutation.mutate({
          scheduledOpenAt: draft.scheduledOpenAt,
          reason: draft.reason,
          by: operatorId,
        });
      }}
    >
      <RescheduleFields
        market={market}
        local={local}
        onLocal={setLocal}
        atError={draft.atError ?? serverAtError}
        reason={reasonText}
        onReason={setReasonText}
        reasonError={errorOf('reason')}
        disabled={mutation.isPending}
      />
    </ReviewDialogShell>
  );
}
