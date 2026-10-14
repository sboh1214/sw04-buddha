'use client';

import { Alert, Badge, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { discountPercent, formatKrw, formatCoin, parseCoinAmount } from '@buddha/shared';
import { useEffect, useRef } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  isChargeInProgress,
  isStaleCatalogue,
  useChargePackages,
  useCharge,
} from '@/hooks/use-wallet';
import { isApiError, isForAnotherAccount, type ChargePackage } from '@/lib/api';
import { isUnavailable } from '@/lib/payments';

/**
 * Only a stale catalogue may claim the package is gone — re-priced, retired or deleted —
 * which is the same set `useCharge` refetches on, so the message and the cards changing under
 * it always agree. A provider refusal is a VALIDATION_ERROR too but names `amountCoin`: nothing
 * about the offer changed, so it must not say so. The two DUPLICATE_REQUEST answers (PLAN 5.4)
 * are told apart the way `useCharge` tells them apart: an earlier click is still running (the
 * key was kept, so the next click collects it), or an earlier click already bought this. The
 * account refusal means the session was switched in another tab: nothing was charged. A closed
 * route names no feature (`isUnavailable`).
 */
function chargeErrorTitle(error: unknown): string {
  if (isApiError(error, 'PRICE_MOVED')) return copy.chargePriceMoved;
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isChargeInProgress(error)) return copy.chargeInProgress;
  if (isApiError(error, 'DUPLICATE_REQUEST')) return copy.chargeDuplicate;
  if (isStaleCatalogue(error)) return copy.chargeUnavailable;
  if (isUnavailable(error)) return copy.unavailable;
  return copy.chargeFailed;
}

/**
 * PLAN 11.3 charging. Users buy one of the packages an admin configured (ADR-0026), so there
 * is no free-form amount: each card shows the Coin granted, the KRW price and the discount. One
 * click charges at once (`useCharge`, the mock provider of ADR-0042) and a toast confirms it.
 * Not drawn while paid Coin is closed (PAID_COIN_SALES_ENABLED, ADR-0049; app/wallet/page.tsx).
 *
 * `highlightPackageId` is `/wallet?package=`, the package the public `/charge` page sent the
 * visitor to buy (ADR-0044): that card is marked and scrolled to, and buying stays a click of
 * its own.
 */
export function ChargeForm({ highlightPackageId }: { highlightPackageId?: string }) {
  const packages = useChargePackages();
  const charge = useCharge();
  const highlighted = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  // Once, when the cards first render: bring the package the visitor came for into view.
  useEffect(() => {
    if (scrolled.current || highlighted.current === null) return;
    scrolled.current = true;
    highlighted.current.scrollIntoView({ block: 'center' });
  }, [packages.data]);

  async function buy(pack: ChargePackage) {
    try {
      const result = await charge.mutateAsync(pack);
      toaster.create({
        type: 'success',
        title: copy.chargeDone,
        description: formatCoin(parseCoinAmount(result.balance.availableCoin)),
      });
    } catch (error) {
      toaster.create({ type: 'error', title: chargeErrorTitle(error) });
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
              const amountCoin = parseCoinAmount(pack.amountCoin);
              const discount = discountPercent(amountCoin, pack.priceKrw);
              const busy = charge.isPending && charge.variables?.id === pack.id;
              const chosen = pack.id === highlightPackageId;
              return (
                <HStack
                  key={pack.id}
                  ref={chosen ? highlighted : undefined}
                  justify="space-between"
                  borderWidth="1px"
                  borderRadius="l2"
                  p="3"
                  gap="3"
                  {...(chosen ? { borderColor: 'brand.border', bg: 'brand.subtle' } : {})}
                  data-testid={`charge-package-${pack.id}`}
                  data-selected={chosen ? 'true' : undefined}
                >
                  <Stack gap="0.5">
                    <HStack gap="2" flexWrap="wrap">
                      <Text fontWeight="semibold" fontSize="lg">
                        {formatCoin(amountCoin)}
                      </Text>
                      {discount > 0 && (
                        <Badge colorPalette="yes" variant="subtle">
                          {discount}% {copy.chargeDiscount}
                        </Badge>
                      )}
                      {chosen && (
                        <Badge colorPalette="brand" variant="outline">
                          {copy.chargePackageSelected}
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
                    disabled={(charge.isPending && !busy) || !charge.ready}
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
