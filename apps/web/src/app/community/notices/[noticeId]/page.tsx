import { Container } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { copy } from '@/copy';
import { fetchNoticeServer } from '@/lib/api.server';
import { noticeDescription } from '@/lib/notices';
import { NoticeView } from './notice-view';

/** Rendered per request: any admin may edit, pin or unpin a notice at any moment. */
export const dynamic = 'force-dynamic';

/** Search engines cut a description around here (the post page's length). */
const META_DESCRIPTION_MAX = 160;

/**
 * Kept out of search engines, as the community's other screens are (the #46 follow-up's answer of
 * 2026-10-19, which reaches this branch with the restack — ADR-0075 result 5): this PR's choice,
 * an open question to the owner (ADR-0077). A link shared keeps its title and description.
 */
const ROBOTS = { index: false } as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ noticeId: string }>;
}): Promise<Metadata> {
  const { noticeId } = await params;
  // The same React-cached call the body makes.
  const notice = await fetchNoticeServer(noticeId);
  if (notice === null) return { title: `${copy.noticeNotFound} | ${copy.appName}`, robots: ROBOTS };
  return {
    title: `${notice.title} | ${copy.appName}`,
    description: noticeDescription(notice.body, META_DESCRIPTION_MAX),
    robots: ROBOTS,
  };
}

/**
 * A notice page (#138, ADR-0077): the operators' notice the community list's fixed area links to —
 * its title, '운영팀', the time, '수정됨' once edited and the body, drawn as a post's. Public: anyone
 * reads, signed in or not (#138's acceptance criteria). Read-only — no comment, like or report
 * (ADR-0069 decision 2 #45-8) — and the same for every visitor, so it is drawn on the server
 * alone: nothing on it depends on who reads it or changes while it is open.
 *
 * A notice that is not pinned answers too, at its address (this PR's choice, ADR-0077: the owner
 * kept unpinned notices on the admin screen and did not say whether their addresses close). An
 * address that is no notice — or not a uuid — is the 404.
 */
export default async function NoticePage({ params }: { params: Promise<{ noticeId: string }> }) {
  const { noticeId } = await params;
  const notice = await fetchNoticeServer(noticeId);
  if (notice === null) notFound();
  return (
    <Container maxW="760px" px="6" py={{ base: '6', md: '10' }}>
      <NoticeView notice={notice} />
    </Container>
  );
}
