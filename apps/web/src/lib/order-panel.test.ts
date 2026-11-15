import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type Order,
  type OrderBook,
  type OrderBookContract,
  type OrderQuote,
} from './api';
import {
  type FrozenQuote,
  INITIAL_ORDER_PANEL,
  type OrderInput,
  type OrderPanelState,
  type OrderTerms,
  type PendingOrderRequest,
  QUOTE_DEBOUNCE_MS,
  REQUOTE_MIN_GAP_MS,
  accountReadView,
  authRefreshOf,
  bestPriceOf,
  bookSideChanged,
  bookWatch,
  coinShortfall,
  debouncer,
  digitsOf,
  initialOrderInput,
  noWidthRefusal,
  orderBlock,
  orderPanelReducer,
  orderTermsOf,
  panelOwnerChanged,
  panelSignedIn,
  placeBodyOf,
  placeOutcomeOf,
  quoteBodyOf,
  quoteRefused,
  quoteStatusReason,
  requestOwnedBy,
  requoteNext,
  sendLocked,
  sendUnlocked,
  sideMovedSinceQuote,
} from './order-panel';

/**
 * 주문 패널 (#66, ADR-0140) without React: the input's checks, the two bodies, the steps from 입력
 * to 결과, the line that keeps 주문 확인 off, and when the quote is read again. The money rules are
 * the point: the order's limit is the frozen quote's, and a request id goes again only with its
 * body.
 */

const ACCOUNT = '0b1c2d3e-0000-4000-8000-000000000001';
const OTHER_ACCOUNT = '0b1c2d3e-0000-4000-8000-000000000002';
const ID_A = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
const ID_B = '7a9619ff-8b86-4011-b42d-00c04fc964aa';
const SEND_A = '9c9619ff-8b86-4011-b42d-00c04fc964c1';
const SEND_B = '9c9619ff-8b86-4011-b42d-00c04fc964c2';

function quote(over: Partial<OrderQuote> = {}): OrderQuote {
  return {
    protectedLimitPriceCoin: 65,
    filledQty: 2,
    filledAmountCoin: '126',
    remainingQty: 0,
    unspentCoin: null,
    maxSpendCoin: '130',
    feeCoin: '0',
    stop: 'filled',
    status: 'filled',
    rejectReason: null,
    cancelReason: null,
    ...over,
  };
}

function input(over: Partial<OrderInput> = {}): OrderInput {
  return { ...initialOrderInput(), qty: '2', ...over };
}

function terms(over: Partial<OrderTerms> = {}): OrderTerms {
  return { outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 2, ...over };
}

function frozen(over: Partial<FrozenQuote> = {}): FrozenQuote {
  return { terms: terms(), quote: quote(), quotedAt: 1_000, ...over };
}

function order(over: Partial<Order> = {}): Order {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    requestId: ID_A,
    marketId: '22222222-2222-4222-8222-222222222222',
    marketSlug: 'm',
    marketTitle: 'M',
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: 65,
    protectedLimitPriceCoin: 65,
    qty: 2,
    budgetCoin: null,
    filledQty: 2,
    filledAmountCoin: '126',
    cancelledQty: 0,
    unspentCoin: null,
    status: 'filled',
    rejectReason: null,
    cancelReason: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    endedAt: '2026-11-16T00:00:00.000Z',
    ...over,
  };
}

function apiError(status: number, code: string, details?: unknown): ApiError {
  return new ApiError(status, { code, message: code, details } as never);
}

function pending(over: Partial<PendingOrderRequest> = {}): PendingOrderRequest {
  return {
    requestId: ID_A,
    sendId: SEND_A,
    body: placeBodyOf(frozen(), ACCOUNT),
    savedAt: 5_000,
    phase: 'first',
    ...over,
  };
}

describe('the input (ADR-0140 결정 2-18: digits only, in range, one place)', () => {
  it('drops spaces and grouping commas, and refuses anything but digits', () => {
    expect(digitsOf(' 1,000 ')).toBe('1000');
    expect(digitsOf('0100')).toBe('0100');
    for (const text of ['1e3', '1.5', '-1', '', ' ', '１']) expect(digitsOf(text), text).toBeNull();
  });

  it('reads a quantity of 1 to 1,000,000 contracts, leading zeros away', () => {
    expect(orderTermsOf(input({ qty: '0100' }))).toEqual({ ok: true, terms: terms({ qty: 100 }) });
    expect(orderTermsOf(input({ qty: '1,000' }))).toEqual({
      ok: true,
      terms: terms({ qty: 1000 }),
    });
    expect(orderTermsOf(input({ qty: '1' }))).toMatchObject({ ok: true });
    expect(orderTermsOf(input({ qty: '1000000' }))).toMatchObject({ ok: true });
    expect(orderTermsOf(input({ qty: '0' }))).toEqual({ ok: false, problems: { qty: 'range' } });
    expect(orderTermsOf(input({ qty: '1000001' }))).toEqual({
      ok: false,
      problems: { qty: 'range' },
    });
    expect(orderTermsOf(input({ qty: '1e3' }))).toEqual({ ok: false, problems: { qty: 'digits' } });
    expect(orderTermsOf(input({ qty: '1.5' }))).toEqual({ ok: false, problems: { qty: 'digits' } });
    expect(orderTermsOf(input({ qty: '' }))).toEqual({ ok: false, problems: { qty: 'empty' } });
  });

  it('reads a limit of 1 to 99 for a GTC order only', () => {
    expect(orderTermsOf(input({ kind: 'gtc', limit: '99' }))).toEqual({
      ok: true,
      terms: terms({ timeInForce: 'gtc', limitPriceCoin: 99 }),
    });
    expect(orderTermsOf(input({ kind: 'gtc', limit: '100' }))).toEqual({
      ok: false,
      problems: { limit: 'range' },
    });
    expect(orderTermsOf(input({ kind: 'gtc', limit: '0' }))).toEqual({
      ok: false,
      problems: { limit: 'range' },
    });
    // An immediate order has no limit field: whatever it holds is not read.
    expect(orderTermsOf(input({ limit: 'x' }))).toEqual({ ok: true, terms: terms() });
  });

  it('reads a budget for an immediate buy with 금액 only, as a decimal string', () => {
    const budget = input({ size: 'budget', budget: '0100', qty: '' });
    expect(orderTermsOf(budget)).toEqual({
      ok: true,
      terms: { outcome: 'YES', side: 'buy', timeInForce: 'ioc', budgetCoin: '100' },
    });
    expect(orderTermsOf({ ...budget, budget: '1000000' })).toMatchObject({ ok: true });
    expect(orderTermsOf({ ...budget, budget: '1000001' })).toEqual({
      ok: false,
      problems: { budget: 'range' },
    });
    expect(orderTermsOf({ ...budget, budget: '1e3' })).toEqual({
      ok: false,
      problems: { budget: 'digits' },
    });
    // A sell or a GTC with 금액 left chosen is a quantity order.
    expect(orderTermsOf(input({ size: 'budget', side: 'sell' }))).toEqual({
      ok: true,
      terms: terms({ side: 'sell' }),
    });
    expect(orderTermsOf(input({ size: 'budget', kind: 'gtc', limit: '40' }))).toEqual({
      ok: true,
      terms: terms({ timeInForce: 'gtc', limitPriceCoin: 40 }),
    });
  });
});

