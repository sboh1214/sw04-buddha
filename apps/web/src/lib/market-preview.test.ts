import { describe, expect, it } from 'vitest';
import { type Category, type CreateMarketFields, type MarketSummary } from './api';
import { toPreviewMarket } from './market-preview';

const categories: Category[] = [
  { id: 1, slug: 'weather', nameKo: '날씨', sortOrder: 1, parentId: null },
];

const body: CreateMarketFields = {
  title: '첫눈이 올까?',
  description: null,
  rules: '기상청 발표 기준',
  resolutionSource: null,
  imageUrl: null,
  categoryId: 1,
  closeAt: '2026-12-01T00:00:00.000Z',
};

/** An OPEN market that has traded. */
const traded: MarketSummary = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'first-snow',
  title: '첫눈이 올까?',
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'open',
  lastPrice: 70,
  volumeCoin: '1250000',
  tradeCount: 42,
  traderCount: 11,
  closeAt: '2026-12-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-08-31T00:00:00.000Z',
  resolvedResult: null,
  statusEventId: '42',
};

describe('toPreviewMarket', () => {
  it('previews an already-traded market at the price it TRADES at', () => {
    // This same component draws 시장 만들기 and the detail screen's 수정 card, and its
    // placeholders were written for the first: on a traded market they would preview 체결 없음
    // and '참여자 0' beside a public card showing 70% and its 11 participants.
    const preview = toPreviewMarket(body, categories, traded);
    expect(preview.lastPrice).toBe(70);
    expect(preview.volumeCoin).toBe('1250000');
    expect(preview.tradeCount).toBe(42);
    expect(preview.traderCount).toBe(11);
    expect(preview.openAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('still shows the EDITED fields over that history', () => {
    // The history is the market's; everything the form can express is the form's, or the preview
    // would stop tracking what is being typed — which is the whole point of it.
    const preview = toPreviewMarket({ ...body, title: '눈이 올까?' }, categories, traded);
    expect(preview.title).toBe('눈이 올까?');
    expect(preview.lastPrice).toBe(70);
  });

  it('keeps the placeholders for a DRAFT, which has no history to show', () => {
    // A draft has never traded and never reaches a visitor's grid, so every placeholder is true
    // for it: no fill yet, so no price — the card reads 체결 없음 (N02 §5).
    const preview = toPreviewMarket(body, categories, { ...traded, status: 'draft' });
    expect(preview.lastPrice).toBeNull();
    expect(preview.tradeCount).toBe(0);
    // The card's footer then reads '참여자 0' — a 0 is shown, not hidden (ADR-0061, ADR-0062).
    expect(preview.traderCount).toBe(0);
    expect(preview.volumeCoin).toBe('0');
    expect(preview.openAt).toBeNull();
  });

  it('keeps them for a market in review too: like a draft, no visitor sees it (#174)', () => {
    // Its 검수 중 badge must not reach a card meant as the one visitors see.
    const preview = toPreviewMarket(body, categories, {
      ...traded,
      status: 'review',
      openAt: null,
    });
    expect(preview.status).toBe('open');
    expect(preview.lastPrice).toBeNull();
    expect(preview.traderCount).toBe(0);
  });

  it('previews a scheduled market as visitors see it: its 개장 예정 badge, no fill yet', () => {
    const scheduled = {
      ...traded,
      status: 'scheduled' as const,
      lastPrice: null,
      traderCount: 0,
      openAt: null,
    };
    const preview = toPreviewMarket(body, categories, scheduled);
    expect(preview.status).toBe('scheduled');
    expect(preview.lastPrice).toBeNull();
    expect(preview.traderCount).toBe(0);
  });

  it('takes the history of every public market, a paused or cancelled one included', () => {
    for (const status of ['paused', 'closed', 'provisional', 'settling', 'cancelled'] as const) {
      const preview = toPreviewMarket(body, categories, { ...traded, status });
      expect(preview.status, status).toBe(status);
      expect(preview.lastPrice, status).toBe(70);
    }
  });

  it('carries no status ordering key, even over a base that has one', () => {
    // `statusEventId` orders `market:status` events for a live subscriber (A-M3-19); the preview
    // card subscribes to nothing, so the key is dropped rather than copied from the base.
    expect(toPreviewMarket(body, categories, traded).statusEventId).toBeNull();
    expect(toPreviewMarket(body, categories).statusEventId).toBeNull();
  });

  it('keeps them on 시장 만들기, where there is no market at all', () => {
    const preview = toPreviewMarket(body, categories);
    // No initial probability exists to show as a price (#125): the card reads 체결 없음.
    expect(preview.lastPrice).toBeNull();
    expect(preview.status).toBe('open');
    expect(preview.tradeCount).toBe(0);
  });

  it('takes a settled market’s own result rather than inventing an open one', () => {
    // The status placeholder answers 'open' because that is what a draft becomes. A market that
    // has already resolved is not open, and the card renders its badge from this field.
    const preview = toPreviewMarket(body, categories, {
      ...traded,
      status: 'settled',
      resolvedResult: 'YES',
    });
    expect(preview.status).toBe('settled');
    expect(preview.resolvedResult).toBe('YES');
  });
});
