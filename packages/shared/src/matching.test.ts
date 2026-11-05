import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONTRACT_TERMS, priceImprovementCoin } from './contract.js';
import { ORDER_SIDES, OUTCOMES, TIME_IN_FORCES, type OrderSide, type Outcome } from './enums.js';
import { quoteLadder } from './market-maker/ladder.js';
import {
  type BookOrder,
  type IncomingOrder,
  MATCH_FILL_KINDS,
  MATCH_STOPS,
  type MatchFill,
  type MatchResult,
  type OrderOwner,
  bookAfterMatch,
  fillProcessInput,
  matchLine,
  matchOrder,
  sameSelfTradeGroup,
} from './matching.js';

// The matching rule (#117, ADR-0111): examples per AC and per ADR-0107 항, the N01 §10 scenarios
// matching alone can run, and properties against a naive reference matcher.
const RUNS = { numRuns: 400 };
const PAYOUT = CONTRACT_TERMS.payoutCoin;

/** People (each their own self-trade group) and two non-person accounts (one bundle). */
const A: OrderOwner = { id: 'A', human: true };
const B: OrderOwner = { id: 'B', human: true };
const C: OrderOwner = { id: 'C', human: true };
const M1: OrderOwner = { id: 'M1', human: false };
const M2: OrderOwner = { id: 'M2', human: false };
const OWNERS = [A, B, C, M1, M2];

const resting = (
  id: string,
  owner: OrderOwner,
  outcome: Outcome,
  side: OrderSide,
  priceCoin: number,
  remainingQty: number,
  arrival: number,
): BookOrder => ({ id, owner, outcome, side, priceCoin, remainingQty, arrival });

const order = (
  owner: OrderOwner | null,
  outcome: Outcome,
  side: OrderSide,
  limitPriceCoin: number,
  qty: number,
  timeInForce: 'ioc' | 'gtc' = 'ioc',
): IncomingOrder => ({ owner, outcome, side, limitPriceCoin, qty, timeInForce, budgetCoin: null });

const budgetBuy = (
  owner: OrderOwner | null,
  outcome: Outcome,
  limitPriceCoin: number,
  budgetCoin: bigint,
): IncomingOrder => ({
  owner,
  outcome,
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin,
  qty: null,
  budgetCoin,
});

/** [resting order, kind, qty, price in the incoming contract] per fill. */
const brief = (result: MatchResult) =>
  result.fills.map((fill) => [fill.restingOrderId, fill.kind, fill.qty, fill.priceCoin]);

const otherOutcome = (outcome: Outcome): Outcome => (outcome === 'YES' ? 'NO' : 'YES');

describe('the constants', () => {
  it('pins the fill kinds: a trade and a pair mint, no burn (#177 4항: no cross-sell)', () => {
    expect(MATCH_FILL_KINDS).toEqual(['trade', 'pair_mint']);
  });

  it('pins the stops (#177 7·8항)', () => {
    expect(MATCH_STOPS).toEqual([
      'filled',
      'budget_spent',
      'no_quote',
      'price_limit',
      'self_trade',
    ]);
  });

  it('takes exactly a book and an order: no option widens the limit or skips a check', () => {
    expect(matchOrder.length).toBe(2);
  });
});

describe('price-time priority at the resting price (AC 1, N01 §4)', () => {
  it('fills the better price first, at the resting price, never at the limit', () => {
    const book = [
      resting('s55', B, 'YES', 'sell', 55, 1, 1),
      resting('s52', C, 'YES', 'sell', 52, 1, 2),
    ];
    const result = matchOrder(book, order(A, 'YES', 'buy', 60, 2));
    expect(brief(result)).toEqual([
      ['s52', 'trade', 1, 52],
      ['s55', 'trade', 1, 55],
    ]);
    expect(result).toMatchObject({
      filledQty: 2,
      amountCoin: 107n,
      stop: 'filled',
      remainder: 'none',
      remainingQty: 0,
      unspentCoin: null,
      counterpartyOwnerIds: ['C', 'B'],
    });
  });

  it('fills the earlier arrival first at one price', () => {
    const book = [
      resting('late', B, 'YES', 'sell', 50, 1, 5),
      resting('early', C, 'YES', 'sell', 50, 1, 3),
    ];
    expect(brief(matchOrder(book, order(A, 'YES', 'buy', 50, 1)))).toEqual([
      ['early', 'trade', 1, 50],
    ]);
  });

  it('sweeps the levels in order, each up to its remaining (N01 §8)', () => {
    const book = [
      resting('l50', B, 'YES', 'sell', 50, 2, 1),
      resting('l51', B, 'YES', 'sell', 51, 3, 2),
      resting('l52', C, 'YES', 'sell', 52, 4, 3),
    ];
    const result = matchOrder(book, order(A, 'YES', 'buy', 60, 6));
    expect(brief(result)).toEqual([
      ['l50', 'trade', 2, 50],
      ['l51', 'trade', 3, 51],
      ['l52', 'trade', 1, 52],
    ]);
    expect(result.fills.map((fill) => fill.restingRemainingQty)).toEqual([0, 0, 3]);
    expect(result.counterpartyOwnerIds).toEqual(['B', 'C']);
  });

  it('keeps a partly filled order in its place before a later order at its price', () => {
    let book: BookOrder[] = [resting('first', B, 'YES', 'sell', 50, 5, 1)];
    const first = order(A, 'YES', 'buy', 50, 2);
    book = bookAfterMatch(book, first, matchOrder(book, first));
    expect(book).toEqual([resting('first', B, 'YES', 'sell', 50, 3, 1)]);
    book = [...book, resting('later', C, 'YES', 'sell', 50, 4, 10)];
    expect(brief(matchOrder(book, order(A, 'YES', 'buy', 50, 4)))).toEqual([
      ['first', 'trade', 3, 50],
      ['later', 'trade', 1, 50],
    ]);
  });
});

describe('opposite-outcome buys mint a pair (AC 2, N01 §4, D17)', () => {
  it('NO 40 waiting and YES 65 arriving: YES 60 / NO 40, 5 back, nothing to the operator', () => {
    const book = [resting('no40', B, 'NO', 'buy', 40, 1, 1)];
    const incoming = order(A, 'YES', 'buy', 65, 1);
    const result = matchOrder(book, incoming);
    expect(result.fills).toEqual([
      {
        kind: 'pair_mint',
        restingOrderId: 'no40',
        restingOwnerId: 'B',
        qty: 1,
        priceCoin: 60,
        restingPriceCoin: 40,
        yesPriceCoin: 60,
        amountCoin: 60n,
        restingRemainingQty: 0,
      },
    ]);
    const call = fillProcessInput(incoming, result.fills[0]!);
    expect(call).toEqual({
      process: 'pair_mint',
      input: {
        qty: 1,
        yesPriceCoin: 60,
        yes: { ownerId: 'A', limitPriceCoin: 65 },
        no: { ownerId: 'B', limitPriceCoin: 40 },
      },
    });
    // What #118's applyPairMintFill gives back: the YES buyer's excess limit, none to the NO one;
    // the two prices fund exactly one pair's collateral.
    expect(priceImprovementCoin(65, 60, 1)).toBe(5n);
    expect(priceImprovementCoin(40, 40, 1)).toBe(0n);
    expect(result.fills[0]!.priceCoin + result.fills[0]!.restingPriceCoin).toBe(PAYOUT);
  });

  it('mirrors for a NO buy against a waiting YES buy: one YES price recorded (#177 11항)', () => {
    const book = [resting('yes70', B, 'YES', 'buy', 70, 3, 1)];
    const incoming = order(A, 'NO', 'buy', 35, 2);
    const result = matchOrder(book, incoming);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]).toMatchObject({
      kind: 'pair_mint',
      qty: 2,
      priceCoin: 30,
      restingPriceCoin: 70,
      yesPriceCoin: 70,
      amountCoin: 60n,
      restingRemainingQty: 1,
    });
    expect(fillProcessInput(incoming, result.fills[0]!)).toEqual({
      process: 'pair_mint',
      input: {
        qty: 2,
        yesPriceCoin: 70,
        yes: { ownerId: 'B', limitPriceCoin: 70 },
        no: { ownerId: 'A', limitPriceCoin: 35 },
      },
    });
  });
});

