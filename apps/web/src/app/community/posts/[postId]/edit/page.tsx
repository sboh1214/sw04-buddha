import { Container } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { copy } from '@/copy';
import { fetchPostServer } from '@/lib/api.server';
import { dehydratePublic } from '@/lib/market-keys';
import { postKey } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import { EditScreen } from './edit-screen';

/** Rendered per request: the post is read as it is now. */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${copy.postEditTitle} | ${copy.appName}`,
  robots: { index: false },
};

/**
 * The edit screen of a post (#46, ADR-0073; #45-4: the title and the body, never the market, at
 * any time). The post is public, so it is read here and seeded like the post page; whether the
 * viewer may edit it — signed in, its author, not hidden — is the browser's to show once `GET /me`
 * has answered, and the server's to decide on the write.
 */
export default async function EditPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const post = await fetchPostServer(postId);
  if (post === null) notFound();
  const queryClient = getQueryClient();
  queryClient.setQueryData(postKey(post.id), post);
  return (
    <Container maxW="760px" px="6" py={{ base: '6', md: '10' }}>
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        <EditScreen postId={post.id} fallback={post} />
      </HydrationBoundary>
    </Container>
  );
}