describe('quoteBodyOf: no account, no request id', () => {
  it('leaves an immediate order without a limit (the server narrows 99 or 1)', () => {
    expect(quoteBodyOf(terms())).toEqual({
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      qty: 2,
    });
    expect(quoteBodyOf(terms({ qty: undefined, budgetCoin: '100' }))).toEqual({
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      budgetCoin: '100',
    });
  });

  it("sends a GTC order's own limit", () => {
    expect(quoteBodyOf(terms({ timeInForce: 'gtc', limitPriceCoin: 40 }))).toEqual({
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'gtc',
      qty: 2,
      limitPriceCoin: 40,
    });
  });
});

describe('placeBodyOf: the limit is the frozen quote’s, never wider than shown (결정 2-3)', () => {
  const paths: [OrderTerms, number][] = [
    // An immediate buy's 최대 매수 단가 and an immediate sell's 최소 매도 단가, narrowed by 가격 보호:
    // never the 99 or 1 a quote starts from.
    [terms(), 65],
    [terms({ side: 'sell' }), 35],
    [terms({ outcome: 'NO' }), 45],
    [terms({ outcome: 'NO', side: 'sell' }), 55],
    // A GTC's is its own limit, which the quote answers unchanged.
    [terms({ timeInForce: 'gtc', limitPriceCoin: 40 }), 40],
    [terms({ timeInForce: 'gtc', side: 'sell', limitPriceCoin: 60 }), 60],
    [terms({ timeInForce: 'gtc', outcome: 'NO', limitPriceCoin: 30 }), 30],
    [terms({ timeInForce: 'gtc', outcome: 'NO', side: 'sell', limitPriceCoin: 70 }), 70],
  ];
  it.each(paths)('%o sends limit %i', (t, limit) => {
    const body = placeBodyOf(
      frozen({ terms: t, quote: quote({ protectedLimitPriceCoin: limit }) }),
      ACCOUNT,
    );
    expect(body.limitPriceCoin).toBe(limit);
    expect(body).toMatchObject({
      outcome: t.outcome,
      side: t.side,
      timeInForce: t.timeInForce,
      qty: 2,
      expectedAccountId: ACCOUNT,
    });
  });

  it('sends a budget order its budget and the quote’s limit', () => {
    const body = placeBodyOf(
      frozen({ terms: terms({ qty: undefined, budgetCoin: '100' }) }),
      ACCOUNT,
    );
    expect(body).toEqual({
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 65,
      budgetCoin: '100',
      expectedAccountId: ACCOUNT,
    });
  });

  it('throws on a refused quote, whose limit is the 99 or 1 it was asked with', () => {
    const refused = quote({
      protectedLimitPriceCoin: 99,
      filledQty: 0,
      filledAmountCoin: '0',
      status: 'rejected',
      rejectReason: 'no_quote',
      stop: 'no_quote',
    });
    expect(() => placeBodyOf(frozen({ quote: refused }), ACCOUNT)).toThrow();
    // A status refusal, and an immediate quote that fills nothing whatever its reason.
    expect(() =>
      placeBodyOf(
        frozen({ quote: quote({ rejectReason: 'closed', status: 'rejected' }) }),
        ACCOUNT,
      ),
    ).toThrow();
    expect(() =>
      placeBodyOf(frozen({ quote: quote({ filledQty: 0, filledAmountCoin: '0' }) }), ACCOUNT),
    ).toThrow();
    // A GTC that fills nothing rests: that is no refusal.
    expect(
      placeBodyOf(
        frozen({
          terms: terms({ timeInForce: 'gtc', limitPriceCoin: 40 }),
          quote: quote({ protectedLimitPriceCoin: 40, filledQty: 0, filledAmountCoin: '0' }),
        }),
        ACCOUNT,
      ).limitPriceCoin,
    ).toBe(40);
    expect(quoteRefused({ timeInForce: 'gtc' }, quote({ filledQty: 0 }))).toBe(false);
  });
});

