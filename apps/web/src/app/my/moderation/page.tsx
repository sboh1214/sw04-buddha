import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyModeration } from './my-moderation';

export const metadata: Metadata = { title: `${copy.myModeration} | ${copy.appName}` };

/**
 * `/my/moderation`: 조치·신고 내역 (#50, ADR-0081; ADR-0069 decision 4 #50: «MY 아래 별도 화면(MY 탭은
 * 더하지 않고 MY 설정에서 연결)»). Gated on every navigation to it (`requireMySession`); the layout
 * draws MY's tabs, none of which is this page. The lists are the member's own and are fetched after
 * hydration like every MY list (nothing of them is in the HTML).
 */
export default async function MyModerationPage() {
  await requireMySession();
  return <MyModeration />;
}
