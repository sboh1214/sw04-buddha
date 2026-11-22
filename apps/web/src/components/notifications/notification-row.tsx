'use client';

import {
  Box,
  Link as ChakraLink,
  HStack,
  Stack,
  Text,
  VisuallyHidden,
  chakra,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import type { ReactNode } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import type { InboxNotification } from '@/lib/api';
import { isUnread, notificationCategoryLabel, notificationHref } from '@/lib/notifications';
import { notificationView } from './notification-renderers';

/**
 * One notification of MY › 알림 and of its preview on MY 요약 (#53, ADR-0157): its category, its
 * title (the type's renderer, or '<분류> 알림' for a type this web does not know, 53-11 ④) and its
 * 발생 시각 in the member's zone (53-3; a merged one's is its latest event's).
 *
 * Unread is told apart by more than colour (PLAN 11.2, 53-3 '눈에 띄게'): the title in semibold, a
 * dot, and '안 읽음' for a screen reader; a read one is normal weight and muted. `data-read` says
 * which for the tests.
 *
 * The row is a link to its target (`notificationHref`): pressing it — a click, Enter, or a
 * middle-click (`auxclick` with button 1), which opens it too — marks it read and goes on (53-2),
 * the read fired without waiting (`onRead`; the write's own options take its answer, whether or not
 * the row is still on screen). A context menu's 'open in a new tab' cannot be seen by the page, so
 * it leaves the notification unread (53-11 ③). A target this web does not know leads nowhere: the
 * row is then a button that only marks it read. A read one fires nothing.
 */
export function NotificationRow({
  notification,
  onRead,
}: {
  notification: InboxNotification;
  /** Marks it read: called on a press of an unread one, never awaited. */
  onRead: (notification: InboxNotification) => void;
}) {
  const format = useFormatDateTime();
  const unread = isUnread(notification);
  const view = notificationView(notification);
  const href = notificationHref(notification.target);
  const markRead = () => {
    if (unread) onRead(notification);
  };
  // Spans throughout: the body is phrasing content, which a link and a button may both hold.
  const body: ReactNode = (
    <Stack as="span" gap="1" w="full" textAlign="start">
      <HStack as="span" gap="2" fontSize="xs" color="fg.muted">
        {unread && (
          <Box
            as="span"
            aria-hidden="true"
            w="2"
            h="2"
            flexShrink="0"
            borderRadius="full"
            bg="brand.solid"
            data-testid="notification-row-unread-dot"
          />
        )}
        {unread && <VisuallyHidden>{copy.notificationUnread}</VisuallyHidden>}
        <Text as="span" data-testid="notification-row-category">
          {notificationCategoryLabel(notification.category)}
        </Text>
      </HStack>
      {/* `keep-all`: the title (a market's stored title since #134) breaks Korean at spaces, never
          between two syllables ('주문'); `anywhere` still breaks a run too long for the row
          (order-panel.tsx's rule). */}
      <Text
        as="span"
        display="block"
        wordBreak="keep-all"
        overflowWrap="anywhere"
        fontWeight={unread ? 'semibold' : 'normal'}
        color={unread ? 'fg' : 'fg.muted'}
        data-testid="notification-row-title"
      >
        {view.known ? (
          <view.Title
            params={view.params}
            eventCount={view.eventCount}
            replyAuthor={view.replyAuthor}
          />
        ) : (
          view.title
        )}
      </Text>
      <Text
        as="span"
        display="block"
        fontSize="xs"
        color="fg.muted"
        data-testid="notification-row-time"
      >
        {format(notification.occurredAt)}
      </Text>
    </Stack>
  );
  const marks = {
    'data-testid': 'notification-row',
    'data-read': unread ? 'false' : 'true',
    'data-notification-id': notification.id,
  };

  if (href === null) {
    return (
      <chakra.button
        type="button"
        display="flex"
        w="full"
        py="2"
        cursor="pointer"
        onClick={markRead}
        {...marks}
      >
        {body}
      </chakra.button>
    );
  }
  return (
    <ChakraLink asChild display="flex" w="full" py="2" color="fg" textDecoration="none" {...marks}>
      <NextLink
        href={href as Route}
        onClick={markRead}
        onAuxClick={(event) => {
          if (event.button === 1) markRead();
        }}
      >
        {body}
      </NextLink>
    </ChakraLink>
  );
}
