import { describe, expect, it } from 'vitest';
import { requestMarketMakerControlBodySchema } from './market-maker-controls.js';
const body = {
  expectedAccountId: 'admin',
  baseVersion: 1,
  baseControlGeneration: '1',
  reason: '근거',
  change: { action: 'stop' },
};
describe('private fixed maker controls wire', () => {
  it('requires explicit account, nonempty bounded reason and a fixed operation generation', () => {
    expect(requestMarketMakerControlBodySchema.safeParse(body).success).toBe(true);
    for (const patch of [
      { expectedAccountId: undefined },
      { reason: '' },
      { reason: 'x'.repeat(501) },
      { baseControlGeneration: '0' },
      { baseVersion: 0 },
      { baseControlGeneration: '9223372036854775807' },
    ])
      expect(requestMarketMakerControlBodySchema.safeParse({ ...body, ...patch }).success).toBe(
        false,
      );
  });
  it.each(['', '0', '-1', '1.2', '1e3', 'Infinity', 'x', '1000000000000001'])(
    'rejects malformed Coin %s without throwing',
    (value) => {
      expect(() =>
        requestMarketMakerControlBodySchema.safeParse({
          ...body,
          change: {
            action: 'settings',
            settings: { maxLossCoin: value, levels: 1, quantity: 1, safetyTicks: 0 },
          },
        }),
      ).not.toThrow();
      expect(
        requestMarketMakerControlBodySchema.safeParse({
          ...body,
          change: {
            action: 'settings',
            settings: { maxLossCoin: value, levels: 1, quantity: 1, safetyTicks: 0 },
          },
        }).success,
      ).toBe(false);
    },
  );
  it.each(['', '0', '-1', '1.2', 'x', '999999999999999999999999'])(
    'rejects malformed generation %s without throwing',
    (baseControlGeneration) => {
      expect(() =>
        requestMarketMakerControlBodySchema.safeParse({ ...body, baseControlGeneration }),
      ).not.toThrow();
      expect(
        requestMarketMakerControlBodySchema.safeParse({ ...body, baseControlGeneration }).success,
      ).toBe(false);
    },
  );
  it('rejects hidden fields, self-selected amounts on stop and missing demand evidence', () => {
    for (const change of [
      { action: 'stop', additionalCoin: '10' },
      { action: 'resume', b: 100 },
      { action: 'increase', additionalCoin: '10' },
      {
        action: 'settings',
        settings: { maxLossCoin: '100', levels: 1, quantity: 1, safetyTicks: 0, b: 123 },
      },
    ])
      expect(requestMarketMakerControlBodySchema.safeParse({ ...body, change }).success).toBe(
        false,
      );
  });
});