describe('placeOutcomeOf: what an answer settles (ADR-0140 결정 2-5)', () => {
  it('reads back an answer that never came, and a 5xx', () => {
    for (const phase of ['first', 'unknown'] as const) {
      expect(placeOutcomeOf(new TypeError('Failed to fetch'), phase)).toEqual({ next: 'recover' });
      expect(placeOutcomeOf(apiError(500, 'INTERNAL'), phase)).toEqual({ next: 'recover' });
      expect(placeOutcomeOf(new ApiError(502, undefined), phase)).toEqual({ next: 'recover' });
    }
  });

  it('reads back any answer without the API’s envelope: the request may have reached it', () => {
    // A proxy's or gateway's 408 or 499 is not the API's refusal, even on a first send.
    for (const status of [401, 408, 499]) {
      expect(placeOutcomeOf(new ApiError(status, undefined), 'first'), String(status)).toEqual({
        next: 'recover',
      });
    }
  });

  it('reads back a DUPLICATE_REQUEST: the id already names an order', () => {
    expect(placeOutcomeOf(apiError(409, 'DUPLICATE_REQUEST'), 'first')).toEqual({ next: 'lookup' });
    expect(placeOutcomeOf(apiError(409, 'DUPLICATE_REQUEST'), 'unknown')).toEqual({
      next: 'lookup',
    });
  });

  it('settles closed intake and NOT_FOUND either way: they come after the replay check', () => {
    for (const phase of ['first', 'unknown'] as const) {
      expect(placeOutcomeOf(apiError(409, 'ORDER_INTAKE_CLOSED'), phase)).toEqual({
        next: 'failed',
        failure: { code: 'ORDER_INTAKE_CLOSED' },
      });
      expect(placeOutcomeOf(apiError(404, 'NOT_FOUND'), phase)).toMatchObject({ next: 'failed' });
    }
    expect(
      placeOutcomeOf(
        apiError(409, 'ORDER_INTAKE_CLOSED', [{ path: ['priceProtection'], message: 'undecided' }]),
        'first',
      ),
    ).toEqual({ next: 'failed', failure: { code: 'ORDER_INTAKE_CLOSED', noWidth: true } });
  });

  it('settles a first send’s guard refusals, and keeps an unknown one’s request', () => {
    const guards = [
      apiError(401, 'UNAUTHENTICATED'),
      apiError(403, 'FORBIDDEN'),
      apiError(403, 'ONBOARDING_REQUIRED'),
      apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 12 }),
      apiError(403, 'RESTRICTED', { kind: 'account', endsAt: null }),
    ];
    for (const error of guards) {
      expect(placeOutcomeOf(error, 'first'), error.code).toMatchObject({ next: 'failed' });
      // Answered before the id is looked at: after a lost answer it does not say no order exists.
      expect(placeOutcomeOf(error, 'unknown'), error.code).toEqual({ next: 'recover' });
    }
    expect(placeOutcomeOf(guards[3], 'first')).toEqual({
      next: 'failed',
      failure: { code: 'RATE_LIMITED', retryAfterSeconds: 12 },
    });
    expect(placeOutcomeOf(guards[4], 'first')).toEqual({
      next: 'failed',
      failure: { code: 'RESTRICTED', restrictedEndsAt: null },
    });
  });

  it('says which reads a refusal puts out of date, settled or not (결정 2-5·2-22)', () => {
    const another = apiError(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]);
    const expired = apiError(401, 'UNAUTHENTICATED');
    // A resend's 401 and another account's 403 leave the order unknown, and still say so.
    expect(placeOutcomeOf(expired, 'unknown')).toEqual({ next: 'recover' });
    expect(placeOutcomeOf(another, 'unknown')).toEqual({ next: 'recover' });
    expect(authRefreshOf(expired)).toEqual({ session: true, me: false });
    expect(authRefreshOf(another)).toEqual({ session: true, me: true });
    expect(authRefreshOf(apiError(403, 'ONBOARDING_REQUIRED'))).toEqual({
      session: false,
      me: true,
    });
    expect(authRefreshOf(apiError(403, 'FORBIDDEN'))).toEqual({ session: false, me: true });
    for (const error of [
      apiError(429, 'RATE_LIMITED'),
      apiError(403, 'RESTRICTED', { kind: 'account', endsAt: null }),
      apiError(404, 'NOT_FOUND'),
      apiError(500, 'INTERNAL'),
      new ApiError(401, undefined),
      new TypeError('Failed to fetch'),
    ]) {
      expect(authRefreshOf(error)).toEqual({ session: false, me: false });
    }
  });

  it('tells another account’s cookie apart from an admin’s refusal', () => {
    const another = apiError(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]);
    expect(placeOutcomeOf(another, 'first')).toEqual({
      next: 'failed',
      failure: { code: 'FORBIDDEN', anotherAccount: true },
    });
    expect(placeOutcomeOf(apiError(403, 'FORBIDDEN'), 'first')).toEqual({
      next: 'failed',
      failure: { code: 'FORBIDDEN' },
    });
  });

  it('knows the no-width refusal by its path', () => {
    expect(
      noWidthRefusal(
        apiError(409, 'ORDER_INTAKE_CLOSED', [{ path: ['priceProtection'], message: 'undecided' }]),
      ),
    ).toBe(true);
    expect(noWidthRefusal(apiError(409, 'ORDER_INTAKE_CLOSED'))).toBe(false);
    expect(noWidthRefusal(new Error('x'))).toBe(false);
  });
});

