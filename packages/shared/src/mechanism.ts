import type { MarketMechanismKind, Outcome } from './enums.js';
import {
  type LmsrState,
  type Quote,
  priceOf,
  probabilityBp,
  quoteBuy,
  quoteSell,
  sharesForSpend,
} from './lmsr.js';

/**
 * PLAN 16: the pricing engine sits behind one interface so a CLOB can replace the AMM
 * without touching the trade transaction. The API picks it with `mechanismFor(market.mechanism)`.
 *
 * The state type is LMSR's for now; a second mechanism widens it into a union.
 */
export interface MarketMechanism {
  quoteBuy(state: LmsrState, outcome: Outcome, shares: number): Quote;
  quoteSell(state: LmsrState, outcome: Outcome, shares: number): Quote;
  sharesForSpend(state: LmsrState, outcome: Outcome, spendP: bigint): number;
  priceOf(state: LmsrState): number;
  probabilityBp(state: LmsrState): number;
}

export const lmsrMechanism: MarketMechanism = {
  quoteBuy,
  quoteSell,
  sharesForSpend,
  priceOf,
  probabilityBp,
};

/** 'clob' throws: the schema is CLOB-ready but no market is ever created with it (M3). */
export function mechanismFor(kind: MarketMechanismKind): MarketMechanism {
  switch (kind) {
    case 'lmsr':
      return lmsrMechanism;
    case 'clob':
      throw new Error('market mechanism "clob" is not implemented');
  }
}
