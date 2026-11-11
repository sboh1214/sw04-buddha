import { CONTRACT_TERMS } from '../contract.js';
import {
  matchLine,
  matchOrderWithBotRisk,
  type BotMatchRiskPolicy,
  type BookOrder,
  type MatchLineEntry,
  type OrderOwner,
} from '../matching.js';
import type { OrderSide, Outcome } from '../enums.js';
import {
  planIntakeMatch,
  type IntakeMatchPlan,
  type IntakeMatchPreparation,
  type OrderTerms,
} from '../orders.js';
import {
  assertBotBook,
  assertLossLimits,
  checkBotOrder,
  maxBotFillQtyFromReservedPnl,
  orderPnlDelta,
  RESULT_SCENARIOS,
  resultPnl,
  type BotBook,
  type BotOrder,
  type BotOrderCheck,
  type ByResult,
  type LossLimits,
} from './risk.js';

/** A single market's snapshot; no stage settings or lifecycle configuration are needed. */
export interface BotMatchSnapshot {
  readonly book: BotBook;
  readonly limits: LossLimits;
}

/** Internal only: cancel this remainder after its optional fill, in matcher encounter order. */
export interface BotRiskCancellation {
  readonly orderId: string;
  readonly ownerId: string;
  readonly qty: number;
}

export type RiskIntakeMatchPlan =
  | {
      kind: 'planned';
      plan: IntakeMatchPlan;
      botCancellations: readonly BotRiskCancellation[];
      projectedBook: BotBook;
    }
  | ({ kind: 'bot_risk_rejected'; reason: 'loss_limit' } & IntakeMatchPreparation)
  | ({
      kind: 'bot_asset_rejected';
      reason: 'insufficient_coin' | 'insufficient_contracts';
    } & IntakeMatchPreparation);

class BotAdmissionRefusal extends Error {
  readonly reason: Exclude<BotOrderCheck, 'ok'>;
  constructor(reason: Exclude<BotOrderCheck, 'ok'>) {
    super(reason);
    this.reason = reason;
  }
}

const asBotOrder = (order: BookOrder): BotOrder => ({
  outcome: order.outcome,
  side: order.side,
  priceCoin: order.priceCoin,
  qty: order.remainingQty,
});

const adverse = (order: BotOrder): ByResult<bigint> => {
  const delta = orderPnlDelta(order, CONTRACT_TERMS);
  return {
    YES: delta.YES < 0n ? delta.YES : 0n,
    NO: delta.NO < 0n ? delta.NO : 0n,
    VOID: delta.VOID < 0n ? delta.VOID : 0n,
  };
};

/** An independent projection. Reservation sums keep resting-order caps linear in book size. */
class BotProjection implements BotMatchRiskPolicy {
  book: BotBook;
  readonly cancellations: BotRiskCancellation[] = [];
  readonly orders = new Map<string, BotOrder>();
  private readonly reserved = { YES: 0n, NO: 0n, VOID: 0n };
  private readonly snapshot: BotMatchSnapshot;

  constructor(book: readonly BookOrder[], snapshot: BotMatchSnapshot) {
    assertBotBook(snapshot.book);
    assertLossLimits(snapshot.limits);
    this.snapshot = snapshot;
    this.book = { ...snapshot.book };
    for (const order of book) {
      if (order.owner.human) continue;
      if (this.orders.has(order.id)) throw new RangeError('Duplicate bot order id');
      const botOrder = asBotOrder(order);
      this.orders.set(order.id, botOrder);
      this.addReservation(botOrder, 1n);
    }
  }

  private addReservation(order: BotOrder, sign: bigint): void {
    const amount = adverse(order);
    for (const result of RESULT_SCENARIOS) this.reserved[result] += sign * amount[result];
  }

  private requireOrder(id: string): BotOrder {
    const order = this.orders.get(id);
    if (!order) throw new RangeError('Bot order is no longer live in this projection');
    return order;
  }

  maxRestingQty(order: BookOrder): number {
    const current = this.requireOrder(order.id);
    const pnl = resultPnl(this.book, CONTRACT_TERMS);
    const own = adverse(current);
    const base = {
      YES: pnl.YES + this.reserved.YES - own.YES,
      NO: pnl.NO + this.reserved.NO - own.NO,
      VOID: pnl.VOID + this.reserved.VOID - own.VOID,
    };
    return maxBotFillQtyFromReservedPnl(
      base,
      current,
      current.qty,
      this.snapshot.limits,
      CONTRACT_TERMS,
    );
  }

  check(order: BotOrder): void {
    const result = checkBotOrder(
      this.book,
      [...this.orders.values()],
      order,
      this.snapshot.limits,
      CONTRACT_TERMS,
    );
    if (result !== 'ok') throw new BotAdmissionRefusal(result);
  }

  checkBudget(budget: bigint): void {
    if (typeof budget !== 'bigint' || budget < 1n) throw new RangeError('Invalid bot budget');
    const locked = [...this.orders.values()].reduce(
      (sum, order) =>
        sum + (order.side === 'buy' ? BigInt(order.priceCoin) * BigInt(order.qty) : 0n),
      0n,
    );
    if (budget > this.book.coin - locked) throw new BotAdmissionRefusal('insufficient_coin');
  }