describe('orderPanelReducer: the steps (ADR-0140 결정 2-2)', () => {
  const editing: OrderPanelState = { ...INITIAL_ORDER_PANEL, input: input() };
  const confirm = orderPanelReducer(editing, {
    type: 'openConfirm',
    frozen: frozen(),
    requestId: ID_A,
    accountId: ACCOUNT,
  });

  it('makes the request id as 확인 opens, from the action, and freezes the account with it', () => {
    expect(confirm.step).toMatchObject({
      name: 'confirm',
      requestId: ID_A,
      accountId: ACCOUNT,
      requote: null,
    });
    // Only from 입력.
    expect(
      orderPanelReducer(confirm, {
        type: 'openConfirm',
        frozen: frozen(),
        requestId: ID_B,
        accountId: ACCOUNT,
      }),
    ).toBe(confirm);
  });

  it('gives a 다시 견적 a new id, and keeps 주문 제출 off while it runs', () => {
    const running = orderPanelReducer(confirm, { type: 'requoteStart', token: 't1' });
    expect(running.step).toMatchObject({ name: 'confirm', requote: 't1', requestId: ID_A });
    // A submit while it runs names the old id: not this step's to take... and the provider never
    // sends one (`step.requote !== null`).
    const fresh = frozen({ quote: quote({ protectedLimitPriceCoin: 66 }), quotedAt: 2_000 });
    const stale = orderPanelReducer(running, {
      type: 'requoteDone',
      token: 'old',
      frozen: fresh,
      requestId: ID_B,
    });
    expect(stale).toBe(running);
    const done = orderPanelReducer(running, {
      type: 'requoteDone',
      token: 't1',
      frozen: fresh,
      requestId: ID_B,
    });
    expect(done.step).toMatchObject({
      name: 'confirm',
      requestId: ID_B,
      accountId: ACCOUNT,
      requote: null,
      frozen: fresh,
    });
  });

  it('goes back to 입력 on a refused 다시 견적 only from the 확인 that asked (결정 2-2)', () => {
    const running = orderPanelReducer(confirm, { type: 'requoteStart', token: 't1' });
    expect(orderPanelReducer(running, { type: 'requoteRefused', token: 't1' }).step).toEqual({
      name: 'editing',
    });
    // A late refusal of an older 다시 견적 leaves a 확인 opened since where it is.
    expect(orderPanelReducer(running, { type: 'requoteRefused', token: 'old' })).toBe(running);
    expect(orderPanelReducer(confirm, { type: 'requoteRefused', token: 't1' })).toBe(confirm);
    const reopened = orderPanelReducer(orderPanelReducer(running, { type: 'back' }), {
      type: 'openConfirm',
      frozen: frozen(),
      requestId: ID_B,
      accountId: ACCOUNT,
    });
    expect(orderPanelReducer(reopened, { type: 'requoteRefused', token: 't1' })).toBe(reopened);
  });

  it('drops the unsent id on 수정, and any answer for it after', () => {
    const back = orderPanelReducer(confirm, { type: 'back' });
    expect(back.step).toEqual({ name: 'editing' });
    expect(orderPanelReducer(back, { type: 'submit', request: pending() })).toBe(back);
    expect(
      orderPanelReducer(back, { type: 'placed', requestId: ID_A, order: order(), replayed: false }),
    ).toBe(back);
    expect(orderPanelReducer(back, { type: 'requoteFailed', token: 't1' })).toBe(back);
  });

  it('sends from 확인 with its own id only', () => {
    expect(
      orderPanelReducer(confirm, { type: 'submit', request: pending({ requestId: ID_B }) }),
    ).toBe(confirm);
    const sent = orderPanelReducer(confirm, { type: 'submit', request: pending() });
    expect(sent.step).toEqual({ name: 'submitting', request: pending() });
    // Locked while it is in flight: no edit, no contract, no new order.
    expect(orderPanelReducer(sent, { type: 'edit', patch: { qty: '9' } })).toBe(sent);
    expect(orderPanelReducer(sent, { type: 'newOrder' })).toBe(sent);
    expect(orderPanelReducer(sent, { type: 'discard' })).toBe(sent);
  });

  const sent = orderPanelReducer(confirm, { type: 'submit', request: pending() });

  it('shows the server’s order, a replay as an ordinary result', () => {
    const placed = orderPanelReducer(sent, {
      type: 'placed',
      requestId: ID_A,
      order: order(),
      replayed: true,
    });
    expect(placed.step).toEqual({ name: 'result', order: order(), replayed: true });
    // A late refusal never covers the success.
    expect(
      orderPanelReducer(placed, {
        type: 'placeFailed',
        requestId: ID_A,
        outcome: { next: 'failed', failure: { code: 'RATE_LIMITED' } },
        attempt: 'a',
      }),
    ).toBe(placed);
  });

  it('ends a first send’s refusal, and reads back an unknown one with the same request', () => {
    const failed = orderPanelReducer(sent, {
      type: 'placeFailed',
      requestId: ID_A,
      outcome: placeOutcomeOf(apiError(409, 'ORDER_INTAKE_CLOSED'), 'first'),
      attempt: 'a',
    });
    // D12: the input stays.
    expect(failed).toMatchObject({ step: { name: 'failed' }, input: input() });
    const lost = orderPanelReducer(sent, {
      type: 'placeFailed',
      requestId: ID_A,
      outcome: { next: 'recover' },
      attempt: 'a',
    });
    expect(lost.step).toEqual({
      name: 'recovering',
      request: pending({ phase: 'unknown' }),
      attempt: 'a',
      exhausted: false,
    });
    const lookup = orderPanelReducer(sent, {
      type: 'placeFailed',
      requestId: ID_A,
      outcome: { next: 'lookup' },
      attempt: 'a',
    });
    expect(lookup.step).toMatchObject({ name: 'recovering', request: { requestId: ID_A } });
  });

  it('asks a signed-out member to sign in, and hands another account nothing typed', () => {
    const signedOut = orderPanelReducer(sent, {
      type: 'placeFailed',
      requestId: ID_A,
      outcome: { next: 'failed', failure: { code: 'UNAUTHENTICATED' } },
      attempt: 'a',
    });
    expect(signedOut.step).toEqual({ name: 'signIn' });
    const another = orderPanelReducer(sent, {
      type: 'placeFailed',
      requestId: ID_A,
      outcome: { next: 'failed', failure: { code: 'FORBIDDEN', anotherAccount: true } },
      attempt: 'a',
    });
    expect(another.input).toEqual(initialOrderInput('YES'));
  });

  const recovering = orderPanelReducer(sent, {
    type: 'placeFailed',
    requestId: ID_A,
    outcome: { next: 'recover' },
    attempt: 'a',
  });

  it('offers the same request again after three NOT_FOUNDs (owner answer 66-Q2)', () => {
    const unsent = orderPanelReducer(recovering, { type: 'recoverMissed', attempt: 'a' });
    expect(unsent.step).toEqual({ name: 'unsent', request: pending({ phase: 'unknown' }) });
    // 같은 요청 다시 보내기: the same id and body, as an unknown answer's retry — a send of its
    // own (`sendId`), which the step holds from here and a lost answer keeps (결정 2-5).
    const again = pending({ phase: 'unknown', sendId: SEND_B });
    const resent = orderPanelReducer(unsent, { type: 'resend', request: again });
    expect(resent.step).toEqual({ name: 'submitting', request: again });
    const lostAgain = orderPanelReducer(resent, {
      type: 'placeFailed',
      requestId: ID_A,
      outcome: { next: 'recover' },
      attempt: 'b',
    });
    expect(lostAgain.step).toMatchObject({ name: 'recovering', request: again });
    expect(
      orderPanelReducer(unsent, { type: 'resend', request: pending({ requestId: ID_B }) }),
    ).toBe(unsent);
    expect(orderPanelReducer(unsent, { type: 'discard' }).step).toEqual({ name: 'editing' });
  });

  it('stays in the read-back after three failed reads, with 다시 확인', () => {
    const exhausted = orderPanelReducer(recovering, { type: 'recoverExhausted', attempt: 'a' });
    expect(exhausted.step).toMatchObject({ name: 'recovering', exhausted: true });
    // An old attempt's answer is dropped.
    expect(orderPanelReducer(exhausted, { type: 'recoverMissed', attempt: 'old' })).toBe(exhausted);
    const again = orderPanelReducer(exhausted, { type: 'recheck', attempt: 'b' });
    expect(again.step).toMatchObject({ name: 'recovering', attempt: 'b', exhausted: false });
    expect(
      orderPanelReducer(again, { type: 'recovered', attempt: 'b', order: order() }).step,
    ).toEqual({ name: 'result', order: order(), replayed: true });
    // Its end where no panel can offer 다시 확인 (order-recovery.tsx); a running read-back stays.
    expect(orderPanelReducer(exhausted, { type: 'discard' }).step).toEqual({ name: 'editing' });
    expect(orderPanelReducer(again, { type: 'discard' })).toBe(again);
  });

  it('keeps a request in flight when the area goes, and drops what was typed otherwise', () => {
    expect(orderPanelReducer(recovering, { type: 'areaGone' }).step).toBe(recovering.step);
    const gone = orderPanelReducer(confirm, { type: 'areaGone' });
    expect(gone.step).toEqual({ name: 'editing' });
    expect(gone.input).toEqual(initialOrderInput('YES'));
  });

  it('restores a kept input to 입력, never further, and says so until the next edit', () => {
    const restored = orderPanelReducer(INITIAL_ORDER_PANEL, {
      type: 'restore',
      input: input({ outcome: 'NO', qty: '3' }),
      openSheet: true,
    });
    expect(restored).toMatchObject({
      step: { name: 'editing' },
      restored: true,
      sheet: { open: true, contract: 'NO' },
    });
    expect(orderPanelReducer(restored, { type: 'edit', patch: { qty: '4' } }).restored).toBe(false);
  });

  it('hands nothing of one account to the next: 확인, a request and a result go (결정 2-22)', () => {
    for (const before of [confirm, sent, recovering]) {
      const changed = orderPanelReducer(before, { type: 'accountChanged', to: OTHER_ACCOUNT });
      expect(changed.step).toEqual({ name: 'editing' });
      expect(changed.input).toEqual(INITIAL_ORDER_PANEL.input);
      expect(changed.sheet.open).toBe(false);
      // The sender's late answer finds no step to land in.
      expect(
        orderPanelReducer(changed, {
          type: 'placed',
          requestId: ID_A,
          order: order(),
          replayed: false,
        }),
      ).toBe(changed);
      expect(orderPanelReducer(changed, { type: 'recoverMissed', attempt: 'a' })).toBe(changed);
    }
    const result = orderPanelReducer(sent, {
      type: 'placed',
      requestId: ID_A,
      order: order(),
      replayed: false,
    });
    expect(orderPanelReducer(result, { type: 'accountChanged', to: OTHER_ACCOUNT }).step).toEqual({
      name: 'editing',
    });
    // A sign-out is the same reset for every step that holds the account's figures or requests.
    for (const before of [confirm, sent, recovering, result]) {
      const out = orderPanelReducer(before, { type: 'accountChanged', to: null });
      expect(out.step).toEqual({ name: 'editing' });
      expect(out.input).toEqual(INITIAL_ORDER_PANEL.input);
    }
  });

  it('keeps 로그인 안내 when the session runs out at 주문 제출, and only for no one (결정 2-22)', () => {
    const typed = input({ outcome: 'NO', qty: '3' });
    const editing = orderPanelReducer(
      orderPanelReducer(INITIAL_ORDER_PANEL, { type: 'openSheet', outcome: 'NO' }),
      { type: 'edit', patch: typed },
    );
    // The 401's own step: 로그인 안내 (`placeFailed` with UNAUTHENTICATED).
    const signIn = orderPanelReducer(editing, { type: 'signIn' });
    expect(signIn.step).toEqual({ name: 'signIn' });
    // The session read again finds no one: the prompt, the input and the open sheet stay.
    const expired = orderPanelReducer(signIn, { type: 'accountChanged', to: null });
    expect(expired.step).toEqual({ name: 'signIn' });
    expect(expired.input).toEqual(signIn.input);
    expect(expired.sheet).toEqual(signIn.sheet);
    expect(expired.outcomeFocus).toBe(false);
    // Another account signed in instead: nothing of it is handed over.
    const switched = orderPanelReducer(signIn, { type: 'accountChanged', to: OTHER_ACCOUNT });
    expect(switched.step).toEqual({ name: 'editing' });
    expect(switched.input).toEqual(INITIAL_ORDER_PANEL.input);
    expect(switched.sheet.open).toBe(false);
  });

  it('leaves 로그인 안내 once the sign-in comes, with or without a draft (D3·D4)', () => {
    const typed = input({ outcome: 'NO', qty: '3' });
    const signIn = orderPanelReducer(
      orderPanelReducer(INITIAL_ORDER_PANEL, { type: 'edit', patch: typed }),
      { type: 'signIn' },
    );
    // No draft to give back (expired, none, unreadable): 입력 with what was typed, nothing sent.
    const back = orderPanelReducer(signIn, { type: 'signedIn' });
    expect(back.step).toEqual({ name: 'editing' });
    expect(back.input).toEqual(signIn.input);
    // Only 로그인 안내 is left by it.
    expect(orderPanelReducer(confirm, { type: 'signedIn' })).toBe(confirm);
    expect(orderPanelReducer(sent, { type: 'signedIn' })).toBe(sent);
  });

  it('moves the focus to a card only after a press in this tab (결정 2-19)', () => {
    expect(confirm.outcomeFocus).toBe(false);
    expect(sent.outcomeFocus).toBe(true);
    // A page load's read-back of a kept request: no press, no focus.
    const loaded = orderPanelReducer(INITIAL_ORDER_PANEL, {
      type: 'recoverStart',
      request: pending({ phase: 'unknown' }),
      attempt: 'r',
    });
    expect(loaded.outcomeFocus).toBe(false);
    const exhausted = orderPanelReducer(loaded, { type: 'recoverExhausted', attempt: 'r' });
    expect(orderPanelReducer(exhausted, { type: 'recheck', attempt: 's' }).outcomeFocus).toBe(true);
    const unsent = orderPanelReducer(loaded, { type: 'recoverMissed', attempt: 'r' });
    expect(unsent.outcomeFocus).toBe(false);
    expect(
      orderPanelReducer(unsent, { type: 'resend', request: pending({ phase: 'unknown' }) })
        .outcomeFocus,
    ).toBe(true);
  });

  it('opens the sheet on the pressed contract as a buy, and goes back to 입력 from 확인', () => {
    const opened = orderPanelReducer(confirm, { type: 'openSheet', outcome: 'NO' });
    expect(opened).toMatchObject({
      step: { name: 'editing' },
      input: { outcome: 'NO', side: 'buy' },
      sheet: { open: true, contract: 'NO' },
    });
  });
});

