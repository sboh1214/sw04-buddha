import {
  Badge,
  Box,
  HStack,
  Heading,
  Link as ChakraLink,
  LinkBox,
  LinkOverlay,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { type PostSummary } from '@/lib/api';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { postFirstLine, postPath } from '@/lib/posts';
import { PostByline } from './post-author';
import { RetriedImage } from './retried-image';

/**
 * One card of the community list (#46, ADR-0073; owner decisions 2026-10-18): the market's title
 * above — a link to its detail, which opens in every status (#46's acceptance criteria) — the
 * post's title, two lines of its text without formatting, the first image as a small square
 * thumbnail on the right (asked for again after a 429, `RetriedImage`), and the byline (author,
 * time, 수정됨). The comment and like counts the owner listed come with #48 and #49; nothing is
 * drawn for a count that does not exist yet.
 *
 * `LinkBox`/`LinkOverlay`, as the market card: the whole card opens the post, and Chakra's
 * `LinkBox` raises the nested market link above the overlay, so both stay one click each. A post
 * without a title is named by its first line, in a heading only a screen reader sees (the excerpt
 * shows the same line), so heading navigation reaches every card; it carries the overlay.
 */
export function PostCard({
  post,
  titleAs = 'h3',
}: {
  post: PostSummary;
  /** One below the heading of the list it sits in. */
  titleAs?: 'h2' | 'h3' | 'h4';
}) {
  const href = postPath(post.id) as Route;
  const firstLine = postFirstLine(post.excerpt);
  return (
    <LinkBox
      as="article"
      position="relative"
      borderRadius="card"
      borderWidth="1px"
      borderColor="border.subtle"
      bg="surface.card"
      px="4"
      py="3"
      transition="border-color 0.15s"
      _hover={{ borderColor: 'border.emphasized' }}
      data-testid={`post-card-${post.id}`}
    >
      <HStack align="flex-start" gap="4">
        <Stack gap="1.5" flex="1" minW="0">
          <HStack gap="2" minW="0">
            <ChakraLink
              asChild
              textStyle="overline"
              color="fg.muted"
              truncate
              minW="0"
              _hover={{ color: 'fg' }}
            >
              <NextLink
                href={`/markets/${post.market.slug}` as Route}
                prefetch={false}
                data-testid="post-card-market"
              >
                {post.market.title}
              </NextLink>
            </ChakraLink>
            {post.market.status !== 'open' && (
              <Badge
                size="sm"
                variant="subtle"
                flexShrink="0"
                colorPalette={MARKET_STATUS_PALETTE[post.market.status]}
              >
                {MARKET_STATUS_LABEL[post.market.status]}
              </Badge>
            )}
          </HStack>
          <LinkOverlay asChild>
            <NextLink href={href} data-testid="post-card-link">
              {post.title !== null ? (
                // The market card's title props, in its order (market-card.tsx): Chakra memoises a
                // style set's CSS under its keys sorted, and the server's cache outlives a request,
                // so with `color` before `lineClamp` a server that had drawn a market card wrote
                // that card's order and a fresh browser this one — two class names for one style,
                // a hydration mismatch on every card (seen in posts.spec.ts's run).
                <Heading as={titleAs} textStyle="title" lineClamp="1" color="fg">
                  {post.title}
                </Heading>
              ) : (
                <Heading as={titleAs} srOnly data-testid="post-card-untitled">
                  {firstLine}
                </Heading>
              )}
            </NextLink>
          </LinkOverlay>
          <Text
            textStyle="bodySm"
            color={post.title === null ? 'fg' : 'fg.muted'}
            lineClamp="2"
            whiteSpace="pre-line"
            wordBreak="break-word"
            data-testid="post-card-excerpt"
          >
            {post.excerpt}
          </Text>
          <PostByline author={post.author} createdAt={post.createdAt} editedAt={post.editedAt} />
        </Stack>
        {post.thumbnailUrl !== null && (
          <Box flexShrink="0" boxSize={{ base: '64px', md: '80px' }}>
            <RetriedImage
              src={post.thumbnailUrl}
              alt={copy.postThumbnailAlt}
              boxSize="100%"
              objectFit="cover"
              borderRadius="row"
              bg="bg.muted"
              loading="lazy"
              data-testid="post-card-thumbnail"
            />
          </Box>
        )}
      </HStack>
    </LinkBox>
  );
}
