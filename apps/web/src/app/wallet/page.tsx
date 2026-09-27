import { Alert, Container, Heading, Stack } from '@chakra-ui/react';
import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { getServerSession } from '@/lib/session.server';
import { parseWalletSearch, walletLoginPath } from '@/lib/smartro-payments';
import { BalanceCard } from './balance-card';
import { ChargeForm } from './charge-form';
import { CouponForm } from './coupon-form';
import { LedgerList } from './ledger-list';
import { PaymentHistory } from './payment-history';
import { PaymentResultNotice } from './payment-result-notice';

export const metadata: Metadata = { title: `${copy.walletTitle} | ${copy.appName}` };

/**
 * PLAN 11.3 `/wallet`: balance, charging and the ledger. The notice at the top is fixed copy
 * (PLAN Appendix A) and must stay above the charge form — P never converts back to cash.
 *
 * The query (DESIGN §6.2, all optional, each ignored unless well formed):
 * - `payment` + `result`: where the SmartroPay callbacks send the browser back, with how the
 *   payment window ended (ADR-0042). `result` alone still gets its notice — a return the API
 *   could not tie to a payment of ours carries no id.
 * - `package`: the package the public `/charge` page's 충전하기 sent the visitor to buy.
 * An anonymous visit keeps all three through the login (`next`), so the package chosen on
 * `/charge` is still the chosen one after signing in.
 */
export default async function WalletPage({
  searchParams,
}: {
  // Every searchParams value is an array when the parameter repeats; the types must say so.
  searchParams: Promise<{
    payment?: string | string[];
    result?: string | string[];
    package?: string | string[];
  }>;
}) {
  const search = parseWalletSearch(await searchParams);
  if (!(await getServerSession())) redirect(walletLoginPath(search) as Route);
  return (
    <Container maxW="2xl" py={{ base: '6', md: '10' }}>
      <Stack gap="6">
        <Heading as="h2" size="2xl">
          {copy.walletTitle}
        </Heading>
        {search.result !== undefined && (
          <PaymentResultNotice paymentId={search.paymentId} result={search.result} />
        )}
        <Alert.Root status="info" data-testid="wallet-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.walletNotice}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <BalanceCard />
        <ChargeForm highlightPackageId={search.packageId} />
        <CouponForm />
        <PaymentHistory />
        <LedgerList />
      </Stack>
    </Container>
  );
}