describe('whose panel it is (ADR-0140 결정 2-22)', () => {
  it('resets only when a signed-in account gives way to another or to none', () => {
    expect(panelOwnerChanged(ACCOUNT, OTHER_ACCOUNT)).toBe(true);
    expect(panelOwnerChanged(ACCOUNT, null)).toBe(true);
    expect(panelOwnerChanged(ACCOUNT, ACCOUNT)).toBe(false);
    // Still answering (the session or `me` read again): nothing changes yet.
    expect(panelOwnerChanged(ACCOUNT, undefined)).toBe(false);
    // The first account known, and a visitor who signs in (D3 keeps what was typed).
    expect(panelOwnerChanged(undefined, ACCOUNT)).toBe(false);
    expect(panelOwnerChanged(null, ACCOUNT)).toBe(false);
  });

  it('tells a sign-in apart from the first account known (D3·D4)', () => {
    expect(panelSignedIn(null, ACCOUNT)).toBe(true);
    expect(panelSignedIn(undefined, ACCOUNT)).toBe(false);
    expect(panelSignedIn(null, null)).toBe(false);
    expect(panelSignedIn(null, undefined)).toBe(false);
    expect(panelSignedIn(ACCOUNT, OTHER_ACCOUNT)).toBe(false);
  });

  it("locks 주문 제출 for the account and request that took it, never another's (결정 2-4)", () => {
    const held = { account: ACCOUNT, requestId: ID_A };
    expect(sendLocked(null, ACCOUNT)).toBe(false);
    // A second press in the same frame by the same account sends nothing.
    expect(sendLocked(held, ACCOUNT)).toBe(true);
    // A's request still waiting after the page turned to B: B's 주문 제출 goes.
    expect(sendLocked(held, OTHER_ACCOUNT)).toBe(false);
    // Let go by its own request only: A's late `finally` leaves B's newer lock.
    const newer = { account: OTHER_ACCOUNT, requestId: ID_B };
    expect(sendUnlocked(newer, ID_A)).toBe(newer);
    expect(sendUnlocked(newer, ID_B)).toBeNull();
    expect(sendUnlocked(null, ID_A)).toBeNull();
  });

  it('says a failed account read instead of waiting on it for good (결정 2-21)', () => {
    const facts = {
      member: true,
      meAnswered: false,
      meFailed: false,
      meFetching: true,
      restrictionSettled: false,
    };
    expect(accountReadView(facts)).toBe('pending');
    // `GET /me` failed (a 429 among them) and nothing is asking again: said, with 다시 시도.
    expect(accountReadView({ ...facts, meFailed: true, meFetching: false })).toBe('failed');
    // 다시 시도 running: pending again.
    expect(accountReadView({ ...facts, meFailed: true, meFetching: true })).toBe('pending');
    // `me` answered: the restriction's answer or failure is all that is waited on.
    expect(accountReadView({ ...facts, meAnswered: true, meFailed: true })).toBe('pending');
    expect(accountReadView({ ...facts, meAnswered: true, restrictionSettled: true })).toBe('ready');
    expect(accountReadView({ ...facts, member: false })).toBe('ready');
  });

  it('reads back, sends again or drops a request only for the account that sent it', () => {
    expect(requestOwnedBy(pending(), ACCOUNT)).toBe(true);
    expect(requestOwnedBy(pending(), OTHER_ACCOUNT)).toBe(false);
    expect(requestOwnedBy(pending(), undefined)).toBe(false);
  });
});

