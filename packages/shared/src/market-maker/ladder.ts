import { yesUnitCostCoin } from '../lmsr.js';
import { type ContractTerms, assertContractTerms } from './terms.js';
import { assertWhole } from './validate.js';

/**
 * The market maker's quote ladder (#127): what the bot is willing to pay, contract by contract,
 * along the LMSR curve (N01 §6). The bot posts buy orders only (ADR-0058 결정 1의 6):
 *
 * - YES bids lower the YES price: the k-th YES the bot buys moves d to d − k and costs
 *   Y(d − k) on the curve.
 * - NO bids raise it: the k-th NO costs P − Y(d + k − 1). A NO bid at x is a YES offer at P − x
 *   to a YES buyer through the opposite-outcome match (D17), so it is the plan's "매도는 위로" seen
 *   from the YES side. By the curve's symmetry it is the YES ladder of −d, and is computed so.
 *
 * Each contract's cost is rounded down to the tick, then lowered by the safety ticks
 * (ADR-0058 결정 1의 3), so the bot never pays more than the curve for any prefix of a ladder,
 * however much of it fills (N01 §6). Contracts that land on one price form one level. A ladder
 * ends at the first contract priced outside the range (결정 1의 5), at `levels` prices (호가
 * 단계) or at `quantity` contracts (기본 물량, 결정 1의 4), whichever comes first.
 *
 * Nothing here follows the last trade (N01 §11): the input is the bot's d, b and the settings.
 * Risk limits — the utilization stages, L, the Coin to lock — trim the ladder in #128.
 */

export interface LadderSettings {
  /** The liquidity b, in contracts. */
  readonly b: number;
  /** 안전 간격: whole ticks every price is lowered by after rounding. */
  readonly safetyTicks: number;
  /** 호가 단계: the most distinct prices one direction posts. */
  readonly levels: number;
  /** 기본 물량: the most contracts one direction posts. */
  readonly quantity: number;
}

export interface QuoteLevel {
  /** The price, in Coin, of the contract the bot buys. */
  readonly priceCoin: number;
  readonly qty: number;
}

export interface QuoteLadder {
  /** The bot buys YES (the YES price falls), best (highest) price first. */
  readonly yesBids: readonly QuoteLevel[];
  /** The bot buys NO (the YES price rises), best (highest) price first. */
  readonly noBids: readonly QuoteLevel[];
}

/**
 * A unit's cost carries at most about 5e-16 of the payout in double error. A price is rounded
 * down from the cost less this share of the payout (2000 times that), so a cost a hair under a
 * tick is never rounded up to it. With the payout at most 1e9 Coin (`assertContractTerms`) the
 * margin is under a thousandth of a Coin: a price can be one tick lower than exact rounding
 * would give, only when the cost is that close above a tick, and never higher.
 */
const ROUNDING_MARGIN = 1e-12;

/**
 * RangeError unless b is positive with 1/b finite and the other settings are whole numbers. The
 * cost function also refuses a b whose product with the payout overflows.
 */
export function assertLadderSettings(settings: LadderSettings): void {
  const { b } = settings;
  if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || !Number.isFinite(1 / b)) {
    throw new RangeError(`b must be a positive number with a finite 1/b, got ${String(b)}`);
  }
  assertWhole('safetyTicks', settings.safetyTicks, 0);
  assertWhole('levels', settings.levels, 1);
  assertWhole('quantity', settings.quantity, 1);
}

/**
 * The price the bot bids for the k-th YES it would buy from d (k ≥ 1): Y(d − k) rounded down
 * to the tick, less the safety ticks. Not range-checked; `quoteLadder` stops outside the range.
 */
export function yesBidPriceCoin(
  d: number,
  k: number,
  settings: LadderSettings,
  terms: ContractTerms,
): number {
  const cost = yesUnitCostCoin(d - k, settings.b, terms.payoutCoin);
  const ticks = Math.floor((cost - ROUNDING_MARGIN * terms.payoutCoin) / terms.tickCoin);
  return (ticks - settings.safetyTicks) * terms.tickCoin;
}

function bidLadder(d: number, settings: LadderSettings, terms: ContractTerms): QuoteLevel[] {
  const levels: { priceCoin: number; qty: number }[] = [];
  for (let k = 1; k <= settings.quantity; k++) {
    const priceCoin = yesBidPriceCoin(d, k, settings, terms);
    // Written so that a NaN price, which no accepted input yields, would also end the ladder.
    if (!(priceCoin >= terms.priceMinCoin && priceCoin <= terms.priceMaxCoin)) break;
    const last = levels.at(-1);
    if (last?.priceCoin === priceCoin) {
      last.qty += 1;
      continue;
    }
    if (levels.length === settings.levels) break;
    levels.push({ priceCoin, qty: 1 });
  }
  return levels;
}

/**
 * The full ladder for the bot's d = qY − qN (held NO − held YES, ADR-0058 결정 1의 7). The
 * same d, settings and terms always give the same ladder. RangeError on a non-finite d or on
 * settings or terms that `assertLadderSettings`/`assertContractTerms` refuse.
 */
export function quoteLadder(
  d: number,
  settings: LadderSettings,
  terms: ContractTerms,
): QuoteLadder {
  if (typeof d !== 'number' || !Number.isFinite(d)) {
    throw new RangeError(`d must be a finite number, got ${String(d)}`);
  }
  assertLadderSettings(settings);
  assertContractTerms(terms);
  return { yesBids: bidLadder(d, settings, terms), noBids: bidLadder(-d, settings, terms) };
}
