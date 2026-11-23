import { adminOperationsViewOf } from '@/lib/admin-operations';
import { AdminOperations } from './admin-operations';

type Param = string | string[] | undefined;

/**
 * 운영 대기열 (#145 part 1, ADR-0163; N03 §8): 마감 예정, 판정 대기·지연 and 정산 실패 — one per screen,
 * `?list=` naming it (마감 예정 without it), `?within=` 마감 예정's window and `?filter=` 판정 대기·지연's
 * filter; an unknown value reads as its default. Access is checked in the admin layout; the API
 * checks it on every call.
 */
export default async function AdminOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: Param; within?: Param; filter?: Param }>;
}) {
  const params = await searchParams;
  return <AdminOperations view={adminOperationsViewOf(params)} />;
}