describe('one line of direct sells and opposite buys (AC 3, #177 4항)', () => {
  it('breaks a price tie by original arrival across the two kinds', () => {
    const book = [
      resting('ask58', C, 'YES', 'sell', 58, 1, 2),
      resting('no42', B, 'NO', 'buy', 42, 1, 1),
    ];
    expect(brief(matchOrder(book, order(A, 'YES', 'buy', 60, 2)))).toEqual([
      ['no42', 'pair_mint', 1, 58],
      ['ask58', 'trade', 1, 58],
    ]);
    // Mirrored: the direct sell came first, so neither kind is preferred at a tie.
    const askFirst = [
      resting('no42', B, 'NO', 'buy', 42, 1, 2),
      resting('ask58', C, 'YES', 'sell', 58, 1, 1),
    ];
    expect(brief(matchOrder(askFirst, order(A, 'YES', 'buy', 60, 1)))).toEqual([
      ['ask58', 'trade', 1, 58],
    ]);
    expect(brief(matchOrder(askFirst, order(A, 'YES', 'buy', 60, 2)))).toEqual([
      ['ask58', 'trade', 1, 58],
      ['no42', 'pair_mint', 1, 58],
    ]);
  });

  it('takes a cheaper opposite buy before a dearer direct sell, and the reverse', () => {
    const cheaperMint = [
      resting('ask57', C, 'YES', 'sell', 57, 1, 1),
      resting('no45', B, 'NO', 'buy', 45, 1, 5),
    ];
    expect(brief(matchOrder(cheaperMint, order(A, 'YES', 'buy', 99, 1)))).toEqual([
      ['no45', 'pair_mint', 1, 55],
    ]);
    const cheaperAsk = [
      resting('ask57', C, 'YES', 'sell', 57, 1, 5),
      resting('no40', B, 'NO', 'buy', 40, 1, 1),
    ];
    expect(brief(matchOrder(cheaperAsk, order(A, 'YES', 'buy', 99, 1)))).toEqual([
      ['ask57', 'trade', 1, 57],
    ]);
  });

  it('counts an order once: NO buy 40 × 10 fills 10 of a YES buy 15 at 60 (#179)', () => {
    const book = [resting('no40', B, 'NO', 'buy', 40, 10, 1)];
    const result = matchOrder(book, order(A, 'YES', 'buy', 60, 15));
    expect(result).toMatchObject({
      filledQty: 10,
      amountCoin: 600n,
      stop: 'no_quote',
      remainder: 'cancel',
      remainingQty: 5,
    });
  });

  it('lists only real orders, each once, for depth and the best quote (#177 4항 중복)', () => {
    const book = [
      resting('ask58', C, 'YES', 'sell', 58, 2, 3),
      resting('no42', B, 'NO', 'buy', 42, 4, 1),
      resting('yes30', B, 'YES', 'buy', 30, 7, 2),
    ];
    const yesAsks = matchLine(book, 'YES', 'buy');
    expect(yesAsks.map((entry) => [entry.order.id, entry.kind, entry.priceCoin])).toEqual([
      ['no42', 'pair_mint', 58],
      ['ask58', 'trade', 58],
    ]);
    expect(yesAsks.reduce((sum, entry) => sum + entry.order.remainingQty, 0)).toBe(6);
    // No complement of the YES bid 30 is NO supply: only the real YES buy, as a NO ask at 70.
    expect(matchLine(book, 'NO', 'buy').map((entry) => [entry.order.id, entry.priceCoin])).toEqual([
      ['yes30', 70],
    ]);
    expect(matchLine([], 'YES', 'buy')).toEqual([]);
    // The same pair with the direct sell arriving first lists it first.
    const askFirst = [
      resting('no42', B, 'NO', 'buy', 42, 4, 2),
      resting('ask58', C, 'YES', 'sell', 58, 2, 1),
    ];
    expect(matchLine(askFirst, 'YES', 'buy').map((entry) => [entry.order.id, entry.kind])).toEqual([
      ['ask58', 'trade'],
      ['no42', 'pair_mint'],
    ]);
  });
});

describe('sells meet same-contract buys only (AC 4, #177 4항: no cross-sell)', () => {
  it('fills the best bids first at their prices', () => {
    const book = [
      resting('b45late', B, 'YES', 'buy', 45, 2, 2),
      resting('b50', C, 'YES', 'buy', 50, 1, 3),
      resting('b45early', C, 'YES', 'buy', 45, 5, 1),
    ];
    const result = matchOrder(book, order(A, 'YES', 'sell', 40, 4));
    expect(brief(result)).toEqual([
      ['b50', 'trade', 1, 50],
      ['b45early', 'trade', 3, 45],
    ]);
    expect(result.amountCoin).toBe(185n);
  });

  it('never meets a sell or an opposite buy', () => {
    const book = [
      resting('noSell', B, 'NO', 'sell', 30, 1, 1),
      resting('noBuy', B, 'NO', 'buy', 60, 1, 2),
      resting('yesSell', C, 'YES', 'sell', 40, 1, 3),
    ];
    const result = matchOrder(book, order(A, 'YES', 'sell', 1, 1));
    expect(result).toMatchObject({ fills: [], stop: 'no_quote', remainder: 'cancel' });
    expect(matchLine(book, 'YES', 'sell')).toEqual([]);
    expect(matchLine(book, 'NO', 'sell').map((entry) => entry.order.id)).toEqual(['noBuy']);
  });
});

describe('the holder may be either side (AC 5, ADR-0058 결과 4)', () => {
  it('a buy meeting a resting sell: the incoming owner buys at the sell price', () => {
    const book = [resting('ask40', B, 'YES', 'sell', 40, 3, 1)];
    const incoming = order(A, 'YES', 'buy', 50, 2);
    const result = matchOrder(book, incoming);
    expect(fillProcessInput(incoming, result.fills[0]!)).toEqual({
      process: 'trade',
      input: {
        outcome: 'YES',
        qty: 2,
        priceCoin: 40,
        buyer: { ownerId: 'A', limitPriceCoin: 50 },
        sellerId: 'B',
      },
    });
  });

  it('a sell meeting a resting buy: the resting owner buys at its own price', () => {
    const book = [resting('bid45', B, 'NO', 'buy', 45, 3, 1)];
    const incoming = order(A, 'NO', 'sell', 40, 1);
    const result = matchOrder(book, incoming);
    expect(result.fills[0]).toMatchObject({ priceCoin: 45, yesPriceCoin: 55, amountCoin: 45n });
    expect(fillProcessInput(incoming, result.fills[0]!)).toEqual({
      process: 'trade',
      input: {
        outcome: 'NO',
        qty: 1,
        priceCoin: 45,
        buyer: { ownerId: 'B', limitPriceCoin: 45 },
        sellerId: 'A',
      },
    });
  });
});

