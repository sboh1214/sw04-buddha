import { Container } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchPostServer } from '@/lib/api.server';
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
 * client component follows the cache from there (an edit writes the new post into it). Nothing
 * personal is read: whether the viewer wrote it — and so 수정 and 삭제 — is decided in the browser
 * once `GET /me` has answered.
 */
export default async function PostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const post = await fetchPostServer(postId);
  if (post === null) notFound();
  const queryClient = getQueryClient();
  queryClient.setQueryData(postKey(post.id), post);

  return (
    <Container maxW="760px" px="6" py={{ base: '6', md: '10' }}>
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        <PostScreen postId={post.id} fallback={post} />
      </HydrationBoundary>
    </Container>
  );
}
