import { Avatar, Badge, HStack, Text } from '@chakra-ui/react';
import { DateTimeText } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type PostAuthor as Author } from '@/lib/api';
import { authorView } from '@/lib/posts';

/**
 * A post's byline (#46, ADR-0073): the author's small round image — the nickname's first letter
 * until #141 brings uploads, never a social login's photo (#37-6) — the CURRENT nickname (#37-3),
 * '운영자' for an account with the admin role (#45-9: operating rights, not a forecasting
 * credential), the time it was written in the viewer's zone (ADR-0063) and '수정됨' once edited
 * (#45-4). A withdrawn author (#140) is '탈퇴한 사용자' on a blank image (#37-16).
 *
 * The name is not a link: the public profile (#41, `/u/<publicId>`) does not exist yet, and a link
 * that answers 404 is worse than none (ADR-0073). #41 makes the name its link here.
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
  return (
    <HStack gap="2" minW="0" flexWrap="wrap" data-testid="post-byline">
      <HStack gap="1.5" minW="0">
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
