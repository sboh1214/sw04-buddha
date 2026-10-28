import { AdminNoticeRevisionView } from '../../../notice-revision';

/**
 * 이전 판 (#138, owner decision 2026-10-21, ADR-0077): one earlier version of a notice, read-only.
 * Access is checked in the admin layout; a version that is not this notice's — or an address that
 * is not a version — is the client's 찾을 수 없습니다.
 */
export default async function AdminNoticeRevisionPage({
  params,
}: {
  params: Promise<{ noticeId: string; revisionId: string }>;
}) {
  const { noticeId, revisionId } = await params;
  return <AdminNoticeRevisionView noticeId={noticeId} revisionId={revisionId} />;
}
