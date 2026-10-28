'use client';

import { Stack, Text } from '@chakra-ui/react';
import { useId } from 'react';
import { AuthoredCommentCard } from '@/components/authored/authored-comment-card';
import { AuthoredListBody } from '@/components/authored/authored-list';
import { AuthoredTabs } from '@/components/authored/authored-tabs';
import { HiddenNoticeLine } from '@/components/authored/hidden-notice';
import { PostCard } from '@/components/post/post-card';
import { copy } from '@/copy';
import { useMyComments, useMyPosts } from '@/hooks/use-authored';
import { type MyComment, type MyPost } from '@/lib/api';
import { Section, SessionEnded, useSessionEnded } from '../portfolio';
import { DeleteHiddenItem } from './delete-hidden';

/**
 * `/my/posts`: MY '내 글' (#51, ADR-0080; ADR-0069 decision 4 #51 and decision 2 #45-5) — the
 * member's posts and their 댓글 and 대댓글 on two tabs, newest first, nothing to filter. What the
 * member deleted is not here; what an operator hid is, its content and counts as they are, under
 * its '숨김' line with the reason (`HiddenNoticeLine`) — for the member alone — and 삭제 beside that
 * line (`DeleteHiddenItem`, owner decision 2026-10-22), after which it leaves the list. Each item
 * opens its post and its market.
 *
 * Personal and client-only like every MY list: read with the member's cookie after hydration,
 * under the private `['my-authored']` root, so nothing of it is in the HTML; and nobody else's —
 * the session decides whose (`GET /me/posts`, `/me/comments` take no account).
 */
export function MyAuthored() {
  const ended = useSessionEnded();
  if (ended) return <SessionEnded />;
  return (
    <Section title={copy.myPosts} testId="my-posts">
      <AuthoredTabs
        label={copy.myPosts}
        testId="my-authored"
        panels={{ posts: <MyPostsBody />, comments: <MyCommentsBody /> }}
      />
    </Section>
  );
}

/**
 * The 글 tab's body, for the tab and for the summary's preview (`limit`, MY_PREVIEW_ROWS, and the
 * label that names the list, `labelledBy`) — one body, so the preview cannot read differently from
 * the tab (ADR-0054).
 */
export function MyPostsBody({
  limit,
  labelledBy,
  testId = 'my-posts-list',
}: {
  limit?: number;
  labelledBy?: string;
  testId?: string;
}) {
  const list = useMyPosts();
  return (
    <AuthoredListBody
      list={list}
      tab="posts"
      limit={limit}
      labelledBy={labelledBy}
      testId={testId}
      renderRow={(post) => <MyPostItem post={post} />}
    />
  );
}

/** The 댓글 tab's body, for the tab and for the summary's preview. */
export function MyCommentsBody({
  limit,
  labelledBy,
  testId = 'my-comments-list',
}: {
  limit?: number;
  labelledBy?: string;
  testId?: string;
}) {
  const list = useMyComments();
  return (
    <AuthoredListBody
      list={list}
      tab="comments"
      limit={limit}
      labelledBy={labelledBy}
      testId={testId}
      renderRow={(comment) => <MyCommentItem comment={comment} />}
    />
  );
}

/**
 * A post as every list draws it (`PostCard`: the community card, `h4` under MY's `h3`), under its
 * '숨김' line and that line's 삭제 when an operator hid it — nothing else of the card changes (owner
 * decision 2026-10-22: «내용·수 그대로»). A hidden post's card has no thumbnail (`GET /media` serves
 * no image of a hidden post) and opens the post page, which shows its placeholder to everybody.
 * The summary's preview draws the same row, 삭제 included (one body, ADR-0054).
 */
function MyPostItem({ post }: { post: MyPost }) {
  return (
    <Stack gap="1.5" minW="0">
      {post.hidden !== null && (
        <HiddenNoticeLine
          hidden={post.hidden}
          action={
            <DeleteHiddenItem
              id={post.id}
              postId={post.id}
              item={{ tab: 'posts', title: post.title, excerpt: post.excerpt }}
            />
          }
        />
      )}
      <PostCard post={post} titleAs="h4" />
    </Stack>
  );
}

/** A comment's card under its '숨김' line and 삭제 when an operator hid it, as a post's. */
function MyCommentItem({ comment }: { comment: MyComment }) {
  return (
    <Stack gap="1.5" minW="0">
      {comment.hidden !== null && (
        <HiddenNoticeLine
          hidden={comment.hidden}
          action={
            <DeleteHiddenItem
              id={comment.id}
              postId={comment.post.id}
              item={{ tab: 'comments', body: comment.body }}
            />
          }
        />
      )}
      <AuthoredCommentCard comment={comment} />
    </Stack>
  );
}

/**
 * 내 글's preview on `/my` (ADR-0054 decision 2, the 준비 중 of #16 until now): the newest
 * `limit` posts and the newest `limit` comments, each under its tab's name — the way 거래·정산
 * 이력's preview shows its two lists — and the section's 전체 보기 to the tab. The names are labels,
 * not headings, so each card's title stays an `h4` under the section's `h3`; each label names its
 * list (`aria-labelledby`), so moving by lists a screen reader hears '댓글' with the 댓글 list, which
 * no heading would otherwise announce (ADR-0080 7-12).
 */
export function MyAuthoredPreview({ limit }: { limit: number }) {
  const postsLabel = useId();
  const commentsLabel = useId();
  return (
    <Stack gap="5">
      <Stack gap="3">
        <Text id={postsLabel} textStyle="emphasisSm" color="fg.muted">
          {copy.authoredTabPosts}
        </Text>
        <MyPostsBody limit={limit} labelledBy={postsLabel} testId="my-preview-posts-list" />
      </Stack>
      <Stack gap="3">
        <Text id={commentsLabel} textStyle="emphasisSm" color="fg.muted">
          {copy.authoredTabComments}
        </Text>
        <MyCommentsBody
          limit={limit}
          labelledBy={commentsLabel}
          testId="my-preview-comments-list"
        />
      </Stack>
    </Stack>
  );
}
