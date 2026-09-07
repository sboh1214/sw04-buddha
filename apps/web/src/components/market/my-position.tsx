'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  Heading,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { formatP, parsePAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { averageCostP, markPriceP, unrealizedPnlP, usePositions } from '@/hooks/use-portfolio';
import { type Position } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';

/**
 * 내 포지션 on the market detail (PLAN 11.3): what this visitor holds in THIS market, marked to
 * the market's own last price.
 *
 * Every figure is `use-portfolio.ts`'s arithmetic, in `bigint`. Not one of them is recomputed
 * here, and `markPriceP` in particular is the reason: a NO contract is worth the complement of
 * the YES price, and valuing it at the YES price is a silent error that produces a plausible
 * number wrong by 100 − 2·price per contract.
 *
 * The list itself is `usePositions('open')` — the same query the portfolio screen and the trade
 * panel read, so a trade's `applyPositionRow` seeds the rows this section shows rather than a
 * second copy of them. It waits for the session on its own, so a signed-out visitor never
 * provokes the 401 that the retry rule refuses to retry; they get the sign-in prompt instead.
 */

/** The repo's placeholder for a figure that does not exist (admin-market-detail.tsx). */
const EMPTY = '—';

export interface MyPositionProps {
  /** The market's canonical lower-cased uuid — `Position.marketId` carries the same string. */
  marketId: string;
  'data-testid'?: string;
}

export function MyPosition({
  marketId,
  'data-testid': testId = 'market-my-position',
}: MyPositionProps) {
  const positions = usePositions('open');
  const pathname = usePathname();
  const rows = (positions.data ?? []).filter((row) => row.marketId === marketId);

  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketMyPosition}
        </Heading>
      </Card.Header>
      <Card.Body>
        {!positions.isLoggedIn && !positions.isPending ? (
          <EmptyState
            message={copy.marketLoginToSeePosition}
            action={
              <Button asChild size="sm" variant="outline">
                {/* The visitor comes back to the market they were reading, which is the whole
                    reason the prompt is here rather than a bare link to /login. */}
                <NextLink href={{ pathname: '/login', query: { next: pathname } }}>
                  {copy.login}
                </NextLink>
              </Button>
            }
          />
        ) : positions.isPending ? (
          <Skeleton height="12" />
        ) : positions.isLoadingError ? (
          <Stack gap="2" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={() => void positions.refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : rows.length === 0 ? (
          <EmptyState message={copy.marketMyPositionEmpty} />
        ) : (
          <Stack gap="4">
            {rows.map((row) => (
              <PositionRows key={row.outcome} position={row} />
            ))}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

function PositionRows({ position }: { position: Position }) {
  const yes = position.outcome === 'YES';
  const average = averageCostP(position);
  const unrealized = unrealizedPnlP(position);
  const realized = parsePAmount(position.realizedPnlP);
  return (
    <Stack gap="2" data-testid={`market-position-${yes ? 'yes' : 'no'}`}>
      <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle" alignSelf="flex-start">
        {yes ? copy.yes : copy.no}
      </Badge>
      <DataList.Root orientation="horizontal" size="sm">
        <Item label={copy.positionQty}>{formatContracts(position.qty)}</Item>
        {/* A row the account has sold out of stays in the list so its realised PnL keeps
            showing; it holds nothing, so there is no average to divide out. */}
        <Item label={copy.positionAvgPrice}>
          {average === undefined ? EMPTY : formatP(average)}
        </Item>
        <Item label={copy.positionCurrentPrice}>{formatP(markPriceP(position))}</Item>
        <Item label={copy.positionPnl}>
          <Signed amount={unrealized} />
        </Item>
        <Item label={copy.positionRealizedPnl}>
          <Signed amount={realized} />
        </Item>
      </DataList.Root>
    </Stack>
  );
}

/**
 * A gain or a loss. `formatP` already writes a loss with U+2212 (PLAN 11.1-6), so the colour
 * only repeats what the sign and the row's label already say — which is the rule, not a
 * nicety: at 0 it stays on the ordinary foreground rather than claiming a direction.
 */
function Signed({ amount }: { amount: bigint }) {
  if (amount === 0n) return <>{formatP(amount)}</>;
  return (
    <Text as="span" colorPalette={amount > 0n ? 'yes' : 'no'} color="colorPalette.fg">
      {formatP(amount)}
    </Text>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue>{children}</DataList.ItemValue>
    </DataList.Item>
  );
}
