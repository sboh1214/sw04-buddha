'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Heading,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
} from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { copy } from '@/copy';
import { useInstantReached } from '@/hooks/use-instant-reached';
import { useOrderBook } from '@/hooks/use-markets';
import {
  type Market,
  type OrderBook,
  type OrderBookContract,
  type OrderBookLevel,
} from '@/lib/api';
import { formatContracts, formatPricePerContract } from '@/lib/market-admin';
import { marketBookKey } from '@/lib/market-keys';
import {
  BOOK_SIDES,
  type BookOutcome,
  type BookSide,
  type BookSideKey,
  bookMoreLabel,
  bookReasonMessage,
  bookRereadAt,
  bookSideKey,
  hiddenLevelCount,
  shownLevels,
} from '@/lib/order-book-view';
import { type ListView, listView, restartQueries } from '@/lib/query-client';

/**
 * 호가창 (#122, ADR-0138; ADR-0135 B1·B2·B3, decision 4's #122 rows): the public book of one
 * market, YES and NO together, each with its 매도호가 over its 매수호가 and the best price first.
 *
 * Two parts, because this app's tests render without effects or clicks (`renderToStaticMarkup`):
 * `OrderBookSection` holds the wiring — the query, the four sides' 더 보기·접기 state and the
 * read at the close — and `OrderBookView` draws from props alone, so every state is testable as
 * HTML.
 *
 * Every number is the book's own: a level's price and summed quantity, and each side's best price
 * as the API answered it. Nothing is computed from another value — no ask made from a bid, no
 * level borrowed from the other contract, no two contracts added, no running total, depth bar or
 * spread (N02 §5, ADR-0135 decision 1 item 17, B6). A level carries no account, direction or
 * source, and nothing here marks a reader's own order or the operator's (B4, ADR-0114).
 *
 * This is part of #122, not all of it: while an open market's book has a reason — 마감 between its
 * close and the worker's, 일시 중단 under a ledger hold — the order entry is still drawn, and
 * turning that entry off is the order panel's (#66, ADR-0135 result 4). The PR is 'Part of #122'
 * for that reason, and #122 closes when #66 merges (owner, ADR-0138).
 */

export interface OrderBookSectionProps {
  /** The row's canonical lower-cased uuid — the key `market:book` restarts. */
  marketId: string;
  /** The live row, `undefined` while it is pending or failed: only the close's re-read uses it. */
  market: Market | undefined;
  /** The server's instant at the read (`detailWindowEnd`), the anchor of the close's timer. */
  now?: number;
}

export function OrderBookSection({ marketId, market, now }: OrderBookSectionProps) {
  const queryClient = useQueryClient();
  const query = useOrderBook(marketId);
  // One state per side, each its own: opening YES 매수호가 opens nothing else, and its 접기 folds
  // it back to five. A re-read keeps them; a reload starts folded (ADR-0138).
  const [yesAsks, setYesAsks] = useState(false);
  const [yesBids, setYesBids] = useState(false);
  const [noAsks, setNoAsks] = useState(false);
  const [noBids, setNoBids] = useState(false);
  // Nothing is published at the close itself, so an open market's book is read once more a
  // second past it (`bookRereadAt`); the worker's `market:status` follows when it closes.
  useInstantReached(bookRereadAt(market), now, () => {
    void restartQueries(queryClient, marketBookKey(marketId));
  });
  const expanded: Record<BookSideKey, boolean> = {
    'yes-asks': yesAsks,
    'yes-bids': yesBids,
    'no-asks': noAsks,
    'no-bids': noBids,
  };
  const setters: Record<BookSideKey, (open: boolean) => void> = {
    'yes-asks': setYesAsks,
    'yes-bids': setYesBids,
    'no-asks': setNoAsks,
    'no-bids': setNoBids,
  };
  return (
    <OrderBookView
      view={listView(query)}
      book={query.data}
      expanded={expanded}
      onToggle={(key) => {
        setters[key](!expanded[key]);
      }}
      onRetry={() => {
        void query.refetch();
      }}
    />
  );
}

