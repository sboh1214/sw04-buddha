import { Container } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchCommentsPageServer, fetchPostServer } from '@/lib/api.server';
import { postCommentsKey } from '@/lib/comments';
import { dehydratePublic } from '@/lib/market-keys';
import { postKey, postPageMetadata } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import { PostScreen } from './post-screen';

/** Rendered per request: a post can be edited, hidden or deleted at any moment. */
export const dynamic = 'force-dynamic';

/** Every answer — the post, its placeholder, and none — is `noindex` (`postPageMetadata`). */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ postId: string }>;
}): Promise<Metadata> {
  const { postId } = await params;
  // The same React-cached call the body makes.
  return postPageMetadata(await fetchPostServer(postId));
}

/**
 * A post page (#46, ADR-0073): the whole post — title, byline, body, its market — or the
 * placeholder of a hidden post and of a deleted one replies hang under (#45-5), and 404 for a
 * deleted post with nothing under it, which is gone (the API answers NOT_FOUND, as for an address
 * that never was a post). Public (N05 §2).
 *
 * The post is read here, once, and seeded under its key, so the HTML carries the post and the
 * client component follows the cache from there (an edit writes the new post into it); so is the
 * first page of its comments (#48, ADR-0074). Nothing personal is read: whether the viewer wrote it
 * or a comment — and so 수정 and 삭제 — is decided in the browser once `GET /me` has answered.
 */
export default async function PostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const queryClient = getQueryClient();
  // The comments' first page alongside the post (#48): under the canonical id the client reads.
  // A failed read — a segment that is no post among them — is not dehydrated, and the browser
  // reads the comments itself.
  const id = postId.toLowerCase();
  const [post] = await Promise.all([
    fetchPostServer(postId),
    queryClient.prefetchInfiniteQuery({
      queryKey: postCommentsKey(id),
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        fetchCommentsPageServer(id, pageParam),
      // The param the client's own options declare (hooks/use-comments.ts), so the seeded page is
      // picked up rather than fetched again.
      initialPageParam: undefined as string | undefined,
    }),
  ]);
  if (post === null) notFound();
  queryClient.setQueryData(postKey(post.id), post);

  return (
    <Container maxW="760px" px="6" py={{ base: '6', md: '10' }}>
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        <PostScreen postId={post.id} fallback={post} />
      </HydrationBoundary>
    </Container>
  );
}
