import { Container, HStack, Heading, Stack } from '@chakra-ui/react';
import type { Metadata, Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { myLoginPath } from '@/lib/my';
import { getServerSession } from '@/lib/session.server';
import { X_PATHNAME, X_SEARCH } from '@/proxy';
import { AccountActions } from './account-actions';
import { MyTabs } from './my-tabs';

export const metadata: Metadata = { title: `${copy.myTitle} | ${copy.appName}` };

/**
 * MY (#16): the signed-in reader's own screens, under one session gate and one tab bar. N04 §2
 * keeps the balance, orders, holdings, fills and PnL to their owner, so nothing below renders
 * for a visitor without a session — and nothing is prefetched for one either: every figure is
 * personal, `api.server.ts` forwards no cookie and `dehydratePublic` filters the private keys
 * out, so each screen fetches after hydration and draws its own skeleton until then.
 *
 * The gate runs where a layout runs — a hard load or a navigation INTO MY — and sends the visitor
 * to the login page told to come back to the MY page they asked for, from the headers `proxy.ts`
 * stamps (`myLoginPath`). A session that ends while a MY screen is open is each screen's own
 * signed-out rung (`profileView`), as it was before the move. Reading `cookies()` through
 * `getServerSession()` is also what marks every MY route dynamic.
 *
 * The profile menu's 관리자 and 로그아웃 live here (`AccountActions`), in one place for every tab.
 */
export default async function MyLayout({ children }: { children: React.ReactNode }) {
  if (!(await getServerSession())) {
    const requestHeaders = await headers();
    redirect(myLoginPath(requestHeaders.get(X_PATHNAME), requestHeaders.get(X_SEARCH)) as Route);
  }
  return (
    <Container maxW="4xl" py={{ base: '6', md: '10' }}>
      <Stack gap="6">
        <HStack justify="space-between" align="center" gap="3" flexWrap="wrap">
          <Heading as="h2" size="2xl">
            {copy.myTitle}
          </Heading>
          <AccountActions />
        </HStack>
        <MyTabs />
        {children}
      </Stack>
    </Container>
  );
}
