'use client';

import { Alert, Badge, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { formatKrw, formatP, parsePAmount } from '@buddha/shared';
import { copy } from '@/copy';
import { usePayments } from '@/hooks/use-wallet';
import { type Payment } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { paymentHistoryReason, paymentMethodLabel, paymentStatusView } from '@/lib/payments';

/**
 * 결제 내역 (ADR-0042): the account's own charges, newest first, 20 per page with 더 보기 —
 * the KRW side of the story the ledger tells in P. A refund shows here as the payment's
 * status and in the ledger as its own 결제 취소(환불) row. Not drawn while paid Coin is closed
 * (PAID_COIN_SALES_ENABLED, ADR-0049; app/wallet/page.tsx).
 */
export function PaymentHistory() {
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    usePayments();
  const payments = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card.Root data-testid="payment-history">
      <Card.Header>
        <Text fontWeight="semibold">{copy.paymentHistoryTitle}</Text>
      </Card.Header>
      <Card.Body>
        {isPending ? (
          <Skeleton height="16" />
        ) : isError ? (
          <Stack gap="3" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : payments.length === 0 ? (
          <Text color="fg.muted">{copy.paymentHistoryEmpty}</Text>
        ) : (
          <Stack gap="3" divideY="1px">
            {payments.map((payment) => (
              <PaymentRow key={payment.id} payment={payment} />
            ))}
            {hasNextPage && (
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                mt="3"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                data-testid="payment-history-more"
              >
                {copy.loadMore}
              </Button>
            )}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

function PaymentRow({ payment }: { payment: Payment }) {
  const status = paymentStatusView(payment);
  const method = paymentMethodLabel(payment.method);
  const reason = paymentHistoryReason(payment);
  return (
    <HStack
      justify="space-between"
      pt="3"
      _first={{ pt: 0 }}
      align="start"
      gap="3"
      data-testid={`payment-row-${payment.id}`}
    >
      <Stack gap="0.5" minW="0">
        <HStack gap="2" flexWrap="wrap">
          <Text fontWeight="medium">{formatP(parsePAmount(payment.amountP))}</Text>
          <Badge colorPalette={status.palette} variant="subtle" data-testid="payment-status">
            {status.label}
          </Badge>
        </HStack>
        {/* When the money moved, not when the payment was made: the approval once there is one. */}
        <Text fontSize="xs" color="fg.muted">
          {payment.approvedAt === null
            ? formatKst(payment.createdAt)
            : `${copy.paymentApprovedAt} ${formatKst(payment.approvedAt)}`}
          {payment.refundedAt !== null &&
            ` · ${copy.paymentRefundedAt} ${formatKst(payment.refundedAt)}`}
        </Text>
        {reason !== null && (
          <Text fontSize="xs" color="fg.muted" wordBreak="break-word">
            {copy.paymentResultReason} {reason}
          </Text>
        )}
      </Stack>
      <Stack gap="0.5" align="end" flexShrink={0}>
        <Text fontWeight="semibold">{formatKrw(payment.priceKrw)}</Text>
        {method !== null && (
          <Text fontSize="xs" color="fg.muted">
            {method}
          </Text>
        )}
      </Stack>
    </HStack>
  );
}
