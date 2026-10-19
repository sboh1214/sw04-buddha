'use client';

import {
  Alert,
  Badge,
  Button,
  Dialog,
  HStack,
  Heading,
  Link as ChakraLink,
  Portal,
  Stack,
  Text,
} from '@chakra-ui/react';
import { readPostDocument } from '@buddha/shared';
import { useQuery } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PostByline } from '@/components/post/post-author';
import { PostBody } from '@/components/post/post-body';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { postQueryOptions, useDeletePost, usePostWriter } from '@/hooks/use-posts';
import { type Post, type PostMarket } from '@/lib/api';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import {
  COMMUNITY_PATH,
  communityPath,
  isOwnPost,
  postEditPath,
  postFirstLine,
  postPlaceholderMessage,
  postWriteErrorMessage,
} from '@/lib/posts';
import { useSession } from '@/lib/use-session';

/**
 * The post page's body (#46, ADR-0073). Reads the post from the cache the server seeded, so the
 * HTML already holds it, and follows it from there: an edit writes the new post in, a deletion
 * leaves the page. `fallback` is the server's row, drawn if the cache entry is ever unreadable.
 *
 * A published post: the title (an `h2` under the nav's `h1`; a post without one has its first line
 * as an `h2` only a screen reader sees, so the body's `h3`–`h5` always sit under one), the byline
 * (author, time, 수정됨), the body and the market it belongs to — a link to its detail, which opens
 * in every status, and to the community list of that market. Its author also gets 수정 and 삭제 (`isOwnPost`, by the
 * public id of `GET /me`, so nothing of it is in the HTML). A hidden or deleted post is its
 * placeholder and its market only (#45-5).
 */
export function PostScreen({ postId, fallback }: { postId: string; fallback: Post }) {
  const query = useQuery(postQueryOptions(postId));
  const post = query.data ?? fallback;

  if (post.state !== 'published') {
    return (
      <Stack gap="6" data-testid="post-screen">
        <Alert.Root status="info" data-testid={`post-${post.state}`}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{postPlaceholderMessage(post.state)}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <MarketBox market={post.market} />
        <BackLink />
      </Stack>
    );
  }

  return (
    <Stack gap="6" data-testid="post-screen">
      <Stack gap="3">
        {post.title !== null ? (
          <Heading as="h2" textStyle="headline" wordBreak="break-word" data-testid="post-title">
            {post.title}
          </Heading>
        ) : (
          <Heading as="h2" srOnly data-testid="post-title-untitled">
            {postFirstLine(readPostDocument(post.body).text)}
          </Heading>
        )}
        <HStack justify="space-between" gap="3" flexWrap="wrap">
          <PostByline
            author={post.author}
            createdAt={post.createdAt}
            editedAt={post.editedAt}
            size="md"
          />
          <AuthorActions post={post} />
        </HStack>
      </Stack>
      <PostBody document={post.body} />
      <MarketBox market={post.market} />
      <BackLink />
    </Stack>
  );
}

/**
 * The market a post belongs to: its title (a link to the detail, in every status — #46's
 * acceptance criteria), category and status, and the community list of that market's posts.
 */
function MarketBox({ market }: { market: PostMarket }) {
  return (
    <Stack
      as="section"
      aria-labelledby="post-market-heading"
      gap="2"
      p="4"
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="card"
      bg="surface.card"
      data-testid="post-market"
    >
      <Text id="post-market-heading" textStyle="overline" color="fg.muted">
        {copy.postMarketHeading}
      </Text>
      <HStack gap="2" flexWrap="wrap">
        <ChakraLink asChild textStyle="title" color="fg">
          <NextLink
            href={`/markets/${market.slug}` as Route}
            prefetch={false}
            data-testid="post-market-link"
          >
            {market.title}
          </NextLink>
        </ChakraLink>
        {market.status !== 'open' && (
          <Badge size="sm" variant="subtle" colorPalette={MARKET_STATUS_PALETTE[market.status]}>
            {MARKET_STATUS_LABEL[market.status]}
          </Badge>
        )}
      </HStack>
      <HStack gap="4" textStyle="bodySm">
        <Text as="span" color="fg.muted">
          {market.category.nameKo}
        </Text>
        <ChakraLink asChild color="brand.fg">
          <NextLink
            href={communityPath({ market: market.id }) as Route}
            data-testid="post-market-posts"
          >
            {copy.postMarketPosts}
          </NextLink>
        </ChakraLink>
      </HStack>
    </Stack>
  );
}

function BackLink() {
  return (
    <ChakraLink asChild alignSelf="flex-start" textStyle="bodySm" color="fg.muted">
      <NextLink href={COMMUNITY_PATH} data-testid="post-back">
        {copy.postBackToCommunity}
      </NextLink>
    </ChakraLink>
  );
}

/**
 * 수정 and 삭제, for the author only and only once `GET /me` has said who the viewer is. 삭제 asks
 * first (it is never undone, #45-5) and then leaves for the community list, which no longer lists
 * the post. The server checks the author on every write; these only hide what would be refused.
 */
function AuthorActions({ post }: { post: Extract<Post, { state: 'published' }> }) {
  const router = useRouter();
  const writer = usePostWriter();
  const { refetch: refetchSession } = useSession();
  const remove = useDeletePost(() => void refetchSession());
  const [confirming, setConfirming] = useState(false);

  if (!isOwnPost(post.author, writer.publicId) || writer.accountId === undefined) return null;
  const accountId = writer.accountId;

  return (
    <HStack gap="2" data-testid="post-author-actions">
      <Button asChild size="xs" variant="outline">
        <NextLink href={postEditPath(post.id) as Route} data-testid="post-edit">
          {copy.postEdit}
        </NextLink>
      </Button>
      <Button
        size="xs"
        variant="outline"
        colorPalette="no"
        onClick={() => setConfirming(true)}
        data-testid="post-delete"
      >
        {copy.postDelete}
      </Button>
      <Dialog.Root
        open={confirming}
        onOpenChange={(details) => {
          if (!details.open && !remove.isPending) setConfirming(false);
        }}
        role="alertdialog"
        lazyMount
        unmountOnExit
        closeOnInteractOutside={!remove.isPending}
        closeOnEscape={!remove.isPending}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content data-testid="post-delete-dialog">
              <Dialog.Header>
                <Dialog.Title>{copy.postDeleteTitle}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>{copy.postDeleteBody}</Text>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => setConfirming(false)}
                  data-testid="post-delete-cancel"
                >
                  {copy.cancel}
                </Button>
                <Button
                  size="sm"
                  colorPalette="no"
                  loading={remove.isPending}
                  onClick={() =>
                    remove.mutate(
                      { postId: post.id, expectedAccountId: accountId },
                      {
                        onSuccess: () => {
                          setConfirming(false);
                          toaster.create({ type: 'success', title: copy.postDeletedToast });
                          router.replace(COMMUNITY_PATH);
                        },
                        onError: (error) => {
                          setConfirming(false);
                          toaster.create({ type: 'error', title: postWriteErrorMessage(error) });
                        },
                      },
                    )
                  }
                  data-testid="post-delete-confirm"
                >
                  {copy.postDeleteConfirm}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </HStack>
  );
}
