import { describe, expect, it } from 'vitest';
import { MARKET_MECHANISMS } from './enums.js';
import { initState, priceOf, probabilityBp, quoteBuy, quoteSell, sharesForSpend } from './lmsr.js';
import { lmsrMechanism, mechanismFor } from './mechanism.js';

describe('mechanismFor', () => {
  const state = initState(0.5, 1000);

  it("answers the LMSR engine for 'lmsr'", () => {
    const mechanism = mechanismFor('lmsr');
    expect(mechanism).toBe(lmsrMechanism);
    expect(mechanism.quoteBuy(state, 'YES', 10)).toEqual(quoteBuy(state, 'YES', 10));
    expect(mechanism.quoteSell(state, 'NO', 10)).toEqual(quoteSell(state, 'NO', 10));
    expect(mechanism.sharesForSpend(state, 'YES', 1000n)).toBe(sharesForSpend(state, 'YES', 1000n));
    expect(mechanism.priceOf(state)).toBe(priceOf(state));
    expect(mechanism.probabilityBp(state)).toBe(probabilityBp(state));
  });

  it("throws for 'clob': the schema is ready but nothing prices a book yet", () => {
    expect(() => mechanismFor('clob')).toThrow(/not implemented/);
  });

  it('covers every kind the enum lists', () => {
    for (const kind of MARKET_MECHANISMS) {
      const attempt = () => mechanismFor(kind);
      if (kind === 'lmsr') expect(attempt()).toBeDefined();
      else expect(attempt).toThrow();
    }
  });
});
