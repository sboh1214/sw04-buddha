import { AdminNotices } from './admin-notices';

/**
 * 운영 공지 (#138, ADR-0077): the pinned notices and the others, each to pin, unpin or edit, and
 * the way to write one. Access is checked in the admin layout.
 */
export default function AdminNoticesPage() {
  return <AdminNotices />;
}
