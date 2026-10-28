import { HStack, Text } from '@chakra-ui/react';
import { DateTimeText } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';

/**
 * A notice's byline (#138, ADR-0077): '운영팀' — never an operator's nickname or the '운영자' mark
 * of a post's author, the owner's decision (ADR-0069 decision 2 #45-8) — the time it was written in
 * the viewer's zone (ADR-0063) and '수정됨' once edited (decision 4 #138), as a post's byline says
 * it. No image: the byline names a team, not an account.
 *
 * No directive: it renders inside the fixed area's client component and the notice page's server
 * component alike; the time is `DateTimeText`'s, whose hook lives in its own client module.
 */
export function NoticeByline({
  createdAt,
  editedAt,
  size = 'sm',
}: {
  createdAt: string;
  editedAt: string | null;
  /** `sm` in the fixed area, `md` on the notice page. */
  size?: 'sm' | 'md';
}) {
  const textStyle = size === 'md' ? 'bodyMd' : 'bodyXs';
  return (
    <HStack gap="2" minW="0" flexWrap="wrap" data-testid="notice-byline">
      <Text
        as="span"
        textStyle={size === 'md' ? 'emphasisMd' : 'emphasisXs'}
        color="fg"
        data-testid="notice-author"
      >
        {copy.noticeAuthor}
      </Text>
      <Text as="span" textStyle={textStyle} color="fg.muted" whiteSpace="nowrap">
        <time dateTime={createdAt} data-testid="notice-created-at">
          <DateTimeText iso={createdAt} />
        </time>
      </Text>
      {editedAt !== null && (
        <Text
          as="span"
          textStyle={textStyle}
          color="fg.muted"
          whiteSpace="nowrap"
          data-testid="notice-edited"
        >
          {copy.postEdited}
        </Text>
      )}
    </HStack>
  );
}
