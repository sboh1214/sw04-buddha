'use client';

import { Link as ChakraLink, HStack, Heading, Skeleton, Stack, Text } from '@chakra-ui/react';
import { parseCoinAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { CoinText } from '@/components/ui/coin-text';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useOrders, usePositions } from '@/hooks/use-portfolio';
import { useLedger } from '@/hooks/use-wallet';
import { useWatchlist } from '@/hooks/use-watchlist';
import { MY_PREVIEW_ROWS, MY_TABS, MY_WALLET_PATH, type MyTabKey } from '@/lib/my';
import { readFailed } from '@/lib/query-client';
import { profilePath } from '@/lib/profile';
import { ComingSoonTab } from './coming-soon';
import {
  BalanceSummary,
  LoadFailed,
  OrdersBody,
  PositionsBody,
  Section,
  SessionEnded,
  SettledBody,
  useHoldings,
  useSessionEnded,
} from './portfolio';
import { LedgerRow } from './wallet/ledger-list';
import { StartGrantPendingNotice } from './wallet/start-grant-notice';
import { WatchlistBody } from './watchlist/watchlist';

function tab(key: MyTabKey) {
  const found = MY_TABS.find((item) => item.key === key);
  if (found === undefined) throw new Error(`unknown MY tab ${key}`);
  return found;
}

/**
 * `/my`, MY's first screen (owner decision 2026-10-13): 잔고 요약 — the old portfolio's card —
 * and a preview of each tab, the first `MY_PREVIEW_ROWS` rows through the tab's own list body
 * with a 전체 보기 to the tab. 설정 has no rows to preview; the tabs with no content yet say 준비 중
 * (내 글 #51, 알림 #53). The previews run in the tab bar's order (MY_TABS, the owner's), so 관심
 * 시장 — rows since #89 (ADR-0064), the newest three watches as market cards — sits between the
 * 준비 중 of 내 글 and of 알림.
 *
 * The holdings, 정산 이력 and the orders are read once here and handed to every card that shows
 * them, so the summary card and the previews are drawn from one price and one list.
 *
 * Above them, the way to the member's own public profile (`ViewOwnProfileLink`, owner decision
 * 2026-10-21 answer 7), as from MY 설정's 프로필 card.
 */
export function MySummary() {
  const ended = useSessionEnded();
  const holdings = useHoldings();
  const settled = usePositions('settled');
  const orders = useOrders();
  if (ended) return <SessionEnded />;

  const positions = tab('positions');
  const pending = tab('orders');
  const history = tab('history');
  return (
    <Stack gap="6">
      <ViewOwnProfileLink />
      <BalanceSummary holdings={holdings} settled={settled} />
      <Section title={positions.label} testId="my-preview-positions" href={positions.href}>
        <PositionsBody holdings={holdings} limit={MY_PREVIEW_ROWS} />
      </Section>
      <Section title={pending.label} testId="my-preview-orders" href={pending.href}>
        <OrdersBody orders={orders} kind="pending" limit={MY_PREVIEW_ROWS} />
      </Section>
      <Section title={history.label} testId="my-preview-history" href={history.href}>
        <Stack gap="5">
          <Stack gap="3">
            <Heading as="h4" size="sm">
              {copy.portfolioSettled}
            </Heading>
            <SettledBody settled={settled} limit={MY_PREVIEW_ROWS} />
          </Stack>
          <Stack gap="3">
            <Heading as="h4" size="sm">
              {copy.portfolioOrders}
            </Heading>
            <OrdersBody orders={orders} kind="history" limit={MY_PREVIEW_ROWS} />
          </Stack>
        </Stack>
      </Section>
      <WalletPreview />
      <ComingSoonPreview tabKey="posts" />
      <WatchlistPreview />
      <ComingSoonPreview tabKey="notifications" />
    </Stack>
  );
}

/**
 * '내 공개 프로필 보기' (#41, ADR-0078; owner decision 2026-10-21 answer 7: «MY 설정 + MY 요약»): the
 * page everyone sees of the account at `/u/<publicId>`, the same link as MY 설정's 프로필 card.
 * Drawn once `GET /me` has answered with the public id; nothing while it is read or when it failed
 * — 잔고 요약 below reports that failure, once.
 */
