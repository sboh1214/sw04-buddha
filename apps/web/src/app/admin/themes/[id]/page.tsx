import { AdminThemeDetail } from './admin-theme-detail';

/**
 * 테마 상세(관리) (#81, ADR-0088): the edit form, publication, the markets and the notices. Access
 * is checked in the admin layout; an unknown id is the client's 찾을 수 없습니다 alert (the API
 * answers 404), and a malformed one gets the same alert without a request.
 */
export default async function AdminThemePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminThemeDetail id={id} />;
}
