import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket } from '@/lib/api';
import { LIQUIDITY_FIELDS, liquidityTexts } from '@/lib/market-liquidity';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { LiquidityFields, LiquidityPanelBody } from './market-liquidity-panel';

const settings = {
  budgetCoin: '10000',
  maxLossCoin: '5000',
  b: 100,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
const version = {
  ...settings,
  marketId: 'm1',
  version: 1,
  reason: '첫 예산 근거',
  createdAt: '2026-11-10T00:00:00.000Z',
  createdBy: { id: 'a1', nickname: '운영자' },
};
type LiquidityMarket = Pick<AdminMarket, 'status' | 'liquidity'>;
const empty: LiquidityMarket = {
  status: 'draft',
  liquidity: { current: null, openedVersion: null, history: [] },
};
const draw = (market: LiquidityMarket, operatorId: string | null = 'a1') =>
  renderWithQueries(
    <LiquidityPanelBody market={market} operatorId={operatorId ?? undefined} onEdit={() => {}} />,
  );

describe('유동성 설정 관리자 카드', () => {
  it('explains the missing settings and fixed reference without displaying guessed values', () => {
    const html = draw(empty);
    expect(byTestId(html, 'market-liquidity-empty')?.text).toBe(copy.marketLiquidityEmpty);
    expect(byTestId(html, 'market-liquidity-reference')?.text).toBe(copy.marketLiquidityReference);
    expect(testIdsStartingWith(html, 'liquidity-current-')).toEqual([]);
    expect(byTestId(html, 'market-liquidity-edit')?.attributes.disabled).toBeUndefined();
    expect(byTestId(draw(empty, null), 'market-liquidity-edit')?.attributes.disabled).toBe('');
  });

  it('shows every stored version and its reason while locking review and scheduled markets', () => {
    const second = { ...version, version: 2, maxLossCoin: '4000', reason: '한도를 낮춥니다.' };
    for (const status of ['review', 'scheduled'] as const) {
      const html = draw({
        status,
        liquidity: { current: second, openedVersion: null, history: [second, version] },
      });
      expect(byTestId(html, 'market-liquidity-edit')).toBeUndefined();
      expect(byTestId(html, 'market-liquidity-locked')?.text).toBe(copy.marketLiquidityLocked);
      expect(byTestId(html, 'market-liquidity-current-version')?.text).toContain('2');
      expect(byTestId(html, 'market-liquidity-version-1')?.text).toContain(version.reason);
      expect(byTestId(html, 'market-liquidity-version-2')?.text).toContain(second.reason);
      expect(testIdsStartingWith(html, 'liquidity-history-1-')).toHaveLength(6);
      expect(testIdsStartingWith(html, 'liquidity-current-')).toHaveLength(6);
    }
  });

  it('keeps the original opening version visible after opening and formats large Coin exactly', () => {
    const current = { ...version, budgetCoin: '9007199254740993', version: 2 };
    const html = draw({
      status: 'open',
      liquidity: { current, openedVersion: 1, history: [current, version] },
    });
    expect(byTestId(html, 'market-liquidity-edit')).toBeUndefined();
    expect(byTestId(html, 'market-liquidity-opened-version')?.text).toContain('1');
    expect(byTestId(html, 'liquidity-current-budgetCoin')?.text).toContain('9,007,199,254,740,993');
    expect(byTestId(html, 'market-liquidity-locked')?.text).toBe(copy.marketLiquidityOpenedLocked);
  });

  it('keeps a legacy ended market without settings read-only without suggesting a new review', () => {
    const html = draw({ ...empty, status: 'cancelled' });
    expect(byTestId(html, 'market-liquidity-empty')?.text).toBe(copy.marketLiquidityMissing);
    expect(byTestId(html, 'market-liquidity-edit')).toBeUndefined();
    expect(html).not.toContain(copy.marketLiquidityEmpty);
  });

  it('renders the six explicit inputs, guards them together and explains b without a loss guarantee', () => {
    const html = renderWithQueries(
      <LiquidityFields
        text={liquidityTexts(settings)}
        disabled
        onChange={() => {}}
        errorOf={(field) => (field === 'maxLossCoin' ? copy.errMarketLiquidityMaxLoss : null)}
      />,
    );
    for (const field of LIQUIDITY_FIELDS) {
      expect(byTestId(html, `market-liquidity-input-${field}`)?.attributes.disabled).toBe('');
    }
    expect(html).toContain(copy.marketLiquidityBHint);
    expect(byTestId(html, 'market-liquidity-error-maxLossCoin')?.text).toBe(
      copy.errMarketLiquidityMaxLoss,
    );
  });
});
