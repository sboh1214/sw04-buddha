'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  HStack,
  Input,
  Link as ChakraLink,
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
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { LEDGER_QUERY_KEY } from '@/hooks/use-wallet';
import { nicknameShown } from '@/lib/account-closure';
import { api, isApiError, unwrap, type AdminUser } from '@/lib/api';
import { boundedInteger } from '@/lib/form-schema';
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

/**
 * What a refused balance adjustment says: a balance that would go below zero, an account its
 * member closed since the list was read (ACCOUNT_CLOSED, #140 — a closed account's ledger takes
 * nothing after its '탈퇴 소멸'), or anything else.
 */
function adjustFailureMessage(error: unknown): string {
  if (isApiError(error, 'INSUFFICIENT_BALANCE')) return copy.errAdjustNegative;
  if (isApiError(error, 'ACCOUNT_CLOSED')) return copy.adminAdjustClosed;
  return copy.errUnknown;
}

/**
 * One account: its nickname — '탈퇴한 사용자' for one its member closed (#140: the nickname went
 * with the closure; the address is the closed placeholder), with the '탈퇴' marker beside it (owner
 * decision 2026-10-23 (2차) 5: the closed account stays in the list, marked apart) — role, address,
 * the way to its moderation page, its balance and the adjustment, which a closed account never
 * takes, so its card says so instead of offering the form.
 *
 * The adjustment names the admin on screen (`useOperatorId`, ADR-0092 — Q-PG-8 ①, owner decision
 * 2026-10-26 17:21 answer 4 «이 PR에서 더함»), so it waits for `GET /me`; the cookie of another
 * account is refused (`copy.sessionChanged`) and the session asked again. The form is drawn for
 * that admin (`AdjustForm`, keyed by it, its fields off until it is known): `['me']` turning from
 * A to B in place drops what A typed (answer 1's way, as the coupon and package forms).
 */
function UserCard({ user }: { user: AdminUser }) {
  // A closed account is the only one with no nickname (profiles_closed_check, migration 0043).
  const closed = user.nickname === null;
  const operatorId = useOperatorId();

  return (
    <Card.Root data-testid={`admin-user-${user.id}`}>
      <Card.Body>
        <Stack gap="4">
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

          {closed ? (
            <Text fontSize="sm" color="fg.muted" data-testid="admin-user-closed">
              {copy.adminAdjustClosed}
            </Text>
          ) : (
            <AdjustForm key={operatorId ?? ''} userId={user.id} />
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * 잔고 조정 of one account, for the admin on screen: drawn again for each (keyed by it in UserCard),
 * its two fields and 조정 off until that admin is known (`OperatorFieldset`).
 */
function AdjustForm({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
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
    mutationFn: async ({ values, by }: { values: AdjustValues; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/users/{id}/balance-adjust', {
          params: { path: { id: userId } },
          body: { amountCoin: values.amountCoin, memo: values.memo, expectedAccountId: by },
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
      // Another account's cookie: nothing was adjusted, and the session is asked again — its reset
      // reads everything again, so nothing else is refreshed here.
      toaster.create({
        type: 'error',
        title: sessionChanged(error) ? copy.sessionChanged : adjustFailureMessage(error),
      });
    },
  });

  const submit = handleSubmit(async (values) => {
    if (operatorId === undefined) return;
    await adjust.mutateAsync({ values, by: operatorId }).catch(() => undefined); // reported by onError
  });

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <OperatorFieldset disabled={operatorId === undefined}>
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
            disabled={operatorId === undefined}
            data-testid="adjust-submit"
          >
            {copy.adminAdjustSubmit}
          </Button>
        </Stack>
      </OperatorFieldset>
    </form>
  );
}
