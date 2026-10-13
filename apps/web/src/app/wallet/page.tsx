import { Alert, Container, Heading, Stack } from '@chakra-ui/react';
import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { walletLoginPath, walletPackageId } from '@/lib/charge-guide';
import { getServerSession } from '@/lib/session.server';
import { BalanceCard } from './balance-card';
import { ChargeForm } from './charge-form';
import { CouponForm } from './coupon-form';
import { LedgerList } from './ledger-list';
import { PaymentHistory } from './payment-history';

export const metadata: Metadata = { title: `${copy.walletTitle} | ${copy.appName}` };

/**
 * PLAN 11.3 `/wallet`: the balance and the ledger. The notice at the top is fixed copy (PLAN
 * Appendix A, N01 §2): P never converts back to cash.
 *
 * Charging, coupons and 결제 내역 are drawn only while paid Coin is on sale
 * (PAID_COIN_SALES_ENABLED, ADR-0049) — closed in the initial product (N06), where the API
 * refuses their routes as well. The components stay, so reopening is that one value.
 *
 * `?package=` is the package the public `/charge` page's 충전하기 sent the visitor to buy
 * (ADR-0044): its card is marked, and an anonymous visit keeps it through the login (`next`).
 * Read only while charging is drawn — a closed wallet ignores it and logs in to plain `/wallet`.
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
  if (!(await getServerSession())) redirect(walletLoginPath(packageId) as Route);
  return (
    <Container maxW="2xl" py={{ base: '6', md: '10' }}>
      <Stack gap="6">
        <Heading as="h2" size="2xl">
          {copy.walletTitle}
        </Heading>
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
    </Container>
  );
}