describe('orderBlock: the line that keeps 주문 확인 off (ADR-0140 결정 2-9)', () => {
  const facts = {
    input: input(),
    quote: undefined,
    noWidth: false,
    bestOpposite: 60,
    account: null,
    unlockedQty: undefined,
  } as const;
  const none = quote({ filledQty: 0, filledAmountCoin: '0', status: 'rejected' });

  it('names the account first (D13)', () => {
    expect(orderBlock({ ...facts, account: 'admin', noWidth: true })).toBe('admin');
    expect(orderBlock({ ...facts, account: 'restricted' })).toBe('restricted');
  });

  it('blocks an IOC on a market with no width, never a GTC', () => {
    expect(orderBlock({ ...facts, noWidth: true })).toBe('no_width');
    expect(
      orderBlock({ ...facts, input: input({ kind: 'gtc', limit: '40' }), noWidth: true }),
    ).toBe(null);
  });

  it('says 호가 없음 from the book before a quote, then follows the quote', () => {
    expect(orderBlock({ ...facts, bestOpposite: null })).toBe('no_quote');
    expect(orderBlock({ ...facts, bestOpposite: undefined })).toBeNull();
    // Once a quote answered, the quote decides: a fill is no block, whatever the book said.
    expect(orderBlock({ ...facts, bestOpposite: null, quote: quote() })).toBeNull();
  });

  it('words a budget order by the quote’s reason, never by budget ÷ price', () => {
    const budget = input({ size: 'budget', budget: '30' });
    expect(
      orderBlock({ ...facts, input: budget, quote: { ...none, rejectReason: 'no_quote' } }),
    ).toBe('no_quote');
    expect(
      orderBlock({ ...facts, input: budget, quote: { ...none, rejectReason: 'budget_too_small' } }),
    ).toBe('budget_too_small');
  });

  it('keeps an IOC that fills nothing off whatever its reason (D9)', () => {
    expect(orderBlock({ ...facts, quote: { ...none, rejectReason: 'price_limit' } })).toBe(
      'price_limit',
    );
    expect(orderBlock({ ...facts, quote: { ...none, rejectReason: 'self_trade' } })).toBe(
      'self_trade',
    );
    expect(
      orderBlock({ ...facts, quote: { ...none, rejectReason: null, stop: 'price_limit' } }),
    ).toBe('price_limit');
    expect(orderBlock({ ...facts, quote: { ...none, rejectReason: null, stop: null } })).toBe(
      'no_quote',
    );
  });

  it('blocks a sell over the unlocked holding, and one with nothing to sell (D11)', () => {
    const sell = input({ side: 'sell', qty: '3' });
    expect(orderBlock({ ...facts, input: sell, unlockedQty: 0 })).toBe('sell_none');
    expect(orderBlock({ ...facts, input: sell, unlockedQty: 2 })).toBe('insufficient_contracts');
    expect(orderBlock({ ...facts, input: sell, unlockedQty: 3 })).toBeNull();
    // A visitor's sell is quoted, not judged: no holding is known.
    expect(orderBlock({ ...facts, input: sell, unlockedQty: undefined })).toBeNull();
  });
});

