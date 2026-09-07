import {
  MAX_P_AMOUNT,
  ORDER_QTY_MAX,
  QUOTE_VALUE_MAX_LENGTH,
  TRADE_MIN_SHARES,
  tradeBodySchema,
} from '@buddha/shared';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type QuoteResult, type TradeBody } from './api';
import {
  INITIAL_TRADE_INPUTS,
  type TradeInputs,
  type TradePanelInput,
  type TradePanelView,
  isTradable,
  maxValueFor,
  quoteErrorMessage,
  quoteRequest,
  setMode,
  setOutcome,
  setSide,
  setValue,
  tradeCta,
  tradeErrorMessage,
  tradePanelView,
  tradeRequest,
  tradeSummary,
} from './trade-panel';

const RUNS = { numRuns: 1000 };

const MARKET_ID = '9f3c0d3e-5f6a-4b2c-8d1e-7a6b5c4d3e2f';
const ACCOUNT_ID = 'user_1';
const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const CLOSE_AT = '2026-12-31T14:59:00.000Z';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

/** 100 contracts of 예 at 63.00, so 맞히면 10,000P and 예상 수익 3,700P. */
const aQuote = (over: Partial<QuoteResult> = {}): QuoteResult => ({
  shares: 100,
  amountP: '6300',
  priceAvgBp: 6300,
  priceBeforeBp: 6250,
  priceAfterBp: 6350,
  maxPayoutP: '10000',
  ...over,
});

/**
 * A buy of 10,000P worth on an open market, signed in and funded: the `ready` row.
 *
 * `quotedValue` defaults to whatever value the test put in the field — the settled state, where
 * the debounce has caught up — so a test that wants the quote to belong to another amount has to
 * say so, which is exactly the case that must never reach a wire body.
 */
const anInput = (over: Partial<TradePanelInput> = {}): TradePanelInput => {
  const inputs: TradeInputs = over.inputs ?? {
    side: 'buy',
    outcome: 'YES',
    mode: 'spend',
    value: '10000',
  };
  return {
    market: { id: MARKET_ID, status: 'open', closeAt: CLOSE_AT },
    inputs,
    quote: aQuote(),
    quotedValue: inputs.value,
    quoteError: null,
    stale: false,
    accountId: ACCOUNT_ID,
    sessionPending: false,
    availableP: 1_000_000n,
    heldQty: 0,
    submitting: false,
    reconfirmFrom: undefined,
    now: NOW,
    ...over,
  };
};

