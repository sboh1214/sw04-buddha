'use client';

import { Alert, Badge, Heading, Link as ChakraLink, Skeleton, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useCallback } from 'react';
import { PostBody } from '@/components/post/post-body';
import { copy } from '@/copy';
import { useAdminNoticeRevision } from '@/hooks/use-notices';
import { formatKst } from '@/lib/datetime';
import {
  adminNoticeImagePath,
  adminNoticePath,
  adminNoticeReadView,
  noticeActorName,
} from '@/lib/notices';

/**
 * One earlier version of a notice, read-only (#138, owner decision 2026-10-21: «이전 판을 보임»,
 * ADR-0077): the '이전 판' mark, its title, when and by whom it was written and replaced, and its
 * body through the posts' renderer, its images through the admin route (`adminNoticeImagePath` —
 * an image an edit took out is no longer public, and a notice not pinned shows none publicly).
 * Nothing on it writes. A version that is not this notice's, or an address that is not a version —
 * an unknown notice or a segment that is not a uuid among them — is '이전 판을 찾을 수 없습니다.'.
 * Once read, the version stays on screen: it never changes, and is not read again on its own
 * (`adminNoticeRevisionQueryOptions`). The title is an `h3` under the admin layout's `h2`, so the
 * body's headings start at `h4` (`headingFrom`).
 */
export function AdminNoticeRevisionView({
  noticeId,
  revisionId,
}: {
  noticeId: string;
  revisionId: string;
}) {
  const revision = useAdminNoticeRevision(noticeId, revisionId);
  const imageSrc = useCallback(
    (mediaId: string) => adminNoticeImagePath(noticeId.toLowerCase(), mediaId),
    [noticeId],
  );
  const back = (
    <ChakraLink
      asChild
      fontSize="sm"
      colorPalette="brand"
      color="colorPalette.fg"
      alignSelf="flex-start"
    >
      <NextLink href={adminNoticePath(noticeId) as Route} data-testid="admin-notice-revision-back">
        ← {copy.adminNoticeBackToEdit}
      </NextLink>
    </ChakraLink>
  );
  const view = adminNoticeReadView(revision);
  if (view === 'missing' || view === 'failed') {
    return (
      <Stack gap="4">
        {back}
        <Alert.Root status="error" role="alert" data-testid="admin-notice-revision-missing">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {view === 'missing' ? copy.adminNoticeRevisionNotFound : copy.errUnknown}
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    );
  }
  if (view === 'pending' || revision.data === undefined) return <Skeleton height="48" />;
  const version = revision.data;
  return (
    <Stack gap="4" data-testid="admin-notice-revision">
      {back}
      <Stack gap="2">
        <Badge variant="subtle" colorPalette="gray" alignSelf="flex-start">
          {copy.adminNoticeRevisionBadge}
        </Badge>
        <Heading
          as="h3"
          size="lg"
          wordBreak="break-word"
          data-testid="admin-notice-revision-heading"
        >
          {version.title}
        </Heading>
        <Text fontSize="sm" color="fg.muted" data-testid="admin-notice-revision-written">
          {`${copy.adminNoticeRevisionWritten} ${formatKst(version.writtenAt)} · ${noticeActorName(version.writtenBy)}`}
        </Text>
        <Text fontSize="sm" color="fg.muted" data-testid="admin-notice-revision-replaced">
          {`${copy.adminNoticeRevisionReplaced} ${formatKst(version.replacedAt)} · ${noticeActorName(version.replacedBy)}`}
        </Text>
      </Stack>
      <PostBody document={version.body} imageSrc={imageSrc} headingFrom={4} />
    </Stack>
  );
}
