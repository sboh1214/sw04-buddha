import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyAuthored } from './my-authored';

export const metadata: Metadata = { title: `${copy.myPosts} | ${copy.appName}` };

/**
 * `/my/posts`: MY's 내 글 tab (#16, filled by #51 — ADR-0080). Gated on every navigation to it
 * (`requireMySession`); the layout draws the tabs, and the lists are fetched after hydration like
 * every MY list (nothing of them is in the HTML).
 */
export default async function MyPostsPage() {
  await requireMySession();
  return <MyAuthored />;
}