describe('coinShortfall and quoteStatusReason', () => {
  it('tells a buy whose whole lock is above the available Coin, in bigint', () => {
    expect(coinShortfall(quote({ maxSpendCoin: '130' }), '100')).toEqual({
      availableCoin: 100n,
      needCoin: 130n,
    });
    expect(coinShortfall(quote({ maxSpendCoin: '130' }), '130')).toBeNull();
    expect(coinShortfall(quote({ maxSpendCoin: null }), '0')).toBeNull();
    expect(coinShortfall(undefined, '0')).toBeNull();
    expect(coinShortfall(quote(), undefined)).toBeNull();
  });

  it('turns a status refusal into the input-closed line', () => {
    expect(quoteStatusReason(quote({ rejectReason: 'closed' }))).toBe('closed');
    expect(quoteStatusReason(quote({ rejectReason: 'paused' }))).toBe('paused');
    expect(quoteStatusReason(quote({ rejectReason: 'no_quote' }))).toBeNull();
    expect(quoteStatusReason(undefined)).toBeNull();
  });
});

describe('the book beside the panel (D2, D7)', () => {
  const yes: OrderBookContract = {
    outcome: 'YES',
    asks: [{ priceCoin: 60, qty: 1 }],
    bids: [{ priceCoin: 40, qty: 3 }],
    bestAskCoin: 60,
    bestBidCoin: 40,
  };
  const no: OrderBookContract = {
    outcome: 'NO',
    asks: [],
    bids: [],
    bestAskCoin: null,
    bestBidCoin: null,
  };
  const bookOf = (first: OrderBookContract): OrderBook => ({
    marketId: '22222222-2222-4222-8222-222222222222',
    marketRejectReason: null,
    contracts: [first, no],
  });
  const book = bookOf(yes);

  it('prices a buy at the best ask and a sell at the best bid, null for none', () => {
    expect(bestPriceOf(book, 'YES', 'buy')).toBe(60);
    expect(bestPriceOf(book, 'YES', 'sell')).toBe(40);
    expect(bestPriceOf(book, 'NO', 'buy')).toBeNull();
    expect(bestPriceOf(undefined, 'YES', 'buy')).toBeUndefined();
  });

  it('compares one side level by level', () => {
    const one = [{ priceCoin: 60, qty: 1 }];
    expect(bookSideChanged(one, [{ priceCoin: 60, qty: 1 }])).toBe(false);
    expect(bookSideChanged(one, [{ priceCoin: 60, qty: 2 }])).toBe(true);
    expect(bookSideChanged(one, [{ priceCoin: 61, qty: 1 }])).toBe(true);
    expect(bookSideChanged(one, [])).toBe(true);
  });

  it('reads a quote whose baseline is unknown again once the book is known (결정 2-13)', () => {
    const one = [{ priceCoin: 60, qty: 1 }];
    // A quote that answered before the first `/book` did: it may predate this liquidity.
    expect(sideMovedSinceQuote(undefined, one)).toBe(true);
    expect(sideMovedSinceQuote(undefined, [])).toBe(true);
    // No book yet, or none any more: nothing to compare.
    expect(sideMovedSinceQuote(undefined, undefined)).toBe(false);
    expect(sideMovedSinceQuote(one, undefined)).toBe(false);
    // A known baseline: the deep compare.
    expect(sideMovedSinceQuote(one, [{ priceCoin: 60, qty: 1 }])).toBe(false);
    expect(sideMovedSinceQuote(one, [{ priceCoin: 60, qty: 2 }])).toBe(true);
    // And through `requoteNext`, under the same limits.
    expect(
      requoteNext({
        sideChanged: sideMovedSinceQuote(undefined, one),
        lastAttemptAt: undefined,
        inFlight: false,
        now: 1,
        panelVisible: true,
        tabVisible: true,
        inputValid: true,
      }),
    ).toEqual({ next: 'now' });
  });

  it('takes the first read after the quote as the baseline, then says the chosen side moved', () => {
    const confirm = orderPanelReducer(
      { ...INITIAL_ORDER_PANEL, input: input() },
      {
        type: 'openConfirm',
        frozen: frozen({ quotedAt: 1_000 }),
        requestId: ID_A,
        accountId: ACCOUNT,
      },
    );
    // A read that answered before the quote is no baseline.
    expect(bookWatch(confirm.step, book, 900)).toBeNull();
    const baseline = bookWatch(confirm.step, book, 1_100);
    expect(baseline).toEqual({ type: 'baseline', requestId: ID_A, levels: yes.asks });
    const watched = orderPanelReducer(confirm, baseline ?? { type: 'back' });
    expect(bookWatch(watched.step, book, 1_200)).toBeNull();
    // The other side moving is not this order's.
    expect(bookWatch(watched.step, bookOf({ ...yes, bids: [] }), 1_300)).toBeNull();
    const asksMoved = bookOf({ ...yes, asks: [{ priceCoin: 60, qty: 4 }] });
    const changed = bookWatch(watched.step, asksMoved, 1_400);
    expect(changed).toEqual({ type: 'bookChanged', requestId: ID_A });
    const told = orderPanelReducer(watched, changed ?? { type: 'back' });
    expect(told.step).toMatchObject({ bookChanged: true, frozen: frozen({ quotedAt: 1_000 }) });
    expect(bookWatch(told.step, asksMoved, 1_500)).toBeNull();
  });
});

