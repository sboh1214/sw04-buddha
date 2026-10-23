import { AdminLinkFlags } from './admin-link-flags';

/**
 * 반복 링크 검토 목록 (#187, ADR-0083), a page of the admin 신고·조치 area (#50, ADR-0081). Access is
 * checked in the admin layout.
 */
export default function AdminLinkFlagsPage() {
  return <AdminLinkFlags />;
}
