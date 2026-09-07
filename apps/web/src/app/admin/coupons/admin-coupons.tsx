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
import { COUPON_MAX_P, COUPON_MIN_P, formatP, parsePAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { api, isApiError, unwrap, type Coupon } from '@/lib/api';
import { formatKst, kstLocalToIso } from '@/lib/datetime';
import { boundedInteger, optionalCouponCode } from '@/lib/form-schema';

const ADMIN_COUPONS_KEY = ['admin', 'coupons'] as const;

const schema = z.object({
  code: optionalCouponCode(copy.errAdminCouponCode),
  amountP: boundedInteger(
    /^\d+$/,
    copy.errCouponAmount,
    (amount) => amount >= COUPON_MIN_P && amount <= COUPON_MAX_P,
    copy.errCouponAmount,
  ),
  maxRedemptions: z.string().trim().regex(/^\d*$/, copy.errCouponAmount),
  expiresAt: z.string().trim(),
  memo: z.string().trim().max(200),
});
type FormValues = z.infer<typeof schema>;

export function AdminCoupons() {
  const queryClient = useQueryClient();
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

  const create = useMutation({
    mutationFn: async (values: FormValues) =>
      unwrap(
        await api.POST('/api/v1/admin/coupons', {
          body: {
            ...(values.code ? { code: values.code } : {}),
            amountP: values.amountP,
            maxRedemptions: values.maxRedemptions ? Number(values.maxRedemptions) : null,
            expiresAt: kstLocalToIso(values.expiresAt),
            memo: values.memo || null,
          },
        }),
      ).data,
    onSuccess: async (coupon) => {
      toaster.create({ type: 'success', title: copy.adminCouponCreated, description: coupon.code });
      reset({ code: '', amountP: '', maxRedemptions: '', expiresAt: '', memo: '' });
      await queryClient.invalidateQueries({ queryKey: ADMIN_COUPONS_KEY });
    },
    onError: (error) =>
      toaster.create({
        type: 'error',
        title: isApiError(error, 'VALIDATION_ERROR') ? copy.errCouponInvalid : copy.errUnknown,
      }),
  });

  const toggle = useMutation({
    mutationFn: async (coupon: Coupon) =>
      unwrap(
        await api.PATCH('/api/v1/admin/coupons/{id}', {
          params: { path: { id: coupon.id } },
          body: { isActive: !coupon.isActive },
        }),
      ).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ADMIN_COUPONS_KEY });
    },
    onError: () => toaster.create({ type: 'error', title: copy.errUnknown }),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', amountP: '', maxRedemptions: '', expiresAt: '', memo: '' },
  });

  // Reset lives in onSuccess (as it does on the user screen): a duplicate code or a rejected
  // one has to leave the five fields the admin typed exactly where they are, or the toast from
  // onError is unactionable. The catch stays because the form discards this promise
  // (`void submit(e)`), so a rethrow would surface as an unhandled rejection.
  const submit = handleSubmit(async (values) => {
    await create.mutateAsync(values).catch(() => undefined); // reported by onError
  });

  return (
    <Stack gap="4">
      <Card.Root>
        <Card.Header>
          <Text fontWeight="semibold">{copy.adminCouponCreate}</Text>
        </Card.Header>
        <Card.Body>
          <form onSubmit={(e) => void submit(e)} noValidate>
            <Stack gap="3">
              <HStack gap="2" align="start" flexWrap="wrap">
                <Field.Root invalid={!!errors.code} maxW="52">
                  <Field.Label>{copy.adminCouponCode}</Field.Label>
                  <Input autoComplete="off" data-testid="coupon-code-input" {...register('code')} />
                  <Field.ErrorText>{errors.code?.message}</Field.ErrorText>
                </Field.Root>
                <Field.Root invalid={!!errors.amountP} required maxW="32">
                  <Field.Label>{copy.adminCouponAmount}</Field.Label>
                  <Input inputMode="numeric" data-testid="coupon-amount" {...register('amountP')} />
                  <Field.ErrorText>{errors.amountP?.message}</Field.ErrorText>
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
                data-testid="coupon-create"
              >
                {copy.adminCouponCreate}
              </Button>
            </Stack>
          </form>
        </Card.Body>
      </Card.Root>

      {coupons.isPending ? (
        <Skeleton height="24" />
      ) : coupons.isError ? (
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
                  <Text>{formatP(parsePAmount(coupon.amountP))}</Text>
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
                loading={toggle.isPending && toggle.variables?.id === coupon.id}
                onClick={() => toggle.mutate(coupon)}
                data-testid={`coupon-toggle-${coupon.id}`}
              >
                {coupon.isActive ? copy.adminCouponDisable : copy.adminCouponEnable}
              </Button>
            </HStack>
          ))}
          {coupons.hasNextPage && (
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
          )}
        </Stack>
      )}
    </Stack>
  );
}
