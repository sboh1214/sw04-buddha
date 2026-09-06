/**
 * `POST /quotes` (PLAN 7.1, M3 design 3.2) against the docker `test` profile: the answer is
 * the shared engine on the stored state, both modes, and the market-state refusals a trade
 * shares (MARKET_NOT_OPEN, MARKET_CLOSED, draft → NOT_FOUND). Skips when TEST_* are unset.
 */
import { createCategory, createMarket, createUser } from '@buddha/db/test';
import {
  ORDER_QTY_MAX,
  quoteBuy,
  quoteSell,
  sharesForSpend,
  type LmsrState,
  type QuoteResult,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { lmsrStateOf } from './market.service.js';

describe.skipIf(!hasTestInfra)('quotes (integration)', () => {
  let t: TestApp;
  let creatorId: string;
  let categoryId: number;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    creatorId = (await createUser(t.db, { role: 'admin' })).user.id;
    categoryId = (await createCategory(t.db)).id;
  });

  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: creatorId, categoryId, ...input });

  /** No cookie, no Origin: the route is public and has no CSRF surface (no session to ride). */
  const quote = (payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/quotes',
      headers: { 'content-type': 'application/json' },
      payload,
    });

  it('prices a buy in shares mode exactly as the shared engine does on the stored state', async () => {
    // Off-centre and traded: the answer must come from the stored q, not from (p0, b).
    const row = await market({ initialProbBp: 3_000, liquidityB: 500, qYes: 120, qNo: -40 });
    const state: LmsrState = lmsrStateOf(row);
    const expected = quoteBuy(state, 'YES', 250);

    const res = await quote({
      marketId: row.id,
      outcome: 'YES',
      side: 'buy',
      mode: 'shares',
      value: '250',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: QuoteResult }>().data).toEqual({
      shares: 250,
      amountP: expected.amountP.toString(),
      priceAvgBp: expected.priceAvgBp,
      priceBeforeBp: expected.priceBeforeBp,
      priceAfterBp: expected.priceAfterBp,
      maxPayoutP: '25000',
    });
    expect(expected.priceAfterBp).toBeGreaterThan(expected.priceBeforeBp);

    // The NO side of the same state moves the price the other way.
    const no = await quote({
      marketId: row.id,
      outcome: 'NO',
      side: 'buy',
      mode: 'shares',
      value: '250',
    });
    const noQuote = no.json<{ data: QuoteResult }>().data;
    expect(noQuote.amountP).toBe(quoteBuy(state, 'NO', 250).amountP.toString());
    expect(noQuote.priceAfterBp).toBeLessThan(noQuote.priceBeforeBp);
  });

  it('prices a sell without a position or a login, with no payout', async () => {
    const row = await market({ qYes: 300, qNo: 100 });
    const expected = quoteSell(lmsrStateOf(row), 'YES', 100);
    const res = await quote({
      marketId: row.id,
      outcome: 'YES',
      side: 'sell',
      mode: 'shares',
      value: '100',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: QuoteResult }>().data).toEqual({
      shares: 100,
      amountP: expected.amountP.toString(),
      priceAvgBp: expected.priceAvgBp,
      priceBeforeBp: expected.priceBeforeBp,
      priceAfterBp: expected.priceAfterBp,
      maxPayoutP: '0',
    });
    expect(expected.priceAfterBp).toBeLessThan(expected.priceBeforeBp);
  });

  it('spend mode answers the most contracts the budget buys, and zero when it buys none', async () => {
    const row = await market();
    const state = lmsrStateOf(row);
    const spend = 5_000n;
    const shares = sharesForSpend(state, 'YES', spend);
    expect(shares).toBeGreaterThan(0);

    const res = await quote({
      marketId: row.id,
      outcome: 'YES',
      side: 'buy',
      mode: 'spend',
      value: spend.toString(),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json<{ data: QuoteResult }>().data;
    const exact = quoteBuy(state, 'YES', shares);
    expect(data).toEqual({
      shares,
      amountP: exact.amountP.toString(),
      priceAvgBp: exact.priceAvgBp,
      priceBeforeBp: exact.priceBeforeBp,
      priceAfterBp: exact.priceAfterBp,
      maxPayoutP: (BigInt(shares) * 100n).toString(),
    });
    // Exact: this many fit the budget, one more does not.
    expect(BigInt(data.amountP)).toBeLessThanOrEqual(spend);
    expect(quoteBuy(state, 'YES', shares + 1).amountP).toBeGreaterThan(spend);

    // At 50% one contract costs about 50P: 1P buys nothing, and the price stays put.
    const nothing = await quote({
      marketId: row.id,
      outcome: 'YES',
      side: 'buy',
      mode: 'spend',
      value: '1',
    });
    expect(nothing.statusCode).toBe(200);
    expect(nothing.json<{ data: QuoteResult }>().data).toEqual({
      shares: 0,
      amountP: '0',
      priceAvgBp: 5_000,
      priceBeforeBp: 5_000,
      priceAfterBp: 5_000,
      maxPayoutP: '0',
    });
  });

  it('refuses spend on a sell naming the mode, and values out of range naming value', async () => {
    const row = await market();
    const base = { marketId: row.id, outcome: 'YES', side: 'sell', mode: 'spend', value: '100' };
    const spendSell = await quote(base);
    expect(spendSell.statusCode).toBe(400);
    expect(spendSell.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['mode'] }] },
    });

    for (const value of ['0', '1.5', '-3', String(ORDER_QTY_MAX + 1), 'ten']) {
      const res = await quote({ ...base, side: 'buy', mode: 'shares', value });
      expect({ value, status: res.statusCode }).toEqual({ value, status: 400 });
      const details = res.json<{ error: { details: { path: string[] }[] } }>().error.details;
      expect(details.some((issue) => issue.path[0] === 'value')).toBe(true);
    }
    expect((await quote({ ...base, side: 'buy', mode: 'spend', value: '0' })).statusCode).toBe(400);
    expect((await quote({ marketId: 'nope' })).statusCode).toBe(400);
  });

  it('answers MARKET_NOT_OPEN, MARKET_CLOSED or NOT_FOUND for a market not taking orders', async () => {
    const body = (marketId: string) => ({
      marketId,
      outcome: 'YES',
      side: 'buy',
      mode: 'shares',
      value: '10',
    });

    const closed = await market({ status: 'closed' });
    const notOpen = await quote(body(closed.id));
    expect(notOpen.statusCode).toBe(409);
    expect(notOpen.json()).toMatchObject({ error: { code: 'MARKET_NOT_OPEN' } });
    for (const status of ['resolving', 'settled', 'voided'] as const) {
      const other = await market({ status });
      const refused = await quote(body(other.id));
      expect({ status, code: refused.statusCode }).toEqual({ status, code: 409 });
      expect(refused.json()).toMatchObject({ error: { code: 'MARKET_NOT_OPEN' } });
    }

    // Open, but its close time has passed and the close job has not run yet.
    const expired = await market({ closeAt: new Date(Date.now() - 60_000) });
    const pastClose = await quote(body(expired.id));
    expect(pastClose.statusCode).toBe(409);
    expect(pastClose.json()).toMatchObject({ error: { code: 'MARKET_CLOSED' } });

    // A draft is invisible to the public: the same 404 as a market that does not exist.
    const draft = await market({ status: 'draft' });
    for (const marketId of [draft.id, randomUUID()]) {
      const res = await quote(body(marketId));
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });
});