  private apply(order: BotOrder): void {
    const direction = order.side === 'buy' ? 1 : -1;
    this.book = {
      ...this.book,
      coin: this.book.coin - BigInt(direction) * BigInt(order.priceCoin) * BigInt(order.qty),
      yesQty: this.book.yesQty + (order.outcome === 'YES' ? direction * order.qty : 0),
      noQty: this.book.noQty + (order.outcome === 'NO' ? direction * order.qty : 0),
    };
    assertBotBook(this.book);
  }

  onFill: BotMatchRiskPolicy['onFill'] = (incoming, resting, fill) => {
    if (!resting.owner.human) {
      const current = this.requireOrder(resting.id);
      this.addReservation(current, -1n);
      this.apply({ ...current, priceCoin: fill.restingPriceCoin, qty: fill.qty });
      const remaining = current.qty - fill.qty;
      if (remaining === 0) this.orders.delete(resting.id);
      else {
        const next = { ...current, qty: remaining };
        this.orders.set(resting.id, next);
        this.addReservation(next, 1n);
      }
    } else if (incoming.owner !== null && !incoming.owner.human) {
      const taken = {
        outcome: incoming.outcome,
        side: incoming.side,
        priceCoin: fill.priceCoin,
        qty: fill.qty,
      };
      // Quantity admission already reserved the whole request at its protected limit. Budget
      // orders have no inferred quantity: every actual fill is checked, or the entire plan fails.
      if (incoming.budgetCoin !== null) this.check(taken);
      this.apply(taken);
    }
  };

  onCancel(order: BookOrder, qty: number): void {
    const current = this.requireOrder(order.id);
    if (current.qty !== qty) throw new RangeError('Cancel must remove the entire bot remainder');
    this.addReservation(current, -1n);
    this.orders.delete(order.id);
    this.cancellations.push({ orderId: order.id, ownerId: order.owner.id, qty });
  }
}

/**
 * One public depth direction: consume its entire price/time line using the actual intake's
 * risk policy. A zero allowance virtually releases that reservation before later orders, and
 * fills update holdings at the resting leg's real price. No cancellation is persisted. Each
 * invocation starts fresh: the four book directions are alternative walks, not four concurrent
 * promises of the same funds. No personal assets, price protection or self-trade apply to depth.
 */
export function executableRiskLine(
  book: readonly BookOrder[],
  outcome: Outcome,
  side: OrderSide,
  snapshot: BotMatchSnapshot,
): MatchLineEntry[] {
  const line = matchLine(book, outcome, side);
  if (line.length === 0) return [];
  const quantity = line.reduce((sum, entry) => sum + BigInt(entry.order.remainingQty), 0n);
  if (quantity > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('The book direction quantity passes the safe-integer range');
  const result = matchOrderWithBotRisk(
    book,
    {
      owner: null,
      outcome,
      side,
      timeInForce: 'ioc',
      limitPriceCoin: side === 'buy' ? CONTRACT_TERMS.priceMaxCoin : CONTRACT_TERMS.priceMinCoin,
      qty: Number(quantity),
      budgetCoin: null,
    },
    new BotProjection(book, snapshot),
  );
  const entries = new Map(line.map((entry) => [entry.order.id, entry]));
  return result.fills.map((fill) => {
    const entry = entries.get(fill.restingOrderId)!;
    return { ...entry, order: { ...entry.order, remainingQty: fill.qty } };
  });
}

/**
 * #128's internal intake plan, using the existing matcher. The reference probe owns a clone;
 * only the actual raw-line walk at the final limit produces cancellations. No input is mutated.
 * Incoming bot quantities pass checkBotOrder at the protected limit for the whole quantity.
 * A budget bot reserves its entire budget and checks actual fills, including all older orders;
 * one failed check discards every speculative fill/cancel. Refusals carry no executable plan.
 * DB callers keep asset-rejected rows, but a loss-limit refusal writes no order or assets.
 */
export function planRiskIntakeMatch(
  book: readonly BookOrder[],
  terms: OrderTerms,
  widthTicks: number | null,
  owner: OrderOwner | null,
  snapshot: BotMatchSnapshot,
): RiskIntakeMatchPlan {
  const reference = new BotProjection(book, snapshot);
  const actual = new BotProjection(book, snapshot);
  let prepared: IntakeMatchPreparation | undefined;
  try {
    const plan = planIntakeMatch(book, terms, widthTicks, owner, {
      reference,
      actual,
      beforeMatch(value) {
        prepared = value;
        if (owner === null || owner.human) return;
        const incoming = value.incoming;
        if (incoming.budgetCoin !== null) actual.checkBudget(incoming.budgetCoin);
        else
          actual.check({
            outcome: incoming.outcome,
            side: incoming.side,
            priceCoin: value.protectedLimitPriceCoin,
            qty: incoming.qty,
          });
      },
    });
    return {
      kind: 'planned',
      plan,
      botCancellations: actual.cancellations,
      projectedBook: actual.book,
    };
  } catch (error) {
    if (!(error instanceof BotAdmissionRefusal) || prepared === undefined) throw error;
    return error.reason === 'loss_limit'
      ? { kind: 'bot_risk_rejected', reason: error.reason, ...prepared }
      : { kind: 'bot_asset_rejected', reason: error.reason, ...prepared };
  }
}
