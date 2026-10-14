import { AdminMarketDetail } from './admin-market-detail';

/**
 * PLAN 12 시장 상세(관리): transitions, trade stats, event log, fills. Access is checked in the
 * admin layout; an unknown id is the client's 찾을 수 없습니다 alert (the API answers 404),
 * and a malformed one — not a uuid — gets the same alert without a request (`marketIdParam`).
 */
export default async function AdminMarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminMarketDetail id={id} />;
}
