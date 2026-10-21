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
import { useCallback, useId, useRef, useState } from 'react';
import { OperatorLink } from '@/components/moderation/operator-link';
import { ReportButton } from '@/components/moderation/report-button';
import { CommentsSection } from '@/components/post/comments-section';
import { LikeButton, LikesUnreadableNotice } from '@/components/post/like-button';
import { PostByline } from '@/components/post/post-author';
import { PostBody } from '@/components/post/post-body';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useOnboardingEntry } from '@/hooks/use-onboarding-entry';
import { postQueryOptions, useDeletePost, usePostWriter } from '@/hooks/use-posts';
import { type Post, type PostMarket } from '@/lib/api';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { adminPostModerationPath, authorPublicIdOf } from '@/lib/moderation';
import {
  COMMUNITY_PATH,
  communityPath,
  isOwnPost,
  postEditPath,
  postFirstLine,
  postGoneAfter,
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
 * (author, time, 수정됨), the body, its 좋아요 (#49, ADR-0076: the public count, and the reader's
 * own toggle once the browser knows who reads — with a line beside it when the reader's likes could
 * not be read, owner decision 2026-10-20, answer 10), 신고 for a reader who did not write it (#50,
 * ADR-0081 — `ReportButton`, decided in the browser), '운영' for an operator (owner decision
 * 2026-10-21, `OperatorLink` — on a placeholder too) and the market it belongs to — a link to its
 * detail, which opens in every status, and to the community list of that market. Its author also
 * gets 수정 and 삭제 (`isOwnPost`, by the public id of `GET /me`, so nothing of it is in the HTML). A
 * hidden or deleted post is its placeholder and its market only (#45-5) — no count, no 좋아요 and
 * no 신고, as it takes none. Under either come the post's comments (#48, ADR-0074): a placeholder
 * keeps them readable (N04 §6), and only a published post takes new ones.
 *
 * The onboarding gate lets an account that finished its onboarding once and faces a re-consent
 * alone open this page (`ONBOARDING_EXEMPT_PAGES`, 오너 결정 2026-10-20): deleting one's own post
 * asks for a session alone (오너 결정 2026-10-19 답 2), on screen too — and so does deleting one's
 * own comment (#48). Its 수정 then goes to the consent step and comes back to the edit screen once
 * that is done (`useOnboardingEntry`), and the comments' writes go to it and come back here
 * (comments-section.tsx, ADR-0074); everything else this page links to is gated as before. An
 * account that has not finished is sent on from this page too, and comes back to it at the end.
 *
 * A post can leave every view while its page is open: its author deletes it in another tab, the
 * last comment under a deleted post is deleted, or a comment write is refused because the post is
 * gone. A read of it after that — the read after the write, or a window's focus — answers
 * NOT_FOUND, while the query keeps the post it read before: the placeholder, a count and a box that
 * no longer hold (ADR-0073 9-50, Codex review of #219, round 5). From then on (`postGoneAfter`, the
 * edit screen's rule too) the page says '없거나 삭제된 글입니다.' in place of the post and its market,
 * and the comment section shows only the texts it holds apart — a write refused because the post
 * is gone, every box with a changed text, each with why — until the writer has closed them all
 * (오너 결정 2026-10-21 답 1; leaving asks while they are shown). Then — at once when there is
 * none — the server page is drawn again (`router.refresh`): it answers what a reload does, the 404
 * (`notFound()`, page.tsx). A read that fails otherwise keeps the post on screen.
 */
export function PostScreen({ postId, fallback }: { postId: string; fallback: Post }) {
  const router = useRouter();
  const query = useQuery(postQueryOptions(postId));
  const post = query.data ?? fallback;
  // Once gone, gone for good (`postGoneAfter`): a later read failing otherwise (the network) does
  // not bring back the post as it was last read.
  const [gone, setGone] = useState(false);
  const nowGone = postGoneAfter(gone, query);
  if (nowGone !== gone) setGone(nowGone);
  const goneNotice = useRef<HTMLDivElement>(null);
  const goneTextId = useId();
  const refreshed = useRef(false);
  const toNotFound = useCallback(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    router.refresh();
  }, [router]);
  const focusGone = useCallback(() => goneNotice.current?.focus({ preventScroll: true }), []);

  // One tree for every state, the post's head (title, byline and body, the placeholder, or the
  // sentence of a post gone) in one slot: the comments sit at the same place whether the post is
  // published, hidden or deleted, so a post closed while its page is open — read again after a
  // refused write, or in the background — keeps the comment section mounted, with every box open in
  // it and every text it holds (ADR-0074 결정 6).
  return (
    <Stack gap="6" data-testid="post-screen">
      {gone ? (
        // Where the focus goes from a text closed while others are left (the comments' heading is
        // gone with them): named by its sentence, so that is what is read out, as a held text is
        // by its reason. A group, not a live region: drawn as the post goes, it would be read out
        // over the held texts' own alerts.
        <Alert.Root
          ref={goneNotice}
          status="info"
          role="group"
          aria-labelledby={goneTextId}
          tabIndex={-1}
          data-testid="post-gone"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description id={goneTextId}>{copy.postNotFound}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : post.state !== 'published' ? (
        <Stack gap="2">
          <Alert.Root status="info" data-testid={`post-${post.state}`}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{postPlaceholderMessage(post.state)}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <PostOperatorLink postId={post.id} />
        </Stack>
      ) : (
        <>
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
          <HStack gap="3" flexWrap="wrap" data-testid="post-reactions">
            <LikeButton
              postId={post.id}
              target={{ kind: 'post', id: post.id }}
              count={post.likeCount}
            />
            <LikesUnreadableNotice postId={post.id} />
            <ReportButton
              subject={{ type: 'post', postId: post.id }}
              authorPublicId={authorPublicIdOf(post.author)}
            />
            <PostOperatorLink postId={post.id} />
          </HStack>
        </>
      )}
      {!gone && <MarketBox market={post.market} />}
      <CommentsSection post={post} gone={gone} onNothingHeld={toNotFound} focusGone={focusGone} />
      <BackLink />
    </Stack>
  );
}

/**
 * '운영', for operators only (owner decision 2026-10-21, `OperatorLink`): the post's moderation
 * page — beside its reactions, or under its placeholder, which the page acts on as well (a hiding
 * cancelled, the deleted original read).
 */
function PostOperatorLink({ postId }: { postId: string }) {
  return (
    <OperatorLink
      href={adminPostModerationPath(postId)}
      label={copy.operatorModerationPostLabel}
      testId="post-operator-link"
    />
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
 * the post — a post with comments under it stays at its address as '삭제된 글입니다' with them
 * (#48) — and, for an author facing a re-consent, the gate there takes it on to that step
 * (오너 결정 2026-10-20 3차 답 4). 수정 is the edit screen, or that step first (`entryPath`). The
 * server checks the author on every write; these only hide what would be refused.
 * The dialog's warning is its description (`Dialog.Description`, `aria-describedby`), so a screen
 * reader says it with the title (ADR-0080 7-19).
 */
function AuthorActions({ post }: { post: Extract<Post, { state: 'published' }> }) {
  const router = useRouter();
  const writer = usePostWriter();
  const { entryPath } = useOnboardingEntry();
  const { refetch: refetchSession } = useSession();
  const remove = useDeletePost(() => void refetchSession());
  const [confirming, setConfirming] = useState(false);

  if (!isOwnPost(post.author, writer.publicId) || writer.accountId === undefined) return null;
  const accountId = writer.accountId;

  return (
    <HStack gap="2" data-testid="post-author-actions">
      <Button asChild size="xs" variant="outline">
        <NextLink href={entryPath(postEditPath(post.id)) as Route} data-testid="post-edit">
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
                <Dialog.Description color="fg">{copy.postDeleteBody}</Dialog.Description>
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
