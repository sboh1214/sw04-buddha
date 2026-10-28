import { Badge, Heading, Link as ChakraLink, Stack } from '@chakra-ui/react';
import NextLink from 'next/link';
import { NoticeByline } from '@/components/notice/notice-byline';
import { PostBody } from '@/components/post/post-body';
import { copy } from '@/copy';
import { type Notice } from '@/lib/api';
import { COMMUNITY_PATH } from '@/lib/posts';

/**
 * The notice page's body (#138, ADR-0077): the '공지' mark and the title (an `h2` under the nav's
 * `h1`, so the body's `h3`–`h5` sit under it, as on a post page), the byline — '운영팀', never an
 * operator (#45-8) — the body through the posts' renderer (the same allow-list, links in a new tab,
 * images by their media id) and the way back to the community. Nothing else: a notice takes no
 * comment, like or report (#45-8), and has no market.
 */
export function NoticeView({ notice }: { notice: Notice }) {
  return (
    <Stack gap="6" data-testid="notice-screen">
      <Stack gap="3">
        <Badge
          size="sm"
          variant="subtle"
          colorPalette="brand"
          alignSelf="flex-start"
          data-testid="notice-badge"
        >
          {copy.noticeBadge}
        </Badge>
        <Heading as="h2" textStyle="headline" wordBreak="break-word" data-testid="notice-title">
          {notice.title}
        </Heading>
        <NoticeByline createdAt={notice.createdAt} editedAt={notice.editedAt} size="md" />
      </Stack>
      <PostBody document={notice.body} />
      <ChakraLink asChild alignSelf="flex-start" textStyle="bodySm" color="fg.muted">
        <NextLink href={COMMUNITY_PATH} data-testid="notice-back">
          {copy.postBackToCommunity}
        </NextLink>
      </ChakraLink>
    </Stack>
  );
}
