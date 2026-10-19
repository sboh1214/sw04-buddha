'use client';

import { Alert, Button, HStack, Heading, Skeleton, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { PostCard } from '@/components/post/post-card';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMarket } from '@/hooks/use-markets';
import { useMarketPosts } from '@/hooks/use-posts';
import { discussionCountText, discussionView } from '@/lib/discussion';
import { postReadErrorMessage, writePath } from '@/lib/posts';

/** Placeholders at a card's height while the first page loads (the community list's height). */
const SKELETON_ROWS = [0, 1];

/**
 * 토론 (#47, ADR-0075): the market detail's section of this market's 근거 글 (N02 §4), after 내
 * 포지션 · 내 대기 주문 and before 관련 시장 at both widths. Every post of the market in the detail
 * itself, newest first — the community list's only order (#45-7) — 20 more per 더 보기, with how
 * many there are beside the heading ('글 N'), as ADR-0069 decision 4 #47 has it. Each post is the
 * community list's preview card as it is (`PostCard`, owner decision 2026-10-18), whose title opens
 * the post page with its whole text and its comments. The count is the first page's, the list the
 * 더 보기 walk continues (`discussionView`); a card's market line — the market's title and, when it
 * is not open, its status — follows the detail's live row, as the header does (`onLiveMarket`).
 *
 * Public, in every public status, ended markets too (N02 §2 «공개 토론», N05 §3): the page reads the
 * first page on the server, without a cookie, and dehydrates it with the detail (page.tsx,
 * `prefetchMarketPosts`), so the cards and the count are in the HTML every visitor gets — a search
 * engine's too, though the owner keeps the post page and the community list out of search (#46's
 * follow-up, `noindex`); whether these cards may stay indexed here is ADR-0075 결과 4's question.
 * Nothing of a post's author is drawn but the byline the community list draws — no holding, side
 * or order (N05 §2; the API's guard tests pin the answer).
 *
 * 글쓰기 is always there — every public status takes a post (#45-6), so no market's section has a
 * closed door (ADR-0069 decision 4 #47) — and it is one link for every reader: the write screen
 * with this market picked (`writePath`). That screen's door decides who may write (#46's
 * `WriteGate`): a visitor gets its sign-in prompt, which comes back to the write screen of this
 * market (where a visitor should come back to is the owner's to say, ADR-0075 결과 4); a member gets
 * the form. An account with onboarding steps left never stays on the detail to press it: the
 * onboarding gate takes it from here to its step and back here once done (#57-8, #57-9), as the
 * write screen's address would. The same `href` for everyone keeps the HTML free of who is reading,
 * as the rest of the detail is (`personalAreaView`).
 *
 * No section card around it, as 관련 시장 has none (ADR-0068, owner decision 2026-10-17 '바깥 카드
 * 없이'): the cards are boxes already, and a box of boxes is what the owner took away there. The
 * rungs are the community list's: skeletons while the first page loads, a first read that failed
 * (said apart from an unreachable server) with 다시 시도, the empty notice — the section stays, with
 * 글쓰기 above it — the cards with 더 보기, a notice above them when a later refresh failed, and one
 * beside 더 보기 when it failed, the button left to ask again.
 */
export function MarketDiscussion({ marketId }: { marketId: string }) {
  const list = useMarketPosts(marketId);
  // The detail's own row: the header's query (one key, seeded by the page, no second request),
  // live through `market:status`. The cards' market line takes its status and title from it.
  const market = useMarket(marketId);
  const view = discussionView(list, market.data);
  return (
    <Stack gap="4" minW="0" data-testid="market-discussion">
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        <HStack gap="2" align="baseline" minW="0">
          {/* The heading is the section's name alone — the reading order of the detail's `h2`s is
              its sections' — and the count stands beside it as text. */}
          <Heading as="h2" size="md">
            {copy.marketDiscussion}
          </Heading>
          {view.total !== undefined && (
            <Text
              as="span"
              textStyle="bodySm"
              color="fg.muted"
              data-testid="market-discussion-count"
            >
              {discussionCountText(view.total)}
            </Text>
          )}
        </HStack>
        {/* The community list's 글쓰기, its props in its order: Chakra memoises a style set's CSS
            under its keys sorted, so the same set in another order hydrates as another class
            (community-screen.tsx). */}
        <Button asChild h="40px" px="5" borderRadius="pill" colorPalette="brand">
          <NextLink href={writePath(marketId) as Route} data-testid="market-discussion-write">
            {copy.communityWrite}
          </NextLink>
        </Button>
      </HStack>
      {view.stale && (
        <Alert.Root status="warning" role="status" data-testid="market-discussion-refresh-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {view.body === 'pending' ? (
        SKELETON_ROWS.map((row) => <Skeleton key={row} height="112px" borderRadius="card" />)
      ) : view.body === 'failed' ? (
        <Stack gap="3" align="flex-start" data-testid="market-discussion-error">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{postReadErrorMessage(list.error)}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : view.body === 'empty' ? (
        <EmptyState message={copy.marketDiscussionEmpty} data-testid="market-discussion-empty" />
      ) : (
        <Stack gap="3" data-testid="market-discussion-list">
          {view.posts.map((post) => (
            // `h3`: one below the section's heading, as the community list's cards are under its.
            <PostCard key={post.id} post={post} titleAs="h3" />
          ))}
        </Stack>
      )}
      {view.moreFailed && (
        // A 더 보기 that failed: the cards stay, 더 보기 under this stays to ask again, and this says
        // why nothing came — an unreachable server told apart, as the first read's failure is.
        <Alert.Root status="error" role="alert" data-testid="market-discussion-more-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{postReadErrorMessage(list.error)}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {view.more && (
        // The community list's 더 보기, its props in its order (see 글쓰기 above).
        <Button
          alignSelf="center"
          variant="outline"
          borderRadius="pill"
          borderColor="border.emphasized"
          h="40px"
          px="4"
          textStyle="emphasisSm"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
          data-testid="market-discussion-more"
        >
          {copy.loadMore}
        </Button>
      )}
    </Stack>
  );
}
