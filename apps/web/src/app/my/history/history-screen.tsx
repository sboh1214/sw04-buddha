'use client';

import {
  Box,
  Button,
  CloseButton,
  HStack,
  Link as ChakraLink,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { FillHistoryList } from '@/components/history/fill-history-list';
import { OrderHistoryList } from '@/components/history/order-history-list';
import { SettlementHistoryList } from '@/components/history/settlement-history-list';
import { ProfileUnavailable } from '@/components/my/profile-unavailable';
import { MarketPicker } from '@/components/post/market-picker';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import {
  HISTORY_KINDS,
  type HistoryFilters,
  type HistoryKind,
  historyListFilters,
  myHistoryPath,
} from '@/lib/my-history';
import { PILL_BUTTON } from '../../market-filters';
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
  const [picking, setPicking] = useState(false);
  // The picker is open only while no market is set, whichever way one was set: picked here, a
  // row's '이 시장만 보기', Back or Forward. The screen is not mounted again for a new address, so
  // an open picker left behind would come back open when the market is let go (React's
  // adjust-state-while-rendering pattern; no effect, no extra paint).
  if (picking && filters.market !== undefined) setPicking(false);
  // The market control swaps elements with the address: the chip replaces '시장 고르기' and the
  // button comes back when the chip is let go, so the element that had focus is removed and focus
  // would fall to the page. After a pick or a clear made HERE, the control that took its place
  // takes focus once the new address has rendered; a page load, a link or Back moves nothing.
  const pickRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'pick' | 'clear' | null>(null);
  useEffect(() => {
    const wanted = filters.market === undefined ? 'pick' : 'clear';
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === wanted) (wanted === 'pick' ? pickRef : clearRef).current?.focus();
  }, [filters.market]);
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

        <HStack gap="2" flexWrap="wrap" data-testid="history-filters">
          <PeriodSelect
            value={filters.period}
            pending={pending}
            onChange={(period) => go({ ...filters, period })}
            testId="history-period"
          />
          {filters.market === undefined ? (
            <Button
              ref={pickRef}
              {...PILL_BUTTON}
              variant="outline"
              aria-expanded={picking}
              onClick={() => setPicking((open) => !open)}
              data-testid="history-market-pick"
            >
              {copy.historyMarketPick}
            </Button>
          ) : (
            <HStack
              {...PILL_BUTTON}
              gap="1"
              pe="1"
              borderWidth="1px"
              borderColor="brand.border"
              maxW="100%"
              data-testid="history-market-chip"
            >
              <Text as="span" textStyle="emphasisSm" truncate>
                {`${copy.historyMarketChip}: ${marketTitle ?? copy.historyMarketUnknown}`}
              </Text>
              <CloseButton
                ref={clearRef}
                size="2xs"
                aria-label={copy.historyMarketClear}
                onClick={() => {
                  focusAfter.current = 'pick';
                  go({ ...filters, market: undefined });
                }}
                data-testid="history-market-clear"
              />
            </HStack>
          )}
        </HStack>

        {picking && filters.market === undefined && (
          <Box borderWidth="1px" borderColor="border.subtle" borderRadius="card" p="4" maxW="640px">
            <MarketPicker
              prompt={copy.historyMarketPickerPrompt}
              onPick={(market) => {
                // The picker (and the option that has focus) goes at once; the button holds focus
                // until the chip that replaces it has come.
                setPicking(false);
                pickRef.current?.focus();
                focusAfter.current = 'clear';
                go({ ...filters, market: market.id });
              }}
              testId="history-market-picker"
            />
          </Box>
        )}

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
