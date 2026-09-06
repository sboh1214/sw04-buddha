'use client';

import { Alert, Button, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { copy } from '@/copy';
import { api, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { auditFailureKindLabel, compactJson } from '@/lib/market-admin';

const ADMIN_AUDIT_FAILURES_KEY = ['admin', 'audit-failures'] as const;

/**
 * PLAN 12 감사 실패 목록: what the `ledger.audit` worker found (a balance that disagrees with
 * its ledger), newest first, 20 per page with 더 보기 (A-M2-5). Read-only: the fix is an
 * ADMIN_ADJUST on the user screen, after looking at the payload.
 */
export function AdminAuditFailures() {
  const failures = useInfiniteQuery({
    queryKey: ADMIN_AUDIT_FAILURES_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/audit-failures', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
  const rows = failures.data?.pages.flatMap((page) => page.items) ?? [];

  if (failures.isPending) return <Skeleton height="24" />;
  if (failures.isError) {
    return (
      <Alert.Root status="error" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.errUnknown}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }
  if (rows.length === 0) return <Text color="fg.muted">{copy.adminNoAuditFailures}</Text>;

  return (
    <Stack gap="2">
      {rows.map((failure) => (
        <Stack
          key={failure.id}
          borderWidth="1px"
          borderRadius="l2"
          p="3"
          gap="1"
          data-testid={`admin-audit-failure-${failure.id}`}
        >
          <HStack justify="space-between" gap="3" flexWrap="wrap">
            <Text fontWeight="semibold">{auditFailureKindLabel(failure.kind)}</Text>
            <Text fontSize="sm" color="fg.muted">
              {formatKst(failure.createdAt)}
            </Text>
          </HStack>
          <Text fontSize="xs" fontFamily="mono" color="fg.muted" wordBreak="break-all">
            {compactJson(failure.payload)}
          </Text>
        </Stack>
      ))}
      {failures.hasNextPage && (
        <Button
          alignSelf="center"
          size="sm"
          variant="ghost"
          loading={failures.isFetchingNextPage}
          onClick={() => void failures.fetchNextPage()}
          data-testid="admin-audit-failures-more"
        >
          {copy.loadMore}
        </Button>
      )}
    </Stack>
  );
}
