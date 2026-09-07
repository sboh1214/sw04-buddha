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
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { usePublicMarketFills } from '@/hooks/use-markets';
import { formatKst } from '@/lib/datetime';
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
 * is P per contract, not basis points.
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
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketRecentFills}
        </Heading>
      </Card.Header>
      <Card.Body>
        {fills.isPending ? (
          <Skeleton height="12" />
        ) : fills.isLoadingError ? (
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
        ) : fills.data.length === 0 ? (
          <EmptyState message={copy.marketFillsEmpty} />
        ) : (
          <Stack gap="1">
            {fills.data.map((fill) => (
              <HStack
                key={fill.id}
                gap="3"
                flexWrap="wrap"
                fontSize="sm"
                data-testid={`market-fill-${fill.id}`}
              >
                <Text color="fg.muted" minW="40">
                  {formatKst(fill.createdAt)}
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
