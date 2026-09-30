'use client';

import { Alert, Badge, Button, Card, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { discountPercent, formatKrw, formatP, parsePAmount } from '@buddha/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cacheOwnerAccount } from '@/components/auth/session-cache-guard';
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
  SMARTRO_APPROVAL_TIMEOUT_MS,
  checkoutOnAccount,
  reservationToOpen,
  withCheckoutPhase,
} from '@/lib/smartro-checkout';
import { isSmartroMobile, smartroScriptUrl } from '@/lib/smartro-sdk';
import { checkoutErrorTitle, isBelowCardMinimum } from '@/lib/smartro-payments';
import { useSession } from '@/lib/use-session';
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
  /** Whose payment it is: the account the prepare sent, which its 2xx proved. */
  account: string;
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
 * A window is the account's that opened it, and stays on screen only while the tab is still
 * that account's (`checkoutBelongsTo`): the ReturnUrl approves by Moid, whoever the cookie then
 * names, so a window left over a wallet another tab has since signed in as somebody else would
 * take a card payment on B's screen and credit it to A. A prepare that answers after the switch
 * opens nothing (`reservationToOpen`), and a window already there is taken off the screen when
 * the switch is noticed (`checkoutOnAccount`) — closed before anything is approved when it is
 * still loading or open; when its page is already on the way out (an approval posted, a phone
 * sent to tmpay), the buttons wait for that navigation rather than come back under it.
 *
 * "Noticed" is better-auth's session atom changing, and until it does this tab still reads as
 * the account that opened the window — so the window stays up, and an approval made in it
 * credits that account, the one the screen still shows. The atom lags in three ways
 * (`SessionCacheGuard`'s limits): side-by-side windows never fire `visibilitychange`, so there
 * the switch waits for the next session refetch; a tab brought back within 5 s of its last
 * focus refetch skips the refetch that return would make (better-auth rate-limits it,
 * `FOCUS_REFETCH_RATE_LIMIT_SECONDS`), so a quick sign-in elsewhere and a quick return go unseen
 * until the next one; and this tab's own requests under the new cookie — the 결제 내역 refetch a
 * prepare's answer starts, say — reach the query cache but never the atom, so that list can show
 * the other account's rows beside this one's balance. A phone already sent to tmpay has no page
 * left here to close.
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
  // The payment id of the last window a switch of account stopped: its toast is an effect's.
  const [stopped, setStopped] = useState<string | null>(null);
  // The payment id of a window a switch of account dropped while its page was on the way out
  // (`checkoutOnAccount`'s `depart`): the buttons wait for that navigation, or for its clock.
  const [departing, setDeparting] = useState<string | null>(null);
  const { data: session, isPending: sessionPending } = useSession();
  // Who the tab belongs to now, as `SessionCacheGuard` reads it; undefined while better-auth
  // is still asking.
  const account = sessionPending ? undefined : (session?.user.id ?? null);
  const highlighted = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  // Another account's window leaves the screen as soon as this render knows the tab is not the
  // opener's any more. Adjusted during render (the realtime provider's precedent) rather than in
  // an effect: the window unmounts in the same commit — a late prepare answer never mounts at
  // all — and `set-state-in-effect` is an error here. Emptied rather than hidden: a switch back
  // would remount the same payment's window under its old key and open it unasked.
  const onAccount = checkoutOnAccount(checkout, account);
  if (checkout !== null && onAccount !== 'keep') {
    setCheckout(null);
    if (onAccount === 'stop') setStopped(checkout.prepared.paymentId);
    if (onAccount === 'depart') setDeparting(checkout.prepared.paymentId);
  }

  useEffect(() => {
    if (stopped !== null) toaster.create({ type: 'info', title: copy.chargeWindowAccountChanged });
  }, [stopped]);

  // The approval clock's length (`SMARTRO_APPROVAL_TIMEOUT_MS`): a page still here by then had
  // its navigation refused or stopped, and nothing else would give the buttons back.
  useEffect(() => {
    if (departing === null) return;
    const clock = setTimeout(() => setDeparting(null), SMARTRO_APPROVAL_TIMEOUT_MS);
    return () => clearTimeout(clock);
  }, [departing]);

  const flow = provider.data?.provider;
  const smartro = flow === 'smartro';
  const openCheckout =
    checkout !== null && ACTIVE_CHECKOUT_PHASES.has(checkout.phase) ? checkout : null;
  const ready = flow !== undefined && (smartro ? prepare.ready : charge.ready);
  // The package whose button spins, and whether any purchase is under way at all.
  let workingOn: string | undefined;
  if (smartro) workingOn = prepare.isPending ? prepare.variables?.id : openCheckout?.packageId;
  else workingOn = charge.isPending ? charge.variables?.id : undefined;
  const working = smartro
    ? prepare.isPending || openCheckout !== null || departing !== null
    : charge.isPending;

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
      // The owner is read from the guard once the answer lands, not from this render's
      // session, which is frozen on the account that clicked.
      const reservation = await reservationToOpen(prepare.mutateAsync(pack), cacheOwnerAccount);
      if (reservation === null) {
        toaster.create({ type: 'error', title: copy.sessionChanged });
        return;
      }
      const { prepared, account: sent } = reservation;
      // Read at click time, in the browser: the SDK decides PC or phone by this same string.
      const userAgent = window.navigator.userAgent;
      setCheckout({
        packageId: pack.id,
        prepared,
        account: sent,
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
