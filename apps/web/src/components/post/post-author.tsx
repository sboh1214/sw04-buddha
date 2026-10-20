import { Avatar, Badge, Link as ChakraLink, HStack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { DateTimeText } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type PostAuthor as Author } from '@/lib/api';
import { authorView } from '@/lib/posts';

/**
 * A post's byline (#46, ADR-0073): the author's small round image — the nickname's first letter
 * until #141 brings uploads, never a social login's photo (#37-6) — the CURRENT nickname (#37-3),
 * '운영자' for an account with the admin role (#45-9: operating rights, not a forecasting
 * credential), the time it was written in the viewer's zone (ADR-0063) and '수정됨' once edited
 * (#45-4). A withdrawn author (#140) is '탈퇴한 사용자' on a blank image, and no link (#37-16).
 *
 * The image and the name are one link to the author's public profile (#41, ADR-0078:
 * `/u/<publicId>`), wherever the byline stands — the post page, a 댓글 or 대댓글 (#48: «같은
 * 표기») and a community card, where Chakra's `LinkBox` raises it above the card's overlay as it
 * does the market link, so it opens the profile and the rest of the card the post. Its name is the
 * nickname alone: the image is hidden from a screen reader, and '운영자' stands beside the link. Not
 * prefetched: a list can hold many authors, and a profile is read when it is opened.
 *
 * No directive: it renders inside the post page's client component and the cards alike; the time
 * is `DateTimeText`'s, whose hook lives in its own client module.
 */
export function PostByline({
  author,
  createdAt,
  editedAt,
  size = 'sm',
}: {
  author: Author;
  createdAt: string;
  editedAt: string | null;
  /** `sm` on a card, `md` on the post page. */
  size?: 'sm' | 'md';
}) {
  const view = authorView(author);
  const textStyle = size === 'md' ? 'bodyMd' : 'bodyXs';
  const face = (
    <>
      <Avatar.Root size={size === 'md' ? 'sm' : 'xs'} flexShrink="0" aria-hidden="true">
        <Avatar.Fallback>{view.initial}</Avatar.Fallback>
        {view.kind === 'member' && view.imageUrl !== null && (
          <Avatar.Image src={view.imageUrl} alt="" />
        )}
      </Avatar.Root>
      <Text
        as="span"
        textStyle={size === 'md' ? 'emphasisMd' : 'emphasisXs'}
        color="fg"
        truncate
        data-testid="post-author-name"
      >
        {view.name}
      </Text>
    </>
  );
  return (
    <HStack gap="2" minW="0" flexWrap="wrap" data-testid="post-byline">
      <HStack gap="1.5" minW="0">
        {view.kind === 'member' ? (
          <ChakraLink asChild gap="1.5" minW="0" color="fg">
            <NextLink href={view.href as Route} prefetch={false} data-testid="post-author-link">
              {face}
            </NextLink>
          </ChakraLink>
        ) : (
          face
        )}
        {view.kind === 'member' && view.isAdmin && (
          <Badge size="sm" variant="subtle" colorPalette="gray" data-testid="post-author-admin">
            {copy.postAuthorAdmin}
          </Badge>
        )}
      </HStack>
      <Text as="span" textStyle={textStyle} color="fg.muted" whiteSpace="nowrap">
        <time dateTime={createdAt} data-testid="post-created-at">
          <DateTimeText iso={createdAt} />
        </time>
      </Text>
      {editedAt !== null && (
        <Text
          as="span"
          textStyle={textStyle}
          color="fg.muted"
          whiteSpace="nowrap"
          data-testid="post-edited"
        >
          {copy.postEdited}
        </Text>
      )}
    </HStack>
  );
}
