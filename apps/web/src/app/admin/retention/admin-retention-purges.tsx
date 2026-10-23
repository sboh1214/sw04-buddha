'use client';

import { Alert, Button, HStack, Link as ChakraLink, Skeleton, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useRetentionPurges } from '@/hooks/use-admin-retention';
import { formatKst } from '@/lib/datetime';
import {
  ADMIN_RELEASE_SETTINGS_PATH,
  type RetentionRun,
  retentionCountText,
  retentionPeriodText,
  retentionRuns,
} from '@/lib/retention';

/**
 * 보존기간 처리 기록 (#184, ADR-0087; ADR-0069 decision 4 #184 «종류·건수·시각을 운영 기록으로 남긴다.
 * 개인정보 내용은 남기지 않는다»): what the worker's daily `retention.purge` deleted, run by run,
 * newest first — each kind it processed with how many it deleted (0 too: it looked and found
 * nothing due) and the period it applied, at the run's instant in Seoul. Read-only. Which kinds a
 * run processes is the release settings' (`/admin/settings` — only an approved period deletes,
 * ADR-0069 decision 7), so the screen says so above the list with the way there. A kind missing
 * from a run is one whose period was not approved then — or one whose first batch failed: a failed
 * batch rolls back with its record and the kind writes no 0, so it shows no line, or only what its
 * earlier batches deleted. The failure is in the worker's log ('retention purge kind failed') and
 * the job's result alone, and the next day's run tries the kind again (ADR-0087 결정 4); the notice
 * says so too. 20 records per page with 더 보기 (A-M2-5), each page completed to the end of its last
 * run by the API, so every run shows whole.
 */
export function AdminRetentionPurges() {
  const purges = useRetentionPurges();
  const runs = retentionRuns(purges.data?.pages.flatMap((page) => page.items) ?? []);

  return (
    <Stack gap="4" data-testid="admin-retention">
      <Stack gap="2">
        <Text color="fg.muted">{copy.adminRetentionIntro}</Text>
        <Text fontSize="sm" color="fg.muted" data-testid="admin-retention-settings-notice">
          {copy.adminRetentionSettingsNotice}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
            <NextLink
              href={ADMIN_RELEASE_SETTINGS_PATH}
              data-testid="admin-retention-settings-link"
            >
              {copy.adminRetentionSettingsLink}
            </NextLink>
          </ChakraLink>
        </Text>
      </Stack>
      {purges.isPending ? (
        <Skeleton height="24" />
      ) : purges.isError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : runs.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-retention-empty">
          {copy.adminRetentionEmpty}
        </Text>
      ) : (
        <Stack gap="2">
          <Stack as="ol" gap="2" listStyleType="none" data-testid="admin-retention-runs">
            {runs.map((run) => (
              <RunRow key={run.ranAt} run={run} />
            ))}
          </Stack>
          {purges.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={purges.isFetchingNextPage}
              onClick={() => void purges.fetchNextPage()}
              data-testid="admin-retention-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * One run: its instant, then a line per kind — the name, the count and the period — wrapping
 * rather than scrolling sideways at phone width.
 */
function RunRow({ run }: { run: RetentionRun }) {
  return (
    <Stack
      as="li"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="2"
      data-testid={`admin-retention-run-${run.ranAt}`}
    >
      <Text fontSize="sm" color="fg.muted" data-testid="admin-retention-ran-at">
        {copy.adminRetentionRanAt} {formatKst(run.ranAt)}
      </Text>
      <Stack as="ul" gap="1" listStyleType="none">
        {run.kinds.map((line) => (
          <HStack
            as="li"
            key={`${line.kind}-${String(line.periodDays)}`}
            justify="space-between"
            align="baseline"
            gap="3"
            flexWrap="wrap"
            fontSize="sm"
            data-testid={`admin-retention-kind-${line.kind}`}
          >
            <Text fontWeight="medium" minW="0" wordBreak="keep-all">
              {line.label}
            </Text>
            <HStack gap="3" flexWrap="wrap">
              <Text
                fontWeight="semibold"
                fontVariantNumeric="tabular-nums"
                data-testid="admin-retention-count"
              >
                {retentionCountText(line.count)}
              </Text>
              <Text color="fg.muted" data-testid="admin-retention-period">
                {retentionPeriodText(line.periodDays)}
              </Text>
            </HStack>
          </HStack>
        ))}
      </Stack>
    </Stack>
  );
}