describe('the limit (AC 6, #177 2항)', () => {
  it('fills nothing beyond a buy limit', () => {
    const book = [resting('ask51', B, 'YES', 'sell', 51, 1, 1)];
    expect(matchOrder(book, order(A, 'YES', 'buy', 50, 1))).toMatchObject({
      fills: [],
      stop: 'price_limit',
      remainder: 'cancel',
      remainingQty: 1,
    });
  });

  it('fills nothing below a sell limit', () => {
    const book = [resting('bid49', B, 'YES', 'buy', 49, 1, 1)];
    expect(matchOrder(book, order(A, 'YES', 'sell', 50, 1))).toMatchObject({
      fills: [],
      stop: 'price_limit',
    });
  });

  it('fills a sell at exactly its limit, then stops below it', () => {
    const atLimit = [resting('bid50', B, 'YES', 'buy', 50, 1, 1)];
    expect(brief(matchOrder(atLimit, order(A, 'YES', 'sell', 50, 1)))).toEqual([
      ['bid50', 'trade', 1, 50],
    ]);
    expect(matchOrder(atLimit, order(A, 'YES', 'sell', 50, 1)).stop).toBe('filled');
    const book = [...atLimit, resting('bid49', C, 'YES', 'buy', 49, 1, 2)];
    expect(matchOrder(book, order(A, 'YES', 'sell', 50, 2))).toMatchObject({
      filledQty: 1,
      stop: 'price_limit',
      remainingQty: 1,
    });
  });

  it('stops at the limit after filling what is within it', () => {
    const book = [
      resting('ask50', B, 'YES', 'sell', 50, 1, 1),
      resting('ask51', C, 'YES', 'sell', 51, 1, 2),
    ];
    expect(matchOrder(book, order(A, 'YES', 'buy', 50, 2))).toMatchObject({
      filledQty: 1,
      stop: 'price_limit',
      remainingQty: 1,
    });
  });
});

describe('the remainder (AC 7, #177 7항)', () => {
  it('cancels an IOC remainder', () => {
    expect(matchOrder([], order(A, 'YES', 'buy', 50, 3))).toMatchObject({
      stop: 'no_quote',
      remainder: 'cancel',
      remainingQty: 3,
    });
  });

  it('rests a GTC remainder at its limit, keeping the fills', () => {
    const book = [
      resting('ask48', B, 'YES', 'sell', 48, 1, 1),
      resting('ask55', C, 'YES', 'sell', 55, 1, 2),
    ];
    const incoming = order(A, 'YES', 'buy', 50, 3, 'gtc');
    const result = matchOrder(book, incoming);
    expect(result).toMatchObject({
      filledQty: 1,
      stop: 'price_limit',
      remainder: 'rest',
      remainingQty: 2,
    });
    expect(bookAfterMatch(book, incoming, result, { id: 'mine', arrival: 3 })).toEqual([
      resting('ask55', C, 'YES', 'sell', 55, 1, 2),
      resting('mine', A, 'YES', 'buy', 50, 2, 3),
    ]);
  });

  it('rests a GTC whole when nothing fills, and after no_quote', () => {
    const incoming = order(A, 'NO', 'sell', 30, 4, 'gtc');
    const result = matchOrder([], incoming);
    expect(result).toMatchObject({
      fills: [],
      stop: 'no_quote',
      remainder: 'rest',
      remainingQty: 4,
    });
    expect(bookAfterMatch([], incoming, result, { id: 'mine', arrival: 0 })).toEqual([
      resting('mine', A, 'NO', 'sell', 30, 4, 0),
    ]);
  });

  it('adds nothing after a full fill, whatever rest is given', () => {
    const book = [resting('ask48', B, 'YES', 'sell', 48, 2, 1)];
    const incoming = order(A, 'YES', 'buy', 50, 2, 'gtc');
    const result = matchOrder(book, incoming);
    expect(result.remainder).toBe('none');
    expect(bookAfterMatch(book, incoming, result, { id: 'mine', arrival: 2 })).toEqual([]);
  });
});

describe('self-trade prevention (AC 8, #177 5·7항)', () => {
  const book = [
    resting('b50', B, 'YES', 'sell', 50, 2, 1),
    resting('own52', A, 'YES', 'sell', 52, 1, 2),
    resting('c53', C, 'YES', 'sell', 53, 1, 3),
  ];

  it('keeps the fills before the own order, cancels the rest and leaves the own order', () => {
    const incoming = order(A, 'YES', 'buy', 60, 5);
    const result = matchOrder(book, incoming);
    expect(brief(result)).toEqual([['b50', 'trade', 2, 50]]);
    expect(result).toMatchObject({ stop: 'self_trade', remainder: 'cancel', remainingQty: 3 });
    expect(bookAfterMatch(book, incoming, result)).toEqual(book.slice(1));
  });

  it('does not rest a GTC that meets its own order', () => {
    const incoming = order(A, 'YES', 'buy', 60, 5, 'gtc');
    const result = matchOrder(book, incoming);
    expect(result).toMatchObject({ stop: 'self_trade', remainder: 'cancel' });
    expect(bookAfterMatch(book, incoming, result, { id: 'mine', arrival: 9 })).toEqual(
      book.slice(1),
    );
  });

  it('stops with no fill when the own order comes first, never skipping it', () => {
    const ownFirst = [
      resting('own50', A, 'YES', 'sell', 50, 1, 1),
      resting('b51', B, 'YES', 'sell', 51, 1, 2),
    ];
    expect(matchOrder(ownFirst, order(A, 'YES', 'buy', 60, 1, 'gtc'))).toMatchObject({
      fills: [],
      stop: 'self_trade',
      remainder: 'cancel',
    });
  });

  it('applies to a sell meeting its own buy', () => {
    const bids = [resting('own45', A, 'NO', 'buy', 45, 1, 1)];
    expect(matchOrder(bids, order(A, 'NO', 'sell', 40, 1)).stop).toBe('self_trade');
  });

  it('applies to the opposite outcome: no mint with the own NO buy (#177 5항)', () => {
    const opposite = [
      resting('ownNo45', A, 'NO', 'buy', 45, 1, 1),
      resting('bNo48', B, 'NO', 'buy', 48, 1, 3),
      resting('cAsk60', C, 'YES', 'sell', 60, 1, 2),
    ];
    const result = matchOrder(opposite, order(A, 'YES', 'buy', 70, 3));
    expect(brief(result)).toEqual([['bNo48', 'pair_mint', 1, 52]]);
    expect(result).toMatchObject({ stop: 'self_trade', remainingQty: 2 });
  });

  it('is skipped for a quote, which has no owner (#179)', () => {
    expect(brief(matchOrder(book, order(null, 'YES', 'buy', 60, 5)))).toEqual([
      ['b50', 'trade', 2, 50],
      ['own52', 'trade', 1, 52],
      ['c53', 'trade', 1, 53],
    ]);
  });
});

