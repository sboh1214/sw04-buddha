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
import { commentCountText } from '@/lib/comments';
import { likeCountText } from '@/lib/likes';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { postFirstLine, postPath } from '@/lib/posts';
import { PostByline } from './post-author';
import { RetriedImage } from './retried-image';

/**
 * One card of the community list (#46, ADR-0073; owner decisions 2026-10-18): the market's title
 * above — a link to its detail, which opens in every status (#46's acceptance criteria) — the
 * post's title, two lines of its text without formatting, the first image as a small square
 * thumbnail on the right (asked for again after a 429, `RetriedImage`), the byline (author, time,
 * 수정됨), '댓글 N' (#48, ADR-0074: the 댓글 and 대댓글 the public reads) and '좋아요 N' (#49,
 * ADR-0076). Both counts are the public ones, the same for every reader and drawn by the server;
 * the card says nothing of whether the reader liked the post (that is the post page's toggle,
 * ADR-0076 — a question for the owner), and it is not a button: the whole card opens the post.
 *
 * `showMarket={false}` leaves the market line out — the market's title and its status badge — for a
 * list that is one market's already: the market detail's 토론 (#47, owner decision 2026-10-20 6), where
 * the line would name the page it is on and link to it from every card. The community list keeps it.
 *
 * `LinkBox`/`LinkOverlay`, as the market card: the whole card opens the post, and Chakra's
 * `LinkBox` raises the nested market link above the overlay, so both stay one click each. A post
 * without a title is named by its first line, in a heading only a screen reader sees (the excerpt
 * shows the same line), so heading navigation reaches every card; it carries the overlay.
 */
export function PostCard({
  post,
  titleAs = 'h3',
  showMarket = true,
}: {
  post: PostSummary;
  /** One below the heading of the list it sits in. */
  titleAs?: 'h2' | 'h3' | 'h4';
  /** The market line above the title; off in a list of one market's posts (토론). */
  showMarket?: boolean;
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
          {showMarket && (
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
                // The market card's badge props, in its order (market-card.tsx): its style props —
                // `colorPalette`, then `flexShrink` — are the same set as this one's, and Chakra's
                // style memo keeps the order of whichever drew it first in the process. With
                // `flexShrink` first, a server that had drawn a market card's badge (the home, 관련
                // 시장) gave this badge that order and a fresh browser this one: a hydration
                // mismatch on the community list's closed-market cards (seen in #47's e2e run once
                // the 토론 stopped drawing these cards on the server).
                <Badge
                  size="sm"
                  colorPalette={MARKET_STATUS_PALETTE[post.market.status]}
                  variant="subtle"
                  flexShrink="0"
                >
                  {MARKET_STATUS_LABEL[post.market.status]}
                </Badge>
              )}
            </HStack>
          )}
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
          <HStack gap="3" minW="0" flexWrap="wrap">
            <PostByline author={post.author} createdAt={post.createdAt} editedAt={post.editedAt} />
            {/* The byline's time's props, in its order (Chakra's style memo, see the title). */}
            <Text
              as="span"
              textStyle="bodyXs"
              color="fg.muted"
              whiteSpace="nowrap"
              data-testid="post-card-comments"
            >
              {commentCountText(post.commentCount)}
            </Text>
            <Text
              as="span"
              textStyle="bodyXs"
              color="fg.muted"
              whiteSpace="nowrap"
              data-testid="post-card-likes"
            >
              {likeCountText(post.likeCount)}
            </Text>
          </HStack>
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
