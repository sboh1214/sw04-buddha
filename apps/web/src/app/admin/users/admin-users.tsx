'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  HStack,
  Input,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { nicknameShown } from '@/lib/account-closure';
import { api, unwrap, type AdminUser } from '@/lib/api';
import { readFailed } from '@/lib/query-client';
import { adminUserModerationPath } from '@/lib/moderation';
import { ClosedBadge } from '../moderation/moderation-parts';

const ADMIN_USERS_KEY = ['admin', 'users'] as const;

export function AdminUsers() {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');

  // Cursor-paginated, 20 per page (PLAN 7). Same 더 보기 idiom as the wallet ledger: without
  // it every user past the first page — including matches of a broad search — is unreachable.
  const users = useInfiniteQuery({
    queryKey: [...ADMIN_USERS_KEY, term],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/users', {
          params: {
            query: { ...(term ? { q: term } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const rows = users.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setTerm(query.trim());
        }}
      >
        <HStack gap="2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.adminUserSearch}
            data-testid="admin-user-search"
          />
          <Button type="submit" flexShrink="0">
            {copy.adminSearch}
          </Button>
        </HStack>
      </form>

      {users.isPending ? (
        <Skeleton height="24" />
      ) : readFailed(users) ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : rows.length === 0 ? (
        <Text color="fg.muted">{copy.adminNoUsers}</Text>
      ) : (
        <Stack gap="3">
          {rows.map((user) => (
            <UserCard key={user.id} user={user} />
          ))}
          {users.hasNextPage && (
            <>
              <LoadMoreFailed
                list={users}
                message={copy.errUnknown}
                data-testid="admin-users-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={users.isFetchingNextPage}
                onClick={() => void users.fetchNextPage()}
                data-testid="admin-users-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * One account: its nickname — '탈퇴한 사용자' for one its member closed (#140: the nickname went
 * with the closure; the address is the closed placeholder), with the '탈퇴' marker beside it (owner
 * decision 2026-10-23 (2차) 5: the closed account stays in the list, marked apart) — role, address,
 * the way to its moderation page and its balance.
 *
 * No balance adjustment (#116, ADR-0109; ADR-0107 결정 2 #73 7항): an admin moves no account's
 * Coin, in either direction, and a gap the ledger audit finds is fixed only by #93's 대사 정정.
 */
function UserCard({ user }: { user: AdminUser }) {
  // A closed account is the only one with no nickname (profiles_closed_check, migration 0043).
  const closed = user.nickname === null;

  return (
    <Card.Root data-testid={`admin-user-${user.id}`}>
      <Card.Body>
        <HStack justify="space-between" align="start" flexWrap="wrap" gap="2">
          <Stack gap="0.5">
            <HStack gap="2">
              <Text fontWeight="semibold">{nicknameShown(user.nickname)}</Text>
              {user.role === 'admin' && (
                <Badge colorPalette="brand" variant="subtle">
                  {copy.adminTitle}
                </Badge>
              )}
              {closed && <ClosedBadge />}
            </HStack>
            <Text fontSize="sm" color="fg.muted">
              {user.email}
            </Text>
            {/* The member's reports and actions, and the actions taken without a report (#50,
                  ADR-0081; decision 4 #50 «신고 없는 조치»). */}
            <ChakraLink asChild fontSize="sm" color="brand.fg">
              <NextLink
                href={adminUserModerationPath(user.id) as Route}
                data-testid="admin-user-moderation"
              >
                {copy.adminModerationOpenMember}
              </NextLink>
            </ChakraLink>
          </Stack>
          <Text fontSize="lg" fontWeight="bold" data-testid="admin-user-balance">
            {formatCoin(parseCoinAmount(user.balance.availableCoin))}
          </Text>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}
