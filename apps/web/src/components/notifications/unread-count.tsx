'use client';

import { Box, type BoxProps } from '@chakra-ui/react';
import { useMe } from '@/hooks/use-me';
import { useNotificationUnreadCount } from '@/hooks/use-notifications';
import { unreadCountLabel, unreadNotificationsText } from '@/lib/notifications';

/** The unread count as one place shows it: the number drawn, the phrase a screen reader hears. */
export interface UnreadNotifications {
  /** '3', or '99+' past 99. */
  label: string;
  /** '안 읽은 알림 3개' — the link's description. */
  text: string;
}

/**
 * The member's unread count for the places that show it beside a link (53-1: MY in the header and
 * the bottom tabs, and MY's 알림 tab): null while nothing is to be shown — signed out, the session
 * or `GET /me` not known yet (so nothing account-specific is in the server's HTML or the hydrating
 * render), the count not read yet, or none unread. Of the account `GET /me` names (ADR-0091,
 * `notificationUnreadKey`), the one the rest of the header shows.
 */
export function useUnreadNotifications(): UnreadNotifications | null {
  const accountId = useMe().data?.id;
  const count = useNotificationUnreadCount(accountId);
  if (count === undefined) return null;
  const label = unreadCountLabel(count);
  const text = unreadNotificationsText(count);
  return label === null || text === null ? null : { label, text };
}

/**
 * The count beside one link, as two siblings of it — never inside it, so the link's text and
 * accessible name stay 'MY' or '알림' (nav.spec.ts reads both): the number, absolutely positioned
 * over the link's corner and hidden from assistive technology (it adds no height to a bar whose
 * height is measured, `HEADER_HEIGHT_PX`, `BOTTOM_TABS_HEIGHT_PX`), and the phrase in a `hidden`
 * element with `id`, which the link names in its `aria-describedby`: the description still reads
 * it (a hidden element the link points at), and a reader moving through the page does not stop on
 * it again as text of its own, as it would on a visually hidden one. The caller's box is
 * `position="relative"`; where the number sits on it is the caller's (`placement`). No toast, ever
 * (53-1). The number is the brand fill with its tested contrast pair (theme/contrast.test.ts) — and
 * it is a number, never colour alone.
 */
export function UnreadCount({
  unread,
  id,
  testId,
  placement,
}: {
  unread: UnreadNotifications | null;
  /** The phrase's id: what the link's `aria-describedby` names. */
  id: string;
  testId: string;
  placement: Pick<BoxProps, 'top' | 'insetEnd' | 'insetStart' | 'left' | 'right'>;
}) {
  if (unread === null) return null;
  return (
    <>
      <Box
        as="span"
        aria-hidden="true"
        position="absolute"
        {...placement}
        minW="18px"
        h="18px"
        px="1"
        borderRadius="full"
        colorPalette="brand"
        bg="colorPalette.solid"
        color="colorPalette.contrast"
        fontSize="11px"
        lineHeight="18px"
        fontWeight="semibold"
        textAlign="center"
        whiteSpace="nowrap"
        pointerEvents="none"
        data-testid={testId}
      >
        {unread.label}
      </Box>
      <span id={id} hidden>
        {unread.text}
      </span>
    </>
  );
}
