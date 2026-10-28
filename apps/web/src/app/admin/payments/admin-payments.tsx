'use client';

import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  HStack,
  Portal,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { PAID_COIN_SALES_ENABLED, formatKrw, formatCoin, parseCoinAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useAdminPayments, useRefundPayment } from '@/hooks/use-admin-payments';
import { type AdminPayment } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from '@/lib/market-admin';
import {
  type RefundAction,
  type RefundFormValues,
  paymentFailureReason,
  paymentMethodLabel,
  type RefundErrorView,
  refundAction,
  refundDeadline,
  refundErrorView,
  refundFormSchema,
  refundKeepsDialog,
} from '@/lib/payments';
import { readFailed } from '@/lib/query-client';

/**
 * PLAN 12 결제 목록: every charge, newest first, 20 per page with 더 보기 (A-M2-5), with the
 * admin refund of ADR-0042 (owner decision 5, 「관리자 환불」) on the rows that allow one. While
 * paid Coin is closed (PAID_COIN_SALES_ENABLED, ADR-0049) the API refuses every refund, so no row
 * offers one, and the admin menu does not link here; the list itself still reads.
 */
export function AdminPayments() {
  const payments = useAdminPayments();
  const rows = payments.data?.pages.flatMap((page) => page.items) ?? [];

  if (payments.isPending) return <Skeleton height="24" />;
  if (readFailed(payments)) {
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
        <>
          <LoadMoreFailed
            list={payments}
            message={copy.errUnknown}
            data-testid="admin-payments-more-failed"
          />
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
        </>
      )}
    </Stack>
  );
}

/**
 * One charge: who, how much, its status, the PG's method and reference, when it was made and
 * approved (and refunded), the PG's last word on a failure — and the refund button when
 * `refundAction` offers one and paid Coin is on sale. `Date.now()` is read in render through
 * `refundAction`'s default, as `isClosingSoon` is on the market list: the admin query never runs
 * on the server, so there is no hydration to mismatch.
 */
function PaymentRow({ payment }: { payment: AdminPayment }) {
  const [refunding, setRefunding] = useState<RefundAction | null>(null);
  const action = PAID_COIN_SALES_ENABLED ? refundAction(payment) : null;
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
          <Text>{formatCoin(parseCoinAmount(payment.amountCoin))}</Text>
          <Text color="fg.muted">{formatKrw(payment.priceKrw)}</Text>
          <Badge
            colorPalette={PAYMENT_STATUS_PALETTE[payment.status]}
            variant="subtle"
            data-testid="admin-payment-status"
          >
            {PAYMENT_STATUS_LABEL[payment.status]}
          </Badge>
          {method !== null && <Badge variant="outline">{method}</Badge>}
        </HStack>
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
      </Stack>
      {refunding !== null && (
        <RefundDialog payment={payment} action={refunding} onClose={() => setRefunding(null)} />
      )}
    </HStack>
  );
}

/**
 * How long a refusal's toast stays when it carries the PG's own answer (a description): long
 * enough to read and note it down — zag's 5 s for an error is not — and closable once done.
 */
const GUIDANCE_TOAST_MS = 20_000;

/** The toast for a refused refund, kept longer and closable when it carries the PG's answer. */
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
 * The refund confirmation with its required reason (ADR-0042). The admin confirmation dialog
 * shape: `alertdialog`, pinned while the request runs — Cancel, Esc and the backdrop all wait,
 * since a refund takes Coin from a member and money back through the PG and the admin must see
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
                  {payment.nickname} · {formatCoin(parseCoinAmount(payment.amountCoin))} ·{' '}
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
