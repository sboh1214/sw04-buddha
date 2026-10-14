import { AdminReleaseSettings } from './admin-release-settings';

/** 출시 설정 (#170, ADR-0055). Access is checked in the admin layout. */
export default function AdminReleaseSettingsPage() {
  return <AdminReleaseSettings />;
}
