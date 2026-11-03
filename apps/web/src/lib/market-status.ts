import { type MarketStatus } from '@buddha/shared';
import { copy } from '@/copy';
import { MARKET_STATUS_LABEL } from './market-admin';

/**
 * A market as a user-facing status label reads it: its status and the API's two display flags
 * (`Market`, `MarketSummary`, `PostMarket`), which the server computes at the read so a page needs
 * no clock of its own and no time the card does not carry — `judgementDelayed`
 * (`isJudgementDelayed`, #22, ADR-0098, ADR-0104) and `disputeUnderReview`
 * (`isDisputeUnderReview`, #175, ADR-0104).
 */
export interface LabelledMarket {
  status: MarketStatus;
  judgementDelayed: boolean;
  disputeUnderReview: boolean;
}

/**
 * Whether a market's status reads '판정 지연' (ADR-0093 decision 1 #173 items 11·12; #22,
 * ADR-0098; #175, ADR-0104): a CLOSED market whose scheduled judgement has passed (예정 판정 시각이
 * 지나면 운영자 기록이 없어도 '판정 지연'으로 보인다), and a PROVISIONAL one a 판정 이의 or a correction
 * waiting for its approval (#176, ADR-0105, decision 3 '#176 정정 대기') still holds once its 이의
 * 기한 has passed (owner answer 2026-11-03). A display, not a status — no list filters by
 * it (ADR-0095 8-6). The status is checked here as well as on the server: a `market:status` moves
 * a cached row's status and resets the flags (`applyStatus`), and a flag read for one status must
 * never label another — no other status reads delayed, whatever a cached row still holds.
 */
export function readsJudgementDelayed(market: LabelledMarket): boolean {
  return (market.status === 'closed' || market.status === 'provisional') && market.judgementDelayed;
}

/**
 * Whether a market's status reads '이의 검토 중' (#173 item 12, #175, ADR-0104): a PROVISIONAL market
 * a 판정 이의 of its current judgement version holds (pending, or accepted and waiting for its
 * correction) — before its 이의 기한; past it the same market reads '판정 지연'
 * (`readsJudgementDelayed`, which comes first). A correction waiting with no dispute holding the
 * market is not under review: '잠정 결과' before the deadline (#176, ADR-0105). PROVISIONAL only,
 * whatever a cached row holds.
 */
export function readsDisputeUnderReview(market: LabelledMarket): boolean {
  return market.status === 'provisional' && market.disputeUnderReview;
}

/**
 * The status badge's words on a user's screen (the detail header, the cards of every list, the
 * search picker, the write screen, MY 보유 계약, and a post's or a comment's market — the community
 * cards, the post page, the 댓글 tab): the status label (`MARKET_STATUS_LABEL`), or a display in
 * its place — '판정 지연' for 거래 마감 or 잠정 결과 (`readsJudgementDelayed`), '이의 검토 중' for 잠정
 * 결과 (`readsDisputeUnderReview`). The delay comes first, as on CLOSED (ADR-0104: the delay label
 * replaces the status label). The colour stays the status's (`MARKET_STATUS_PALETTE`): CLOSED and
 * PROVISIONAL already wait for the admin. Admin screens keep the status itself, and the admin
 * detail notes the delay beside it.
 */
export function marketStatusLabel(market: LabelledMarket): string {
  if (readsJudgementDelayed(market)) return copy.marketStatusJudgementDelayed;
  if (readsDisputeUnderReview(market)) return copy.marketStatusDisputeUnderReview;
  return MARKET_STATUS_LABEL[market.status];
}
