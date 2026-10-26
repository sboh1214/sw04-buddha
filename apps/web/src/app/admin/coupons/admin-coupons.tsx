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
import { COUPON_MAX_COIN, COUPON_MIN_COIN, formatCoin, parseCoinAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { api, isApiError, unwrap, type Coupon } from '@/lib/api';
import { formatKst, kstLocalToIso } from '@/lib/datetime';
import { boundedInteger, optionalCouponCode } from '@/lib/form-schema';
import { readFailed } from '@/lib/query-client';

const ADMIN_COUPONS_KEY = ['admin', 'coupons'] as const;

const schema = z.object({
  code: optionalCouponCode(copy.errAdminCouponCode),
  amountCoin: boundedInteger(
    /^\d+$/,
    copy.errCouponAmount,
    (amount) => amount >= COUPON_MIN_COIN && amount <= COUPON_MAX_COIN,
    copy.errCouponAmount,
  ),
  maxRedemptions: z.string().trim().regex(/^\d*$/, copy.errCouponAmount),
  expiresAt: z.string().trim(),
  memo: z.string().trim().max(200),
});
type FormValues = z.infer<typeof schema>;

/**
 * 쿠폰 (ADR-0026; off the nav while paid Coin is off, ADR-0049): issue and stop or resume. Both
 * name the admin on screen (`useOperatorId`, ADR-0092), so they wait for `GET /me`; the cookie of
 * another account is refused (`copy.sessionChanged`) and the session asked again. The issue form is
 * drawn for that admin (`CreateCouponCard`, keyed by it, its fields off until it is known):
 * `['me']` turning from A to B in place drops what A typed (owner decision 2026-10-26 17:21 answer
 * 1).
 */
export function AdminCoupons() {
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  // Cursor-paginated, 20 per page (PLAN 7). Unlike the user list this screen has no search,
  // so without 더 보기 a coupon past the first page — and its 중지 toggle — is unreachable,
  // and an admin issuing them one click at a time reaches 20 quickly.
  const coupons = useInfiniteQuery({
    queryKey: ADMIN_COUPONS_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/coupons', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
  const rows = coupons.data?.pages.flatMap((page) => page.items) ?? [];

  const toggle = useMutation({
    mutationFn: async ({ coupon, by }: { coupon: Coupon; by: string }) =>
      unwrap(
        await api.PATCH('/api/v1/admin/coupons/{id}', {
          params: { path: { id: coupon.id } },
          body: { isActive: !coupon.isActive, expectedAccountId: by },
        }),
      ).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ADMIN_COUPONS_KEY });
    },
    onError: (error) =>
      toaster.create({
        type: 'error',
        title: sessionChanged(error) ? copy.sessionChanged : copy.errUnknown,
      }),
  });

  return (
    <Stack gap="4">
      <CreateCouponCard key={operatorId ?? ''} />
      {coupons.isPending ? (
        <Skeleton height="24" />
      ) : readFailed(coupons) ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : (
        <Stack gap="2">
          {rows.map((coupon) => (
            <HStack
              key={coupon.id}
              justify="space-between"
              borderWidth="1px"
              borderRadius="l2"
              p="3"
              gap="3"
              flexWrap="wrap"
              data-testid={`admin-coupon-${coupon.id}`}
            >
              <Stack gap="0.5">
                <HStack gap="2" flexWrap="wrap">
                  <Text fontWeight="semibold" fontFamily="mono">
                    {coupon.code}
                  </Text>
                  <Text>{formatCoin(parseCoinAmount(coupon.amountCoin))}</Text>
                  <Badge colorPalette={coupon.isActive ? 'brand' : 'gray'} variant="subtle">
                    {coupon.isActive ? copy.adminPackageActive : copy.adminPackageInactive}
                  </Badge>
                </HStack>
                <Text fontSize="xs" color="fg.muted">
                  {copy.adminCouponUsage} {coupon.redeemedCount}
                  {coupon.maxRedemptions === null
                    ? ` / ${copy.adminCouponUnlimited}`
                    : ` / ${String(coupon.maxRedemptions)}`}
                  {coupon.expiresAt ? ` · ~${formatKst(coupon.expiresAt)}` : ''}
                  {coupon.memo ? ` · ${coupon.memo}` : ''}
                </Text>
              </Stack>
              <Button
                size="xs"
                variant="outline"
                loading={toggle.isPending && toggle.variables?.coupon.id === coupon.id}
                disabled={operatorId === undefined}
                onClick={() => {
                  if (operatorId !== undefined) toggle.mutate({ coupon, by: operatorId });
                }}
                data-testid={`coupon-toggle-${coupon.id}`}
              >
                {coupon.isActive ? copy.adminCouponDisable : copy.adminCouponEnable}
              </Button>
            </HStack>
          ))}
          {coupons.hasNextPage && (
            <>
              <LoadMoreFailed
                list={coupons}
                message={copy.errUnknown}
                data-testid="admin-coupons-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={coupons.isFetchingNextPage}
                onClick={() => void coupons.fetchNextPage()}
                data-testid="admin-coupons-more"
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
 * 쿠폰 발급, for the admin on screen: drawn again for each (keyed by it in AdminCoupons), its five
 * fields and 발급 off until that admin is known (`OperatorFieldset`).
 */
function CreateCouponCard() {
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();

  const create = useMutation({
    mutationFn: async ({ values, by }: { values: FormValues; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/coupons', {
          body: {
            ...(values.code ? { code: values.code } : {}),
            amountCoin: values.amountCoin,
            maxRedemptions: values.maxRedemptions ? Number(values.maxRedemptions) : null,
            expiresAt: kstLocalToIso(values.expiresAt),
            memo: values.memo || null,
            expectedAccountId: by,
          },
        }),
      ).data,
    onSuccess: async (coupon) => {
      toaster.create({ type: 'success', title: copy.adminCouponCreated, description: coupon.code });
      reset({ code: '', amountCoin: '', maxRedemptions: '', expiresAt: '', memo: '' });
      await queryClient.invalidateQueries({ queryKey: ADMIN_COUPONS_KEY });
    },
    onError: (error) =>
      toaster.create({
        type: 'error',
        title: sessionChanged(error)
          ? copy.sessionChanged
          : isApiError(error, 'VALIDATION_ERROR')
            ? copy.errCouponInvalid
            : copy.errUnknown,
      }),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', amountCoin: '', maxRedemptions: '', expiresAt: '', memo: '' },
  });

  // Reset lives in onSuccess (as it does on the user screen): a duplicate code or a rejected
  // one has to leave the five fields the admin typed exactly where they are, or the toast from
  // onError is unactionable. The catch stays because the form discards this promise
  // (`void submit(e)`), so a rethrow would surface as an unhandled rejection.
  const submit = handleSubmit(async (values) => {
    if (operatorId === undefined) return;
    await create.mutateAsync({ values, by: operatorId }).catch(() => undefined); // reported by onError
  });

  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminCouponCreate}</Text>
      </Card.Header>
      <Card.Body>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <OperatorFieldset disabled={operatorId === undefined}>
            <Stack gap="3">
              <HStack gap="2" align="start" flexWrap="wrap">
                <Field.Root invalid={!!errors.code} maxW="52">
                  <Field.Label>{copy.adminCouponCode}</Field.Label>
                  <Input autoComplete="off" data-testid="coupon-code-input" {...register('code')} />
                  <Field.ErrorText>{errors.code?.message}</Field.ErrorText>
                </Field.Root>
                <Field.Root invalid={!!errors.amountCoin} required maxW="32">
                  <Field.Label>{copy.adminCouponAmount}</Field.Label>
                  <Input
                    inputMode="numeric"
                    data-testid="coupon-amount"
                    {...register('amountCoin')}
                  />
                  <Field.ErrorText>{errors.amountCoin?.message}</Field.ErrorText>
                </Field.Root>
                <Field.Root invalid={!!errors.maxRedemptions} maxW="32">
                  <Field.Label>{copy.adminCouponMax}</Field.Label>
                  <Input
                    inputMode="numeric"
                    placeholder={copy.adminCouponUnlimited}
                    data-testid="coupon-max"
                    {...register('maxRedemptions')}
                  />
                  <Field.ErrorText>{errors.maxRedemptions?.message}</Field.ErrorText>
                </Field.Root>
                <Field.Root maxW="56">
                  <Field.Label>{copy.adminCouponExpires}</Field.Label>
                  <Input
                    type="datetime-local"
                    data-testid="coupon-expires"
                    {...register('expiresAt')}
                  />
                </Field.Root>
              </HStack>
              <Field.Root>
                <Field.Label>{copy.adminCouponMemo}</Field.Label>
                <Input autoComplete="off" data-testid="coupon-memo" {...register('memo')} />
              </Field.Root>
              <Button
                type="submit"
                size="sm"
                alignSelf="flex-start"
                loading={isSubmitting}
                disabled={operatorId === undefined}
                data-testid="coupon-create"
              >
                {copy.adminCouponCreate}
              </Button>
            </Stack>
          </OperatorFieldset>
        </form>
      </Card.Body>
    </Card.Root>
  );
}
