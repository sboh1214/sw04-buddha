import { describe, expect, it } from 'vitest';
import { MAX_COIN_AMOUNT } from './constants.js';
import { decideTreasuryIssueBodySchema, requestTreasuryIssueBodySchema } from './treasury.js';

describe('treasury issue wire input', () => {
  const body = {
    expectedAccountId: 'admin-id',
    reason: 'Initial operating treasury',
    amountCoin: '1',
  };
  it('parses exact positive Coin and accepts the shared maximum', () => {
    expect(requestTreasuryIssueBodySchema.parse(body).amountCoin).toBe(1n);
    expect(
      requestTreasuryIssueBodySchema.parse({ ...body, amountCoin: String(MAX_COIN_AMOUNT) })
        .amountCoin,
    ).toBe(MAX_COIN_AMOUNT);
  });
  it.each(['0', '-1', '1.5', '01', '1e3', String(MAX_COIN_AMOUNT + 1n), '9'.repeat(1000), 1])(
    'refuses invalid or rounded amount %s',
    (amountCoin) => {
      expect(requestTreasuryIssueBodySchema.safeParse({ ...body, amountCoin }).success).toBe(false);
    },
  );
  it('does not allow approval to replace the fixed amount or actor', () => {
    expect(decideTreasuryIssueBodySchema.safeParse(body).success).toBe(false);
    expect(
      requestTreasuryIssueBodySchema.safeParse({ ...body, requestedBy: 'someone-else' }).success,
    ).toBe(false);
  });
  it('requires a pinned account and a nonblank reason', () => {
    expect(
      requestTreasuryIssueBodySchema.safeParse({ ...body, expectedAccountId: undefined }).success,
    ).toBe(false);
    expect(requestTreasuryIssueBodySchema.safeParse({ ...body, reason: '  ' }).success).toBe(false);
  });
});
