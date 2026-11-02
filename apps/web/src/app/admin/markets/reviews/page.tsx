import { Stack } from '@chakra-ui/react';
import { AdminMarketPauseDecisions } from './admin-market-pause-decisions';
import { AdminMarketReviews } from './admin-market-reviews';
import { AdminMarketSupplements } from './admin-market-supplements';

/**
 * 검수 대기 (#78, ADR-0099): the markets waiting for another admin's approval or 반려 — and under
 * them 규칙 보충 대기 (#80, ADR-0101), the supplements of open markets waiting the same way, and 일시
 * 중단 결정 대기 (#114, ADR-0102), the paused markets' 재개·조기 마감 requests. A static segment beside
 * `[id]`, which Next matches first. Access is checked in the admin layout; the API checks it on
 * every call.
 */
export default function AdminMarketReviewsPage() {
  return (
    <Stack gap="10">
      <AdminMarketReviews />
      <AdminMarketSupplements />
      <AdminMarketPauseDecisions />
    </Stack>
  );
}
