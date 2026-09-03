import { Alert, Container, Heading, Stack } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { getServerSession } from '@/lib/session.server';
import { BalanceCard } from './balance-card';
import { ChargeForm } from './charge-form';
import { LedgerList } from './ledger-list';

export const metadata: Metadata = { title: `${copy.walletTitle} | ${copy.appName}` };

/**
 * PLAN 11.3 `/wallet`: balance, charging and the ledger. The notice at the top is fixed copy
 * (PLAN Appendix A) and must stay above the charge form — P never converts back to cash.
 */
export default async function WalletPage() {
  if (!(await getServerSession())) redirect('/login?next=/wallet');
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
        <ChargeForm />
        <LedgerList />
      </Stack>
    </Container>
  );
}
