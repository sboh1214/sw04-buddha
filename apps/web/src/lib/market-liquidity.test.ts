import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { MARKET_LIQUIDITY_DEFAULT_SETTINGS } from '@buddha/shared';
import { ApiError, type ReleaseSetting } from './api';
import {
  canEditLiquidity,
  liquidityDraft,
  liquidityFailure,
  liquidityTexts,
  liquidityInitialForm,
  liquidityVersionChanged,
} from './market-liquidity';

const settings = {
  budgetCoin: '10000',
  maxLossCoin: '5000',
  b: 100,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
const reason = '첫 검수에 사용할 예산과 호가 범위입니다.';
const refusal = (path: string[], message: string) =>
  new ApiError(400, {
    code: 'VALIDATION_ERROR',
    message: 'Invalid request',
    details: [{ path, message }],
  });

describe('관리자 유동성 설정', () => {
  it('prefills only explicit valid values, keeps gaps blank and saved market values first', () => {
    const rows: ReleaseSetting[] = Object.values(MARKET_LIQUIDITY_DEFAULT_SETTINGS).map(
      (definition) => ({
        key: definition.key,
        label: definition.label,
        unit: definition.unit,
        description: definition.description,
        valueSchema: {},
        status: 'undecided',
        value: null,
        updatedAt: null,
        updatedBy: null,
      }),
    );
    const defaults = rows.map((row) =>
      row.key === MARKET_LIQUIDITY_DEFAULT_SETTINGS.budgetCoin.key
        ? { ...row, status: 'test' as const, value: '999999999999999' }
        : row.key === MARKET_LIQUIDITY_DEFAULT_SETTINGS.b.key
          ? { ...row, status: 'proposal' as const, value: 1e-100 }
          : row,
    );
    expect(liquidityInitialForm(null, defaults)).toEqual({
      text: { ...liquidityTexts(null), budgetCoin: '999999999999999', b: '1e-100' },
      sources: { budgetCoin: 'test', b: 'proposal' },
    });
    expect(liquidityDraft(liquidityInitialForm(null, defaults).text, reason, null).ready).toBe(
      false,
    );
    expect(liquidityInitialForm(settings, defaults)).toEqual({
      text: liquidityTexts(settings),
      sources: {},
    });
    expect(
      liquidityInitialForm(
        null,
        defaults.map((row) => ({ ...row, value: 0 })),
      ),
    ).toEqual({ text: liquidityTexts(null), sources: {} });
    const contradictory = { ...liquidityTexts(settings), maxLossCoin: '10001' };
    expect(liquidityDraft(contradictory, reason, null).errors.maxLossCoin).toBe(
      copy.errMarketLiquidityMaxLoss,
    );
  });

  it('only edits drafts, and never retargets an open form to a new version or status', () => {
    expect(canEditLiquidity('draft')).toBe(true);
    for (const status of [
      'review',
      'scheduled',
      'open',
      'paused',
      'closed',
      'settled',
      'cancelled',
    ] as const) {
      expect(canEditLiquidity(status)).toBe(false);
      expect(liquidityVersionChanged(status, 1, 1)).toBe(true);
    }
    expect(liquidityVersionChanged('draft', null, null)).toBe(false);
    expect(liquidityVersionChanged('draft', 1, null)).toBe(true);
    expect(liquidityVersionChanged('draft', 2, 1)).toBe(true);
    expect(liquidityVersionChanged('draft', 1, 1)).toBe(false);
  });

  it('requires explicit values and a reason without silently inventing launch settings', () => {
    const blank = liquidityTexts(null);
    expect(Object.values(blank)).toEqual(['', '', '', '', '', '']);
    expect(liquidityDraft(blank, '', null)).toMatchObject({
      ready: false,
      settings: null,
      errors: {},
    });
    expect(liquidityDraft(liquidityTexts(settings), reason, null)).toMatchObject({
      ready: true,
      settings,
      reason,
    });
    expect(liquidityDraft(liquidityTexts(settings), ' ', null).ready).toBe(false);
    expect(liquidityDraft(liquidityTexts(settings), reason, settings)).toMatchObject({
      ready: false,
      unchanged: true,
    });
  });

  it('preserves exact Coin integers and rejects a loss limit above the budget', () => {
    const large = { ...settings, budgetCoin: '1000000000000000', maxLossCoin: '999999999999999' };
    const draft = liquidityDraft(liquidityTexts(large), reason, null);
    expect(draft).toMatchObject({ ready: true, settings: large });
    expect(draft.settings?.budgetCoin).toBe('1000000000000000');
    expect(
      liquidityDraft({ ...liquidityTexts(settings), maxLossCoin: '10001' }, reason, null),
    ).toMatchObject({
      ready: false,
      settings: null,
      errors: { maxLossCoin: copy.errMarketLiquidityMaxLoss },
    });
    for (const budgetCoin of [
      '0',
      '-1',
      '1.5',
      '1e3',
      'Infinity',
      '1000000000000001',
      '9007199254740993',
    ]) {
      expect(liquidityDraft({ ...liquidityTexts(settings), budgetCoin }, reason, null).ready).toBe(
        false,
      );
    }
  });

  it('uses decimal b and whole quote counts/ticks, retaining zero safety ticks', () => {
    expect(
      liquidityDraft({ ...liquidityTexts(settings), b: '0.5', safetyTicks: '0' }, reason, null),
    ).toMatchObject({ ready: true, settings: { b: 0.5, safetyTicks: 0 } });
    for (const [field, value] of [
      ['b', '0'],
      ['b', 'Infinity'],
      ['levels', '1.5'],
      ['quantity', '0'],
      ['safetyTicks', '-1'],
    ] as const) {
      expect(
        liquidityDraft({ ...liquidityTexts(settings), [field]: value }, reason, null).ready,
      ).toBe(false);
    }
  });

  it('round-trips saved exponent-form b when editing another field, within the shared number domain', () => {
    for (const b of [1e-8, 1e21, 1e-300, 1e300]) {
      const current = { ...settings, b };
      const text = { ...liquidityTexts(current), maxLossCoin: '4000' };
      expect(liquidityDraft(text, reason, current), String(b)).toMatchObject({
        ready: true,
        settings: { ...current, maxLossCoin: '4000' },
      });
    }
    for (const b of ['1e309', '1e-324', '1e-320', '1e', 'Infinity']) {
      expect(liquidityDraft({ ...liquidityTexts(settings), b }, reason, null).ready, b).toBe(false);
    }
  });

  it('shows nested field failures, refreshes a stale version, and handles account changes', () => {
    expect(liquidityFailure(refusal(['settings', 'maxLossCoin'], 'greater than budget'))).toEqual({
      kind: 'field',
      field: 'maxLossCoin',
      message: copy.errMarketLiquidityMaxLoss,
      refresh: false,
    });
    expect(liquidityFailure(refusal(['baseVersion'], 'stale'))).toEqual({
      kind: 'alert',
      message: copy.marketLiquidityStale,
      refresh: true,
    });
    expect(liquidityFailure(refusal(['status'], 'review'))).toEqual({
      kind: 'alert',
      message: copy.errMarketStatus,
      refresh: true,
    });
    expect(
      liquidityFailure(
        new ApiError(403, {
          code: 'FORBIDDEN',
          message: 'Mismatch',
          details: [{ path: ['expectedAccountId'], message: 'mismatch' }],
        }),
      ),
    ).toEqual({ kind: 'toast', message: copy.sessionChanged });
    expect(liquidityFailure(new TypeError('Failed to fetch')).kind).toBe('alert');
  });
});