describe('requoteNext: a book move reads the quote again only within limits (결정 2-13)', () => {
  const now = 100_000;
  const facts = {
    sideChanged: true,
    lastAttemptAt: now - REQUOTE_MIN_GAP_MS,
    inFlight: false,
    now,
    panelVisible: true,
    tabVisible: true,
    inputValid: true,
  };

  it('reads now only with all of them, and nothing for a move it has no reason to read on', () => {
    expect(requoteNext(facts)).toEqual({ next: 'now' });
    expect(requoteNext({ ...facts, lastAttemptAt: undefined })).toEqual({ next: 'now' });
    expect(requoteNext({ ...facts, sideChanged: false })).toEqual({ next: 'none' });
    expect(requoteNext({ ...facts, panelVisible: false })).toEqual({ next: 'none' });
    expect(requoteNext({ ...facts, tabVisible: false })).toEqual({ next: 'none' });
    expect(requoteNext({ ...facts, inputValid: false })).toEqual({ next: 'none' });
  });

  it('keeps a move inside the gap for a trailing read at its end, not dropped', () => {
    // '호가 없음', then liquidity 1 s later and no move after it: read at the gap's end.
    expect(requoteNext({ ...facts, lastAttemptAt: now - 1_000 })).toEqual({
      next: 'wait',
      ms: REQUOTE_MIN_GAP_MS - 1_000,
    });
    expect(requoteNext({ ...facts, lastAttemptAt: now - REQUOTE_MIN_GAP_MS + 1 })).toEqual({
      next: 'wait',
      ms: 1,
    });
  });

  it('counts the gap from the last read started, and never reads beside one in flight', () => {
    // A read that failed or is slow left the last answer old: the gap still counts from its
    // start, so book moves every 3 s do not ask every 3 s.
    expect(requoteNext({ ...facts, lastAttemptAt: now - 3_000 })).toMatchObject({ next: 'wait' });
    expect(requoteNext({ ...facts, inFlight: true })).toEqual({ next: 'afterFetch' });
    expect(requoteNext({ ...facts, inFlight: true, lastAttemptAt: now - 60_000 })).toEqual({
      next: 'afterFetch',
    });
    expect(requoteNext({ ...facts, inFlight: true, sideChanged: false })).toEqual({ next: 'none' });
  });

  it('asks at most twelve times a minute, inside the tab budget of fifty', () => {
    expect(60_000 / REQUOTE_MIN_GAP_MS).toBe(12);
    expect(60_000 / REQUOTE_MIN_GAP_MS).toBeLessThanOrEqual(50);
  });
});

describe('debouncer: a burst of keystrokes asks for one quote', () => {
  it('settles on the last value once none has come for the delay, and not after a cancel', () => {
    vi.useFakeTimers();
    try {
      const settled: string[] = [];
      const debounce = debouncer<string>(QUOTE_DEBOUNCE_MS, (value) => {
        settled.push(value);
      });
      debounce.push('1');
      vi.advanceTimersByTime(QUOTE_DEBOUNCE_MS - 1);
      debounce.push('12');
      vi.advanceTimersByTime(QUOTE_DEBOUNCE_MS - 1);
      debounce.push('123');
      vi.advanceTimersByTime(QUOTE_DEBOUNCE_MS - 1);
      expect(settled).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(settled).toEqual(['123']);
      // An unmount drops the wait in progress.
      debounce.push('1234');
      debounce.cancel();
      vi.advanceTimersByTime(QUOTE_DEBOUNCE_MS * 2);
      expect(settled).toEqual(['123']);
    } finally {
      vi.useRealTimers();
    }
  });
});
