'use client';

import { HStack, Heading, SimpleGrid, Skeleton, Stack, Text } from '@chakra-ui/react';
import { parseCoinAmount } from '@buddha/shared';
import { CoinText } from '@/components/ui/coin-text';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useOrders, usePositions } from '@/hooks/use-portfolio';
import { useLedger } from '@/hooks/use-wallet';
import { MY_PREVIEW_ROWS, MY_TABS, MY_WALLET_PATH, type MyTabKey } from '@/lib/my';
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

/** The tabs whose content their own issues bring (#51, #89, #53): 준비 중 until then. */
const COMING_SOON: readonly MyTabKey[] = ['posts', 'watchlist', 'notifications'];

function tab(key: MyTabKey) {
  const found = MY_TABS.find((item) => item.key === key);
  if (found === undefined) throw new Error(`unknown MY tab ${key}`);
  return found;
}

/**
 * `/my`, MY's first screen (owner decision 2026-10-13): 잔고 요약 — the old portfolio's card —
 * and a preview of each tab, the first `MY_PREVIEW_ROWS` rows through the tab's own list body
 * with a 전체 보기 to the tab. 설정 has no rows to preview; the tabs with no content yet say 준비 중.
 *
 * The holdings, 정산 이력 and the orders are read once here and handed to every card that shows
 * them, so the summary card and the previews are drawn from one price and one list.
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
      <SimpleGrid columns={{ base: 1, md: 3 }} gap="6">
        {COMING_SOON.map((key) => (
          <ComingSoonTab key={key} title={tab(key).label} testId={`my-preview-${key}`} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

/**
 * 지갑's preview: the balance as the wallet's own card states it, and the newest ledger rows.
 * A failed `GET /me` is reported once, by 잔고 요약 above, so the balance here is a dash then.
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
        <Stack gap="3">
          <Heading as="h4" size="sm">
            {copy.ledgerTitle}
          </Heading>
          {ledger.isPending ? (
            <Skeleton height="24" />
          ) : ledger.isError ? (
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
