import { Container, HStack, Heading, Stack } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
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
 * The session gate is `requireMySession` (`lib/my.server.ts`), which sends a visitor to the login
 * page told to come back to the MY page they asked for. This layout calls it and so does every
 * MY page: the layout runs only on a hard load or a navigation INTO MY, the page on every
 * navigation to it. A session that ends while a MY screen stays open is that screen's own
 * business until the next navigation, as it was before the move: the lists and the balance draw
 * their signed-out rung (`useSessionEnded`, `profileView`), 설정's cards stay skeletons.
 *
 * 관리자 and 로그아웃 live here (`AccountActions`), in one place for every tab: the header has no
 * profile menu (owner decision 2026-10-13).
 */
export default async function MyLayout({ children }: { children: React.ReactNode }) {
  await requireMySession();
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
