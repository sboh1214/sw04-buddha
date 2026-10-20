import { Badge, HStack, Text } from '@chakra-ui/react';
import { type HiddenNotice } from '@/lib/api';
import { hiddenNoticeView } from '@/lib/authored';

/**
 * The line MY '내 글' draws above an item an operator hid (#45-5: «숨긴 글은 '숨김' 표시와 사유를
 * 본인에게 보인다»): the '숨김' mark, and the reason once the hiding carries one (#50 records it;
 * until then the mark stands alone, `hiddenNoticeView`). Never on a profile — the public lists
 * leave a hidden item out, and no public answer marks one (PRIVATE_DATA `moderation`). Never who
 * hid it (#45-13).
 *
 * Above the card rather than inside it, so the card stays the one every list draws (post-card.tsx)
 * and the mark is read before the card's link.
 */
export function HiddenNoticeLine({ hidden }: { hidden: HiddenNotice }) {
  const view = hiddenNoticeView(hidden);
  return (
    <HStack gap="2" minW="0" flexWrap="wrap" data-testid="authored-hidden">
      <Badge size="sm" variant="subtle" colorPalette="orange" flexShrink="0">
        {view.mark}
      </Badge>
      {view.reason !== null && (
        <Text
          textStyle="bodySm"
          color="fg.muted"
          wordBreak="break-word"
          minW="0"
          data-testid="authored-hidden-reason"
        >
          {view.reason}
        </Text>
      )}
    </HStack>
  );
}
