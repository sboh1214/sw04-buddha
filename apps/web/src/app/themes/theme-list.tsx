'use client';

import { Alert, Button, Grid, Skeleton, Stack } from '@chakra-ui/react';
import { THEME_GRID_COLUMNS, ThemeCard } from '@/components/theme/theme-card';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useThemeList } from '@/hooks/use-themes';
import { listSection } from '@/lib/query-client';

const SKELETON_ROWS = [0, 1, 2];

/**
 * The public theme list's cards, 20 a page with 더 보기, in the API's order. The rungs are every
 * list's (`listSection`): skeleton, a first load that failed with 다시 시도, the empty notice, the
 * cards, and a notice above them when a later refresh failed.
 */
export function ThemeList() {
  const themes = useThemeList();
  const rows = themes.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(themes, rows.length);
  return (
    <Stack gap="4" data-testid="theme-list">
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid="themes-refresh-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Grid templateColumns={THEME_GRID_COLUMNS} gap="4">
          {SKELETON_ROWS.map((row) => (
            <Skeleton key={row} height="24" borderRadius="card" />
          ))}
        </Grid>
      ) : section.body === 'failed' ? (
        <Stack gap="3" align="flex-start" data-testid="themes-error">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void themes.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : section.body === 'empty' ? (
        <EmptyState message={copy.themesEmpty} data-testid="themes-empty" />
      ) : (
        <>
          <Grid templateColumns={THEME_GRID_COLUMNS} gap="4" data-testid="themes-grid">
            {rows.map((theme) => (
              <ThemeCard key={theme.id} theme={theme} />
            ))}
          </Grid>
          {themes.hasNextPage && (
            <Button
              alignSelf="center"
              variant="outline"
              borderRadius="pill"
              loading={themes.isFetchingNextPage}
              onClick={() => void themes.fetchNextPage()}
              data-testid="themes-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </>
      )}
    </Stack>
  );
}
