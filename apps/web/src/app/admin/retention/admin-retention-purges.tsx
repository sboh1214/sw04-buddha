'use client';

import {
  Alert,
  Badge,
  Button,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
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
 * from a run is usually one whose period was not approved then. A kind the run gave up on — a
 * batch's transaction rejected and rolled back — has its line marked 실패 beside its name, with
 * what its earlier batches deleted as '오류 전까지 N건' (owner decision 2026-10-24 14: the `failed`
 * record), and the next day's run tries it again (ADR-0087 결정 4); the notice says so too. A
 * failure the database would not even record (ADR-0087 7-21) leaves the kind without a line, or
 * with what its earlier batches deleted and no 실패 — the notice's last sentence says that as well.
 * 20 records per page with 더 보기 (A-M2-5), each page completed to the end of its last run by the
 * API, so every run shows whole. A 더 보기 that failed keeps the runs read so far and says so above
 * its button (`LoadMoreFailed`, owner decision 2026-10-20 7, ADR-0075 5-14 — as every 더 보기
 * list); only a first read that failed (`isLoadingError`) shows the error in their place.
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
      ) : purges.isLoadingError ? (
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
            <>
              {/* A 더 보기 that failed: the runs stay, and this says so above the button that asks
                  again (owner decision 2026-10-20 7, as every 더 보기 list). */}
              <LoadMoreFailed
                list={purges}
                message={copy.errUnknown}
                data-testid="admin-retention-more-failed"
              />
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
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * One run: its instant, then a line per kind — the name with 실패 beside it for a kind it gave up
 * on, then the count ('오류 전까지 N건' for that kind, so the badge is not the word before the
 * number, on screen or read aloud) and the period — wrapping rather than scrolling sideways at
 * phone width. Lines are keyed by `RetentionRunKind.key`: a kind can have two of one period, the
 * second what a later step deleted of it after its failure (`retentionRuns`).
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
            key={line.key}
            justify="space-between"
            align="baseline"
            gap="3"
            flexWrap="wrap"
            fontSize="sm"
            data-testid={`admin-retention-kind-${line.kind}`}
          >
            <HStack gap="2" flexWrap="wrap" minW="0" data-testid="admin-retention-label">
              <Text fontWeight="medium" minW="0" wordBreak="keep-all">
                {line.label}
              </Text>
              {line.failed && (
                <Badge colorPalette="red" variant="subtle" data-testid="admin-retention-failed">
                  {copy.adminRetentionFailed}
                </Badge>
              )}
            </HStack>
            <HStack gap="3" flexWrap="wrap" data-testid="admin-retention-figures">
              <Text
                fontWeight="semibold"
                fontVariantNumeric="tabular-nums"
                data-testid="admin-retention-count"
              >
                {retentionCountText(line.count, line.failed)}
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
