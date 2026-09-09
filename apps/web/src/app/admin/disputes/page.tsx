import {
  type AdminDisputeSearchParams,
  adminDisputeFiltersFromSearchParams,
} from '@/lib/admin-disputes';
import { AdminDisputes } from './admin-disputes';

/**
 * PLAN 12 이의 목록: 시장별 그룹, 수용/기각 + 메모. Access is checked in the admin layout. The
 * URL is normalised into the filter set here, once, and handed down as a prop (the public
 * list's `filtersFromSearchParams` precedent): `?marketId=` is how the market detail's 이의
 * row arrives, `?status=` how a bookmark does, and neither may 400 the page when mistyped.
 */
export default async function AdminDisputesPage({
  searchParams,
}: {
  searchParams: Promise<AdminDisputeSearchParams>;
}) {
  const filters = adminDisputeFiltersFromSearchParams(await searchParams);
  return <AdminDisputes filters={filters} />;
}
