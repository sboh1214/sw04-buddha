import { describe, expect, it } from 'vitest';
import { type Category, type CreateMarketBody, type MarketSummary } from './api';
import { toPreviewMarket } from './market-preview';

const categories: Category[] = [
  { id: 1, slug: 'weather', nameKo: '날씨', sortOrder: 1, parentId: null },
];

const body: CreateMarketBody = {
  title: '첫눈이 올까?',
  description: null,
  rules: '기상청 발표 기준',
  resolutionSource: null,
  imageUrl: null,
  categoryId: 1,
  closeAt: '2026-12-01T00:00:00.000Z',
  initialProbBp: 5_000,
  liquidityB: 1_000,
};

/** An OPEN market that has traded away from the probability it opened at. */
const traded: MarketSummary = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'first-snow',
  title: '첫눈이 올까?',
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'open',
  lastPrice: 70,
  pYesBp: 7_000,
  volumeP: '1250000',
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
    // THE HAZARD: this same component draws 시장 만들기 and the detail screen's 수정 card, and
    // its placeholders were written for the first. `initialProbBp` is the price the market
    // OPENED at and the API refuses to change it once open — so the card presented to the admin
    // as the real one showed 50% while the public card showed 70%, with 거래량 0 and no
    // participants, and the edit was approved against that.
    const preview = toPreviewMarket(body, categories, traded);
    expect(preview.lastPrice).toBe(70);
    expect(preview.pYesBp).toBe(7_000);
    expect(preview.volumeP).toBe('1250000');
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

  it('keeps the derived placeholders for a DRAFT, which has no history to show', () => {
    // `canEditLiquidity` is the condition, and not by coincidence: it is the same `status ===
    // 'draft'` that freezes the curve. A draft has never traded and never reaches a visitor's
    // grid, so every placeholder is true for it — and the initial probability is genuinely the
    // price it would open at.
    const preview = toPreviewMarket(body, categories, { ...traded, status: 'draft' });
    expect(preview.lastPrice).toBe(50);
    expect(preview.tradeCount).toBe(0);
    expect(preview.volumeP).toBe('0');
    expect(preview.openAt).toBeNull();
  });

  it('carries no status ordering key, even over a base that has one', () => {
    // `statusEventId` orders `market:status` events for a live subscriber (A-M3-19); the preview
    // card subscribes to nothing, so the key is dropped rather than copied from the base.
    expect(toPreviewMarket(body, categories, traded).statusEventId).toBeNull();
    expect(toPreviewMarket(body, categories).statusEventId).toBeNull();
  });

  it('keeps them on 시장 만들기, where there is no market at all', () => {
    const preview = toPreviewMarket(body, categories);
    expect(preview.lastPrice).toBe(50);
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
