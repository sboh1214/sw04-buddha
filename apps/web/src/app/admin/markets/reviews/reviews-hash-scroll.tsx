'use client';

import { useHashScrollOnce } from '@/hooks/use-hash-scroll-once';
import {
  useAdminMarketJudgements,
  useAdminMarketPauseDecisions,
  useAdminMarketReviews,
  useAdminMarketSupplements,
} from '@/hooks/use-admin-markets';

/**
 * Scrolls again to the section the address's hash names — 운영 대기열's '판정 승인 대기로' opens
 * `#market-judgements` (#145, ADR-0163) — once the lists above it and its own have drawn their
 * first read. The browser scrolls to the section at load, while each list is still a skeleton;
 * their rows (or empty sentences) then move it, and a page too short to bring it to the top at
 * load cannot be kept in place by the browser's scroll anchoring. Reads the same queries the lists
 * do (one request each), draws nothing.
 */
export function ReviewsHashScroll() {
  const reviews = useAdminMarketReviews();
  const supplements = useAdminMarketSupplements();
  const pauses = useAdminMarketPauseDecisions();
  const judgements = useAdminMarketJudgements();
  useHashScrollOnce(
    !reviews.isPending && !supplements.isPending && !pauses.isPending && !judgements.isPending,
  );
  return null;
}
