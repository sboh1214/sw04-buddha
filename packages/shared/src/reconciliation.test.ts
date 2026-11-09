import { describe, expect, it } from 'vitest';
import { reconciliationTargetSchema } from './reconciliation.js';

describe('reconciliation target identity', () => {
  it('canonicalizes a market UUID before advisory locks and persistent target keys use it', () => {
    const id = 'ABCDEF01-2345-4678-9ABC-DEF012345678';
    expect(reconciliationTargetSchema.parse({ scope: 'market', marketId: id })).toEqual({
      scope: 'market',
      marketId: id.toLowerCase(),
    });
  });
});
