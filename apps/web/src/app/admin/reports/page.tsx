import { adminReportQueueOf } from '@/lib/moderation';
import { AdminReports } from './admin-reports';

/**
 * 신고 목록 (#50, ADR-0081): the report queue, grouped by target, in its two halves —
 * `?status=resolved` is the processed one, anything else the pending one. Access is checked in the
 * admin layout; the API checks it on every call.
 */
export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status } = await searchParams;
  return <AdminReports queue={adminReportQueueOf(status)} />;
}