describe('the non-person bundle (AC 9, #73 11항, ADR-0108 결과 5)', () => {
  it('tells groups apart by id for people and as one bundle otherwise', () => {
    expect(sameSelfTradeGroup(A, A)).toBe(true);
    expect(sameSelfTradeGroup(A, B)).toBe(false);
    expect(sameSelfTradeGroup(A, M1)).toBe(false);
    expect(sameSelfTradeGroup(M1, A)).toBe(false);
    expect(sameSelfTradeGroup(M1, M1)).toBe(true);
    expect(sameSelfTradeGroup(M1, M2)).toBe(true);
  });

  it('never fills two non-person accounts: a mint, a buy or a sell', () => {
    const noBid = [resting('m1No40', M1, 'NO', 'buy', 40, 5, 1)];
    expect(matchOrder(noBid, order(M2, 'YES', 'buy', 70, 1, 'gtc'))).toMatchObject({
      fills: [],
      stop: 'self_trade',
      remainder: 'cancel',
    });
    const ask = [resting('m1Ask50', M1, 'YES', 'sell', 50, 5, 1)];
    expect(matchOrder(ask, order(M2, 'YES', 'buy', 70, 1)).stop).toBe('self_trade');
    const bid = [resting('m1Bid45', M1, 'YES', 'buy', 45, 5, 1)];
    expect(matchOrder(bid, order(M2, 'YES', 'sell', 40, 1)).stop).toBe('self_trade');
  });

  it('fills a person against a non-person account both ways', () => {
    const book = [
      resting('m1No40', M1, 'NO', 'buy', 40, 5, 1),
      resting('m1Yes45', M1, 'YES', 'buy', 45, 5, 2),
    ];
    expect(brief(matchOrder(book, order(A, 'YES', 'buy', 60, 1)))).toEqual([
      ['m1No40', 'pair_mint', 1, 60],
    ]);
    expect(brief(matchOrder(book, order(A, 'YES', 'sell', 40, 1)))).toEqual([
      ['m1Yes45', 'trade', 1, 45],
    ]);
  });

  it('holds in a simulation (#71·#131), which passes real owners, never null', () => {
    let book = [
      resting('m1No45', M1, 'NO', 'buy', 45, 5, 1),
      resting('aAsk60', A, 'YES', 'sell', 60, 2, 2),
    ];
    const botBid = order(M1, 'YES', 'buy', 56, 3, 'gtc');
    const result = matchOrder(book, botBid);
    expect(result).toMatchObject({ fills: [], stop: 'self_trade', remainder: 'cancel' });
    book = bookAfterMatch(book, botBid, result, { id: 'm1Yes56', arrival: 3 });
    expect(book.map((entry) => entry.id)).toEqual(['m1No45', 'aAsk60']);
    const own = matchOrder(book, order(A, 'YES', 'buy', 60, 6));
    expect(brief(own)).toEqual([['m1No45', 'pair_mint', 5, 55]]);
    expect(own).toMatchObject({ stop: 'self_trade', remainingQty: 1 });
    // Ownerless, the same bot bid would mint with the bot's own NO buy: only a quote may do that.
    expect(brief(matchOrder(book, { ...botBid, owner: null }))).toEqual([
      ['m1No45', 'pair_mint', 3, 55],
    ]);
  });
});

describe('the stops (AC 11, #177 8항)', () => {
  it('is 호가 부족 on an empty book, also for a bot that is not quoting', () => {
    for (const incoming of [
      order(A, 'YES', 'buy', 99, 1),
      order(A, 'NO', 'sell', 1, 1),
      budgetBuy(A, 'YES', 99, 100n),
    ]) {
      expect(matchOrder([], incoming)).toMatchObject({
        fills: [],
        stop: 'no_quote',
        remainder: 'cancel',
      });
    }
  });

  it('is 호가 부족 when the line ends within the limit, 가격 한도 when the next is beyond it', () => {
    const book = [resting('ask50', B, 'YES', 'sell', 50, 1, 1)];
    expect(matchOrder(book, order(A, 'YES', 'buy', 60, 2)).stop).toBe('no_quote');
    const deeper = [...book, resting('ask61', C, 'YES', 'sell', 61, 1, 2)];
    expect(matchOrder(deeper, order(A, 'YES', 'buy', 60, 2)).stop).toBe('price_limit');
  });

  it('reads an own order beyond the limit as 가격 한도, so a GTC rests (not crossed)', () => {
    const ownAsk = [resting('ownAsk70', A, 'YES', 'sell', 70, 1, 1)];
    expect(matchOrder(ownAsk, order(A, 'YES', 'buy', 60, 1, 'gtc'))).toMatchObject({
      stop: 'price_limit',
      remainder: 'rest',
    });
    // A's NO buy 45 is a YES ask at 55: beyond A's YES limit 50, and 45 + 50 < 100.
    const ownNo = [resting('ownNo45', A, 'NO', 'buy', 45, 1, 1)];
    expect(matchOrder(ownNo, order(A, 'YES', 'buy', 50, 1, 'gtc'))).toMatchObject({
      stop: 'price_limit',
      remainder: 'rest',
    });
  });

  it('reads an own order within the limit but beyond the budget as 금액 부족', () => {
    const ownNo = [resting('ownNo45', A, 'NO', 'buy', 45, 1, 1)];
    expect(matchOrder(ownNo, budgetBuy(A, 'YES', 60, 50n))).toMatchObject({
      fills: [],
      stop: 'budget_spent',
      remainder: 'none',
      unspentCoin: 50n,
    });
  });

  it('is 금액 부족 when the best price within the limit is above the whole budget', () => {
    const book = [resting('ask30', B, 'YES', 'sell', 30, 5, 1)];
    expect(matchOrder(book, budgetBuy(A, 'YES', 60, 20n))).toMatchObject({
      fills: [],
      stop: 'budget_spent',
      unspentCoin: 20n,
    });
  });

  it('is 가격 한도 for a budget whose best quote is beyond its limit', () => {
    const book = [resting('ask70', B, 'YES', 'sell', 70, 5, 1)];
    expect(matchOrder(book, budgetBuy(A, 'YES', 60, 1_000n))).toMatchObject({
      stop: 'price_limit',
      remainder: 'cancel',
      unspentCoin: 1_000n,
    });
  });

  it('carries no bot-internal reason: only the planned fields', () => {
    const result = matchOrder(
      [resting('m1No40', M1, 'NO', 'buy', 40, 1, 1)],
      order(A, 'YES', 'buy', 99, 2),
    );
    expect(Object.keys(result).sort()).toEqual(
      [
        'amountCoin',
        'counterpartyOwnerIds',
        'filledQty',
        'fills',
        'remainder',
        'remainingQty',
        'stop',
        'unspentCoin',
      ].sort(),
    );
    expect(MATCH_STOPS.join(' ')).not.toMatch(/loss|bot|risk|halt|pause/);
  });
});

