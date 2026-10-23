import { adminAccountRequestQueueOf } from '@/lib/moderation';
import { AdminAccountRequests } from './admin-account-requests';

/**
 * 계정 제한 요청 (#139, ADR-0085): the account restriction requests in their two halves —
 * `?status=decided` is the decided one, anything else the one waiting for a decision. Access is
 * checked in the admin layout; the API checks it on every call.
 */
export default async function AdminAccountRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status } = await searchParams;
  return <AdminAccountRequests queue={adminAccountRequestQueueOf(status)} />;
}
