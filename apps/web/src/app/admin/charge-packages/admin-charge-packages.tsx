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
  CHARGE_PACKAGE_MAX_COIN,
  CHARGE_PACKAGE_MIN_COIN,
  discountPercent,
  formatKrw,
  formatCoin,
  parseCoinAmount,
} from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { CHARGE_PACKAGES_QUERY_KEY } from '@/hooks/use-wallet';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import { ApiError, api, isApiError, unwrap, type ChargePackage } from '@/lib/api';
import { boundedInteger, integerField } from '@/lib/form-schema';

const ADMIN_PACKAGES_KEY = ['admin', 'charge-packages'] as const;

const DIGITS = /^\d+$/;

/** Same rules as the API: a positive integer amount within bounds, price never above it. */
const schema = z
  .object({
    amountCoin: boundedInteger(
      DIGITS,
      copy.errPackagePrice,
      (amount) => amount >= CHARGE_PACKAGE_MIN_COIN && amount <= CHARGE_PACKAGE_MAX_COIN,
      copy.errPackagePrice,
    ),
    priceKrw: integerField(DIGITS, copy.errPackagePrice),
    sortOrder: integerField(DIGITS, copy.errPackagePrice),
  })
  // Object-level, so it runs even when a field above failed and it sees the raw string: it
  // has to prove both halves are digits itself before converting (see lib/form-schema).
  .refine(
    (value) =>
      !DIGITS.test(value.amountCoin) ||
      !DIGITS.test(value.priceKrw) ||
      BigInt(value.priceKrw) <= BigInt(value.amountCoin),
    { message: copy.errPackagePrice, path: ['priceKrw'] },
  );
type FormValues = z.infer<typeof schema>;

/** Both lists a package write changes: this screen's and the wallet's. */
const invalidatePackages = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ADMIN_PACKAGES_KEY }),
    queryClient.invalidateQueries({ queryKey: CHARGE_PACKAGES_QUERY_KEY }),
  ]);

/**
 * 충전 상품 (ADR-0026; off the nav while paid Coin is off, ADR-0049): add, retire or revive, and
 * remove. Each names the admin on screen (`useOperatorId`, ADR-0092 — the removal in its query),
 * so they wait for `GET /me`; the cookie of another account is refused (`copy.sessionChanged`)
 * and the session asked again. The add form is drawn for that admin (`CreatePackageCard`, keyed by
 * it, its fields off until it is known): `['me']` turning from A to B in place drops what A typed
 * (owner decision 2026-10-26 17:21 answer 1).
 */