function ViewOwnProfileLink() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <ChakraLink asChild alignSelf="flex-start" textStyle="bodySm" color="brand.fg">
      <NextLink href={profilePath(me.profile.publicId) as Route} data-testid="my-view-profile">
        {copy.viewOwnProfile}
      </NextLink>
    </ChakraLink>
  );
}

/** The preview of a tab whose content its own issue brings: 준비 중 (ADR-0054 decision 1-7). */
function ComingSoonPreview({ tabKey }: { tabKey: MyTabKey }) {
  return <ComingSoonTab title={tab(tabKey).label} testId={`my-preview-${tabKey}`} />;
}

/**
 * 관심 시장's preview (#89): the tab's own body with its first `MY_PREVIEW_ROWS` cards, and the
 * tab's 전체 보기 for the rest. Its own component so its query and its room joins live only as
 * long as the summary does.
 */
function WatchlistPreview() {
  const watchlist = useWatchlist();
  const watchlistTab = tab('watchlist');
  return (
    <Section title={watchlistTab.label} testId="my-preview-watchlist" href={watchlistTab.href}>
      <WatchlistBody watchlist={watchlist} limit={MY_PREVIEW_ROWS} />
    </Section>
  );
}

/**
 * 지갑's preview: the balance as the wallet's own card states it — with the wallet's notice while
 * the start Coin waits for its amount (`StartGrantPendingNotice`, owner decision 2026-10-18) — and
 * the newest ledger rows. A failed `GET /me` is reported once, by 잔고 요약 above, so the balance
 * here is a dash then, and there is no notice.
 *
 * The rows are the wallet tab's own query (`useLedger`), so its failure rung is `readFailed`, not
 * `isError`: a 더 보기 that failed on the wallet tab leaves that query in `error` with its pages
 * kept, and on `isError` this preview — which has no 더 보기 — swapped its rows for an error on the
 * way back, and through the refetch that follows (ADR-0075 5-18).
 */
function WalletPreview() {
  const me = useMe();
  const ledger = useLedger();
  const entries = (ledger.data?.pages[0]?.items ?? []).slice(0, MY_PREVIEW_ROWS);

  return (
    <Section title={copy.myWallet} testId="my-preview-wallet" href={MY_WALLET_PATH}>
      <Stack gap="4">
        {me.isPending ? (
          <Skeleton height="6" />
        ) : (
          <HStack gap="4" flexWrap="wrap" fontSize="sm">
            <HStack gap="2">
              <Text color="fg.muted">{copy.walletBalance}</Text>
              {me.data ? (
                <CoinText
                  fontWeight="semibold"
                  amount={parseCoinAmount(me.data.balance.availableCoin)}
                  data-testid="my-preview-wallet-available"
                />
              ) : (
                <Text>—</Text>
              )}
            </HStack>
            <HStack gap="2" color="fg.muted">
              <Text>{copy.walletLocked}</Text>
              {me.data ? (
                <CoinText amount={parseCoinAmount(me.data.balance.lockedCoin)} />
              ) : (
                <Text>—</Text>
              )}
            </HStack>
          </HStack>
        )}
        <StartGrantPendingNotice
          me={me.data}
          size="sm"
          testId="my-preview-wallet-start-grant-pending"
        />
        <Stack gap="3">
          <Heading as="h4" size="sm">
            {copy.ledgerTitle}
          </Heading>
          {ledger.isPending ? (
            <Skeleton height="24" />
          ) : readFailed(ledger) ? (
            <LoadFailed message={copy.errUnknown} onRetry={() => void ledger.refetch()} />
          ) : entries.length === 0 ? (
            <Text color="fg.muted">{copy.ledgerEmpty}</Text>
          ) : (
            <Stack gap="3" divideY="1px">
              {entries.map((entry) => (
                <LedgerRow key={entry.id} entry={entry} />
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Section>
  );
}
