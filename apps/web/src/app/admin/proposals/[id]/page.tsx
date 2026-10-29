import { AdminProposalDetail } from './admin-proposal-detail';

/**
 * 시장 제안 상세 (#77, ADR-0089): the proposal, its record, and the operators' moves. Access is
 * checked in the admin layout; an unknown id is the client's 찾을 수 없습니다 alert (the API answers
 * 404), and a malformed one — not a uuid — the same alert without a request (`proposalIdParam`).
 */
export default async function AdminProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminProposalDetail id={id} />;
}