export function AdminChargePackages() {
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const packages = useQuery({
    queryKey: ADMIN_PACKAGES_KEY,
    queryFn: async (): Promise<ChargePackage[]> =>
      unwrap(await api.GET('/api/v1/admin/charge-packages')).data,
  });

  const invalidate = () => invalidatePackages(queryClient);

  const toggle = useMutation({
    mutationFn: async ({ pack, by }: { pack: ChargePackage; by: string }) =>
      unwrap(
        await api.PATCH('/api/v1/admin/charge-packages/{id}', {
          params: { path: { id: pack.id } },
          body: { isActive: !pack.isActive, expectedAccountId: by },
        }),
      ).data,
    onSuccess: invalidate,
    onError: (error) =>
      toaster.create({
        type: 'error',
        title: sessionChanged(error) ? copy.sessionChanged : copy.errUnknown,
      }),
  });

  const remove = useMutation({
    mutationFn: async ({ id, by }: { id: string; by: string }) => {
      const result = await api.DELETE('/api/v1/admin/charge-packages/{id}', {
        // A DELETE has no body: the admin on screen rides in the query.
        params: { path: { id }, query: { expectedAccountId: by } },
      });
      // The API's refusal as read everywhere else, so another account's is told apart.
      if (result.error) throw new ApiError(result.response.status, result.error.error);
    },
    onSuccess: async () => {
      toaster.create({ type: 'success', title: copy.adminPackageDeleted });
      await invalidate();
    },
    onError: (error) =>
      toaster.create({
        type: 'error',
        title: sessionChanged(error) ? copy.sessionChanged : copy.errUnknown,
      }),
  });

  return (
    <Stack gap="4">
      <CreatePackageCard key={operatorId ?? ''} />
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
            const amountCoin = parseCoinAmount(pack.amountCoin);
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
                  <Text fontWeight="semibold">{formatCoin(amountCoin)}</Text>
                  <Text color="fg.muted">{formatKrw(pack.priceKrw)}</Text>
                  <Badge colorPalette="yes" variant="subtle">
                    {discountPercent(amountCoin, pack.priceKrw)}% {copy.chargeDiscount}
                  </Badge>
                  <Badge colorPalette={pack.isActive ? 'brand' : 'gray'} variant="subtle">
                    {pack.isActive ? copy.adminPackageActive : copy.adminPackageInactive}
                  </Badge>
                </HStack>
                <HStack gap="2">
                  <Button
                    size="xs"
                    variant="outline"
                    loading={toggle.isPending && toggle.variables?.pack.id === pack.id}
                    disabled={operatorId === undefined}
                    onClick={() => {
                      if (operatorId !== undefined) toggle.mutate({ pack, by: operatorId });
                    }}
                    data-testid={`package-toggle-${pack.id}`}
                  >
                    {pack.isActive ? copy.adminPackageInactive : copy.adminPackageActive}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette="no"
                    loading={remove.isPending && remove.variables?.id === pack.id}
                    disabled={operatorId === undefined}
                    onClick={() => {
                      if (operatorId !== undefined) remove.mutate({ id: pack.id, by: operatorId });
                    }}
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

/**
 * 충전 상품 추가, for the admin on screen: drawn again for each (keyed by it in
 * AdminChargePackages), its three fields and 추가 off until that admin is known (`OperatorFieldset`).
 */
function CreatePackageCard() {
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();

  const create = useMutation({
    mutationFn: async ({ values, by }: { values: FormValues; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/charge-packages', {
          body: {
            amountCoin: values.amountCoin,
            priceKrw: Number(values.priceKrw),
            sortOrder: Number(values.sortOrder),
            isActive: true,
            expectedAccountId: by,
          },
        }),
      ).data,
    onSuccess: async () => {
      toaster.create({ type: 'success', title: copy.adminPackageSaved });
      reset({ amountCoin: '', priceKrw: '', sortOrder: '0' });
      await invalidatePackages(queryClient);
    },
    onError: (error) =>
      toaster.create({
        type: 'error',
        title: sessionChanged(error)
          ? copy.sessionChanged
          : isApiError(error, 'VALIDATION_ERROR')
            ? copy.errPackagePrice
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
    defaultValues: { amountCoin: '', priceKrw: '', sortOrder: '0' },
  });

  // Only on success (see the coupon screen): a refused price must not erase what was typed.
  const submit = handleSubmit(async (values) => {
    if (operatorId === undefined) return;
    await create.mutateAsync({ values, by: operatorId }).catch(() => undefined); // reported by onError
  });

  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminPackageAdd}</Text>
      </Card.Header>
      <Card.Body>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <OperatorFieldset disabled={operatorId === undefined}>
            <Stack gap="3">
              <HStack gap="2" align="start" flexWrap="wrap">
                <Field.Root invalid={!!errors.amountCoin} required maxW="40">
                  <Field.Label>{copy.adminPackageAmount}</Field.Label>
                  <Input
                    inputMode="numeric"
                    data-testid="package-amount"
                    {...register('amountCoin')}
                  />
                  <Field.ErrorText>{errors.amountCoin?.message}</Field.ErrorText>
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
                disabled={operatorId === undefined}
                data-testid="package-create"
              >
                {copy.adminPackageAdd}
              </Button>
            </Stack>
          </OperatorFieldset>
        </form>
      </Card.Body>
    </Card.Root>
  );
}
