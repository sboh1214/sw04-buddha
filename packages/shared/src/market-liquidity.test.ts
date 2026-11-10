import { describe, expect, it } from 'vitest';
import { MAX_COIN_AMOUNT, ORDER_QTY_MAX } from './constants.js';
import {
  marketLiquiditySettingsInputSchema,
  setMarketLiquidityBodySchema,
} from './market-liquidity.js';

const settings = {
  budgetCoin: '10000',
  maxLossCoin: '5000',
  b: 100,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
describe('explicit market liquidity settings (#72)', () => {
  it('parses money exactly, fractional b, and existing integer boundaries', () => {
    expect(
      marketLiquiditySettingsInputSchema.parse({
        ...settings,
        budgetCoin: String(MAX_COIN_AMOUNT),
        maxLossCoin: String(MAX_COIN_AMOUNT),
        b: 0.25,
        levels: Number.MAX_SAFE_INTEGER,
        quantity: ORDER_QTY_MAX,
        safetyTicks: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ budgetCoin: MAX_COIN_AMOUNT, maxLossCoin: MAX_COIN_AMOUNT, b: 0.25 });
    expect(
      marketLiquiditySettingsInputSchema.parse({ ...settings, safetyTicks: 0 }).safetyTicks,
    ).toBe(0);
  });
  it.each(['0', '-1', String(MAX_COIN_AMOUNT + 1n), '1.5', '1e3'])(
    'rejects invalid budget %s',
    (budgetCoin) => {
      expect(
        marketLiquiditySettingsInputSchema.safeParse({ ...settings, budgetCoin }).success,
      ).toBe(false);
    },
  );
  it('rejects L>A at maxLossCoin and never accepts a JSON money number or missing field', () => {
    const invalid = marketLiquiditySettingsInputSchema.safeParse({
      ...settings,
      maxLossCoin: '10001',
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error.issues[0]?.path).toEqual(['maxLossCoin']);
    expect(
      marketLiquiditySettingsInputSchema.safeParse({ ...settings, budgetCoin: 10000 }).success,
    ).toBe(false);
    const { b: _b, ...missing } = settings;
    expect(marketLiquiditySettingsInputSchema.safeParse(missing).success).toBe(false);
  });
  it.each([0, -1, NaN, Infinity, Number.MIN_VALUE, Number.MAX_VALUE])(
    'rejects unsafe curve b=%s',
    (b) => {
      expect(marketLiquiditySettingsInputSchema.safeParse({ ...settings, b }).success).toBe(false);
    },
  );
  it.each([
    { levels: 0 },
    { levels: 1.5 },
    { levels: Number.MAX_SAFE_INTEGER + 1 },
    { quantity: 0 },
    { quantity: ORDER_QTY_MAX + 1 },
    { quantity: 1.5 },
    { safetyTicks: -1 },
    { safetyTicks: 0.5 },
    { safetyTicks: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid ladder fields %o', (changed) => {
    expect(marketLiquiditySettingsInputSchema.safeParse({ ...settings, ...changed }).success).toBe(
      false,
    );
  });
  it('requires the seen version, reason and account, and rejects extra setting keys', () => {
    const body = {
      settings,
      baseVersion: null,
      reason: ' 명시적인 설정 ',
      expectedAccountId: 'admin',
    };
    expect(setMarketLiquidityBodySchema.parse(body)).toMatchObject({
      baseVersion: null,
      reason: '명시적인 설정',
    });
    const { baseVersion: _base, ...missing } = body;
    expect(setMarketLiquidityBodySchema.safeParse(missing).success).toBe(false);
    expect(setMarketLiquidityBodySchema.safeParse({ ...body, reason: ' ' }).success).toBe(false);
    expect(
      setMarketLiquidityBodySchema.safeParse({
        ...body,
        settings: { ...settings, initialProbability: 0.5 },
      }).success,
    ).toBe(false);
  });
});
