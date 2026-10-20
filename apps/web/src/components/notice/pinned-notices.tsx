'use client';

import { Alert, Badge, Box, Button, HStack, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { usePinnedNotices } from '@/hooks/use-notices';
import { noticePath, pinnedNoticesView } from '@/lib/notices';
import { NoticeByline } from './notice-byline';

/**
 * The fixed area above the community list (#138, ADR-0077; ADR-0069 decision 2 #45-8 «커뮤니티 목록
 * 위의 고정 영역에만»): every pinned notice — at most NOTICE_PIN_LIMIT — the latest pinned first,
 * apart from the posts, which never push it down however many are written. A row is the '공지'
 * mark, the title on one line and the byline ('운영팀', the time, '수정됨'); the whole row opens the
 * notice's page. No count, no comment, no like: a notice takes none (#45-8).
 *
 * The community page reads the notices on the server and seeds them, so the area is in the HTML
 * for every visitor. Which of nothing, the failure with 다시 시도, or the rows it draws is
 * `pinnedNoticesView`'s (lib/notices.ts, unit-tested there): a later refresh that fails keeps the
 * rows, and marks the area `data-refresh-failed` — nothing a reader sees, the point a test knows
 * the failure has landed and the rows stayed.
 */
export function PinnedNotices() {
  const notices = usePinnedNotices();
  const view = pinnedNoticesView(notices);
  if (view.kind === 'none') return null;
  if (view.kind === 'error') {
    return (
      <Stack gap="2" align="flex-start" data-testid="community-notices-error">
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.noticesLoadFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Button size="sm" variant="outline" onClick={() => void notices.refetch()}>
          {copy.retry}
        </Button>
      </Stack>
    );
  }
  const { rows } = view;
  return (
    <Box
      as="section"
      aria-label={copy.noticesLabel}
      data-refresh-failed={view.refreshFailed ? 'true' : undefined}
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="card"
      bg="surface.card"
      overflow="hidden"
      data-testid="community-notices"
    >
      <Box as="ul" listStyleType="none" m="0" p="0">
        {rows.map((notice, index) => (
          <Box
            as="li"
            key={notice.id}
            borderTopWidth={index === 0 ? '0' : '1px'}
            borderColor="border.subtle"
            data-testid={`community-notice-${notice.id}`}
          >
            <Box
              asChild
              display="block"
              px="4"
              py="3"
              _hover={{ bg: 'surface.hover' }}
              _focusVisible={{ outlineOffset: '-2px' }}
            >
              <NextLink href={noticePath(notice.id) as Route} data-testid="community-notice-link">
                <Stack gap="1" minW="0">
                  <HStack gap="2" minW="0">
                    <Badge size="sm" variant="subtle" colorPalette="brand" flexShrink="0">
                      {copy.noticeBadge}
                    </Badge>
                    <Text
                      as="span"
                      textStyle="emphasisMd"
                      color="fg"
                      truncate
                      minW="0"
                      data-testid="community-notice-title"
                    >
                      {notice.title}
                    </Text>
                  </HStack>
                  <NoticeByline createdAt={notice.createdAt} editedAt={notice.editedAt} />
                </Stack>
              </NextLink>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
