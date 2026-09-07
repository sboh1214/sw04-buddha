'use client';

import { Alert, Badge, Button, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { formatKrw, formatP, parsePAmount } from '@buddha/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { copy } from '@/copy';
import { api, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from '@/lib/market-admin';

const ADMIN_PAYMENTS_KEY = ['admin', 'payments'] as const;

/** PLAN 12 결제 목록: every charge, newest first, 20 per page with 더 보기 (A-M2-5). */
export function AdminPayments() {
  const payments = useInfiniteQuery({
    queryKey: ADMIN_PAYMENTS_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/payments', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
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
        <HStack
          key={payment.id}
          justify="space-between"
          borderWidth="1px"
          borderRadius="l2"
          p="3"
          gap="3"
          flexWrap="wrap"
          data-testid={`admin-payment-${payment.id}`}
        >
          <Stack gap="0.5">
            <HStack gap="2" flexWrap="wrap">
              <Text fontWeight="semibold">{payment.nickname}</Text>
              <Text>{formatP(parsePAmount(payment.amountP))}</Text>
              <Text color="fg.muted">{formatKrw(payment.priceKrw)}</Text>
              <Badge colorPalette={PAYMENT_STATUS_PALETTE[payment.status]} variant="subtle">
                {PAYMENT_STATUS_LABEL[payment.status]}
              </Badge>
            </HStack>
            <Text fontSize="xs" color="fg.muted" fontFamily="mono">
              {payment.provider}
              {payment.providerRef ? ` · ${payment.providerRef}` : ''}
            </Text>
          </Stack>
          <Text fontSize="sm" color="fg.muted">
            {formatKst(payment.createdAt)}
          </Text>
        </HStack>
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
