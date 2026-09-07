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
import { type MarketStatus, formatP, parsePAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import {
  averageCostP,
  markPriceP,
  markToLivePrice,
  positionListStatusFor,
  unrealizedPnlP,
  usePositions,
} from '@/hooks/use-portfolio';
import { type Position } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';

/**
 * 내 포지션 on the market detail (PLAN 11.3): what this visitor holds in THIS market, marked to
 * the market's own last price while it still trades, and what the market paid them once it has
 * finished.
 *
 * Every figure is `use-portfolio.ts`'s arithmetic, in `bigint`. Not one of them is recomputed
 * here, and `markPriceP` in particular is the reason: a NO contract is worth the complement of
 * the YES price, and valuing it at the YES price is a silent error that produces a plausible
 * number wrong by 100 − 2·price per contract.
 *
 * The list itself is `usePositions` — the same query the portfolio screen and the trade panel
 * read, so a trade's `applyPositionRow` seeds the rows this section shows rather than a second
 * copy of them. It waits for the session on its own, so a signed-out visitor never provokes
 * the 401 that the retry rule refuses to retry; they get the sign-in prompt instead.
 *
 * WHICH of the two lists it reads follows the market's own status through
 * `positionListStatusFor`: a finished market moved its holders' rows to the settled list, so
 * asking only for `'open'` would answer "아직 이 시장에 참여하지 않았습니다" to an account that
 * did hold and was paid out — while /portfolio, reading the same rows, listed it under 정산
 * 이력 at the same moment. A finished market therefore shows 결과 · 실현 손익 (PLAN 11.3),
 * field for field the 정산 이력 row, so the two screens cannot say different things.
 */

/** The repo's placeholder for a figure that does not exist (admin-market-detail.tsx). */
const EMPTY = '—';

export interface MyPositionProps {
  /** The market's canonical lower-cased uuid — `Position.marketId` carries the same string. */
  marketId: string;
  /**
   * The market's current status, which is what says which of the two position lists this
   * account's rows are in. Optional and `'open'` by default: a caller that has not loaded the
   * row yet keeps exactly the pre-terminal reading rather than guessing at the wrong list, and
   * the detail page seeds the row into the cache before the first client render, so the
   * default is a fallback and not the ordinary path.
   */
  status?: MarketStatus;
  /**
   * The market's live YES price, which is what 현재가 and 평가손익 are marked to.
   *
   * `Position.marketLastPrice` is a join taken when the positions list was fetched, and only
   * this account's own trades ever move that list; somebody else's trade arrives as a
   * `market:tick` and writes the `['market', id]` cache instead. Without this prop the
   * probability in the header above and the valuation in this card drifted apart on a market
   * anyone else was trading — the same reading, from two different prices, one screen apart.
   * `undefined` (the row not loaded) keeps the snapshot the list carried, which is exactly
   * what /portfolio does for a market it has no cache entry for.
   */
  lastPrice?: number;
  'data-testid'?: string;
}

export function MyPosition({
  marketId,
  status = 'open',
  lastPrice,
  'data-testid': testId = 'market-my-position',
}: MyPositionProps) {
  const listStatus = positionListStatusFor(status);
  const positions = usePositions(listStatus);
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
            {rows.map((row) =>
              listStatus === 'settled' ? (
                // A finished market is never marked to a price (see `SettledPositionRows`), so
                // the live one is not passed down here — there is nothing for it to value.
                <SettledPositionRows key={row.outcome} position={row} />
              ) : (
                <PositionRows key={row.outcome} position={markToLivePrice(row, lastPrice)} />
              ),
            )}
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
 * 결과 · 실현 손익 for a market that has finished (PLAN 11.3) — the same three fields, in the
 * same order, as /portfolio's 정산 이력 row, so one account's row cannot read differently on
 * the two screens. It carries no market link or status badge: this IS that market's page, and
 * the header badge and the status notice above have already said what it became.
 *
 * No 현재가 and no 평가손익. Void and settlement both close the row out (`voidRefund` and
 * `settle` both leave qty and cost basis at 0), the P has already landed in the balance,
 * and `marketLastPrice` on a finished market is only the last price something TRADED at — so
 * marking such a row to it would print a plausible number that is not a result. `realizedPnlP`
 * is the whole story, and on a void it is only what earlier sells made, the refund itself
 * being a return of the cost rather than a gain.
 */
function SettledPositionRows({ position }: { position: Position }) {
  const yes = position.outcome === 'YES';
  const result = position.resolvedResult;
  return (
    <Stack gap="2" data-testid={`market-settled-${yes ? 'yes' : 'no'}`}>
      <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle" alignSelf="flex-start">
        {yes ? copy.yes : copy.no}
      </Badge>
      <DataList.Root orientation="horizontal" size="sm">
        {/* A voided market resolved to nothing at all, and every P it took was refunded. */}
        <Item label={copy.marketResolvedResult}>
          {result === null ? EMPTY : result === 'YES' ? copy.yes : copy.no}
        </Item>
        <Item label={copy.positionQty}>{formatContracts(position.qty)}</Item>
        <Item label={copy.positionRealizedPnl}>
          <Signed amount={parsePAmount(position.realizedPnlP)} />
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
