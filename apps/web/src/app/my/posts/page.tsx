import type { Metadata } from 'next';
import { copy } from '@/copy';
import { ComingSoonTab } from '../coming-soon';

export const metadata: Metadata = { title: `${copy.myPosts} | ${copy.appName}` };

/** `/my/posts`: MY's 내 글 tab (#16), 준비 중 until its own issue fills it. */
export default function MyPostsPage() {
  return <ComingSoonTab title={copy.myPosts} testId="my-posts" />;
}
