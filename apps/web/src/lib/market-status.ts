import { type MarketStatus } from '@buddha/shared';
import { copy } from '@/copy';
import { MARKET_STATUS_LABEL } from './market-admin';

/**
 * A market as a user-facing status label reads it: its status and the API's `judgementDelayed`
 * (`Market`, `MarketSummary`, `PostMarket`), which the server computes at the read
 * (`isJudgementDelayed`, #22, ADR-0098) so a page needs no clock of its own and no time the card
 * does not carry.
 */
export interface LabelledMarket {
  status: MarketStatus;
  judgementDelayed: boolean;
}

/**
 * Whether a market's status reads '판정 지연' rather than '거래 마감' (ADR-0093 decision 1 #173
 * item 11: 예정 판정 시각이 지나면 운영자 기록이 없어도 '판정 지연'으로 보인다; #22, ADR-0098): a
 * CLOSED market whose scheduled judgement has passed. A display, not a status — no list filters by
 * it (ADR-0095 8-6). The status is checked here as well as on the server: a `market:status` moves
 * a cached row's status and carries no flag (`applyStatus`), so a flag read while the market was
 * CLOSED must not label it once it is 잠정 결과. PROVISIONAL's late review is #175's.
 */
export function readsJudgementDelayed(market: LabelledMarket): boolean {
  return market.status === 'closed' && market.judgementDelayed;
}

/**
 * The status badge's words on a user's screen (the detail header, the cards of every list, the
 * search picker, the write screen, MY 보유 계약, and a post's or a comment's market — the community
 * cards, the post page, the 댓글 tab): the status label (`MARKET_STATUS_LABEL`), or
 * '판정 지연' in place of '거래 마감' (`readsJudgementDelayed`). The colour stays the status's
 * (`MARKET_STATUS_PALETTE`): CLOSED already waits for the admin. Admin screens keep the status
 * itself, and the admin detail notes the delay beside it.
 */
export function marketStatusLabel(market: LabelledMarket): string {
  return readsJudgementDelayed(market)
    ? copy.marketStatusJudgementDelayed
    : MARKET_STATUS_LABEL[market.status];
}
