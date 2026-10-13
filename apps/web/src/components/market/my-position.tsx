'use client';

import { Alert, Badge, Button, Card, DataList, Heading, Skeleton, Stack } from '@chakra-ui/react';
import { type MarketStatus, parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import {
  averageCostCoin,
  markPriceCoin,
  markToLiveMarket,
  positionListStatusFor,
  unrealizedPnlCoin,
  usePositions,
} from '@/hooks/use-portfolio';
import { type Position } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';
import { sessionListSection } from '@/lib/query-client';

/**
 * 내 포지션 on the market detail (PLAN 11.3): what this visitor holds in THIS market, marked to
 * the market's own last price while it still trades, and what the market paid them once it has
 * finished.
 *
 * Every figure is `use-portfolio.ts`'s arithmetic, in `bigint`. Not one of them is recomputed
 * here, and `markPriceCoin` in particular is the reason: a NO contract is worth the complement of
 * the YES price, and valuing it at the YES price is a silent error that produces a plausible
 * number wrong by 100 − 2·price per contract.
 *
 * The list itself is `usePositions` — the same query the portfolio screen reads, so the two
 * screens hold one copy of the rows rather than two. It waits for the session on its own, so a signed-out visitor never provokes
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
   * The market's live YES price, which is what 현재가 and 평가손익 are marked to; `null` is the
   * row saying 체결 없음.
   *
   * `Position.marketLastPrice` is a join taken when the positions list was fetched, and only
   * this account's own trades ever move that list; somebody else's trade arrives as a
   * `market:tick` and writes the `['market', id]` cache instead. Without this prop the
   * price in the header above and the valuation in this card drifted apart on a market
   * anyone else was trading — the same reading, from two different prices, one screen apart.
   * `undefined` (the row not loaded) keeps the snapshot the list carried, which is exactly
   * what /portfolio does for a market it has no cache entry for.
   */
  lastPrice?: number | null;
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
  // Four states, not three. A refetch that fails after the list has answered KEEPS the rows and
  // reports `isRefetchError`, which this ladder folded into the ordinary reading — and on this
  // card that silence is a false sentence, not merely a stale one. `user:position` can neither
  // BUILD a row (it carries no marketSlug/Title/Status/LastPrice) nor MOVE one between the two
  // lists, so `applyPositionEvent` answers `refetch` for exactly the two cases that matter here:
  // another tab opening this market's first holding, and a settlement. That refetch is the only
  // path, and when it failed the card told an account that DOES hold — and on a settled market,
  // one that was already paid out — 아직 이 시장에 참여하지 않았습니다.
  //
  // The count is the MARKET-FILTERED one: a stale list full of other markets' rows is empty for
  // this market, which is the reading that has to reach the empty rung rather than an empty list.
  const section = sessionListSection(positions, rows.length);

  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketMyPosition}
        </Heading>
      </Card.Header>
      <Card.Body>
        {section.body === 'signedOut' ? (
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
        ) : (
          <Stack gap="3">
            {/* Above the body, never in place of it: the rows are real and worth keeping on
                screen, and the empty rung is the one that needs the label most. The same shape
                as 체결 내역 directly below this card. */}
            {section.stale && (
              <Alert.Root status="warning" role="status" data-testid="market-my-position-stale">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
                </Alert.Content>
                <Button
                  size="xs"
                  variant="outline"
                  ml="auto"
                  onClick={() => void positions.refetch()}
                >
                  {copy.retry}
                </Button>
              </Alert.Root>
            )}
            {section.body === 'pending' ? (
              <Skeleton height="12" />
            ) : section.body === 'failed' ? (
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
            ) : section.body === 'empty' ? (
              <EmptyState message={copy.marketMyPositionEmpty} />
            ) : (
              <Stack gap="4">
                {rows.map((row) =>
                  listStatus === 'settled' ? (
                    // A finished market is never marked to a price (see `SettledPositionRows`),
                    // so the live one is not passed down here — there is nothing to value.
                    <SettledPositionRows key={row.outcome} position={row} />
                  ) : (
                    <PositionRows
                      key={row.outcome}
                      position={markToLiveMarket(row, { lastPrice })}
                    />
                  ),
                )}
              </Stack>
            )}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

function PositionRows({ position }: { position: Position }) {
  const yes = position.outcome === 'YES';
  const average = averageCostCoin(position);
  // Both `undefined` for a market with no fill to mark to (체결 없음, N02 §5).
  const mark = markPriceCoin(position);
  const unrealized = unrealizedPnlCoin(position);
  const realized = parseCoinAmount(position.realizedPnlCoin);
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
          {average === undefined ? EMPTY : <CoinText amount={average} />}
        </Item>
        <Item label={copy.positionCurrentPrice}>
          {mark === undefined ? copy.noFills : <CoinText amount={mark} />}
        </Item>
        <Item label={copy.positionPnl}>
          {unrealized === undefined ? EMPTY : <Signed amount={unrealized} />}
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
 * No 현재가 and no 평가손익. Settlement closes the row out (`settle` leaves qty and cost basis at
 * 0), the Coin has already landed in the balance, and `marketLastPrice` on a finished market is
 * only the last price something TRADED at — so marking such a row to it would print a plausible
 * number that is not a result. `realizedPnlCoin` is the whole story.
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
        {/* A voided market resolved to nothing at all, so it has no result to name. */}
        <Item label={copy.marketResolvedResult}>
          {result === null ? EMPTY : result === 'YES' ? copy.yes : copy.no}
        </Item>
        <Item label={copy.positionQty}>{formatContracts(position.qty)}</Item>
        <Item label={copy.positionRealizedPnl}>
          <Signed amount={parseCoinAmount(position.realizedPnlCoin)} />
        </Item>
      </DataList.Root>
    </Stack>
  );
}

/**
 * A gain or a loss. `formatCoin` already writes a loss with U+2212 (PLAN 11.1-6), so the colour
 * only repeats what the sign and the row's label already say — which is the rule, not a
 * nicety: at 0 it stays on the ordinary foreground rather than claiming a direction.
 */
function Signed({ amount }: { amount: bigint }) {
  if (amount === 0n) return <CoinText amount={amount} />;
  return (
    <CoinText amount={amount} colorPalette={amount > 0n ? 'yes' : 'no'} color="colorPalette.fg" />
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
