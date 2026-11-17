import { DataList, Link as ChakraLink } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import type { ReactNode } from 'react';
import { CoinText } from '@/components/ui/coin-text';
import { copy } from '@/copy';

/**
 * What the three lists of 거래·정산 이력 (#124, ADR-0143) draw alike: a row's market line, its
 * '이 시장만 보기', a signed Coin figure and one label with its value. No hook and no directive —
 * the lists that use them are client components and own the queries.
 */

/** The repo's placeholder for a figure that does not exist (admin-market-detail.tsx). */
export const EMPTY = '—';

/**
 * A row's market: its title, the way to its detail — an ended or settled market has one too (N05
 * §3). `as Route`, as the other rows write it (typedRoutes takes the literal only).
 */
export function HistoryMarketLink({ slug, title }: { slug: string; title: string }) {
  return (
    <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
      <NextLink href={`/markets/${slug}` as Route}>{title}</NextLink>
    </ChakraLink>
  );
}

/**
 * '이 시장만 보기' (ADR-0135 G3): the list this row is in, narrowed to the row's market with the
 * period kept (`myHistoryPath`). The list leaves it out once it is narrowed to that market.
 */
export function OnlyMarketLink({ href }: { href: string }) {
  return (
    <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
      <NextLink href={href as Route} data-testid="history-only-market">
        {copy.historyOnlyMarket}
      </NextLink>
    </ChakraLink>
  );
}

/**
 * A gain or a loss, as the holdings write theirs (holding-rows.tsx): `formatCoin` writes a loss
 * with U+2212, so the colour only repeats the sign, and exactly 0 claims no direction. The name
 * beside it is all there is — no rank, rate or score (N04 §3).
 */
export function SignedCoin({ amount }: { amount: bigint }) {
  if (amount === 0n) return <CoinText amount={amount} />;
  return (
    <CoinText amount={amount} colorPalette={amount > 0n ? 'yes' : 'no'} color="colorPalette.fg" />
  );
}

/** One label and value; the value never pushes the row wider than the screen. */
export function HistoryItem({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue
        minW="0"
        overflowWrap="anywhere"
        fontVariantNumeric="tabular-nums"
        data-testid={testId}
      >
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}
