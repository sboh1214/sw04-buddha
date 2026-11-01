import { AdminMarketReviews } from './admin-market-reviews';

/**
 * 검수 대기 (#78, ADR-0099): the markets waiting for another admin's approval or 반려. A static
 * segment beside `[id]`, which Next matches first. Access is checked in the admin layout; the API
 * checks it on every call.
 */
export default function AdminMarketReviewsPage() {
  return <AdminMarketReviews />;
}