describe('the Coin-amount IOC buy (#177 3항)', () => {
  it('buys what the budget affords and releases the rest: 100 at 30 buys 3, 10 back', () => {
    const book = [resting('ask30', B, 'YES', 'sell', 30, 10, 1)];
    const result = matchOrder(book, budgetBuy(A, 'YES', 60, 100n));
    expect(brief(result)).toEqual([['ask30', 'trade', 3, 30]]);
    expect(result).toMatchObject({
      amountCoin: 90n,
      stop: 'budget_spent',
      remainder: 'none',
      remainingQty: null,
      unspentCoin: 10n,
    });
  });

  it('buys the next contract when the budget left equals its price exactly', () => {
    const one = matchOrder(
      [resting('ask30', B, 'YES', 'sell', 30, 5, 1)],
      budgetBuy(A, 'YES', 60, 30n),
    );
    expect(brief(one)).toEqual([['ask30', 'trade', 1, 30]]);
    expect(one).toMatchObject({ stop: 'budget_spent', remainder: 'none', unspentCoin: 0n });
    const book = [
      resting('ask30', B, 'YES', 'sell', 30, 1, 1),
      resting('ask40', C, 'YES', 'sell', 40, 1, 2),
      resting('ask45', C, 'YES', 'sell', 45, 1, 3),
    ];
    const walk = matchOrder(book, budgetBuy(A, 'YES', 60, 70n));
    expect(brief(walk)).toEqual([
      ['ask30', 'trade', 1, 30],
      ['ask40', 'trade', 1, 40],
    ]);
    expect(walk).toMatchObject({ amountCoin: 70n, stop: 'budget_spent', unspentCoin: 0n });
  });

  it('stops on a partly bought entry whatever follows: beyond the limit, own, nothing', () => {
    const base = resting('ask30', B, 'YES', 'sell', 30, 10, 1);
    for (const next of [
      [resting('ask70', C, 'YES', 'sell', 70, 1, 2)],
      [resting('ownAsk40', A, 'YES', 'sell', 40, 1, 2)],
      [],
    ]) {
      expect(matchOrder([base, ...next], budgetBuy(A, 'YES', 60, 100n))).toMatchObject({
        filledQty: 3,
        stop: 'budget_spent',
        remainder: 'none',
        unspentCoin: 10n,
      });
    }
  });

  it('walks direct and opposite entries; spent to 0 it is filled even at the line end', () => {
    const book = [
      resting('ask30', B, 'YES', 'sell', 30, 1, 1),
      resting('no60', C, 'NO', 'buy', 60, 2, 2),
    ];
    const exact = matchOrder(book, budgetBuy(A, 'YES', 50, 110n));
    expect(brief(exact)).toEqual([
      ['ask30', 'trade', 1, 30],
      ['no60', 'pair_mint', 2, 40],
    ]);
    expect(exact).toMatchObject({ stop: 'budget_spent', remainder: 'none', unspentCoin: 0n });
    expect(matchOrder(book, budgetBuy(A, 'YES', 50, 150n))).toMatchObject({
      filledQty: 3,
      stop: 'no_quote',
      remainder: 'cancel',
      unspentCoin: 40n,
    });
  });

  it('ends with 가격 한도 or 자기 체결 when the budget is left and the next cannot be met', () => {
    const ask30 = resting('ask30', B, 'YES', 'sell', 30, 1, 1);
    expect(
      matchOrder(
        [ask30, resting('ask70', C, 'YES', 'sell', 70, 1, 2)],
        budgetBuy(A, 'YES', 60, 100n),
      ),
    ).toMatchObject({ filledQty: 1, stop: 'price_limit', remainder: 'cancel', unspentCoin: 70n });
    expect(
      matchOrder(
        [ask30, resting('own35', A, 'YES', 'sell', 35, 1, 2)],
        budgetBuy(A, 'YES', 60, 100n),
      ),
    ).toMatchObject({ filledQty: 1, stop: 'self_trade', remainder: 'cancel', unspentCoin: 70n });
  });

  it('gives the budget leg no limit: the difference stays locked (ADR-0110 결정 5)', () => {
    const book = [
      resting('ask30', B, 'YES', 'sell', 30, 1, 1),
      resting('yes70', C, 'YES', 'buy', 70, 1, 2),
    ];
    const incoming = budgetBuy(A, 'NO', 50, 100n);
    const result = matchOrder(book, incoming);
    expect(brief(result)).toEqual([['yes70', 'pair_mint', 1, 30]]);
    expect(fillProcessInput(incoming, result.fills[0]!)).toEqual({
      process: 'pair_mint',
      input: {
        qty: 1,
        yesPriceCoin: 70,
        yes: { ownerId: 'C', limitPriceCoin: 70 },
        no: { ownerId: 'A', limitPriceCoin: null },
      },
    });
    const trade = matchOrder(book, budgetBuy(A, 'YES', 50, 100n));
    expect(fillProcessInput(budgetBuy(A, 'YES', 50, 100n), trade.fills[0]!)).toMatchObject({
      process: 'trade',
      input: { buyer: { ownerId: 'A', limitPriceCoin: null }, sellerId: 'B' },
    });
  });

  it('stays exact for budgets of 10^15 and beyond 2^53', () => {
    const cheap = [resting('ask1', B, 'YES', 'sell', 1, 10, 1)];
    expect(matchOrder(cheap, budgetBuy(A, 'YES', 1, 10n ** 15n)).unspentCoin).toBe(
      10n ** 15n - 10n,
    );
    const dear = [resting('ask99', B, 'YES', 'sell', 99, 3, 1)];
    const huge = 2n ** 60n + 1n;
    expect(matchOrder(dear, budgetBuy(A, 'YES', 99, huge))).toMatchObject({
      filledQty: 3,
      amountCoin: 297n,
      unspentCoin: huge - 297n,
      stop: 'no_quote',
    });
  });

  it('refuses a budget whose filled total would pass 2^53 instead of rounding it', () => {
    // Each resting quantity is a safe integer; together they are not.
    const book = [
      resting('askMax', B, 'YES', 'sell', 1, Number.MAX_SAFE_INTEGER, 1),
      resting('askTwo', C, 'YES', 'sell', 1, 2, 2),
    ];
    expect(() => matchOrder(book, budgetBuy(A, 'YES', 1, 2n ** 53n + 1n))).toThrow(RangeError);
    // Up to the range it is exact: the total equals the fills' sum.
    const exact = matchOrder(book, budgetBuy(A, 'YES', 1, 2n ** 53n - 1n));
    expect(exact.filledQty).toBe(Number.MAX_SAFE_INTEGER);
    expect(exact.fills.reduce((sum, fill) => sum + fill.qty, 0)).toBe(exact.filledQty);
  });
});

describe('the bot ladder is YES supply only through a pair mint (ADR-0058 결과 4)', () => {
  it('fills a person’s YES buy against the bot’s NO bids at a non-decreasing YES price', () => {
    const ladder = quoteLadder(
      0,
      { b: 10, safetyTicks: 1, levels: 5, quantity: 10 },
      CONTRACT_TERMS,
    );
    const book = ladder.noBids.map((level, index) =>
      resting(`m1No${String(level.priceCoin)}`, M1, 'NO', 'buy', level.priceCoin, level.qty, index),
    );
    const total = ladder.noBids.reduce((sum, level) => sum + level.qty, 0);
    expect(total).toBeGreaterThan(1);
    const result = matchOrder(book, order(A, 'YES', 'buy', 99, total));
    expect(result.filledQty).toBe(total);
    expect(result.fills.every((fill) => fill.kind === 'pair_mint')).toBe(true);
    const prices = result.fills.map((fill) => fill.yesPriceCoin);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });
});

describe('N01 §10 scenarios matching alone runs (AC 12)', () => {
  /** Runs `orders` in turn on `book`, resting GTC remainders with increasing arrivals. */
  const replay = (book: BookOrder[], orders: IncomingOrder[], firstArrival = 1_000) => {
    const results: MatchResult[] = [];
    orders.forEach((incoming, index) => {
      const result = matchOrder(book, incoming);
      results.push(result);
      const arrival = firstArrival + index;
      book = bookAfterMatch(book, incoming, result, { id: `r${String(arrival)}`, arrival });
    });
    return { book, results };
  };
  const levels = () => [
    resting('l50', M1, 'NO', 'buy', 50, 2, 1),
    resting('l52', M1, 'NO', 'buy', 48, 3, 2),
    resting('l55', B, 'YES', 'sell', 55, 2, 3),
  ];

  it('일방향 연속 매수: consecutive buys climb the levels, never past a level’s quantity', () => {
    const { results } = replay(
      levels(),
      Array.from({ length: 10 }, () => order(A, 'YES', 'buy', 99, 1)),
    );
    expect(results.map((result) => result.fills[0]?.priceCoin ?? null)).toEqual([
      50,
      50,
      52,
      52,
      52,
      55,
      55,
      null,
      null,
      null,
    ]);
    expect(results.slice(7).every((result) => result.stop === 'no_quote')).toBe(true);
  });

  it('큰손·분할 주문: one order of 6 and six orders of 1 buy the same at the same cost', () => {
    const whole = matchOrder(levels(), order(A, 'YES', 'buy', 55, 6));
    const { results } = replay(
      levels(),
      Array.from({ length: 6 }, () => order(A, 'YES', 'buy', 55, 1)),
    );
    expect(results.reduce((sum, result) => sum + result.filledQty, 0)).toBe(whole.filledQty);
    expect(results.reduce((sum, result) => sum + result.amountCoin, 0n)).toBe(whole.amountCoin);
    expect(whole).toMatchObject({ filledQty: 6, amountCoin: 311n });
  });

  it('사용자 간 거래: people trade with no bot order in the book', () => {
    const { book, results } = replay(
      [],
      [
        order(B, 'YES', 'sell', 55, 3, 'gtc'),
        order(C, 'NO', 'buy', 40, 2, 'gtc'),
        order(A, 'YES', 'buy', 60, 4),
        order(C, 'YES', 'sell', 50, 1, 'gtc'),
      ],
    );
    expect(results[0]).toMatchObject({ stop: 'no_quote', remainder: 'rest' });
    expect(results[1]).toMatchObject({ stop: 'no_quote', remainder: 'rest' });
    expect(brief(results[2]!)).toEqual([
      ['r1000', 'trade', 3, 55],
      ['r1001', 'pair_mint', 1, 60],
    ]);
    expect(results[3]).toMatchObject({ fills: [], stop: 'no_quote', remainder: 'rest' });
    expect(book.map((resting) => [resting.id, resting.owner.id, resting.remainingQty])).toEqual([
      ['r1001', 'C', 1],
      ['r1003', 'C', 1],
    ]);
    expect(book.every((resting) => resting.owner.human)).toBe(true);
  });

  it('자기 거래: an own resting order stops the incoming one and stays', () => {
    const { book, results } = replay(
      [],
      [
        order(A, 'YES', 'buy', 45, 2, 'gtc'),
        order(B, 'YES', 'buy', 44, 1, 'gtc'),
        order(A, 'YES', 'sell', 40, 3, 'gtc'),
        order(C, 'YES', 'sell', 40, 3),
      ],
    );
    expect(results[2]).toMatchObject({ fills: [], stop: 'self_trade', remainder: 'cancel' });
    expect(brief(results[3]!)).toEqual([
      ['r1000', 'trade', 2, 45],
      ['r1001', 'trade', 1, 44],
    ]);
    expect(book).toEqual([]);
  });
});