/** Selling 100 held contracts: mode is always 'shares' on the sell tab. */
const aSellInput = (over: Partial<TradePanelInput> = {}): TradePanelInput =>
  anInput({
    inputs: { side: 'sell', outcome: 'YES', mode: 'shares', value: '100' },
    quote: aQuote({ maxPayoutP: '0' }),
    heldQty: 100,
    ...over,
  });

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('the input reducer', () => {
  it('starts on 예를 P 금액으로 매수', () => {
    expect(INITIAL_TRADE_INPUTS).toEqual({
      side: 'buy',
      outcome: 'YES',
      mode: 'spend',
      value: '',
    });
  });

  it('forces mode `shares` and clears the value when the sell tab is picked', () => {
    // quoteBodySchema's first refine rejects spend + sell naming `mode`, so the toggle is
    // hidden on that tab and the state must never be able to hold that pair.
    const inputs: TradeInputs = { side: 'buy', outcome: 'NO', mode: 'spend', value: '10000' };
    expect(setSide(inputs, 'sell')).toEqual({
      side: 'sell',
      outcome: 'NO',
      mode: 'shares',
      value: '',
    });
  });

  it('keeps the mode but clears the value when the buy tab is picked', () => {
    // "10 contracts to sell" and "10 to buy" are different intents, and the held cap that
    // bounded the number no longer applies.
    const inputs: TradeInputs = { side: 'sell', outcome: 'YES', mode: 'shares', value: '100' };
    expect(setSide(inputs, 'buy')).toEqual({
      side: 'buy',
      outcome: 'YES',
      mode: 'shares',
      value: '',
    });
  });

  it('keeps the value across an outcome switch', () => {
    // Comparing 예 and 아니오 at the same amount is the core interaction (PLAN 11.1-2):
    // clearing here would make the comparison two extra taps every time.
    const inputs: TradeInputs = { side: 'buy', outcome: 'YES', mode: 'spend', value: '10000' };
    expect(setOutcome(inputs, 'NO')).toEqual({ ...inputs, outcome: 'NO' });
    expect(setOutcome(setOutcome(inputs, 'NO'), 'YES')).toEqual(inputs);
  });

  it('clears the value when the unit changes', () => {
    const inputs: TradeInputs = { side: 'buy', outcome: 'YES', mode: 'spend', value: '10000' };
    expect(setMode(inputs, 'shares')).toEqual({ ...inputs, mode: 'shares', value: '' });
  });

  it('keeps only digits, drops leading zeros and truncates at the schema bound', () => {
    const inputs = INITIAL_TRADE_INPUTS;
    expect(setValue(inputs, '1,234').value).toBe('1234');
    expect(setValue(inputs, '12.5').value).toBe('125');
    expect(setValue(inputs, ' 10 000 P ').value).toBe('10000');
    expect(setValue(inputs, '-40').value).toBe('40');
    expect(setValue(inputs, 'abc').value).toBe('');
    expect(setValue(inputs, '007').value).toBe('7');
    expect(setValue(inputs, '000').value).toBe('0');
    // A lone zero survives: the view answers it with an explanation rather than swallowing
    // the keystroke, and the next digit strips it anyway.
    expect(setValue(inputs, '0').value).toBe('0');
    expect(setValue(inputs, '05').value).toBe('5');
    // An inputMode="numeric" field still receives pastes.
    expect(setValue(inputs, '9'.repeat(40)).value).toBe('9'.repeat(QUOTE_VALUE_MAX_LENGTH));
    expect(setValue(inputs, `${'0'.repeat(30)}42`).value).toBe('42');
  });

  it('never lets a keystroke produce a value the schema would refuse for its length', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const { value } = setValue(INITIAL_TRADE_INPUTS, raw);
        expect(value.length).toBeLessThanOrEqual(QUOTE_VALUE_MAX_LENGTH);
        expect(value === '' || /^(0|[1-9]\d*)$/.test(value)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('maxValueFor', () => {
  const sell: TradeInputs = { ...INITIAL_TRADE_INPUTS, side: 'sell', mode: 'shares' };
  const spend: TradeInputs = { ...INITIAL_TRADE_INPUTS, side: 'buy', mode: 'spend' };

  it('never offers a sell quantity the schema would refuse', () => {
    // THE BUG: a position accumulates across orders up to POSITION_QTY_MAX, but ORDER_QTY_MAX
    // is the ceiling on ONE order. Offering the whole holding wrote a number `quoteRequest`
    // answers undefined for, so pressing 최대 left the panel on `invalid` — no quote, no
    // submit, and 계약 수를 확인해 주세요 under a number the panel itself had filled in.
    const held = ORDER_QTY_MAX + 1;
    expect(maxValueFor({ inputs: sell, heldQty: held, availableP: 1n })).toBe(
      String(ORDER_QTY_MAX),
    );
    // Whatever it offers must be quotable, which is the property the chip exists for.
    const offered = maxValueFor({ inputs: sell, heldQty: held, availableP: 1n });
    expect(quoteRequest(MARKET_ID, { ...sell, value: offered ?? '' }, true)).toBeDefined();
  });

  it('offers the whole holding while it fits in one order', () => {
    expect(maxValueFor({ inputs: sell, heldQty: 7, availableP: 1n })).toBe('7');
    expect(maxValueFor({ inputs: sell, heldQty: ORDER_QTY_MAX, availableP: 1n })).toBe(
      String(ORDER_QTY_MAX),
    );
  });

  it('offers no ceiling it does not know, and none worth pressing', () => {
    // `undefined` is 아직 모름 (the list has not loaded) and 0 is 보유 없음: neither is a
    // number to fill in, and `no_position` is what the panel says about the second.
    expect(maxValueFor({ inputs: sell, heldQty: undefined, availableP: 1n })).toBeUndefined();
    expect(maxValueFor({ inputs: sell, heldQty: 0, availableP: 1n })).toBeUndefined();
    expect(maxValueFor({ inputs: spend, heldQty: 5, availableP: undefined })).toBeUndefined();
    expect(maxValueFor({ inputs: spend, heldQty: 5, availableP: 0n })).toBeUndefined();
  });

  it('caps a spend-mode buy at the balance and offers nothing for a count buy', () => {
    expect(maxValueFor({ inputs: spend, heldQty: 5, availableP: 12_345n })).toBe('12345');
    // Buying a COUNT has no ceiling this side of a quote, so there is no chip at all.
    const countBuy: TradeInputs = { ...INITIAL_TRADE_INPUTS, side: 'buy', mode: 'shares' };
    expect(maxValueFor({ inputs: countBuy, heldQty: 5, availableP: 12_345n })).toBeUndefined();
  });
});

describe('isTradable', () => {
  it('is true only for an open market whose close time is still ahead', () => {
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      expect(isTradable({ status: 'open', closeAt: CLOSE_AT }, NOW), tz).toBe(true);
      // A-M3-31: a seeded market past its close time stays `open` and the server answers
      // MARKET_CLOSED, so the status alone is not the question.
      expect(isTradable({ status: 'open', closeAt: '2026-09-07T11:59:59.000Z' }, NOW), tz).toBe(
        false,
      );
      expect(isTradable({ status: 'closed', closeAt: CLOSE_AT }, NOW), tz).toBe(false);
    }
  });

  it('does not invent a refusal for a close time it cannot read', () => {
    expect(isTradable({ status: 'open', closeAt: 'not-a-date' }, NOW)).toBe(true);
  });
});

describe('quoteRequest', () => {
  const inputs = (over: Partial<TradeInputs> = {}): TradeInputs => ({
    ...INITIAL_TRADE_INPUTS,
    mode: 'shares',
    value: '100',
    ...over,
  });

  it('builds the body for askable inputs', () => {
    expect(quoteRequest(MARKET_ID, inputs(), true)).toEqual({
      marketId: MARKET_ID,
      outcome: 'YES',
      side: 'buy',
      mode: 'shares',
      value: '100',
    });
  });

  it('lower-cases the market id, so the quote key is the id every row carries', () => {
    // A-M3-29: uuidSchema's `.toLowerCase()` is why the panel does not have to remember to
    // canonicalise an id that reached the screen in another case.
    const body = quoteRequest(MARKET_ID.toUpperCase(), inputs(), true);
    expect(body?.marketId).toBe(MARKET_ID);
  });

  it('asks for nothing on a market that cannot be traded', () => {
    expect(quoteRequest(MARKET_ID, inputs(), false)).toBeUndefined();
  });

  it('refuses a value outside the mode’s range without a round trip', () => {
    expect(quoteRequest(MARKET_ID, inputs({ value: '' }), true)).toBeUndefined();
    expect(quoteRequest(MARKET_ID, inputs({ value: '0' }), true)).toBeUndefined();
    expect(quoteRequest(MARKET_ID, inputs({ value: '1000001' }), true)).toBeUndefined();
    expect(quoteRequest(MARKET_ID, inputs({ value: '1000000' }), true)).toBeDefined();
    expect(quoteRequest(MARKET_ID, inputs({ mode: 'spend', value: '0' }), true)).toBeUndefined();
    expect(quoteRequest(MARKET_ID, inputs({ mode: 'spend', value: '1' }), true)).toBeDefined();
  });

  it('refuses spend + sell, the pair the schema names `mode`', () => {
    expect(
      quoteRequest(MARKET_ID, inputs({ side: 'sell', mode: 'spend', value: '10000' }), true),
    ).toBeUndefined();
    expect(
      quoteRequest(MARKET_ID, inputs({ side: 'sell', mode: 'shares', value: '100' }), true),
    ).toBeDefined();
  });

  it('refuses an id that is not a uuid', () => {
    expect(quoteRequest('not-a-uuid', inputs(), true)).toBeUndefined();
  });
});

describe('tradeRequest', () => {
  const inputs: TradeInputs = { side: 'buy', outcome: 'YES', mode: 'shares', value: '100' };
  const build = (over: Partial<TradeInputs>, quote = aQuote()) =>
    tradeRequest({
      marketId: MARKET_ID,
      inputs: { ...inputs, ...over },
      quote,
      accountId: ACCOUNT_ID,
    });

  it('sends a buy with maxCostP and never the sell guard', () => {
    expect(build({})).toEqual({
      marketId: MARKET_ID,
      outcome: 'YES',
      side: 'buy',
      shares: 100,
      expectedAccountId: ACCOUNT_ID,
      maxCostP: '6363',
    });
    expect(build({})).not.toHaveProperty('minProceedsP');
  });

  it('sends a sell with minProceedsP and never the buy guard', () => {
    expect(build({ side: 'sell' })).toEqual({
      marketId: MARKET_ID,
      outcome: 'YES',
      side: 'sell',
      shares: 100,
      expectedAccountId: ACCOUNT_ID,
      minProceedsP: '6237',
    });
    expect(build({ side: 'sell' })).not.toHaveProperty('maxCostP');
  });

  it('caps a spend-mode buy at the budget the user typed', () => {
    // "never charge me more than the number I typed" — the tolerance may not exceed it.
    expect(build({ mode: 'spend', value: '6320' })?.maxCostP).toBe('6320');
    // A budget above the 1% ceiling changes nothing.
    expect(build({ mode: 'spend', value: '999999' })?.maxCostP).toBe('6363');
  });

  it('sends P as decimal strings, so the body survives JSON.stringify', () => {
    // The wire type is components['schemas']['TradeBody'], never z.infer of tradeBodySchema,
    // whose maxCostP is a bigint after the input transform.
    const body = build({});
    expect(typeof body?.maxCostP).toBe('string');
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it('refuses to trade a quote that buys nothing', () => {
    // A-M3-1: a spend below one contract answers shares 0, amountP '0'.
    expect(
      build({ mode: 'spend', value: '1' }, aQuote({ shares: 0, amountP: '0' })),
    ).toBeUndefined();
  });

  it('cannot build a body tradeBodySchema refuses, for any inputs the panel can produce', () => {
    // THE load-bearing assertion: the four refines at market.ts:238-253 (a buy needs maxCostP,
    // a sell needs minProceedsP, neither may carry the other's) hold by construction, so the
    // panel can never be one keystroke away from a 400.
    fc.assert(
      fc.property(
        fc.uuid({ version: 4 }),
        fc.constantFrom('YES' as const, 'NO' as const),
        fc.constantFrom(
          { side: 'buy' as const, mode: 'spend' as const },
          { side: 'buy' as const, mode: 'shares' as const },
          { side: 'sell' as const, mode: 'shares' as const },
        ),
        fc.bigInt({ min: 1n, max: MAX_P_AMOUNT }),
        fc.integer({ min: TRADE_MIN_SHARES, max: ORDER_QTY_MAX }),
        fc.bigInt({ min: 0n, max: MAX_P_AMOUNT }),
        (marketId, outcome, { side, mode }, budgetP, shares, amountP) => {
          const value = mode === 'spend' ? budgetP.toString() : String(shares);
          const quote = aQuote({ shares, amountP: amountP.toString() });
          const body = tradeRequest({
            marketId,
            inputs: { side, outcome, mode, value },
            quote,
            accountId: ACCOUNT_ID,
          });
          expect(body).toBeDefined();
          expect(tradeBodySchema.safeParse(body).success).toBe(true);
          expect('maxCostP' in (body ?? {})).toBe(side === 'buy');
          expect('minProceedsP' in (body ?? {})).toBe(side === 'sell');
        },
      ),
      RUNS,
    );
  });
});

describe('tradeSummary', () => {
  const buy: TradeInputs = { side: 'buy', outcome: 'YES', mode: 'spend', value: '10000' };

  it('reads a buy as contracts, average price, payout and profit', () => {
    expect(tradeSummary(buy, aQuote(), false)).toEqual({
      shares: 100,
      priceAvgBp: 6300,
      amountP: 6300n,
      maxPayoutP: 10000n,
      profitP: 3700n,
      priceAfterBp: 6350,
      guardP: 6363n,
      guardKind: 'maxCost',
      stale: false,
    });
  });

  it('shows the sell guard as the floor on the proceeds', () => {
    // A sell quote answers maxPayoutP '0' (there is no payout leg), which is why the renderer
    // shows 맞히면 지급 / 예상 수익 only when the guard is a maxCost.
    const summary = tradeSummary(
      { side: 'sell', outcome: 'YES', mode: 'shares', value: '100' },
      aQuote({ maxPayoutP: '0' }),
      false,
    );
    expect(summary.guardKind).toBe('minProceeds');
    expect(summary.guardP).toBe(6237n);
    expect(summary.maxPayoutP).toBe(0n);
  });

  it('discloses the budget cap, not a tolerance the trade would not carry', () => {
    expect(tradeSummary({ ...buy, value: '6320' }, aQuote(), false).guardP).toBe(6320n);
  });

  it('carries `stale` so the numbers can be dimmed without being withheld', () => {
    expect(tradeSummary(buy, aQuote(), true).stale).toBe(true);
  });
});

describe('tradePanelView', () => {
  it('shows the market before anything else when it is not open', () => {
    const market = { id: MARKET_ID, status: 'settled' as const, closeAt: CLOSE_AT };
    expect(tradePanelView(anInput({ market }))).toEqual({ kind: 'not_open', status: 'settled' });
  });

  it('shows 마감 for an open market whose close time has passed, quote or not', () => {
    // A-M3-31 again, and the reason step 2 exists at all: the status still says `open`, so a
    // status-only gate would offer a panel that cannot trade.
    const closeAt = new Date(NOW - 1000).toISOString();
    const market = { id: MARKET_ID, status: 'open' as const, closeAt };
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      expect(tradePanelView(anInput({ market })), tz).toEqual({ kind: 'past_close' });
    }
  });

  it('rests on an empty field instead of calling it an error', () => {
    expect(tradePanelView(anInput({ inputs: { ...INITIAL_TRADE_INPUTS } }))).toEqual({
      kind: 'empty',
    });
  });

  it('explains an unaskable amount in the unit the field is in', () => {
    const spend = anInput({ inputs: { side: 'buy', outcome: 'YES', mode: 'spend', value: '0' } });
    expect(tradePanelView(spend)).toEqual({ kind: 'invalid', message: copy.errTradeAmount });
    const shares = anInput({
      inputs: { side: 'buy', outcome: 'YES', mode: 'shares', value: '1000001' },
    });
    expect(tradePanelView(shares)).toEqual({ kind: 'invalid', message: copy.errTradeShares });
  });

  it('refuses a hopeless sell before it costs a round trip', () => {
    // Step 5 runs before the quote is consulted, so a held-nothing sell never issues one.
    expect(tradePanelView(aSellInput({ heldQty: 0 }))).toEqual({ kind: 'no_position' });
  });

  it('reports a failed quote with the market’s own reason', () => {
    const view = tradePanelView(anInput({ quoteError: apiError(409, 'MARKET_CLOSED') }));
    expect(view).toEqual({ kind: 'quote_failed', message: copy.errTradeClosed });
  });

  it('waits while the quote is pending or is another intent’s placeholder', () => {
    expect(tradePanelView(anInput({ quote: undefined }))).toEqual({ kind: 'quoting' });
  });

  it('never prices the field against a quote asked for another amount', () => {
    // The quote is keyed on the DEBOUNCED value (PLAN 11.4's 300ms), so for the length of that
    // window the held answer belongs to an amount the trader has already typed past. Pairing the
    // two builds a trade nobody saw priced, and both modes fail differently.
    //
    // 'shares': the guard comes from the OLD cost and there is no budget to clamp it, so the
    // server fills the old contract count — 1,000 for ~50,120P with `100` in the field.
    const shares = anInput({
      inputs: { side: 'buy', outcome: 'YES', mode: 'shares', value: '100' },
      quotedValue: '1000',
      quote: aQuote({ shares: 1000, amountP: '50120', maxPayoutP: '100000' }),
    });
    expect(tradePanelView(shares)).toEqual({ kind: 'quoting' });

    // 'spend': the freshly typed budget clamps `maxCostP` below the old quote's own `amountP`,
    // which trade.service.ts answers with PRICE_MOVED — for a price that never moved.
    const spend = anInput({
      inputs: { side: 'buy', outcome: 'YES', mode: 'spend', value: '1000' },
      quotedValue: '10000',
      quote: aQuote({ shares: 199, amountP: '9987' }),
    });
    expect(tradePanelView(spend)).toEqual({ kind: 'quoting' });

    // Once the debounce has caught up there is one intent again, and the body carries the guard
    // the summary discloses: a 1,000P budget on a 998P quote.
    const settled = anInput({
      inputs: { side: 'buy', outcome: 'YES', mode: 'spend', value: '1000' },
      quote: aQuote({ shares: 19, amountP: '998', maxPayoutP: '1900' }),
    });
    expect(tradePanelView(settled)).toMatchObject({
      kind: 'ready',
      summary: { amountP: 998n, guardP: 1000n },
      body: { shares: 19, maxCostP: '1000' },
    });
  });

  it('says a spend below one contract is too small, before any session check', () => {
    const view = tradePanelView(
      anInput({
        quote: aQuote({ shares: 0, amountP: '0', maxPayoutP: '0' }),
        accountId: undefined,
        sessionPending: true,
        availableP: 0n,
      }),
    );
    expect(view).toEqual({ kind: 'too_small' });
  });

  it('holds the submitting and reconfirm phases above every pre-flight check', () => {
    const submitting = tradePanelView(anInput({ submitting: true, availableP: 0n }));
    expect(submitting.kind).toBe('submitting');
    const reconfirm = tradePanelView(anInput({ reconfirmFrom: 6200n, availableP: 0n }));
    expect(reconfirm).toMatchObject({ kind: 'reconfirm', previousAmountP: 6200n });
  });

  it('separates a session still loading from a visitor who is not signed in', () => {
    // Sending expectedAccountId: undefined is not an option, so the disabled phase is its own.
    expect(tradePanelView(anInput({ sessionPending: true, accountId: undefined })).kind).toBe(
      'session_pending',
    );
    const anonymous = tradePanelView(anInput({ accountId: undefined, availableP: undefined }));
    expect(anonymous.kind).toBe('anonymous');
    // The whole calculator works signed out: POST /quotes is public.
    expect(anonymous).toMatchObject({ summary: { shares: 100, amountP: 6300n } });
  });

  it('shows what the contracts are worth even when more are being sold than are held', () => {
    const view = tradePanelView(aSellInput({ heldQty: 50 }));
    expect(view).toMatchObject({ kind: 'over_position', heldQty: 50 });
    expect(view).toMatchObject({ summary: { guardKind: 'minProceeds' } });
  });

  it('names the shortfall so the one 충전하기 path can be rendered', () => {
    const view = tradePanelView(anInput({ availableP: 100n }));
    expect(view).toMatchObject({ kind: 'short', shortfallP: 6200n });
  });

  it('does not check a balance it does not know', () => {
    expect(tradePanelView(anInput({ availableP: undefined })).kind).toBe('ready');
  });

  it('builds the wire body once every check has passed', () => {
    const view = tradePanelView(anInput());
    expect(view).toMatchObject({
      kind: 'ready',
      body: {
        marketId: MARKET_ID,
        outcome: 'YES',
        side: 'buy',
        shares: 100,
        expectedAccountId: ACCOUNT_ID,
        maxCostP: '6363',
      },
    });
  });

  it('dims but never blocks on a stale quote', () => {
    // A busy market would otherwise become unbuyable: every trade by anyone moves the price.
    const view = tradePanelView(anInput({ stale: true }));
    expect(view.kind).toBe('ready');
    expect(view).toMatchObject({ summary: { stale: true } });
  });
});

describe('tradeCta', () => {
  const summary = tradeSummary(
    { side: 'buy', outcome: 'YES', mode: 'spend', value: '10000' },
    aQuote(),
    false,
  );
  const body: TradeBody = {
    marketId: MARKET_ID,
    outcome: 'YES',
    side: 'buy',
    shares: 100,
    expectedAccountId: ACCOUNT_ID,
    maxCostP: '6363',
  };

  it('puts the amount on the button when the trade can be sent', () => {
    // The label is `${copy.tradeBuy} · ${formatP(amountP)}`: the press is informed, which is
    // why there is no confirmation modal on top of it.
    expect(tradeCta({ kind: 'ready', summary, body })).toEqual({ kind: 'submit', amountP: 6300n });
  });

  it('loads rather than disappears while the answer is unknown', () => {
    // The useCharge().ready precedent: a button that is replaced shifts the layout under the
    // thumb that is about to press it.
    expect(tradeCta({ kind: 'submitting', summary })).toEqual({ kind: 'pending' });
    expect(tradeCta({ kind: 'session_pending', summary })).toEqual({ kind: 'pending' });
  });

  it('asks for a second press only after the server said the price moved', () => {
    expect(tradeCta({ kind: 'reconfirm', summary, previousAmountP: 6200n })).toEqual({
      kind: 'reconfirm',
    });
  });

  it('sends a visitor to login and a funded-short user to 충전하기', () => {
    expect(tradeCta({ kind: 'anonymous', summary })).toEqual({ kind: 'login' });
    expect(tradeCta({ kind: 'short', summary, shortfallP: 6200n })).toEqual({
      kind: 'charge',
      shortfallP: 6200n,
    });
  });

  it('is disabled for every phase with nothing to send', () => {
    const disabled: TradePanelView[] = [
      { kind: 'not_open', status: 'closed' },
      { kind: 'past_close' },
      { kind: 'empty' },
      { kind: 'invalid', message: copy.errTradeAmount },
      { kind: 'no_position' },
      { kind: 'quote_failed', message: copy.errTradeQuote },
      { kind: 'quoting' },
      { kind: 'too_small' },
      { kind: 'over_position', summary, heldQty: 50 },
    ];
    for (const view of disabled) {
      expect(tradeCta(view), view.kind).toEqual({ kind: 'disabled' });
    }
  });
});

describe('tradeErrorMessage', () => {
  it('maps every refusal the trade route can answer', () => {
    expect(tradeErrorMessage(apiError(409, 'PRICE_MOVED'))).toBe(copy.tradeReconfirm);
    expect(tradeErrorMessage(apiError(409, 'INSUFFICIENT_BALANCE'))).toBe(copy.errTradeBalance);
    expect(tradeErrorMessage(apiError(409, 'INSUFFICIENT_POSITION'))).toBe(copy.errTradePosition);
    expect(tradeErrorMessage(apiError(409, 'MARKET_CLOSED'))).toBe(copy.errTradeClosed);
    expect(tradeErrorMessage(apiError(409, 'MARKET_NOT_OPEN'))).toBe(copy.errMarketNotOpen);
    expect(tradeErrorMessage(apiError(404, 'NOT_FOUND'))).toBe(copy.errTradeNotFound);
    expect(tradeErrorMessage(apiError(401, 'UNAUTHENTICATED'))).toBe(copy.errUnauthenticated);
  });

  it('recognises the trade’s DUPLICATE_REQUEST, which carries no details', () => {
    // Verified in trade.service.ts replay(): the only trade DUPLICATE_REQUEST is thrown with a
    // message alone. A concurrent twin is replayed, never refused, so the charge route's
    // `Idempotency-Key` details row does not exist here.
    expect(tradeErrorMessage(apiError(409, 'DUPLICATE_REQUEST'))).toBe(copy.errTradeDuplicate);
    expect(
      tradeErrorMessage(
        apiError(409, 'DUPLICATE_REQUEST', [{ path: ['Idempotency-Key'], message: 'in progress' }]),
      ),
    ).toBe(copy.errTradeDuplicate);
  });

  it('tells the two FORBIDDEN failures apart by the field they name', () => {
    expect(
      tradeErrorMessage(
        apiError(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another account' }]),
      ),
    ).toBe(copy.sessionChanged);
    // No field: the CSRF refusal, which is not something the user changed accounts to fix.
    expect(tradeErrorMessage(apiError(403, 'FORBIDDEN'))).toBe(copy.errUnknown);
    expect(
      tradeErrorMessage(apiError(403, 'FORBIDDEN', [{ path: ['origin'], message: 'bad origin' }])),
    ).toBe(copy.errUnknown);
  });

  it('only names the contract ceiling for the VALIDATION_ERROR that is about it', () => {
    expect(
      tradeErrorMessage(apiError(400, 'VALIDATION_ERROR', [{ path: ['shares'], message: 'max' }])),
    ).toBe(copy.errTradeSharesMax);
    // A body the client should never have built: nothing the user can act on.
    expect(
      tradeErrorMessage(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['Idempotency-Key'], message: 'invalid' }]),
      ),
    ).toBe(copy.errUnknown);
    expect(
      tradeErrorMessage(apiError(400, 'VALIDATION_ERROR', [{ path: ['maxCostP'], message: 'x' }])),
    ).toBe(copy.errUnknown);
    expect(tradeErrorMessage(apiError(400, 'VALIDATION_ERROR'))).toBe(copy.errUnknown);
  });

  it('falls back for a transport failure and anything that is not an ApiError', () => {
    expect(tradeErrorMessage(new TypeError('Failed to fetch'))).toBe(copy.errUnknown);
    expect(tradeErrorMessage(apiError(500, 'INTERNAL'))).toBe(copy.errUnknown);
    expect(tradeErrorMessage(undefined)).toBe(copy.errUnknown);
  });
});

describe('quoteErrorMessage', () => {
  it('passes the market’s own reasons through', () => {
    expect(quoteErrorMessage(apiError(409, 'MARKET_CLOSED'))).toBe(copy.errTradeClosed);
    expect(quoteErrorMessage(apiError(409, 'MARKET_NOT_OPEN'))).toBe(copy.errMarketNotOpen);
    expect(quoteErrorMessage(apiError(404, 'NOT_FOUND'))).toBe(copy.errTradeNotFound);
  });

  it('says only that the quote failed for anything else', () => {
    // The body was built by quoteRequest, so a VALIDATION_ERROR here is a client bug, and the
    // route is public — there is no 로그인 to suggest.
    expect(quoteErrorMessage(apiError(400, 'VALIDATION_ERROR'))).toBe(copy.errTradeQuote);
    expect(quoteErrorMessage(apiError(500, 'INTERNAL'))).toBe(copy.errTradeQuote);
    expect(quoteErrorMessage(new TypeError('Failed to fetch'))).toBe(copy.errTradeQuote);
  });
});
