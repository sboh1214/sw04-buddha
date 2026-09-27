'use client';

import { Alert, Badge, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { discountPercent, formatKrw, formatP, parsePAmount } from '@buddha/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  isChargeInProgress,
  isStaleCatalogue,
  useChargePackages,
  useCharge,
  usePaymentProvider,
  useSmartroPrepare,
} from '@/hooks/use-wallet';
import {
  isApiError,
  isForAnotherAccount,
  type ChargePackage,
  type SmartroPrepareResult,
} from '@/lib/api';
import {
  ACTIVE_CHECKOUT_PHASES,
  type CheckoutPhase,
  withCheckoutPhase,
} from '@/lib/smartro-checkout';
import { isSmartroMobile, smartroScriptUrl } from '@/lib/smartro-sdk';
import { checkoutErrorTitle, isBelowCardMinimum } from '@/lib/smartro-payments';
import { SmartroCheckout } from './smartro-checkout';

/**
 * Only a stale catalogue may claim the package is gone — re-priced, retired or deleted —
 * which is the same set `useCharge` refetches on, so the message and the cards changing under
 * it always agree. A provider refusal is a VALIDATION_ERROR too but names `amountP`: nothing
 * about the offer changed, so it must not say so. The two DUPLICATE_REQUEST answers (PLAN 5.4)
 * are told apart the way `useCharge` tells them apart: an earlier click is still running (the
 * key was kept, so the next click collects it), or an earlier click already bought this. The
 * account refusal means the session was switched in another tab: nothing was charged. The
 * payment window's own refusals (a missing contact) come first; both flows share the rest.
 */
function chargeErrorTitle(error: unknown): string {
  const checkout = checkoutErrorTitle(error);
  if (checkout !== undefined) return checkout;
  if (isApiError(error, 'PRICE_MOVED')) return copy.chargePriceMoved;
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isChargeInProgress(error)) return copy.chargeInProgress;
  if (isApiError(error, 'DUPLICATE_REQUEST')) return copy.chargeDuplicate;
  if (isStaleCatalogue(error)) return copy.chargeUnavailable;
  return copy.chargeFailed;
}

/** The payment window of the last package clicked under SmartroPay, and where it is. */
interface Checkout {
  packageId: string;
  prepared: SmartroPrepareResult;
  scriptUrl: string;
  mobile: boolean;
  phase: CheckoutPhase;
}

/**
 * PLAN 11.3 charging. Users buy one of the packages an admin configured (ADR-0026), so there
 * is no free-form amount: each card shows the P granted, the KRW price and the discount.
 *
 * Two flows behind the same buttons, chosen by the server's provider (ADR-0042):
 * - `mock`: one click charges at once (`useCharge`) and a toast confirms it — unchanged, and
 *   what the e2e suite drives.
 * - `smartro`: one click reserves a payment (`useSmartroPrepare`) and opens the SmartroPay
 *   window for it (`SmartroCheckout`); the page returns to `/wallet?payment=&result=` with
 *   the outcome. Every button waits while a window is on its way or open.
 * Until the provider is known every button waits too — it decides what a click does.
 *
 * `highlightPackageId` is `/wallet?package=`, the package the public `/charge` page sent the
 * visitor to buy: that card is marked and scrolled to, and buying stays a click of its own.
 */
export function ChargeForm({ highlightPackageId }: { highlightPackageId?: string }) {
  const packages = useChargePackages();
  const provider = usePaymentProvider();
  const charge = useCharge();
  const prepare = useSmartroPrepare();
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const highlighted = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  const flow = provider.data?.provider;
  const smartro = flow === 'smartro';
  const openCheckout =
    checkout !== null && ACTIVE_CHECKOUT_PHASES.has(checkout.phase) ? checkout : null;
  const ready = flow !== undefined && (smartro ? prepare.ready : charge.ready);
  // The package whose button spins, and whether any purchase is under way at all.
  let workingOn: string | undefined;
  if (smartro) workingOn = prepare.isPending ? prepare.variables?.id : openCheckout?.packageId;
  else workingOn = charge.isPending ? charge.variables?.id : undefined;
  const working = smartro ? prepare.isPending || openCheckout !== null : charge.isPending;

  // Once, when the cards first render: bring the package the visitor came for into view.
  useEffect(() => {
    if (scrolled.current || highlighted.current === null) return;
    scrolled.current = true;
    highlighted.current.scrollIntoView({ block: 'center' });
  }, [packages.data]);

  // Scoped by payment id: a window this one replaced may still be winding down.
  const onPhase = useCallback((paymentId: string, phase: CheckoutPhase) => {
    setCheckout((current) => withCheckoutPhase(current, paymentId, phase));
    if (phase === 'failed') toaster.create({ type: 'error', title: copy.chargeWindowFailed });
  }, []);

  async function buy(pack: ChargePackage) {
    try {
      const result = await charge.mutateAsync(pack);
      toaster.create({
        type: 'success',
        title: copy.chargeDone,
        description: formatP(parsePAmount(result.balance.availableP)),
      });
    } catch (error) {
      toaster.create({ type: 'error', title: chargeErrorTitle(error) });
    }
  }

  async function openWindow(pack: ChargePackage) {
    try {
      const prepared = await prepare.mutateAsync(pack);
      // Read at click time, in the browser: the SDK decides PC or phone by this same string.
      const userAgent = window.navigator.userAgent;
      setCheckout({
        packageId: pack.id,
        prepared,
        scriptUrl: smartroScriptUrl(prepared.scriptUrl, userAgent),
        mobile: isSmartroMobile(userAgent),
        phase: 'loading',
      });
    } catch (error) {
      toaster.create({ type: 'error', title: chargeErrorTitle(error) });
    }
  }

  // The provider fails the section only when it never loaded: a background refetch that fails
  // (it is re-read on focus, and after a refused charge) keeps the flow already on screen.
  const failed = packages.isError || provider.isLoadingError;

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
        ) : failed ? (
          <Stack gap="3" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (packages.isError) void packages.refetch();
                if (provider.isLoadingError) void provider.refetch();
              }}
            >
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
              const busy = workingOn === pack.id;
              const chosen = pack.id === highlightPackageId;
              // The window takes cards from 1,000원: a cheaper package is shown, not offered.
              const belowMinimum = smartro && isBelowCardMinimum(pack.priceKrw);
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
                        {formatP(amountP)}
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
                    {belowMinimum && (
                      <Text fontSize="xs" color="fg.muted">
                        {copy.chargeBelowCardMinimum}
                      </Text>
                    )}
                  </Stack>
                  <Button
                    onClick={() => void (smartro ? openWindow(pack) : buy(pack))}
                    loading={busy}
                    disabled={(working && !busy) || !ready || belowMinimum}
                    data-testid={`charge-buy-${pack.id}`}
                  >
                    {copy.chargeSubmit}
                  </Button>
                </HStack>
              );
            })}
            {checkout?.phase === 'approving' && (
              <Text fontSize="sm" color="fg.muted" role="status" data-testid="charge-approving">
                {copy.chargeApproving}
              </Text>
            )}
          </Stack>
        )}
        {checkout !== null && (
          <SmartroCheckout
            key={checkout.prepared.paymentId}
            prepared={checkout.prepared}
            scriptUrl={checkout.scriptUrl}
            mobile={checkout.mobile}
            onPhase={onPhase}
          />
        )}
      </Card.Body>
    </Card.Root>
  );
}