export interface OrderBookViewProps {
  view: ListView;
  /** The last answer; drawn while `ready` and, under a notice, while `stale`. */
  book: OrderBook | undefined;
  expanded: Readonly<Record<BookSideKey, boolean>>;
  /** Opens a folded side or folds an open one: its 더 보기 and 접기 are one button. */
  onToggle: (key: BookSideKey) => void;
  onRetry: () => void;
}

/**
 * The section as drawn. The card and its `h2` are there in every state — the server's HTML is the
 * pending one, a skeleton under the title — so the slot keeps its place and its heading.
 *
 * A book with a reason (`marketRejectReason`) draws one line in place of the contracts; the
 * reason, not the market's status, decides it (ADR-0135 B3), which is why this takes no status.
 */
export function OrderBookView({ view, book, expanded, onToggle, onRetry }: OrderBookViewProps) {
  return (
    <Card.Root data-testid="market-order-book">
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketOrderBook}
        </Heading>
      </Card.Header>
      <Card.Body>
        {/* A failed re-read keeps the last book on screen and says so, as 최근 체결 does. */}
        {view === 'stale' && (
          <Alert.Root status="warning" role="status" data-testid="market-order-book-stale" mb="3">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
            </Alert.Content>
            <Button size="xs" variant="outline" ml="auto" onClick={onRetry}>
              {copy.retry}
            </Button>
          </Alert.Root>
        )}
        {view === 'pending' ? (
          <Skeleton height="6" data-testid="market-order-book-pending" />
        ) : view === 'failed' ? (
          <Stack gap="2" align="flex-start" data-testid="market-order-book-failed">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={onRetry}>
              {copy.retry}
            </Button>
          </Stack>
        ) : book === undefined ? null : book.marketRejectReason !== null ? (
          <Text color="fg.muted" data-testid="market-order-book-reason">
            {bookReasonMessage(book.marketRejectReason)}
          </Text>
        ) : (
          // Together, in the book's order (YES then NO): one over the other until there is room
          // for two readable columns (lg, ADR-0138), side by side from there (B1).
          <SimpleGrid columns={{ base: 1, lg: 2 }} gap={{ base: '6', lg: '8' }}>
            {book.contracts.map((contract) => (
              <BookContract
                key={contract.outcome}
                contract={contract}
                expanded={expanded}
                onToggle={onToggle}
              />
            ))}
          </SimpleGrid>
        )}
      </Card.Body>
    </Card.Root>
  );
}

/** One contract: its name as an `h3`, then 매도호가 over 매수호가. */
function BookContract({
  contract,
  expanded,
  onToggle,
}: {
  contract: OrderBookContract;
  expanded: Readonly<Record<BookSideKey, boolean>>;
  onToggle: (key: BookSideKey) => void;
}) {
  const yes = contract.outcome === 'YES';
  const testId = `market-order-book-${yes ? 'yes' : 'no'}`;
  return (
    <Stack gap="4" minW="0" data-testid={testId}>
      <Heading as="h3" size="sm">
        {/* The contract's colour here only; the rows are neutral. */}
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
      </Heading>
      {BOOK_SIDES.map((side) => (
        <BookSideLevels
          key={side}
          outcome={contract.outcome}
          side={side}
          levels={contract[side]}
          best={side === 'asks' ? contract.bestAskCoin : contract.bestBidCoin}
          // One visible header row per contract, over its first table: 매도호가's, or 매수호가's when
          // there is no ask. The other keeps its header for screen readers (`scope="col"`).
          showsHead={side === 'asks' || contract.asks.length === 0}
          expanded={expanded[bookSideKey(contract.outcome, side)]}
          onToggle={() => {
            onToggle(bookSideKey(contract.outcome, side));
          }}
          testId={`${testId}-${side}`}
        />
      ))}
    </Stack>
  );
}