describe('validation: a caller’s bug is a RangeError', () => {
  const ok = resting('ok', B, 'YES', 'sell', 50, 1, 1);
  const bad = (over: Record<string, unknown>) => ({ ...ok, ...over });
  const incoming = order(A, 'YES', 'buy', 60, 1);

  it.each([
    ['an empty id', [bad({ id: '' })]],
    ['a duplicate id', [ok, bad({ arrival: 2 })]],
    ['an owner with no id', [bad({ owner: { id: '', human: true } })]],
    ['an owner with no human flag', [bad({ owner: { id: 'B' } })]],
    [
      'one owner as a person and not',
      [ok, bad({ id: 'x', arrival: 2, owner: { id: 'B', human: false } })],
    ],
    ['an unknown outcome', [bad({ outcome: 'MAYBE' })]],
    ['an unknown side', [bad({ side: 'hold' })]],
    ['a price off the grid', [bad({ priceCoin: 0 })]],
    ['a price of the payout', [bad({ priceCoin: 100 })]],
    ['a fractional price', [bad({ priceCoin: 50.5 })]],
    ['no remaining quantity', [bad({ remainingQty: 0 })]],
    ['a negative arrival', [bad({ arrival: -1 })]],
    ['a fractional arrival', [bad({ arrival: 1.5 })]],
    ['a duplicate arrival', [ok, bad({ id: 'x' })]],
  ])('refuses a book with %s', (_name, book) => {
    expect(() => matchOrder(book, incoming)).toThrow(RangeError);
    expect(() => matchLine(book, 'YES', 'buy')).toThrow(RangeError);
  });

  const badOrder = (over: Record<string, unknown>) => ({ ...incoming, ...over });
  it.each([
    ['an owner as a person and not', badOrder({ owner: { id: 'B', human: false } })],
    ['an owner with no id', badOrder({ owner: { id: '', human: true } })],
    ['an unknown outcome', badOrder({ outcome: 'MAYBE' })],
    ['an unknown side', badOrder({ side: 'hold' })],
    ['an unknown time in force', badOrder({ timeInForce: 'fok' })],
    ['a limit off the grid', badOrder({ limitPriceCoin: 100 })],
    ['no quantity', badOrder({ qty: 0 })],
    ['a missing quantity', badOrder({ qty: null })],
    ['a quantity and a budget', badOrder({ budgetCoin: 100n })],
    ['a zero budget', badOrder({ qty: null, budgetCoin: 0n })],
    ['a number budget', badOrder({ qty: null, budgetCoin: 100 })],
    ['a budget on a sell', badOrder({ qty: null, budgetCoin: 100n, side: 'sell' })],
    ['a budget on a GTC', badOrder({ qty: null, budgetCoin: 100n, timeInForce: 'gtc' })],
  ])('refuses an order with %s', (_name, bad) => {
    expect(() => matchOrder([ok], bad)).toThrow(RangeError);
  });

  it('refuses a line of an unknown outcome or side', () => {
    expect(() => matchLine([ok], 'MAYBE' as Outcome, 'buy')).toThrow(RangeError);
    expect(() => matchLine([ok], 'YES', 'hold' as OrderSide)).toThrow(RangeError);
  });

  it('refuses to apply a quote or a pair mint on a sell', () => {
    const book = [resting('no40', B, 'NO', 'buy', 40, 1, 1)];
    const fill = matchOrder(book, order(null, 'YES', 'buy', 60, 1)).fills[0]!;
    expect(() => fillProcessInput(order(null, 'YES', 'buy', 60, 1), fill)).toThrow(RangeError);
    expect(() => fillProcessInput(order(A, 'YES', 'sell', 60, 1), fill)).toThrow(RangeError);
    expect(() => fillProcessInput(badOrder({ limitPriceCoin: 0 }), fill)).toThrow(RangeError);
  });

  it('refuses a book after a match that does not fit it', () => {
    const gtc = order(A, 'YES', 'buy', 40, 2, 'gtc');
    const resting50 = [ok];
    const result = matchOrder(resting50, gtc);
    expect(result.remainder).toBe('rest');
    expect(() => bookAfterMatch(resting50, gtc, result)).toThrow(RangeError);
    expect(() => bookAfterMatch(resting50, gtc, result, { id: 'ok', arrival: 5 })).toThrow(
      RangeError,
    );
    expect(() => bookAfterMatch(resting50, gtc, result, { id: 'new', arrival: 1 })).toThrow(
      RangeError,
    );
    expect(() => bookAfterMatch(resting50, gtc, result, { id: 'new', arrival: -1 })).toThrow(
      RangeError,
    );
    const quote = order(null, 'YES', 'buy', 40, 2, 'gtc');
    expect(() =>
      bookAfterMatch(resting50, quote, matchOrder(resting50, quote), { id: 'n', arrival: 5 }),
    ).toThrow(RangeError);
    const filled = matchOrder(resting50, order(A, 'YES', 'buy', 50, 1));
    expect(() => bookAfterMatch([], incoming, filled)).toThrow(RangeError);
    const overfilled: MatchResult = { ...filled, fills: [{ ...filled.fills[0]!, qty: 2 }] };
    expect(() => bookAfterMatch(resting50, incoming, overfilled)).toThrow(RangeError);
  });
});

// ---- properties -------------------------------------------------------------------------------

const ownerArb = fc.constantFrom(...OWNERS);
const priceArb = fc.integer({ min: 1, max: 99 });

/** Any well-formed book (possibly crossed): ≤ 16 orders, five owners, unique arrivals. */
const anyBookArb: fc.Arbitrary<BookOrder[]> = fc
  .array(
    fc.record({
      owner: ownerArb,
      outcome: fc.constantFrom(...OUTCOMES),
      side: fc.constantFrom(...ORDER_SIDES),
      priceCoin: priceArb,
      remainingQty: fc.integer({ min: 1, max: 20 }),
    }),
    { maxLength: 16 },
  )
  .chain((rows) =>
    fc
      .uniqueArray(fc.nat({ max: 10_000 }), { minLength: rows.length, maxLength: rows.length })
      .map((arrivals) =>
        rows.map((row, i) => ({ ...row, id: `o${String(i)}`, arrival: arrivals[i]! })),
      ),
  );

