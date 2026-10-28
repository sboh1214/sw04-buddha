import { AdminNoticeEdit } from '../notice-forms';

/**
 * 공지 수정 (#138, ADR-0077): a notice's title and body, by any admin, with its pin and unpin.
 * Access is checked in the admin layout; an unknown id — or one that is not a uuid, which the API
 * refuses — is the client's 찾을 수 없습니다.
 */
export default async function AdminNoticeEditPage({
  params,
}: {
  params: Promise<{ noticeId: string }>;
}) {
  const { noticeId } = await params;
  return <AdminNoticeEdit noticeId={noticeId} />;
}
