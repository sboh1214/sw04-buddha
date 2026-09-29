'use client';

import { Alert } from '@chakra-ui/react';
import { type PaymentReturnResult } from '@buddha/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { LEDGER_QUERY_KEY, PAYMENTS_QUERY_KEY, useMyPayment } from '@/hooks/use-wallet';
import { paymentResultNotice } from '@/lib/smartro-payments';

/**
 * The outcome of the payment window, where the API's ReturnUrl / StopUrl sent the browser:
 * `/wallet?payment=<id>&result=<r>` (ADR-0042; the `/settings?error=` precedent). The URL
 * says how it ended when the API redirected; the payment itself (`GET /me/payments/:id`) says
 * how it stands now and, for a failure, the PG's reason — `paymentResultNotice` weighs the two.
 *
 * The page arrived by a full navigation, but the query client outlives client-side ones, and
 * the balance and lists in it are from before the payment: they are refreshed on arrival, and
 * again whenever the outcome changes under the notice (a `pending` payment settling while it
 * is being re-read).
 */
export function PaymentResultNotice({
  paymentId,
  result,
}: {
  paymentId: string | undefined;
  result: PaymentReturnResult;
}) {
  const queryClient = useQueryClient();
  const payment = useMyPayment(paymentId);
  const notice = paymentResultNotice(result, payment.data);
  const outcome = notice.outcome;

  useEffect(() => {
    // The list, exactly: the notice's own payment is being read already. And a read already
    // running is left to finish (`cancelRefetch: false`) — on a fresh page load every one of
    // these is in flight, and it is fresh enough.
    const running = { cancelRefetch: false };
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }, running),
      queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }, running),
      queryClient.invalidateQueries({ queryKey: PAYMENTS_QUERY_KEY, exact: true }, running),
    ]);
  }, [queryClient, paymentId, outcome]);

  return (
    <Alert.Root
      status={notice.status}
      role={notice.status === 'error' ? 'alert' : 'status'}
      data-testid="payment-result-notice"
      data-outcome={outcome}
    >
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{notice.message}</Alert.Description>
        {notice.reason !== null && (
          <Alert.Description data-testid="payment-result-reason">
            {copy.paymentResultReason} {notice.reason}
          </Alert.Description>
        )}
      </Alert.Content>
    </Alert.Root>
  );
}
