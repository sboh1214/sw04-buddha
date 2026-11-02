import { adminDisputeQueueOf } from '@/lib/admin-disputes';
import { AdminDisputes } from './admin-disputes';

/**
 * 이의 접수 (#175, ADR-0104; N03 §8 '이의 접수'): the members' 판정 이의 in two halves — `?status=decided`
 * is 처리됨, anything else 검토 대기. Access is checked in the admin layout; the API checks it on
 * every call.
 */
export default async function AdminDisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status } = await searchParams;
  return <AdminDisputes status={adminDisputeQueueOf(status)} />;
}
