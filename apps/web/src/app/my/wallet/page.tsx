import { Alert, Stack } from '@chakra-ui/react';
import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { fetchMarketServer } from '@/lib/api.server';
import { historyMarketTitle } from '@/lib/my-history';
import { requireMySession } from '@/lib/my.server';
import { type WalletSearchParams, walletFiltersFromSearchParams } from '@/lib/wallet';
import { BalanceCard } from './balance-card';
import { ChargeForm } from './charge-form';
import { CouponForm } from './coupon-form';
import { LedgerSection } from './ledger-list';
import { PaymentHistory } from './payment-history';
import { ReconciliationCorrectionHistory } from './reconciliation-correction-history';

export const metadata: Metadata = { title: `${copy.walletTitle} | ${copy.appName}` };

/**
 * MY's 지갑 (`/my/wallet`, #16; PLAN 11.3's `/wallet` until then): the balance and the ledger.
 * The notice at the top is fixed copy (PLAN Appendix A, N01 §2): Coin never converts back to
 * cash. No session -> the login page, on every navigation to it (`requireMySession`).
 *
 * Charging, coupons and 결제 내역 are drawn only while paid Coin is on sale
 * (PAID_COIN_SALES_ENABLED, ADR-0049) — closed in the initial product (N06), where the API
 * refuses their routes as well. The components stay, so reopening is that one value.
 *
 * `?package=` is the package the public `/charge` page's 충전하기 sent the visitor to buy
 * (ADR-0044): its card is marked, and an anonymous visit keeps it through the login (the MY
 * gate's `myLoginPath`). Read only while charging is drawn — a closed wallet ignores it.
 *
 * `?kind=&period=&market=` are 이용 내역's filters (#69, ADR-0144): normalised ONCE, here, and
 * handed down (`walletFiltersFromSearchParams` — a value the API would refuse is dropped, and a
 * package is kept only while sales are on). No row of the ledger is read on the server: it is the
 * account's own, read in the browser with its cookie. The one thing read here is the public title
 * of the market `?market=` names, for the filter's chip (`historyMarketTitle`, as the history's).
 * An anonymous visit to a filtered address comes back from the login to the unfiltered wallet: the
 * MY gate carries only the package (`myLoginPath`, ADR-0144 결정 2-13).
 */
export default async function WalletPage({
  searchParams,
}: {
  // Every searchParams value is an array when the parameter repeats; the types must say so.
  searchParams: Promise<WalletSearchParams>;
}) {
  await requireMySession();
  const filters = walletFiltersFromSearchParams(await searchParams);
  const marketTitle = await historyMarketTitle(filters.market, fetchMarketServer);
  return (
    // The wallet's own measure from before the move, inside MY's wider column.
    <Stack gap="6" maxW="2xl">
      <Alert.Root status="info" data-testid="wallet-notice">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.walletNotice}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
      <BalanceCard />
      {PAID_COIN_SALES_ENABLED && (
        <>
          <ChargeForm highlightPackageId={filters.packageId} />
          <CouponForm />
          <PaymentHistory />
        </>
      )}
      <LedgerSection filters={filters} marketTitle={marketTitle} />
      <ReconciliationCorrectionHistory />
    </Stack>
  );
}
