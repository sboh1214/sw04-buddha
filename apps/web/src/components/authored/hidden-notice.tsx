import { Badge, HStack, Stack, Text } from '@chakra-ui/react';
import { type ReactNode } from 'react';
import { type HiddenNotice } from '@/lib/api';
import { hiddenNoticeView } from '@/lib/authored';

/**
 * The line MY '내 글' draws above an item an operator hid (#45-5: «숨긴 글은 '숨김' 표시와 사유를
 * 본인에게 보인다»): the '숨김' mark, and once the hiding carries a reason (#50 records it; until then
 * the mark stands alone, `hiddenNoticeView`) the reason — one of the report reasons — and the
 * operator's explanation on a line under it when there is one (owner decision 2026-10-22). Never on
 * a profile — the public lists leave a hidden item out, and no public answer marks one
 * (PRIVATE_DATA `moderation`). Never who hid it (#45-13).
 *
 * `action` is what sits beside the mark at the line's end: MY's 삭제 (owner decision 2026-10-22:
 * «'숨김' 줄 옆, 확인 후», `DeleteHiddenItem`). It stays outside the notice itself
 * (`authored-hidden`), so the notice reads as the mark and its reason alone.
 *
 * Above the card rather than inside it, so the card stays the one every list draws (post-card.tsx)
 * and the mark is read before the card's link.
 */
export function HiddenNoticeLine({ hidden, action }: { hidden: HiddenNotice; action?: ReactNode }) {
  const view = hiddenNoticeView(hidden);
  return (
    <HStack gap="2" minW="0" align="flex-start" data-testid="authored-hidden-line">
      <Stack gap="1" minW="0" flex="1" data-testid="authored-hidden">
        <HStack gap="2" minW="0" flexWrap="wrap">
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
        {view.note !== null && (
          <Text
            textStyle="bodySm"
            color="fg.muted"
            whiteSpace="pre-wrap"
            wordBreak="break-word"
            minW="0"
            data-testid="authored-hidden-note"
          >
            {view.note}
          </Text>
        )}
      </Stack>
      {action}
    </HStack>
  );
}