const incomingArbOf = (owner: fc.Arbitrary<OrderOwner | null>): fc.Arbitrary<IncomingOrder> =>
  fc.oneof(
    fc.record({
      owner,
      outcome: fc.constantFrom(...OUTCOMES),
      side: fc.constantFrom(...ORDER_SIDES),
      timeInForce: fc.constantFrom(...TIME_IN_FORCES),
      limitPriceCoin: priceArb,
      qty: fc.integer({ min: 1, max: 60 }),
      budgetCoin: fc.constant(null),
    }),
    fc.record({
      owner,
      outcome: fc.constantFrom(...OUTCOMES),
      side: fc.constant('buy' as const),
      timeInForce: fc.constant('ioc' as const),
      limitPriceCoin: priceArb,
      qty: fc.constant(null),
      budgetCoin: fc.bigInt({ min: 1n, max: 3_000n }),
    }),
  );
const incomingArb = incomingArbOf(fc.option(ownerArb, { nil: null }));

/** Feeds owned orders through the matcher from an empty book (uncrossed by induction). */
function replayBook(stream: readonly IncomingOrder[]): BookOrder[] {
  let book: BookOrder[] = [];
  stream.forEach((incoming, index) => {
    book = bookAfterMatch(book, incoming, matchOrder(book, incoming), {
      id: `r${String(index)}`,
      arrival: index,
    });
  });
  return book;
}
const replayedBookArb = fc.array(incomingArbOf(ownerArb), { maxLength: 30 }).map(replayBook);
const bookArb = fc.oneof(anyBookArb, replayedBookArb);

/**
 * A naive reference: re-reads the whole book and fills one contract per step, with the same
 * precedence. Its fills are merged per consecutive resting order.
 */
function referenceMatch(book: readonly BookOrder[], incoming: IncomingOrder) {
  const left = new Map(book.map((resting) => [resting.id, resting.remainingQty]));
  const fills: { id: string; kind: string; qty: number; priceCoin: number }[] = [];
  let qtyLeft = incoming.qty ?? 0;
  let budgetLeft = incoming.budgetCoin ?? 0n;
  const isBuy = incoming.side === 'buy';
  let stop: string;
  for (;;) {
    if (incoming.budgetCoin === null ? qtyLeft === 0 : budgetLeft === 0n) {
      stop = incoming.budgetCoin === null ? 'filled' : 'budget_spent';
      break;
    }
    const candidates = book
      .filter((resting) => left.get(resting.id)! > 0)
      .flatMap((resting) => {
        if (isBuy && resting.outcome === incoming.outcome && resting.side === 'sell') {
          return [{ resting, kind: 'trade', priceCoin: resting.priceCoin }];
        }
        if (isBuy && resting.outcome !== incoming.outcome && resting.side === 'buy') {
          return [{ resting, kind: 'pair_mint', priceCoin: PAYOUT - resting.priceCoin }];
        }
        if (!isBuy && resting.outcome === incoming.outcome && resting.side === 'buy') {
          return [{ resting, kind: 'trade', priceCoin: resting.priceCoin }];
        }
        return [];
      });
    const best = candidates.reduce<(typeof candidates)[number] | undefined>((a, b) => {
      if (a === undefined) return b;
      if (a.priceCoin !== b.priceCoin)
        return (isBuy ? a.priceCoin < b.priceCoin : a.priceCoin > b.priceCoin) ? a : b;
      return a.resting.arrival < b.resting.arrival ? a : b;
    }, undefined);
    if (best === undefined) {
      stop = 'no_quote';
      break;
    }
    if (
      isBuy ? best.priceCoin > incoming.limitPriceCoin : best.priceCoin < incoming.limitPriceCoin
    ) {
      stop = 'price_limit';
      break;
    }
    if (incoming.budgetCoin !== null && budgetLeft < BigInt(best.priceCoin)) {
      stop = 'budget_spent';
      break;
    }
    const owner = incoming.owner;
    const theirs = best.resting.owner;
    if (owner !== null && (owner.id === theirs.id || (!owner.human && !theirs.human))) {
      stop = 'self_trade';
      break;
    }
    left.set(best.resting.id, left.get(best.resting.id)! - 1);
    qtyLeft -= 1;
    budgetLeft -= BigInt(best.priceCoin);
    const last = fills.at(-1);
    if (last?.id === best.resting.id) last.qty += 1;
    else fills.push({ id: best.resting.id, kind: best.kind, qty: 1, priceCoin: best.priceCoin });
  }
  const remainder =
    stop === 'filled' || stop === 'budget_spent'
      ? 'none'
      : stop === 'self_trade' || incoming.timeInForce === 'ioc'
        ? 'cancel'
        : 'rest';
  return { fills, stop, remainder };
}

const bestPrice = (book: readonly BookOrder[], outcome: Outcome, side: OrderSide) => {
  const prices = book
    .filter((resting) => resting.outcome === outcome && resting.side === side)
    .map((resting) => resting.priceCoin);
  if (prices.length === 0) return undefined;
  return side === 'buy' ? Math.max(...prices) : Math.min(...prices);
};