/**
 * One side: its name and best price on one line — '매도호가 · 최우선 60.00 Coin', or '매도호가 · 호가
 * 없음' with no table when the side is empty (N02 §5) — then the levels, the first five until its
 * 더 보기 and again after its 접기. The best price is the answer's `bestAskCoin`·`bestBidCoin`,
 * never re-read off a row, and it is said here only: the first row is not made bold as well.
 */
function BookSideLevels({
  outcome,
  side,
  levels,
  best,
  showsHead,
  expanded,
  onToggle,
  testId,
}: {
  outcome: BookOutcome;
  side: BookSide;
  levels: readonly OrderBookLevel[];
  best: number | null;
  showsHead: boolean;
  expanded: boolean;
  onToggle: () => void;
  testId: string;
}) {
  const name = side === 'asks' ? copy.marketBookAsks : copy.marketBookBids;
  return (
    <Stack gap="2" data-testid={testId}>
      <Text fontSize="sm" color="fg.muted">
        <Text as="span" fontWeight="semibold" color="fg">
          {name}
        </Text>
        {' · '}
        {best === null ? (
          <Text as="span" data-testid={`${testId}-empty`}>
            {copy.marketBookEmpty}
          </Text>
        ) : (
          <Text as="span" data-testid={`${testId}-best`}>
            {`${copy.marketBookBest} ${formatPricePerContract(best * 100)}`}
          </Text>
        )}
      </Text>
      {levels.length > 0 && (
        <Table.Root size="sm" aria-label={`${outcome === 'YES' ? copy.yes : copy.no} ${name}`}>
          <Table.Header {...(showsHead ? {} : { srOnly: true })}>
            <Table.Row>
              <Table.ColumnHeader scope="col">{copy.marketBookPrice}</Table.ColumnHeader>
              <Table.ColumnHeader scope="col" textAlign="end">
                {copy.marketBookQty}
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shownLevels(levels, expanded).map((level) => (
              <Table.Row
                key={level.priceCoin}
                data-testid={`${testId}-level-${String(level.priceCoin)}`}
              >
                <BookLevelCells level={level} />
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      <BookMoreButton
        outcome={outcome}
        side={side}
        hiddenCount={hiddenLevelCount(levels)}
        expanded={expanded}
        onToggle={onToggle}
        testId={`${testId}-more`}
      />
    </Stack>
  );
}

/**
 * A level's two cells, from the level alone: its price per contract and its summed quantity
 * (ADR-0135 result 4). Its props are the public `OrderBookLevel` and nothing else, so no account,
 * direction or source can reach a row.
 */
function BookLevelCells({ level }: { level: OrderBookLevel }) {
  return (
    <>
      <Table.Cell fontVariantNumeric="tabular-nums">
        {formatPricePerContract(level.priceCoin * 100)}
      </Table.Cell>
      <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
        {formatContracts(level.qty)}
      </Table.Cell>
    </>
  );
}

/**
 * A side's 더 보기: opens the rest of that side and no other (B2). Once open, the same button
 * reads 접기 and folds the side back to five (owner decision 2026-11-16, ADR-0138). It stays
 * drawn either way, so the focus stays on it and `aria-expanded` says which it is. A side of five
 * levels or fewer has no button, open or not.
 */
function BookMoreButton({
  outcome,
  side,
  hiddenCount,
  expanded,
  onToggle,
  testId,
}: {
  outcome: BookOutcome;
  side: BookSide;
  /** The levels the folded side leaves out. */
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
  testId: string;
}) {
  if (hiddenCount === 0) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      alignSelf="flex-start"
      aria-label={bookMoreLabel(outcome, side, expanded)}
      aria-expanded={expanded}
      onClick={onToggle}
      data-testid={testId}
    >
      {expanded ? copy.marketBookCollapse : copy.marketBookShowAll}
    </Button>
  );
}
