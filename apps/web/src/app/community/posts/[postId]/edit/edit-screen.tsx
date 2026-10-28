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
  type PostEditGone,
  isOwnPost,
  postEditDeleted,
  postEditGoneAfter,
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
 * edited). Its author deletes a hidden post on MY '내 글', from 삭제 beside its '숨김' line (owner
 * decision 2026-10-22, ADR-0080); its page has none (the public answer for it names no author). The
 * message here does not point there: every signed-in viewer of a hidden post's address reads the
 * same one, and the owner kept it so (owner decision 2026-10-22 2nd answer 1, ADR-0080 7-17).
 * Saving the same content changes nothing on the server (no '수정됨'); saving a change marks it
 * edited and keeps the earlier version for operators. Either way the screen goes back to the post.
 *
 * A post deleted while its edit screen is open — in another tab — is gone once a read of it
 * answers NOT_FOUND (`postGoneAfter`, ADR-0073 9-50, Codex review of #219, round 5): the read after
 * a save refused as NOT_FOUND (`updatePostOptions`), or a window's focus. The query keeps the post
 * it read before, so the form stayed, and every save could only be refused again. What the writer
 * had in the form is theirs, and the screen keeps it (오너 결정 2026-10-24, ADR-0073 9-52 — the
 * rule of #48's comment boxes, ADR-0074 오너 결정 2026-10-20 답 4 and 2026-10-21 답 1·2): the
 * form stays with its title and body read-only, to select and copy, under '없거나 삭제된
 * 글입니다.', and 닫기 in place of 저장; leaving asks first, as it did. Closed — and at once when
 * the form held nothing of the writer's, or was not on screen — the screen says the sentence in the
 * form's place and draws the server page again (`router.refresh`): the 404 a reload gets
 * (`notFound()`, page.tsx). Whether the form holds something is its own word as of its last
 * render (`onHoldingChange`), taken as the post goes (`postEditGoneAfter`). A read that fails
 * otherwise keeps the form and what is written in it.
 *
 * A post with comments under it is not gone when deleted (#48): it stays at its address as
 * '삭제된 글입니다', and the read after the refused save — or a focus — answers that placeholder,
 * not NOT_FOUND. The screen holds it deleted all the same (`postEditDeleted`, ADR-0074 7-35) and
 * keeps the form as above, drawn from the post as it last had it published (the query holds the
 * placeholder now). Closed — or at once — the screen is the placeholder, as a reload draws it, and
 * draws the server page again too.
 */
export function EditScreen({ postId, fallback }: { postId: string; fallback: Post }) {
  const router = useRouter();
  const query = useQuery(postQueryOptions(postId));
  const post = query.data ?? fallback;
  // The post as the screen last had it published: what a held form is drawn from once a read has
  // put the placeholder of the post deleted under it in its place (`postEditDeleted`).
  const [published, setPublished] = useState(post.state === 'published' ? post : undefined);
  if (post.state === 'published' && post !== published) setPublished(post);
  // NOT_FOUND heard (`postGoneAfter`): the post left every view, and the server page is the 404.
  const [notFound, setNotFound] = useState(false);
  const nowNotFound = postGoneAfter(notFound, query);
  if (nowNotFound !== notFound) setNotFound(nowNotFound);
  // Whether the form holds something of the writer's, as it last said (`onHoldingChange`).
  const [formHolding, setFormHolding] = useState(false);
  const [state, setState] = useState<PostEditGone>({ gone: false, held: false });
  const next = postEditGoneAfter(state, {
    gone: nowNotFound || postEditDeleted(published, post),
    formHolding,
  });
  if (next !== state) setState(next);
  const { gone, held } = state;
  // Drawn again as NOT_FOUND comes after the placeholder too (its last comment deleted since): the
  // 404 in place of the placeholder.
  useEffect(() => {
    if (gone && !held) router.refresh();
  }, [gone, held, notFound, router]);
  // Held, the form is drawn from the post as it last had it published: the query may hold the
  // placeholder now.
  const shown = held && published !== undefined ? published : post;
  return (
    <Stack gap="6" data-testid="post-edit-screen">
      <Heading as="h2" textStyle="headline">
        {copy.postEditTitle}
      </Heading>
      {gone && !held && notFound ? (
        <EmptyState message={copy.postNotFound} data-testid="post-edit-gone" />
      ) : (
        <WriteGate back={postEditPath(postId)}>
          {(writer) =>
            shown.state !== 'published' ? (
              <EmptyState
                message={
                  shown.state === 'hidden'
                    ? copy.errPostNotEditable
                    : postPlaceholderMessage(shown.state)
                }
                data-testid="post-edit-unavailable"
              />
            ) : !isOwnPost(shown.author, writer.publicId) ? (
              <EmptyState message={copy.postEditNotYours} data-testid="post-edit-not-yours" />
            ) : (
              <EditForm
                post={shown}
                accountId={writer.accountId}
                gone={gone}
                onClose={() => setState({ gone: true, held: false })}
                onHoldingChange={setFormHolding}
              />
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
  gone,
  onClose,
  onHoldingChange,
}: {
  post: Extract<Post, { state: 'published' }>;
  accountId: string;
  /**
   * The post left every view or stands as its placeholder (#48), and the form holds what the writer
   * had in it (`PostEditGone`).
   */
  gone: boolean;
  onClose: () => void;
  onHoldingChange: (holding: boolean) => void;
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
        gone={gone}
        onClose={onClose}
        onHoldingChange={onHoldingChange}
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
