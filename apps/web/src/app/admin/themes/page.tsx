import { AdminThemes } from './admin-themes';

/** 테마 목록 / 만들기 (#81, ADR-0088). Access is checked in the admin layout. */
export default function AdminThemesPage() {
  return <AdminThemes />;
}