/** Whether any two resting orders of the book could fill each other (any owners). */
function isCrossed(book: readonly BookOrder[]): boolean {
  for (const outcome of OUTCOMES) {
    const bid = bestPrice(book, outcome, 'buy');
    const ask = bestPrice(book, outcome, 'sell');
    if (bid !== undefined && ask !== undefined && bid >= ask) return true;
  }
  const yesBid = bestPrice(book, 'YES', 'buy');
  const noBid = bestPrice(book, 'NO', 'buy');
  return yesBid !== undefined && noBid !== undefined && yesBid + noBid >= PAYOUT;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const ownerOf = (book: readonly BookOrder[], fill: MatchFill) =>
  book.find((resting) => resting.id === fill.restingOrderId)!;

describe('properties', () => {
  it('P1 equals a naive one-contract-at-a-time reference matcher', () => {
    fc.assert(
      fc.property(bookArb, incomingArb, (book, incoming) => {
        const result = matchOrder(book, incoming);
        const reference = referenceMatch(book, incoming);
        expect(
          result.fills.map((fill) => ({
            id: fill.restingOrderId,
            kind: fill.kind,
            qty: fill.qty,
            priceCoin: fill.priceCoin,
          })),
        ).toEqual(reference.fills);
        expect([result.stop, result.remainder]).toEqual([reference.stop, reference.remainder]);
      }),
      RUNS,
    );
  });

  it('P2 never fills past the limit; prices on the grid; a pair sums to the payout', () => {
    fc.assert(
      fc.property(bookArb, incomingArb, (book, incoming) => {
        for (const fill of matchOrder(book, incoming).fills) {
          if (incoming.side === 'buy')
            expect(fill.priceCoin).toBeLessThanOrEqual(incoming.limitPriceCoin);
          else expect(fill.priceCoin).toBeGreaterThanOrEqual(incoming.limitPriceCoin);
          for (const price of [fill.priceCoin, fill.restingPriceCoin, fill.yesPriceCoin]) {
            expect(price).toBeGreaterThanOrEqual(CONTRACT_TERMS.priceMinCoin);
            expect(price).toBeLessThanOrEqual(CONTRACT_TERMS.priceMaxCoin);
          }
          expect(fill.restingPriceCoin).toBe(ownerOf(book, fill).priceCoin);
          if (fill.kind === 'pair_mint')
            expect(fill.priceCoin + fill.restingPriceCoin).toBe(PAYOUT);
          else expect(fill.priceCoin).toBe(fill.restingPriceCoin);
          expect(fill.yesPriceCoin).toBe(
            incoming.outcome === 'YES' ? fill.priceCoin : PAYOUT - fill.priceCoin,
          );
          expect(fill.amountCoin).toBe(BigInt(fill.priceCoin) * BigInt(fill.qty));
        }
      }),
      RUNS,
    );
  });

  it('P3 counts a resting order once: one fill each, within its remaining, a line prefix', () => {
    fc.assert(
      fc.property(bookArb, incomingArb, (book, incoming) => {
        const { fills } = matchOrder(book, incoming);
        const line = matchLine(book, incoming.outcome, incoming.side);
        expect(new Set(fills.map((fill) => fill.restingOrderId)).size).toBe(fills.length);
        fills.forEach((fill, index) => {
          const entry = line[index]!;
          expect(fill.restingOrderId).toBe(entry.order.id);
          expect(fill.kind).toBe(entry.kind);
          expect(fill.qty).toBeGreaterThanOrEqual(1);
          expect(fill.qty + fill.restingRemainingQty).toBe(entry.order.remainingQty);
          if (index < fills.length - 1) expect(fill.restingRemainingQty).toBe(0);
        });
      }),
      RUNS,
    );
  });

  it('P3 the four lines hold each buy twice and each sell once, never twice in one line', () => {
    fc.assert(
      fc.property(bookArb, (book) => {
        const seen = new Map<string, number>();
        for (const outcome of OUTCOMES) {
          for (const side of ORDER_SIDES) {
            const ids = matchLine(book, outcome, side).map((entry) => entry.order.id);
            expect(new Set(ids).size).toBe(ids.length);
            for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
          }
        }
        for (const resting of book) {
          expect(seen.get(resting.id)).toBe(resting.side === 'buy' ? 2 : 1);
        }
      }),
      RUNS,
    );
  });

  it('P4·P5 no fill within one group; a sell meets only same-outcome buys', () => {
    fc.assert(
      fc.property(bookArb, incomingArb, (book, incoming) => {
        for (const fill of matchOrder(book, incoming).fills) {
          const theirs = ownerOf(book, fill);
          if (incoming.owner !== null) {
            expect(sameSelfTradeGroup(incoming.owner, theirs.owner)).toBe(false);
          }
          if (incoming.side === 'sell') {
            expect([theirs.outcome, theirs.side, fill.kind]).toEqual([
              incoming.outcome,
              'buy',
              'trade',
            ]);
          } else if (fill.kind === 'trade') {
            expect([theirs.outcome, theirs.side]).toEqual([incoming.outcome, 'sell']);
          } else {
            expect([theirs.outcome, theirs.side]).toEqual([otherOutcome(incoming.outcome), 'buy']);
          }
        }
      }),
      RUNS,
    );
  });

  it('P6 conserves quantity and Coin', () => {
    fc.assert(
      fc.property(bookArb, incomingArb, (book, incoming) => {
        const result = matchOrder(book, incoming);
        expect(result.filledQty).toBe(result.fills.reduce((sum, fill) => sum + fill.qty, 0));
        expect(result.amountCoin).toBe(
          result.fills.reduce((sum, fill) => sum + fill.amountCoin, 0n),
        );
        expect(result.counterpartyOwnerIds).toEqual([
          ...new Set(result.fills.map((fill) => fill.restingOwnerId)),
        ]);
        if (incoming.budgetCoin === null) {
          expect(result.filledQty + result.remainingQty!).toBe(incoming.qty);
          expect(result.unspentCoin).toBeNull();
        } else {
          expect(result.amountCoin).toBeLessThanOrEqual(incoming.budgetCoin);
          expect(result.unspentCoin).toBe(incoming.budgetCoin - result.amountCoin);
          expect(result.remainingQty).toBeNull();
        }
        if (incoming.owner === null && result.remainder === 'rest') return;
        const after = bookAfterMatch(book, incoming, result, { id: 'new', arrival: 20_000 });
        const total = (orders: readonly BookOrder[]) =>
          orders.reduce((sum, resting) => sum + resting.remainingQty, 0);
        const rested = result.remainder === 'rest' ? result.remainingQty! : 0;
        expect(total(after)).toBe(total(book) - result.filledQty + rested);
      }),
      RUNS,
    );
  });

  it('P7 is deterministic and never mutates its inputs', () => {
    fc.assert(
      fc.property(bookArb, incomingArb, (book, incoming) => {
        const copy = structuredClone(book);
        const frozenBook = deepFreeze(structuredClone(book));
        const frozenIncoming = deepFreeze({ ...incoming });
        const first = matchOrder(frozenBook, frozenIncoming);
        expect(matchOrder(frozenBook, frozenIncoming)).toEqual(first);
        expect(matchOrder(book, incoming)).toEqual(first);
        matchLine(frozenBook, incoming.outcome, incoming.side);
        if (incoming.owner !== null) {
          bookAfterMatch(frozenBook, frozenIncoming, deepFreeze(first), {
            id: 'new',
            arrival: 20_000,
          });
        }
        expect(book).toEqual(copy);
      }),
      RUNS,
    );
  });

  it('P8 never leaves a crossed book after an owned order, across or within groups', () => {
    fc.assert(
      fc.property(replayedBookArb, incomingArbOf(ownerArb), (book, incoming) => {
        expect(isCrossed(book)).toBe(false);
        const after = bookAfterMatch(book, incoming, matchOrder(book, incoming), {
          id: 'new',
          arrival: 20_000,
        });
        expect(isCrossed(after)).toBe(false);
      }),
      RUNS,
    );
  });

  it('P9 a quote equals the owned match unless the owned one stops at its own order', () => {
    fc.assert(
      fc.property(bookArb, incomingArbOf(ownerArb), (book, incoming) => {
        const owned = matchOrder(book, incoming);
        fc.pre(owned.stop !== 'self_trade');
        expect(matchOrder(book, { ...incoming, owner: null })).toEqual(owned);
      }),
      RUNS,
    );
  });

  it('P10 renaming owners within the group structure changes nothing but the names', () => {
    const rename: Record<string, OrderOwner> = { A: B, B: C, C: A, M1: M2, M2: M1 };
    fc.assert(
      fc.property(bookArb, incomingArb, (book, incoming) => {
        const renamed = book.map((resting) => ({ ...resting, owner: rename[resting.owner.id]! }));
        const renamedIncoming = {
          ...incoming,
          owner: incoming.owner === null ? null : rename[incoming.owner.id]!,
        } as IncomingOrder;
        const result = matchOrder(book, incoming);
        const other = matchOrder(renamed, renamedIncoming);
        expect(other).toEqual({
          ...result,
          fills: result.fills.map((fill) => ({
            ...fill,
            restingOwnerId: rename[fill.restingOwnerId]!.id,
          })),
          counterpartyOwnerIds: result.counterpartyOwnerIds.map((id) => rename[id]!.id),
        });
      }),
      RUNS,
    );
  });

  it('큰손·분할: one order of N and N orders of 1 fill the same on any book with no own order', () => {
    const Z: OrderOwner = { id: 'Z', human: true };
    fc.assert(
      fc.property(
        bookArb,
        fc.constantFrom(...OUTCOMES),
        fc.constantFrom(...ORDER_SIDES),
        priceArb,
        fc.integer({ min: 1, max: 30 }),
        (book, outcome, side, limit, qty) => {
          const whole = matchOrder(book, order(Z, outcome, side, limit, qty));
          let split = book;
          let filledQty = 0;
          let amountCoin = 0n;
          for (let i = 0; i < qty; i += 1) {
            const one = order(Z, outcome, side, limit, 1);
            const result = matchOrder(split, one);
            filledQty += result.filledQty;
            amountCoin += result.amountCoin;
            split = bookAfterMatch(split, one, result);
          }
          expect([filledQty, amountCoin]).toEqual([whole.filledQty, whole.amountCoin]);
        },
      ),
      RUNS,
    );
  });
});
