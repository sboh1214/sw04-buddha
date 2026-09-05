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
import {
  CHARGE_PACKAGE_MAX_P,
  CHARGE_PACKAGE_MIN_P,
  discountPercent,
  formatKrw,
  formatP,
  parsePAmount,
} from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { CHARGE_PACKAGES_QUERY_KEY } from '@/hooks/use-wallet';
import { api, isApiError, unwrap, type ChargePackage } from '@/lib/api';
import { boundedInteger, integerField } from '@/lib/form-schema';

const ADMIN_PACKAGES_KEY = ['admin', 'charge-packages'] as const;

const DIGITS = /^\d+$/;

/** Same rules as the API: a positive integer amount within bounds, price never above it. */
const schema = z
  .object({
    amountP: boundedInteger(
      DIGITS,
      copy.errPackagePrice,
      (amount) => amount >= CHARGE_PACKAGE_MIN_P && amount <= CHARGE_PACKAGE_MAX_P,
      copy.errPackagePrice,
    ),
    priceKrw: integerField(DIGITS, copy.errPackagePrice),
    sortOrder: integerField(DIGITS, copy.errPackagePrice),
  })
  // Object-level, so it runs even when a field above failed and it sees the raw string: it
  // has to prove both halves are digits itself before converting (see lib/form-schema).
  .refine(
    (value) =>
      !DIGITS.test(value.amountP) ||
      !DIGITS.test(value.priceKrw) ||
      BigInt(value.priceKrw) <= BigInt(value.amountP),
    { message: copy.errPackagePrice, path: ['priceKrw'] },
  );
type FormValues = z.infer<typeof schema>;

export function AdminChargePackages() {
  const queryClient = useQueryClient();
  const packages = useQuery({
    queryKey: ADMIN_PACKAGES_KEY,
    queryFn: async (): Promise<ChargePackage[]> =>
      unwrap(await api.GET('/api/v1/admin/charge-packages')).data,
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ADMIN_PACKAGES_KEY }),
      queryClient.invalidateQueries({ queryKey: CHARGE_PACKAGES_QUERY_KEY }),
    ]);

  const create = useMutation({
    mutationFn: async (values: FormValues) =>
      unwrap(
        await api.POST('/api/v1/admin/charge-packages', {
          body: {
            amountP: values.amountP,
            priceKrw: Number(values.priceKrw),
            sortOrder: Number(values.sortOrder),
            isActive: true,
          },
        }),
      ).data,
    onSuccess: async () => {
      toaster.create({ type: 'success', title: copy.adminPackageSaved });
      reset({ amountP: '', priceKrw: '', sortOrder: '0' });
      await invalidate();
    },
    onError: (error) =>
      toaster.create({
        type: 'error',
        title: isApiError(error, 'VALIDATION_ERROR') ? copy.errPackagePrice : copy.errUnknown,
      }),
  });

  const toggle = useMutation({
    mutationFn: async (pack: ChargePackage) =>
      unwrap(
        await api.PATCH('/api/v1/admin/charge-packages/{id}', {
          params: { path: { id: pack.id } },
          body: { isActive: !pack.isActive },
        }),
      ).data,
    onSuccess: invalidate,
    onError: () => toaster.create({ type: 'error', title: copy.errUnknown }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await api.DELETE('/api/v1/admin/charge-packages/{id}', {
        params: { path: { id } },
      });
      if (result.error) throw new Error(copy.errUnknown);
    },
    onSuccess: async () => {
      toaster.create({ type: 'success', title: copy.adminPackageDeleted });
      await invalidate();
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
    defaultValues: { amountP: '', priceKrw: '', sortOrder: '0' },
  });

  // Only on success (see the coupon screen): a refused price must not erase what was typed.
  const submit = handleSubmit(async (values) => {
    await create.mutateAsync(values).catch(() => undefined); // reported by onError
  });

  return (
    <Stack gap="4">
      <Card.Root>
        <Card.Header>
          <Text fontWeight="semibold">{copy.adminPackageAdd}</Text>
        </Card.Header>
        <Card.Body>
          <form onSubmit={(e) => void submit(e)} noValidate>
            <Stack gap="3">
              <HStack gap="2" align="start" flexWrap="wrap">
                <Field.Root invalid={!!errors.amountP} required maxW="40">
                  <Field.Label>{copy.adminPackageAmount}</Field.Label>
                  <Input
                    inputMode="numeric"
                    data-testid="package-amount"
                    {...register('amountP')}
                  />
                  <Field.ErrorText>{errors.amountP?.message}</Field.ErrorText>
                </Field.Root>
                <Field.Root invalid={!!errors.priceKrw} required maxW="40">
                  <Field.Label>{copy.adminPackagePrice}</Field.Label>
                  <Input
                    inputMode="numeric"
                    data-testid="package-price"
                    {...register('priceKrw')}
                  />
                  <Field.ErrorText>{errors.priceKrw?.message}</Field.ErrorText>
                </Field.Root>
                <Field.Root invalid={!!errors.sortOrder} maxW="28">
                  <Field.Label>{copy.adminPackageOrder}</Field.Label>
                  <Input
                    inputMode="numeric"
                    data-testid="package-order"
                    {...register('sortOrder')}
                  />
                  <Field.ErrorText>{errors.sortOrder?.message}</Field.ErrorText>
                </Field.Root>
              </HStack>
              <Button
                type="submit"
                size="sm"
                alignSelf="flex-start"
                loading={isSubmitting}
                data-testid="package-create"
              >
                {copy.adminPackageAdd}
              </Button>
            </Stack>
          </form>
        </Card.Body>
      </Card.Root>

      {packages.isPending ? (
        <Skeleton height="24" />
      ) : packages.isError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : (
        <Stack gap="2">
          {packages.data.map((pack) => {
            const amountP = parsePAmount(pack.amountP);
            return (
              <HStack
                key={pack.id}
                justify="space-between"
                borderWidth="1px"
                borderRadius="l2"
                p="3"
                gap="3"
                flexWrap="wrap"
                data-testid={`admin-package-${pack.id}`}
              >
                <HStack gap="3" flexWrap="wrap">
                  <Text fontWeight="semibold">{formatP(amountP)}</Text>
                  <Text color="fg.muted">{formatKrw(pack.priceKrw)}</Text>
                  <Badge colorPalette="yes" variant="subtle">
                    {discountPercent(amountP, pack.priceKrw)}% {copy.chargeDiscount}
                  </Badge>
                  <Badge colorPalette={pack.isActive ? 'brand' : 'gray'} variant="subtle">
                    {pack.isActive ? copy.adminPackageActive : copy.adminPackageInactive}
                  </Badge>
                </HStack>
                <HStack gap="2">
                  <Button
                    size="xs"
                    variant="outline"
                    loading={toggle.isPending && toggle.variables?.id === pack.id}
                    onClick={() => toggle.mutate(pack)}
                    data-testid={`package-toggle-${pack.id}`}
                  >
                    {pack.isActive ? copy.adminPackageInactive : copy.adminPackageActive}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette="no"
                    loading={remove.isPending && remove.variables === pack.id}
                    onClick={() => remove.mutate(pack.id)}
                    data-testid={`package-delete-${pack.id}`}
                  >
                    {copy.adminPackageDelete}
                  </Button>
                </HStack>
              </HStack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
