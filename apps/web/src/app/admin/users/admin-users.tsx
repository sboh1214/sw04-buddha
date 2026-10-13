'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  HStack,
  Input,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { ADJUST_MAX_ABS_COIN, formatCoin, parseCoinAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { LEDGER_QUERY_KEY } from '@/hooks/use-wallet';
import { api, isApiError, unwrap, type AdminUser } from '@/lib/api';
import { boundedInteger } from '@/lib/form-schema';

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
      ) : users.isError ? (
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
          )}
        </Stack>
      )}
    </Stack>
  );
}

const adjustSchema = z.object({
  amountCoin: boundedInteger(
    /^-?\d+$/,
    copy.errAdjustRange,
    (amount) => amount !== 0n && amount >= -ADJUST_MAX_ABS_COIN && amount <= ADJUST_MAX_ABS_COIN,
    copy.errAdjustRange,
  ),
  memo: z.string().trim().min(1, copy.errAdjustMemo).max(200),
});
type AdjustValues = z.infer<typeof adjustSchema>;

function UserCard({ user }: { user: AdminUser }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AdjustValues>({
    resolver: zodResolver(adjustSchema),
    defaultValues: { amountCoin: '', memo: '' },
  });

  const adjust = useMutation({
    mutationFn: async (values: AdjustValues) =>
      unwrap(
        await api.POST('/api/v1/admin/users/{id}/balance-adjust', {
          params: { path: { id: user.id } },
          body: { amountCoin: values.amountCoin, memo: values.memo },
        }),
      ).data,
    onSuccess: async () => {
      toaster.create({ type: 'success', title: copy.adminAdjustDone });
      reset({ amountCoin: '', memo: '' });
      // An admin may adjust their own balance, so the nav chip and the wallet ledger are
      // refreshed alongside the list they are looking at.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
        queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
      ]);
    },
    onError: (error) => {
      toaster.create({
        type: 'error',
        title: isApiError(error, 'INSUFFICIENT_BALANCE') ? copy.errAdjustNegative : copy.errUnknown,
      });
    },
  });

  const submit = handleSubmit(async (values) => {
    await adjust.mutateAsync(values).catch(() => undefined); // reported by onError
  });

  return (
    <Card.Root data-testid={`admin-user-${user.id}`}>
      <Card.Body>
        <Stack gap="4">
          <HStack justify="space-between" align="start" flexWrap="wrap" gap="2">
            <Stack gap="0.5">
              <HStack gap="2">
                <Text fontWeight="semibold">{user.nickname}</Text>
                {user.role === 'admin' && (
                  <Badge colorPalette="brand" variant="subtle">
                    {copy.adminTitle}
                  </Badge>
                )}
              </HStack>
              <Text fontSize="sm" color="fg.muted">
                {user.email}
              </Text>
            </Stack>
            <Text fontSize="lg" fontWeight="bold" data-testid="admin-user-balance">
              {formatCoin(parseCoinAmount(user.balance.availableCoin))}
            </Text>
          </HStack>

          <form onSubmit={(e) => void submit(e)} noValidate>
            <Stack gap="3">
              <Text fontSize="sm" fontWeight="medium">
                {copy.adminAdjust}
              </Text>
              <HStack gap="2" align="start" flexWrap="wrap">
                <Field.Root invalid={!!errors.amountCoin} required maxW="40">
                  <Field.Label>{copy.adminAdjustAmount}</Field.Label>
                  <Input
                    inputMode="numeric"
                    autoComplete="off"
                    data-testid="adjust-amount"
                    {...register('amountCoin')}
                  />
                  <Field.ErrorText>{errors.amountCoin?.message}</Field.ErrorText>
                </Field.Root>
                <Field.Root invalid={!!errors.memo} required flex="1" minW="48">
                  <Field.Label>{copy.adminAdjustMemo}</Field.Label>
                  <Input autoComplete="off" data-testid="adjust-memo" {...register('memo')} />
                  <Field.ErrorText>{errors.memo?.message}</Field.ErrorText>
                </Field.Root>
              </HStack>
              <Button
                type="submit"
                size="sm"
                alignSelf="flex-start"
                loading={isSubmitting}
                data-testid="adjust-submit"
              >
                {copy.adminAdjustSubmit}
              </Button>
            </Stack>
          </form>
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}
