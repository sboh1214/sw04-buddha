'use client';

import { Alert, Badge, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { discountPercent, formatKrw, formatP, parsePAmount } from '@buddha/shared';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useChargePackages, useCharge } from '@/hooks/use-wallet';
import { isApiError, type ChargePackage } from '@/lib/api';

/**
 * PLAN 11.3 charging. Users buy one of the packages an admin configured (ADR-0026), so there
 * is no free-form amount: each card shows the P granted, the KRW price and the discount.
 */
export function ChargeForm() {
  const packages = useChargePackages();
  const charge = useCharge();

  async function buy(pack: ChargePackage) {
    try {
      const result = await charge.mutateAsync(pack.id);
      toaster.create({
        type: 'success',
        title: copy.chargeDone,
        description: formatP(parsePAmount(result.balance.availableP)),
      });
    } catch (error) {
      toaster.create({
        type: 'error',
        title: isApiError(error, 'VALIDATION_ERROR') ? copy.chargeUnavailable : copy.chargeFailed,
      });
    }
  }

  return (
    <Card.Root data-testid="charge-form">
      <Card.Header>
        <Text fontWeight="semibold">{copy.chargeTitle}</Text>
        <Text fontSize="sm" color="fg.muted">
          {copy.chargeHint}
        </Text>
      </Card.Header>
      <Card.Body>
        {packages.isPending ? (
          <Skeleton height="24" />
        ) : packages.isError ? (
          <Stack gap="3" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={() => void packages.refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : packages.data.length === 0 ? (
          <Text color="fg.muted">{copy.chargeNoPackages}</Text>
        ) : (
          <Stack gap="3">
            {packages.data.map((pack) => {
              const amountP = parsePAmount(pack.amountP);
              const discount = discountPercent(amountP, pack.priceKrw);
              const busy = charge.isPending && charge.variables === pack.id;
              return (
                <HStack
                  key={pack.id}
                  justify="space-between"
                  borderWidth="1px"
                  borderRadius="l2"
                  p="3"
                  gap="3"
                  data-testid={`charge-package-${pack.id}`}
                >
                  <Stack gap="0.5">
                    <HStack gap="2">
                      <Text fontWeight="semibold" fontSize="lg">
                        {formatP(amountP)}
                      </Text>
                      {discount > 0 && (
                        <Badge colorPalette="yes" variant="subtle">
                          {discount}% {copy.chargeDiscount}
                        </Badge>
                      )}
                    </HStack>
                    <Text fontSize="sm" color="fg.muted">
                      {formatKrw(pack.priceKrw)}
                    </Text>
                  </Stack>
                  <Button
                    onClick={() => void buy(pack)}
                    loading={busy}
                    disabled={charge.isPending && !busy}
                    data-testid={`charge-buy-${pack.id}`}
                  >
                    {copy.chargeSubmit}
                  </Button>
                </HStack>
              );
            })}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
