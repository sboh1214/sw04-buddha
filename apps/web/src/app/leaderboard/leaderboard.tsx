'use client';

import { Alert, Skeleton, Stack, Table, Text } from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useLeaderboard } from '@/hooks/use-leaderboard';
import { listSection } from '@/lib/query-client';

/**
 * PLAN M6's optional global ranking. A table, not cards: three short columns whose whole point
 * is that they line up, and a reader compares down a column rather than across a row.
 *
 * The amounts are formatted through `formatCoin` from the decimal STRING the API sent — never
 * `Number(...)`, which is the one thing PLAN 0.2 forbids about a Coin amount and which
 * `use-portfolio.test.ts` already demonstrates losing precision.
 */
export function Leaderboard() {
  const query = useLeaderboard();
  const rows = query.data ?? [];
  const section = listSection(query, rows.length);

  return (
    <Stack gap="4">
      <Text color="fg.muted">{copy.leaderboardIntro}</Text>
      {/* A refetch that failed while rows are on screen: the rows stay, the notice sits above
          them. Same shape as every other list in this app. */}
      {section.stale && (
        <Alert.Root status="warning" size="sm">
          <Alert.Indicator />
          <Alert.Title>{copy.errLeaderboardLoad}</Alert.Title>
        </Alert.Root>
      )}
      {section.body === 'pending' && <Skeleton height="16" data-testid="leaderboard-pending" />}
      {section.body === 'failed' && (
        <Alert.Root status="error">
          <Alert.Indicator />
          <Alert.Title>{copy.errLeaderboardLoad}</Alert.Title>
        </Alert.Root>
      )}
      {section.body === 'empty' && (
        <EmptyState message={copy.leaderboardEmpty} data-testid="leaderboard-empty" />
      )}
      {section.body === 'rows' && (
        <Table.Root size="sm" data-testid="leaderboard-table">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>{copy.leaderboardRank}</Table.ColumnHeader>
              <Table.ColumnHeader>{copy.leaderboardNickname}</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">{copy.leaderboardRealizedPnl}</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((entry) => (
              <Table.Row key={entry.rank}>
                <Table.Cell>{entry.rank}</Table.Cell>
                <Table.Cell>{entry.nickname}</Table.Cell>
                <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                  {formatCoin(parseCoinAmount(entry.realizedPnlCoin))}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
    </Stack>
  );
}
