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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { api, isApiError, unwrap, type Coupon } from '@/lib/api';

const ADMIN_COUPONS_KEY = ['admin', 'coupons'] as const;

const dateFormat = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Seoul',
});

/**
 * `datetime-local` gives `2026-12-31T23:59` in the admin's own zone; the API wants UTC ISO.
 * An empty field means "no expiry".
 */
function toIsoOrNull(local: string): string | null {
  if (!local) return null;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const schema = z.object({
  code: z.string().trim().toUpperCase().max(32),
  amountP: z
    .string()
    .trim()
    .regex(/^\d+$/, copy.errCouponAmount)
    .refine((value) => {
      const amount = BigInt(value);
      return amount >= COUPON_MIN_P && amount <= COUPON_MAX_P;
    }, copy.errCouponAmount),
  maxRedemptions: z.string().trim().regex(/^\d*$/, copy.errCouponAmount),
  expiresAt: z.string().trim(),
  memo: z.string().trim().max(200),
});
type FormValues = z.infer<typeof schema>;

export function AdminCoupons() {
  const queryClient = useQueryClient();
  const coupons = useQuery({
    queryKey: ADMIN_COUPONS_KEY,
    queryFn: async (): Promise<Coupon[]> => unwrap(await api.GET('/api/v1/admin/coupons')).data,
  });

  const create = useMutation({
    mutationFn: async (values: FormValues) =>
      unwrap(
        await api.POST('/api/v1/admin/coupons', {
          body: {
            ...(values.code ? { code: values.code } : {}),
            amountP: values.amountP,
            maxRedemptions: values.maxRedemptions ? Number(values.maxRedemptions) : null,
            expiresAt: toIsoOrNull(values.expiresAt),
            memo: values.memo || null,
          },
        }),
      ).data,
    onSuccess: async (coupon) => {
      toaster.create({ type: 'success', title: copy.adminCouponCreated, description: coupon.code });
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

  const submit = handleSubmit(async (values) => {
    await create.mutateAsync(values).catch(() => undefined); // reported by onError
    reset({ code: '', amountP: '', maxRedemptions: '', expiresAt: '', memo: '' });
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
                <Field.Root maxW="52">
                  <Field.Label>{copy.adminCouponCode}</Field.Label>
                  <Input autoComplete="off" data-testid="coupon-code-input" {...register('code')} />
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
          {coupons.data.map((coupon) => (
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
                  {coupon.expiresAt ? ` · ~${dateFormat.format(new Date(coupon.expiresAt))}` : ''}
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
        </Stack>
      )}
    </Stack>
  );
}
