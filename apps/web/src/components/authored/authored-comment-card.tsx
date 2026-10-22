import {
  Badge,
  HStack,
  Link as ChakraLink,
  LinkBox,
  LinkOverlay,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { CardReportButton } from '@/components/moderation/report-button';
import { PostByline } from '@/components/post/post-author';
import { type AuthoredComment } from '@/lib/api';
import { commentKindLabel, commentedPostText } from '@/lib/authored';
import { likeCountText } from '@/lib/likes';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { authorPublicIdOf } from '@/lib/moderation';
import { postPath } from '@/lib/posts';

/**
 * One item of a 댓글 tab (#51, ADR-0080; #37-14: «댓글(대댓글 포함)»), on a profile and in MY '내
 * 글': the market above — a link to its detail, which opens in every status (N05 §3: an ended
 * market's rules, result and discussion stay readable) — then whether it is a 댓글 or a 답글 (the
 * post page's word for a 대댓글) and the post it sits under (its title or first line; a deleted or
 * hidden post by its placeholder's words, nothing of it), the comment's text, the byline and '좋아요
 * N' (decision 4 #49: the count on the profile's lists too — a number beside the item, never a
 * score).
 *
 * The whole card opens the post page, where the comment is read in its thread — a placeholder
 * post's page included (its comments stay readable, ADR-0074) — and Chakra's `LinkBox` raises the
 * market link and the byline's profile link above that overlay, as the community card does
 * (post-card.tsx). The overlay link is the kind and the post line, so a screen reader names it by
 * what it opens ('답글 <the post's title>'), as the community card names its link by the title; the
 * comment's text — up to 1,000 characters, which a three-line clamp only hides from sight — sits
 * outside it as plain text, as the card's excerpt does (ADR-0080 7-8). Its links are the post
 * page's (a link inside the card's own would nest two anchors). On a profile's tab it carries 신고
 * for every reader but its author (owner decision 2026-10-21, `CardReportButton`), above the
 * card's link and outside it.
 *
 * No directive: it renders inside the lists' client components. The lists are read in the browser
 * only, so nothing here is in the server's HTML.
 */
export function AuthoredCommentCard({
  comment,
  report,
}: {
  comment: AuthoredComment;
  /**
   * 신고 on the card (owner decision 2026-10-21) — a profile's 댓글 tab's, not MY's (the member's
   * own) — with the tab's page for a visitor's login to come back to.
   */
  report?: { backPath: string };
}) {
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
      data-testid={`authored-comment-${comment.id}`}
    >
      <Stack gap="1.5" minW="0">
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
              href={`/markets/${comment.market.slug}` as Route}
              prefetch={false}
              data-testid="authored-comment-market"
            >
              {comment.market.title}
            </NextLink>
          </ChakraLink>
          {comment.market.status !== 'open' && (
            <Badge
              size="sm"
              variant="subtle"
              flexShrink="0"
              colorPalette={MARKET_STATUS_PALETTE[comment.market.status]}
            >
              {MARKET_STATUS_LABEL[comment.market.status]}
            </Badge>
          )}
        </HStack>
        <LinkOverlay asChild display="flex" alignItems="center" gap="2" minW="0">
          <NextLink href={postPath(comment.post.id) as Route} data-testid="authored-comment-link">
            <Badge
              size="sm"
              variant="outline"
              colorPalette="gray"
              flexShrink="0"
              data-testid="authored-comment-kind"
            >
              {commentKindLabel(comment.parentId)}
            </Badge>
            <Text
              as="span"
              textStyle="bodySm"
              color="fg.muted"
              truncate
              minW="0"
              data-testid="authored-comment-post"
              data-state={comment.post.state}
            >
              {commentedPostText(comment.post)}
            </Text>
          </NextLink>
        </LinkOverlay>
        <Text
          textStyle="bodyMd"
          color="fg"
          lineClamp="3"
          whiteSpace="pre-wrap"
          overflowWrap="anywhere"
          data-testid="authored-comment-body"
        >
          {comment.body}
        </Text>
        <HStack gap="3" minW="0" flexWrap="wrap">
          <PostByline
            author={comment.author}
            createdAt={comment.createdAt}
            editedAt={comment.editedAt}
          />
          <Text
            as="span"
            textStyle="bodyXs"
            color="fg.muted"
            whiteSpace="nowrap"
            data-testid="authored-comment-likes"
          >
            {likeCountText(comment.likeCount)}
          </Text>
          {report !== undefined && (
            <CardReportButton
              subject={{ type: 'comment', commentId: comment.id, postId: comment.post.id }}
              item={{ type: 'comment', body: comment.body }}
              authorPublicId={authorPublicIdOf(comment.author)}
              backPath={report.backPath}
            />
          )}
        </HStack>
      </Stack>
    </LinkBox>
  );
}
