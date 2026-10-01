'use client';

import {
  Alert,
  Badge,
  Button,
  Link as ChakraLink,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  RadioGroup,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { formatKrw, formatP, parsePAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Fragment, type Ref, useEffect, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useAdminPayments, useRefundPayment, useSettlePayment } from '@/hooks/use-admin-payments';
import { usePaymentProvider } from '@/hooks/use-wallet';
import { type AdminPayment } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from '@/lib/market-admin';
import {
  type RefundAction,
  type RefundFormValues,
  SETTLE_OUTCOME_VIEW,
  type SettleErrorView,
  type SettleFormOutput,
  type SettleFormValues,
  merchantAdminSites,
  merchantOrderId,
  offersSettle,
  paymentFailureReason,
  paymentMethodLabel,
  type RefundErrorView,
  refundAction,
  refundDeadline,
  refundErrorView,
  refundFormSchema,
  refundKeepsDialog,
  settleErrorView,
  settleFormSchema,
  settleKeepsDialog,
  settleOutcomesFor,
  toSettleBody,
} from '@/lib/smartro-payments';

/**
 * PLAN 12 결제 목록: every charge, newest first, 20 per page with 더 보기 (A-M2-5), with the
 * admin refund of ADR-0042 (owner decision 5, 「관리자 환불」) on the rows that allow one, and 수동
 * 정리 on the SmartroPay rows the API could not settle by itself (`needsReview`, 확인 필요).
 */
export function AdminPayments() {
  const payments = useAdminPayments();
  const rows = payments.data?.pages.flatMap((page) => page.items) ?? [];

  if (payments.isPending) return <Skeleton height="24" />;
  if (payments.isError) {
    return (
      <Alert.Root status="error" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.errUnknown}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }
  if (rows.length === 0) return <Text color="fg.muted">{copy.adminNoPayments}</Text>;

  return (
    <Stack gap="2">
      {rows.map((payment) => (
        <PaymentRow key={payment.id} payment={payment} />
      ))}
      {payments.hasNextPage && (
        <Button
          alignSelf="center"
          size="sm"
          variant="ghost"
          loading={payments.isFetchingNextPage}
          onClick={() => void payments.fetchNextPage()}
          data-testid="admin-payments-more"
        >
          {copy.loadMore}
        </Button>
      )}
    </Stack>
  );
}

/**
 * One charge: who, how much, its status, the PG's method and reference, when it was made and
 * approved (and refunded), the PG's last word on a failure — the refund button when
 * `refundAction` offers one, and 수동 정리 beside it when `offersSettle` does (a flagged row
 * carries 확인 필요 as well). `Date.now()` is read in render through `refundAction`'s default,
 * as `isClosingSoon` is on the market list: the admin query never runs on the server, so
 * there is no hydration to mismatch.
 */
function PaymentRow({ payment }: { payment: AdminPayment }) {
  const [refunding, setRefunding] = useState<RefundAction | null>(null);
  const [settling, setSettling] = useState(false);
  const action = refundAction(payment);
  const settle = offersSettle(payment);
  const method = paymentMethodLabel(payment.method);
  const reason = paymentFailureReason(payment);
  return (
    <HStack
      justify="space-between"
      align="start"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="3"
      flexWrap="wrap"
      data-testid={`admin-payment-${payment.id}`}
    >
      <Stack gap="0.5" minW="0">
        <HStack gap="2" flexWrap="wrap">
          <Text fontWeight="semibold">{payment.nickname}</Text>
          <Text>{formatP(parsePAmount(payment.amountP))}</Text>
          <Text color="fg.muted">{formatKrw(payment.priceKrw)}</Text>
          <Badge
            colorPalette={PAYMENT_STATUS_PALETTE[payment.status]}
            variant="subtle"
            data-testid="admin-payment-status"
          >
            {PAYMENT_STATUS_LABEL[payment.status]}
          </Badge>
          {payment.needsReview && (
            <Badge colorPalette="no" variant="solid" data-testid="admin-payment-needs-review">
              {copy.adminPaymentNeedsReview}
            </Badge>
          )}
          {method !== null && <Badge variant="outline">{method}</Badge>}
        </HStack>
        {/* After a credit this is the approval's Tid the settle stored (the refund cancels it). */}
        <Text fontSize="xs" color="fg.muted" fontFamily="mono" wordBreak="break-all">
          {payment.provider}
          {payment.providerRef ? ` · ${payment.providerRef}` : ''}
        </Text>
        {payment.approvedAt !== null && (
          <Text fontSize="xs" color="fg.muted">
            {copy.paymentApprovedAt} {formatKst(payment.approvedAt)}
            {payment.refundedAt !== null &&
              ` · ${copy.paymentRefundedAt} ${formatKst(payment.refundedAt)}`}
            {action === 'refund' &&
              ` · ${copy.adminPaymentRefundDeadline} ${formatKst(new Date(refundDeadline(payment)).toISOString())}`}
          </Text>
        )}
        {reason !== null && (
          <Text fontSize="xs" color="fg.muted" wordBreak="break-word">
            {copy.paymentResultReason} {reason}
          </Text>
        )}
      </Stack>
      <Stack gap="2" align="end">
        <Text fontSize="sm" color="fg.muted">
          {formatKst(payment.createdAt)}
        </Text>
        {(action !== null || settle) && (
          <HStack gap="2" flexWrap="wrap" justify="end">
            {action !== null && (
              <Button
                size="xs"
                variant="outline"
                colorPalette={action === 'retry' ? 'orange' : undefined}
                onClick={() => setRefunding(action)}
                data-testid={`admin-payment-refund-${payment.id}`}
              >
                {action === 'retry' ? copy.adminPaymentRefundRetry : copy.adminPaymentRefund}
              </Button>
            )}
            {settle && (
              <Button
                size="xs"
                variant="outline"
                colorPalette="no"
                onClick={() => setSettling(true)}
                data-testid={`admin-payment-settle-${payment.id}`}
              >
                {copy.adminPaymentSettle}
              </Button>
            )}
          </HStack>
        )}
      </Stack>
      {refunding !== null && (
        <RefundDialog payment={payment} action={refunding} onClose={() => setRefunding(null)} />
      )}
      {/* Mounted until it closes itself, not while the row allows it: the answer re-renders
          the row first (seeded, then refetched), and an unmounted dialog would drop the toast
          that says how it ended (a mutate call's callbacks die with its observer). */}
      {settling && <SettleDialog payment={payment} onClose={() => setSettling(false)} />}
    </HStack>
  );
}

/**
 * How long a refusal's toast stays when it says what to do next (a description): the admin has
 * to read up to ~200 characters of Korean and act on them — zag's 5 s for an error is not
 * enough — and can close it once done.
 */
const GUIDANCE_TOAST_MS = 20_000;

/** The toast for a refused payment action, kept longer and closable when it carries guidance. */
function refusalToast(view: RefundErrorView) {
  toaster.create({
    type: 'error',
    title: view.title,
    ...(view.description === undefined
      ? {}
      : { description: view.description, duration: GUIDANCE_TOAST_MS, closable: true }),
  });
}

/**
 * The refund confirmation with its required reason (ADR-0042). The disputes' review dialog
 * shape: `alertdialog`, pinned while the request runs — Cancel, Esc and the backdrop all wait,
 * since a refund takes P from a member and money back through the PG and the admin must see
 * how it ended. The reason is a form (zodResolver), refused under the field when blank.
 *
 * A refusal closes the dialog (the list has been refreshed to the row's new state, with its
 * own button if one is left), except the reason being refused and a request that never came
 * back (`refundKeepsDialog`).
 */
function RefundDialog({
  payment,
  action,
  onClose,
}: {
  payment: AdminPayment;
  action: RefundAction;
  onClose: () => void;
}) {
  const refund = useRefundPayment();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RefundFormValues>({
    resolver: zodResolver(refundFormSchema),
    defaultValues: { reason: '' },
  });
  const loading = refund.isPending;

  const submit = handleSubmit((values) => {
    refund.mutate(
      { id: payment.id, body: { reason: values.reason } },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.adminPaymentRefunded });
          onClose();
        },
        onError: (error) => {
          refusalToast(refundErrorView(error));
          if (!refundKeepsDialog(error)) onClose();
        },
      },
    );
  });

  const retry = action === 'retry';
  return (
    <Dialog.Root
      open
      onOpenChange={(details) => {
        if (!details.open && !loading) onClose();
      }}
      role="alertdialog"
      lazyMount
      unmountOnExit
      closeOnInteractOutside={!loading}
      closeOnEscape={!loading}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                {retry ? copy.adminPaymentRefundRetryTitle : copy.adminPaymentRefundTitle}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Text fontWeight="medium">
                  {payment.nickname} · {formatP(parsePAmount(payment.amountP))} ·{' '}
                  {formatKrw(payment.priceKrw)}
                </Text>
                <Text>
                  {retry ? copy.adminPaymentRefundRetryBody : copy.adminPaymentRefundBody}
                </Text>
                <Field.Root invalid={!!errors.reason} required>
                  <Field.Label>{copy.adminPaymentRefundReason}</Field.Label>
                  <Textarea rows={3} data-testid="payment-refund-reason" {...register('reason')} />
                  {errors.reason ? (
                    <Field.ErrorText>{errors.reason.message}</Field.ErrorText>
                  ) : (
                    <Field.HelperText>{copy.adminPaymentRefundReasonHint}</Field.HelperText>
                  )}
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={onClose}
                data-testid="payment-refund-cancel"
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                colorPalette="no"
                loading={loading}
                onClick={() => void submit()}
                data-testid="payment-refund-confirm"
              >
                {retry ? copy.adminPaymentRefundRetry : copy.adminPaymentRefundSubmit}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * 수동 정리 (ADR-0042): the admin records what SmartroPay's merchant admin shows for a payment
 * the API could not settle by itself. The dialog first sends them there (the deployment's site,
 * the order number to search by), then offers only the outcomes the row's status allows
 * (`settleOutcomesFor`), each described by what it does. A credit takes the approval's Tid as
 * the merchant admin shows it — typed, never taken from `providerRef` (the authentication's
 * Tid, which may not be the approval's) — and the API needs it only when no successful approval
 * is on record, when it names `tid` and the refusal lands under that field. The reason is
 * required. Nothing is sent before a second step that repeats the choice: a settle moves P and
 * cannot be undone. Pinned while the request runs, like the refund dialog, and never closed by
 * a click outside it: what the admin typed would go with it.
 *
 * A refusal the admin answers here (`settleKeepsDialog`: a field, the Tid or the outcome to
 * change, a request to repeat later) goes back to the first step — under the field it is about,
 * or as an alert at the top that stays until the next attempt; any other closes the dialog over
 * the refreshed list, with a toast.
 *
 * Focus follows each step change (`focusNext`), since the footer's buttons are not the same
 * buttons from one step to the next (keyed): the summary on the second step — never 정리하기,
 * where a second Enter would send what the step is there to show once more — and the choice,
 * the refused field or the alert back on the first.
 */
function SettleDialog({ payment, onClose }: { payment: AdminPayment; onClose: () => void }) {
  const settle = useSettlePayment();
  // From the row as it is now: a refresh that moved it (another admin, a 재통보) changes what
  // the dialog offers — nothing at all once there is nothing left to settle.
  const outcomes = settleOutcomesFor(payment);
  const provider = usePaymentProvider();
  // The values the second step shows and sends; null on the first step.
  const [confirming, setConfirming] = useState<SettleFormOutput | null>(null);
  // The last refusal the dialog stayed open for that names no field; cleared on the next attempt.
  const [refusal, setRefusal] = useState<SettleErrorView | null>(null);
  const focusNext = useRef<SettleFocus | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const refusalRef = useRef<HTMLDivElement>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    setValue,
    formState: { errors },
  } = useForm<SettleFormValues, unknown, SettleFormOutput>({
    resolver: zodResolver(settleFormSchema),
    defaultValues: { tid: '', reason: '' },
  });
  // `useWatch`, not `watch()` (react-hooks/incompatible-library): the Tid field follows it.
  const selected = useWatch({ control, name: 'outcome' });
  const loading = settle.isPending;
  const moid = merchantOrderId(payment.id);
  // As on the row. It may name where the merchant admin files the card instead of `moid`: an
  // approval of another payment's window, under that payment's 주문번호 and its own TID.
  const reason = paymentFailureReason(payment);
  const sites = merchantAdminSites(provider.data);
  // The radio the outcome's focus lands on (`setFocus`, and the resolver's own refusal): the
  // chosen one, or the first while none of those offered is chosen.
  const outcomeFocus =
    selected !== undefined && outcomes.includes(selected) ? selected : outcomes[0];

  // After the step change has rendered: the target is mounted (and registered) by then.
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === 'summary') summaryRef.current?.focus();
    else if (target === 'refusal') refusalRef.current?.focus();
    else setFocus(target);
  }, [confirming, setFocus]);

  const toStep = (values: SettleFormOutput | null, focus: SettleFocus) => {
    focusNext.current = focus;
    setConfirming(values);
  };

  // The outcome chosen is no longer one the row allows (it moved since): choose again.
  const refuseOutcome = () => {
    setValue('outcome', undefined);
    setError('outcome', { message: copy.errSettleOutcome });
  };

  // Built in the handler, not in render: the step change writes `focusNext`.
  const next = () =>
    handleSubmit((values) => {
      if (!outcomes.includes(values.outcome)) {
        refuseOutcome();
        setFocus('outcome');
        return;
      }
      toStep(values, 'summary');
    })();

  const submit = () => {
    if (confirming === null) return;
    if (!outcomes.includes(confirming.outcome)) {
      refuseOutcome();
      toStep(null, 'outcome');
      return;
    }
    const chosen = confirming.outcome;
    setRefusal(null);
    settle.mutate(
      { id: payment.id, body: toSettleBody(confirming) },
      {
        onSuccess: () => {
          toaster.create({
            type: 'success',
            title: copy.adminPaymentSettled,
            description: SETTLE_OUTCOME_VIEW[chosen].label,
          });
          onClose();
        },
        onError: (error) => {
          const view = settleErrorView(error);
          if (!settleKeepsDialog(error)) {
            refusalToast(view);
            onClose();
            return;
          }
          if (view.field !== undefined) {
            // Under the field it is about, back on the first step, focused; no toast on top.
            setError(view.field, { message: view.title });
            toStep(null, view.field);
            return;
          }
          // What to do about it stays in view (a toast would be gone in seconds).
          setRefusal(view);
          toStep(null, 'refusal');
        },
      },
    );
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(details) => {
        if (!details.open && !loading) onClose();
      }}
      role="alertdialog"
      lazyMount
      unmountOnExit
      closeOnInteractOutside={false}
      closeOnEscape={!loading}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content data-testid="payment-settle-dialog">
            <Dialog.Header>
              <Dialog.Title>{copy.adminPaymentSettleTitle}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                {confirming === null && refusal !== null && (
                  <Alert.Root
                    status="error"
                    role="alert"
                    ref={refusalRef}
                    tabIndex={-1}
                    data-testid="payment-settle-refusal"
                  >
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>{refusal.title}</Alert.Title>
                      {refusal.description !== undefined && (
                        <Alert.Description>{refusal.description}</Alert.Description>
                      )}
                    </Alert.Content>
                  </Alert.Root>
                )}
                <Stack gap="0.5">
                  <Text fontWeight="medium">
                    {payment.nickname} · {formatP(parsePAmount(payment.amountP))} ·{' '}
                    {formatKrw(payment.priceKrw)} · {PAYMENT_STATUS_LABEL[payment.status]}
                  </Text>
                  <Text fontSize="sm" color="fg.muted">
                    {formatKst(payment.createdAt)}
                  </Text>
                  {moid !== null && (
                    <Text fontSize="sm" wordBreak="break-all">
                      {copy.adminPaymentSettleMoid}{' '}
                      <Text as="span" fontFamily="mono" data-testid="payment-settle-moid">
                        {moid}
                      </Text>
                    </Text>
                  )}
                  {reason !== null && (
                    <Text
                      fontSize="sm"
                      wordBreak="break-word"
                      data-testid="payment-settle-result-reason"
                    >
                      {copy.paymentResultReason} {reason}
                    </Text>
                  )}
                </Stack>
                {confirming === null ? (
                  <>
                    <Text>{copy.adminPaymentSettleBody}</Text>
                    <Text fontSize="sm">
                      {copy.adminPaymentSettleSites}{' '}
                      {sites.map((site, index) => (
                        <Text as="span" key={site.mode}>
                          {index > 0 && ' · '}
                          {site.mode === 'STG'
                            ? copy.adminPaymentSettleSiteStg
                            : copy.adminPaymentSettleSiteReal}{' '}
                          {/* The PG's own site, on the admin's screen: a new tab that cannot
                              reach back into this one and does not announce where it came from,
                              and says so in its name. */}
                          <ChakraLink
                            href={site.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            colorPalette="brand"
                            color="colorPalette.fg"
                          >
                            {new URL(site.url).host} {copy.adminPaymentSettleSiteNewTab}
                          </ChakraLink>
                        </Text>
                      ))}
                    </Text>
                    {outcomes.length === 0 ? (
                      <Text color="fg.muted" data-testid="payment-settle-none">
                        {copy.adminPaymentSettleNone}
                      </Text>
                    ) : (
                      <Field.Root invalid={!!errors.outcome} required>
                        <Controller
                          name="outcome"
                          control={control}
                          render={({ field }) => (
                            // Named by its own Label part, as the market resolve dialog's group.
                            <RadioGroup.Root
                              name={field.name}
                              value={field.value ?? null}
                              onValueChange={(details) => {
                                const value = outcomes.find((outcome) => outcome === details.value);
                                if (value !== undefined) field.onChange(value);
                              }}
                              colorPalette="brand"
                            >
                              <RadioGroup.Label fontWeight="medium" mb="1">
                                {copy.adminPaymentSettleOutcome}
                              </RadioGroup.Label>
                              <Stack gap="3">
                                {outcomes.map((outcome) => (
                                  <RadioGroup.Item
                                    key={outcome}
                                    value={outcome}
                                    alignItems="start"
                                    data-testid={`payment-settle-${outcome}`}
                                  >
                                    <RadioGroup.ItemHiddenInput
                                      ref={outcome === outcomeFocus ? field.ref : undefined}
                                      onBlur={field.onBlur}
                                    />
                                    <RadioGroup.ItemIndicator />
                                    <RadioGroup.ItemText>
                                      {/* A span: the item is a <label>, phrasing only. */}
                                      <Stack as="span" gap="0">
                                        <Text as="span" fontWeight="medium">
                                          {SETTLE_OUTCOME_VIEW[outcome].label}
                                        </Text>
                                        <Text as="span" fontSize="sm" color="fg.muted">
                                          {SETTLE_OUTCOME_VIEW[outcome].description}
                                        </Text>
                                      </Stack>
                                    </RadioGroup.ItemText>
                                  </RadioGroup.Item>
                                ))}
                              </Stack>
                            </RadioGroup.Root>
                          )}
                        />
                        <Field.ErrorText>{errors.outcome?.message}</Field.ErrorText>
                      </Field.Root>
                    )}
                    {selected === 'credit' && outcomes.includes('credit') && (
                      <Field.Root invalid={!!errors.tid}>
                        <Field.Label>{copy.adminPaymentSettleTid}</Field.Label>
                        <Input
                          autoComplete="off"
                          spellCheck={false}
                          fontFamily="mono"
                          data-testid="payment-settle-tid"
                          {...register('tid')}
                        />
                        {errors.tid ? (
                          <Field.ErrorText>{errors.tid.message}</Field.ErrorText>
                        ) : (
                          <Field.HelperText>{copy.adminPaymentSettleTidHint}</Field.HelperText>
                        )}
                      </Field.Root>
                    )}
                    <Field.Root invalid={!!errors.reason} required>
                      <Field.Label>{copy.adminPaymentSettleReason}</Field.Label>
                      <Textarea
                        rows={3}
                        data-testid="payment-settle-reason"
                        {...register('reason')}
                      />
                      {errors.reason ? (
                        <Field.ErrorText>{errors.reason.message}</Field.ErrorText>
                      ) : (
                        <Field.HelperText>{copy.adminPaymentSettleReasonHint}</Field.HelperText>
                      )}
                    </Field.Root>
                  </>
                ) : (
                  <SettleSummary values={confirming} ref={summaryRef} />
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              {/* Keyed per step: the same two slots hold other buttons (다음 → 정리하기), and a
                  focused 다음 updated in place into 정리하기 would take a second Enter as the
                  irreversible send. A second click of a double click is dropped (`detail`) on
                  the two buttons that end up under it. */}
              {confirming === null ? (
                <Fragment key="edit">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(event) => {
                      if (event.detail <= 1) onClose();
                    }}
                    data-testid="payment-settle-cancel"
                  >
                    {copy.cancel}
                  </Button>
                  <Button
                    size="sm"
                    disabled={outcomes.length === 0}
                    onClick={() => void next()}
                    data-testid="payment-settle-next"
                  >
                    {copy.adminPaymentSettleNext}
                  </Button>
                </Fragment>
              ) : (
                <Fragment key="confirm">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => toStep(null, 'outcome')}
                    data-testid="payment-settle-back"
                  >
                    {copy.adminPaymentSettleBack}
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="no"
                    loading={loading}
                    onClick={(event) => {
                      if (event.detail <= 1) submit();
                    }}
                    data-testid="payment-settle-confirm"
                  >
                    {copy.adminPaymentSettleSubmit}
                  </Button>
                </Fragment>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Where focus goes once the settle dialog's step change has rendered. */
type SettleFocus = 'summary' | 'refusal' | 'outcome' | 'tid' | 'reason';

/**
 * The second step: the choice as it will be sent, to be read once more before it is. Focused on
 * arrival (`tabIndex={-1}`), so it is what is read out, and Enter there sends nothing.
 */
function SettleSummary({ values, ref }: { values: SettleFormOutput; ref: Ref<HTMLDivElement> }) {
  const view = SETTLE_OUTCOME_VIEW[values.outcome];
  const tid = toSettleBody(values).tid;
  return (
    <Stack gap="2" ref={ref} tabIndex={-1} data-testid="payment-settle-summary">
      <Text>{copy.adminPaymentSettleConfirmBody}</Text>
      <Stack gap="0.5">
        <Text fontWeight="semibold">{view.label}</Text>
        <Text fontSize="sm" color="fg.muted">
          {view.description}
        </Text>
      </Stack>
      {tid !== undefined && (
        <Text fontSize="sm" wordBreak="break-all">
          {copy.adminPaymentSettleTid}{' '}
          <Text as="span" fontFamily="mono">
            {tid}
          </Text>
        </Text>
      )}
      <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
        {copy.adminPaymentSettleReason}: {values.reason}
      </Text>
    </Stack>
  );
}
