'use client';

import { HStack, Link as ChakraLink, Stack } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { FillHistoryList } from '@/components/history/fill-history-list';
import { OrderHistoryList } from '@/components/history/order-history-list';
import { SettlementHistoryList } from '@/components/history/settlement-history-list';
import { ProfileUnavailable } from '@/components/my/profile-unavailable';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import {
  HISTORY_KINDS,
  type HistoryFilters,
  type HistoryKind,
  historyListFilters,
  myHistoryPath,
} from '@/lib/my-history';
import { MarketFilterBar } from '../market-filter';
import { PeriodSelect } from '../period-select';
import { Section, SessionEnded, useSessionEnded } from '../portfolio';

/** 기록 종류's three names (ADR-0135 G2: '거래 유형' is the kind of record). */
const KIND_LABEL: Record<HistoryKind, string> = {
  orders: copy.historyKindOrders,
  fills: copy.historyKindFills,
  settlements: copy.historyKindSettlements,
};

/**
 * `/my/history`: 거래·정산 이력 (#124, ADR-0143 결정 6) — the account's ended orders, its fills and
 * its settlement records as three lists, one shown at a time (기록 종류), under the two filters all
 * three share: 기간 and one market. Top to bottom: the kind tabs, the filter line, the list.
 *
 * Every control writes the address and reads its value back out of the `filters` prop the server
 * page normalised (the community list's rule): `?kind=&period=&market=` is the one source of
 * truth, so a filtered list is an address to come back to and Back undoes a filter. The kind tabs
 * and a row's '이 시장만 보기' are links; the period and the market picked or let go are pushes,
 * marked busy until the page under the new address has come.
 *
 * Only the list shown is mounted, so only it reads; its query lives in its own file
 * (components/history). Each is keyed by the account `GET /me` names and waits for it
 * (`ProfileUnavailable`), and none of it is in the server's HTML — the page reads the picked
 * market's public title for the chip and nothing else.
 */
export function HistoryScreen({
  filters,
  marketTitle,
}: {
  filters: HistoryFilters;
  /** The title of the market `filters.market` names, read on the server; absent if it failed. */
  marketTitle?: string;
}) {
  const ended = useSessionEnded();
  const accountId = useMe().data?.id;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (next: HistoryFilters) => {
    startTransition(() => {
      router.push(myHistoryPath(next) as Route);
    });
  };
  if (ended) return <SessionEnded />;
  const listFilters = historyListFilters(filters);

  return (
    <Section title={copy.myHistory} testId="my-history">
      <Stack gap="4" minW="0">
        <HStack as="nav" aria-label={copy.historyKindLabel} gap="1" flexWrap="wrap">
          {HISTORY_KINDS.map((kind) => {
            const current = kind === filters.kind;
            return (
              <ChakraLink
                key={kind}
                asChild
                px="4"
                py="2"
                borderRadius="pill"
                textStyle="emphasisMd"
                color={current ? 'fg' : 'fg.muted'}
                textDecoration="none"
                bg={current ? 'surface.hover' : undefined}
                _hover={{ bg: 'surface.hover', color: 'fg', textDecoration: 'none' }}
                data-testid={`history-kind-${kind}`}
              >
                {/* The filters ride along: changing the kind keeps the period and the market. */}
                <NextLink
                  href={myHistoryPath({ ...filters, kind }) as Route}
                  aria-current={current ? 'true' : undefined}
                >
                  {KIND_LABEL[kind]}
                </NextLink>
              </ChakraLink>
            );
          })}
        </HStack>

        <MarketFilterBar
          market={filters.market}
          marketTitle={marketTitle}
          onChange={(market) => go({ ...filters, market })}
          prompt={copy.historyMarketPickerPrompt}
          testIdPrefix="history-market"
          rowTestId="history-filters"
        >
          <PeriodSelect
            value={filters.period}
            pending={pending}
            onChange={(period) => go({ ...filters, period })}
            testId="history-period"
          />
        </MarketFilterBar>

        {accountId === undefined ? (
          <ProfileUnavailable height="24" />
        ) : filters.kind === 'orders' ? (
          <OrderHistoryList
            key={accountId}
            accountId={accountId}
            filters={listFilters}
            testId="my-order-history"
          />
        ) : filters.kind === 'fills' ? (
          <FillHistoryList
            key={accountId}
            accountId={accountId}
            filters={listFilters}
            testId="my-fill-history"
          />
        ) : (
          <SettlementHistoryList
            key={accountId}
            accountId={accountId}
            filters={listFilters}
            testId="my-settlement-history"
          />
        )}
      </Stack>
    </Section>
  );
}
