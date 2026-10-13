import { Alert, Stack } from '@chakra-ui/react';
import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { walletPackageId } from '@/lib/charge-guide';
import { BalanceCard } from './balance-card';
import { ChargeForm } from './charge-form';
import { CouponForm } from './coupon-form';
import { LedgerList } from './ledger-list';
import { PaymentHistory } from './payment-history';

export const metadata: Metadata = { title: `${copy.walletTitle} | ${copy.appName}` };

/**
 * MY's 지갑 (`/my/wallet`, #16; PLAN 11.3's `/wallet` until then): the balance and the ledger.
 * The notice at the top is fixed copy (PLAN Appendix A, N01 §2): Coin never converts back to
 * cash. The session gate is the MY layout's.
 *
 * Charging, coupons and 결제 내역 are drawn only while paid Coin is on sale
 * (PAID_COIN_SALES_ENABLED, ADR-0049) — closed in the initial product (N06), where the API
 * refuses their routes as well. The components stay, so reopening is that one value.
 *
 * `?package=` is the package the public `/charge` page's 충전하기 sent the visitor to buy
 * (ADR-0044): its card is marked, and an anonymous visit keeps it through the login (the MY
 * layout's `myLoginPath`). Read only while charging is drawn — a closed wallet ignores it.
 */
export default async function WalletPage({
  searchParams,
}: {
  // Every searchParams value is an array when the parameter repeats; the types must say so.
  searchParams: Promise<{ package?: string | string[] }>;
}) {
  const packageId = PAID_COIN_SALES_ENABLED
    ? walletPackageId((await searchParams).package)
    : undefined;
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
          <ChargeForm highlightPackageId={packageId} />
          <CouponForm />
          <PaymentHistory />
        </>
      )}
      <LedgerList />
    </Stack>
  );
}
