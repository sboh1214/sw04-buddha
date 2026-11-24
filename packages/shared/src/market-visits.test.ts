import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { findExcludedIdentifier } from './guards/excluded.js';
import * as shared from './index.js';
import { recordMarketVisitBodySchema } from './market-visits.js';

const MARKET = '0b9c3c1e-6f0e-4d3a-9a51-1c2d3e4f5a6b';

describe('RecordMarketVisitBody (#151, ADR-0170)', () => {
  it('takes exactly the account on screen and the market, nothing about the open itself', () => {
    expect(Object.keys(recordMarketVisitBodySchema.shape)).toEqual([
      'expectedAccountId',
      'marketId',
    ]);
    expect(z.globalRegistry.get(recordMarketVisitBodySchema)?.id).toBe('RecordMarketVisitBody');
    expect(shared.recordMarketVisitBodySchema).toBe(recordMarketVisitBodySchema);
    const body = { expectedAccountId: 'account-a', marketId: MARKET };
    expect(recordMarketVisitBodySchema.parse(body)).toEqual(body);
  });

  it('lower-cases the market id, as every uuid the request supplies', () => {
    expect(
      recordMarketVisitBodySchema.parse({
        expectedAccountId: 'account-a',
        marketId: MARKET.toUpperCase(),
      }).marketId,
    ).toBe(MARKET);
  });

  it('refuses a missing or bad field and anything more — no date, time, page or referrer (151-3)', () => {
    const body = { expectedAccountId: 'account-a', marketId: MARKET };
    const broken: unknown[] = [
      {},
      { marketId: MARKET },
      { expectedAccountId: 'account-a' },
      { ...body, expectedAccountId: '' },
      { ...body, expectedAccountId: 'a'.repeat(256) },
      { ...body, marketId: 'not-a-uuid' },
      { ...body, marketId: 'some-slug' },
      { ...body, visitDate: '2026-11-24' },
      { ...body, visitedAt: '2026-11-24T00:00:00.000Z' },
      { ...body, referrer: 'https://example.com' },
    ];
    for (const value of broken) {
      expect(recordMarketVisitBodySchema.safeParse(value).success, JSON.stringify(value)).toBe(
        false,
      );
    }
  });

  it('names nothing an attendance feature would (no check in, attendance, streak or bonus)', () => {
    for (const name of [
      'RecordMarketVisitBody',
      'recordMarketVisitBodySchema',
      'recordMyMarketVisit',
      'recordMarketVisit',
      'market-visits',
      '/me/market-visits',
      'market_visits',
      'visit_date',
      'market_visit_collection',
      'marketVisits',
      'marketVisitCollection',
      'retention.market_visits',
    ]) {
      for (const surface of ['api', 'route', 'storage'] as const) {
        expect(findExcludedIdentifier(name, surface), `${surface} ${name}`).toEqual([]);
      }
      expect(findExcludedIdentifier(name, 'route', { path: true }), name).toEqual([]);
    }
  });
});
