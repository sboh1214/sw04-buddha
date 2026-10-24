'use client';

import { Heading, Stack, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PostForm } from '@/components/post/post-form';
import { WriteGate } from '@/components/post/write-gate';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { postQueryOptions, useUpdatePost } from '@/hooks/use-posts';
import { type Post } from '@/lib/api';
import {
  isOwnPost,
  postEditPath,
  postGoneAfter,
  postPath,
  postPlaceholderMessage,
  postWriteErrorMessage,
  refusedImageIds,
} from '@/lib/posts';
import { useSession } from '@/lib/use-session';

/**
 * Editing a post (#45-4): its title and body in the write screen's form, its market shown and not
 * changeable. Only its author edits it, and not while it is hidden (#45-5: a hidden post cannot be
 * edited). Its author may delete a hidden post, but only through the API until #50·#51 give them
 * the control — its page has none (the public answer for it names no author) — so the message
 * here promises no deletion, and every signed-in viewer of a hidden post's address reads the same
 * one. Saving the same content changes nothing on the server (no '수정됨'); saving a change marks
 * it edited and keeps the earlier version for operators. Either way the screen goes back to the
 * post.
 *
 * A post deleted while its edit screen is open — in another tab — is gone once a read of it
 * answers NOT_FOUND (`postGoneAfter`, ADR-0073 9-50, Codex review of #219, round 5): the read after
 * a save refused as NOT_FOUND (`updatePostOptions`), or a window's focus. The query keeps the post
 * it read before, so the form stayed, and every save could only be refused again. Now the screen
 * says '없거나 삭제된 글입니다.' in the form's place — the form goes, as it does for a post hidden
 * meanwhile — and draws the server page again (`router.refresh`): the 404 a reload gets
 * (`notFound()`, page.tsx). A read that fails otherwise keeps the form and what is written in it.
 * What is written goes with the form, and leaving no longer asks. That is a change: before, a save
 * refused as NOT_FOUND left the form and its text on screen under the same sentence
 * (`copy.errPostGone`). #48's comment boxes keep a refused text until it is closed (ADR-0074, owner
 * decisions 2026-10-20 답 4 and 2026-10-21 답 1·2); whether this screen does too is the question in
 * ADR-0073 결과 4.
 */
export function EditScreen({ postId, fallback }: { postId: string; fallback: Post }) {
  const router = useRouter();
  const query = useQuery(postQueryOptions(postId));
  const post = query.data ?? fallback;
  const [gone, setGone] = useState(false);
  const nowGone = postGoneAfter(gone, query);
  if (nowGone !== gone) setGone(nowGone);
  useEffect(() => {
    if (gone) router.refresh();
  }, [gone, router]);
  return (
    <Stack gap="6" data-testid="post-edit-screen">
      <Heading as="h2" textStyle="headline">
        {copy.postEditTitle}
      </Heading>
      {gone ? (
        <EmptyState message={copy.postNotFound} data-testid="post-edit-gone" />
      ) : (
        <WriteGate back={postEditPath(postId)}>
          {(writer) =>
            post.state !== 'published' ? (
              <EmptyState
                message={
                  post.state === 'hidden'
                    ? copy.errPostNotEditable
                    : postPlaceholderMessage(post.state)
                }
                data-testid="post-edit-unavailable"
              />
            ) : !isOwnPost(post.author, writer.publicId) ? (
              <EmptyState message={copy.postEditNotYours} data-testid="post-edit-not-yours" />
            ) : (
              <EditForm post={post} accountId={writer.accountId} />
            )
          }
        </WriteGate>
      )}
    </Stack>
  );
}

function EditForm({
  post,
  accountId,
}: {
  post: Extract<Post, { state: 'published' }>;
  accountId: string;
}) {
  const router = useRouter();
  const { refetch: refetchSession } = useSession();
  const update = useUpdatePost(() => void refetchSession());
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  return (
    <Stack gap="4">
      <Stack gap="0.5">
        <Text textStyle="overline" color="fg.muted">
          {copy.postWriteMarketLabel}
        </Text>
        <Text textStyle="title" data-testid="post-edit-market">
          {post.market.title}
        </Text>
      </Stack>
      <PostForm
        initialTitle={post.title}
        initialDocument={post.body}
        draftKey={{ kind: 'edit', postId: post.id }}
        accountId={accountId}
        submitLabel={copy.postEditSubmit}
        // Held through the move to the post once saved, as the write screen holds it: the form
        // stays locked, and leaving no longer asks (the draft is the server's).
        pending={update.isPending || update.isSuccess}
        saved={update.isSuccess}
        errorMessage={refusal}
        refusedImageIds={refusedImageIds(update.error)}
        onSubmit={({ title, body }) => {
          setRefusal(undefined);
          update.mutate(
            { postId: post.id, title, body, expectedAccountId: accountId },
            {
              onSuccess: (saved) => router.push(postPath(saved.id) as Route),
              onError: (error) => setRefusal(postWriteErrorMessage(error)),
            },
          );
        }}
      />
    </Stack>
  );
}
