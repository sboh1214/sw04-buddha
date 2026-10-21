'use client';

import {
  Alert,
  Badge,
  Button,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import {
  linkFlagFlaggedAt,
  linkFlagItemPath,
  linkFlagKindLabel,
  linkFlagReasonLabel,
  linkFlagStates,
  linkFlagWrittenAt,
} from '@/lib/admin-link-flags';
import { type AdminLinkFlag, api, unwrap } from '@/lib/api';
import { profilePath } from '@/lib/profile';

const ADMIN_LINK_FLAGS_KEY = ['admin', 'link-flags'] as const;

/**
 * 반복 링크 검토 목록 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187): the posts and
 * comments a repetition rule caught, newest first, 20 a page with 더 보기 — the admin audit list's
 * shape. Read-only: the post stays as it is (decision 4 #187 «글은 그대로 보임»), and hiding,
 * warning or restricting is #50's moderation, where this list moves when that area is built.
 *
 * Each entry: the rule, when it was caught, the link as the rules compared it (plain text, never a
 * link — an operator copies it rather than following a link someone repeats), the item — a 근거 글
 * or a 댓글, its excerpt linking to the post's page — its author (their public profile), its market
 * (the admin market screen), when it was written and what became of it since (edited, deleted,
 * hidden). An item that met both rules, or holds two such links, is listed once for each.
 */
export function AdminLinkFlags() {
  const flags = useInfiniteQuery({
    queryKey: ADMIN_LINK_FLAGS_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/link-flags', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
  const rows = flags.data?.pages.flatMap((page) => page.items) ?? [];

  if (flags.isPending) return <Skeleton height="24" />;
  if (flags.isError) {
    return (
      <Alert.Root status="error" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.errUnknown}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }

  return (
    <Stack gap="4" data-testid="admin-link-flags">
      <Text color="fg.muted">{copy.adminLinkFlagsIntro}</Text>
      {rows.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-link-flags-empty">
          {copy.adminNoLinkFlags}
        </Text>
      ) : (
        <Stack gap="2">
          {rows.map((flag) => (
            <LinkFlagEntry key={flag.id} flag={flag} />
          ))}
        </Stack>
      )}
      {flags.hasNextPage && (
        <Button
          alignSelf="center"
          size="sm"
          variant="ghost"
          loading={flags.isFetchingNextPage}
          onClick={() => void flags.fetchNextPage()}
          data-testid="admin-link-flags-more"
        >
          {copy.loadMore}
        </Button>
      )}
    </Stack>
  );
}

function LinkFlagEntry({ flag }: { flag: AdminLinkFlag }) {
  const { target } = flag;
  const states = linkFlagStates(target);
  return (
    <Stack
      as="article"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="1.5"
      data-testid={`admin-link-flag-${flag.id}`}
      data-reason={flag.reason}
    >
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        <Badge colorPalette="orange" variant="subtle" data-testid="admin-link-flag-reason">
          {linkFlagReasonLabel(flag.reason)}
        </Badge>
        <Text fontSize="sm" color="fg.muted">
          {linkFlagFlaggedAt(flag)}
        </Text>
      </HStack>
      <Text fontSize="sm" fontFamily="mono" wordBreak="break-all" data-testid="admin-link-flag-url">
        {flag.url}
      </Text>
      <HStack gap="2" align="baseline" minW="0">
        <Text fontSize="sm" color="fg.muted" flexShrink={0}>
          {linkFlagKindLabel(target.kind)}
        </Text>
        <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" minW="0">
          <NextLink
            href={linkFlagItemPath(target) as Route}
            data-testid="admin-link-flag-item"
            style={{ overflowWrap: 'anywhere' }}
          >
            {target.excerpt}
          </NextLink>
        </ChakraLink>
      </HStack>
      <HStack gap="3" flexWrap="wrap" fontSize="sm" color="fg.muted">
        <Text>
          {copy.adminLinkFlagAuthor}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
            <NextLink
              href={profilePath(target.author.publicId) as Route}
              data-testid="admin-link-flag-author"
            >
              {target.author.nickname}
            </NextLink>
          </ChakraLink>
        </Text>
        <Text>
          {copy.adminLinkFlagMarket}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
            <NextLink
              href={`/admin/markets/${target.market.id}` as Route}
              data-testid="admin-link-flag-market"
            >
              {target.market.title}
            </NextLink>
          </ChakraLink>
        </Text>
        <Text>{linkFlagWrittenAt(target)}</Text>
      </HStack>
      {states.length > 0 && (
        <HStack gap="2" flexWrap="wrap" data-testid="admin-link-flag-states">
          {states.map((state) => (
            <Badge key={state} variant="outline" size="sm">
              {state}
            </Badge>
          ))}
        </HStack>
      )}
    </Stack>
  );
}
