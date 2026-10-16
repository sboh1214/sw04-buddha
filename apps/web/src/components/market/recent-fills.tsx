'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  HStack,
  Heading,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { usePublicMarketFills } from '@/hooks/use-markets';
import { listView } from '@/lib/query-client';
import { formatContracts, formatPricePerContract } from '@/lib/market-admin';

/**
 * 최근 체결 (PLAN 11.3's 시장 상세): the newest twenty fills, anonymous.
 *
 * The route answers one page with no cursor and no `meta`, so there is no 더 보기 to render —
 * the list is deliberately a glance at what just happened, not a tape. It shares its cache key
 * with the admin detail's own fills list (`marketFillsKey`), which is why it goes through
 * `usePublicMarketFills` rather than declaring a second query for the same rows.
 *
 * Every row states its side and its outcome in words beside the colour (PLAN 11.2), and both
 * numbers come from the shared formatters: a contract count is never a bare integer and a price
 * is Coin per contract, not basis points.
 */

export interface RecentFillsProps {
  /** The market's canonical lower-cased uuid — the fills route takes a uuid only. */
  marketId: string;
  /**
   * Off while the market cannot have fills to read, e.g. a draft in the admin preview: the
   * public route answers 404 for one, which is not a failure worth rendering.
   */
  enabled?: boolean;
  'data-testid'?: string;
}

export function RecentFills({
  marketId,
  enabled = true,
  'data-testid': testId = 'market-fills',
}: RecentFillsProps) {
  const fills = usePublicMarketFills(marketId, enabled);
  const formatDateTime = useFormatDateTime();
  // Four states, not three: `listView` is where `stale` stops being folded into `ready`.
  const view = listView(fills);
  // `view` no longer narrows `data` for the compiler the way the old `isPending`/`isLoadingError`
  // ladder did, and a `stale` list renders its rows by design — so the rows are read once here.
  const rows = fills.data ?? [];
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketRecentFills}
        </Heading>
      </Card.Header>
      <Card.Body>
        {/* A refetch that FAILED keeps the rows it last answered, and on this list that silence
            costs a row: `market:trade` carries no `amountCoin`, so it is deliberately never merged
            into the cache and the refetch is the only path a new fill arrives by. The rows stay
            — the same reading `market-list.tsx` takes — with the same notice and a way back. */}
        {view === 'stale' && (
          <Alert.Root status="warning" role="status" data-testid="market-fills-stale" mb="3">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
            </Alert.Content>
            <Button size="xs" variant="outline" ml="auto" onClick={() => void fills.refetch()}>
              {copy.retry}
            </Button>
          </Alert.Root>
        )}
        {view === 'pending' ? (
          <Skeleton height="12" />
        ) : view === 'failed' ? (
          <Stack gap="2" align="flex-start">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.errUnknown}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button size="sm" variant="outline" onClick={() => void fills.refetch()}>
              {copy.retry}
            </Button>
          </Stack>
        ) : rows.length === 0 ? (
          <EmptyState message={copy.marketFillsEmpty} />
        ) : (
          <Stack gap="1">
            {rows.map((fill) => (
              <HStack
                key={fill.id}
                gap="3"
                flexWrap="wrap"
                fontSize="sm"
                data-testid={`market-fill-${fill.id}`}
              >
                <Text color="fg.muted" minW="40">
                  {formatDateTime(fill.createdAt)}
                </Text>
                <Badge colorPalette={fill.outcome === 'YES' ? 'yes' : 'no'} variant="subtle">
                  {fill.outcome === 'YES' ? copy.yes : copy.no}
                </Badge>
                <Text>{fill.side === 'buy' ? copy.buy : copy.sell}</Text>
                <Text>{formatContracts(fill.qty)}</Text>
                <Text color="fg.muted">
                  {copy.fillAvgPrice} {formatPricePerContract(fill.priceAvgBp)}
                </Text>
              </HStack>
            ))}
          </Stack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
