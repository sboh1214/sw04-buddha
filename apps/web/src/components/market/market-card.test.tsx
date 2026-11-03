import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type MarketSummary } from '@/lib/api';
import { renderWithQueries } from '@/test/render';
import { MarketCard } from './market-card';

const CLOSED: MarketSummary = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'closed',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: 63,
  volumeCoin: '130000',
  tradeCount: 11,
  traderCount: 5,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  statusEventId: '3',
  createdAt: '2026-08-30T00:00:00.000Z',
};

const draw = (market: MarketSummary) =>
  renderWithQueries(<MarketCard market={market} data-testid="card" />);

/**
 * The card's status badge (ADR-0093 decision 1 #173 item 11; #22, ADR-0098): every list draws a
 * market through this card — home, search, related markets, a theme, 관심 — so a closed market past
 * its scheduled judgement reads '판정 지연' in all of them, from the flag the API computed.
 */
describe('MarketCard status badge', () => {
  it("reads '판정 지연' for a closed market past its scheduled judgement, '거래 마감' before it", () => {
    const delayed = draw({ ...CLOSED, judgementDelayed: true });
    expect(delayed).toContain(copy.marketStatusJudgementDelayed);
    expect(delayed).not.toContain(copy.marketStatusClosed);
    const closed = draw(CLOSED);
    expect(closed).toContain(copy.marketStatusClosed);
    expect(closed).not.toContain(copy.marketStatusJudgementDelayed);
  });
});
