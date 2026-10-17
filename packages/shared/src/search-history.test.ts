import { describe, expect, it } from 'vitest';
import { MARKET_SEARCH_TERM_MAX } from './constants.js';
import { findPrivateField } from './guards/private-data.js';
import { marketListQuerySchema, marketSearchTermSchema } from './market.js';
import {
  RECENT_SEARCHES_LIMIT,
  recentSearchSchema,
  recordSearchBodySchema,
  searchHistoryWriteBodySchema,
} from './search-history.js';

const accountId = 'user-a';

describe('the recent list (#15, ADR-0066)', () => {
  it('holds the newest 10 distinct terms (ADR-0061 decision 3, the #15 row)', () => {
    expect(RECENT_SEARCHES_LIMIT).toBe(10);
  });

  it('answers an id to delete by, the term and its time — and no filter or result count', () => {
    // The owner keeps neither the filters picked nor how many results came back.
    expect(Object.keys(recentSearchSchema.shape).sort()).toEqual(['id', 'query', 'searchedAt']);
    const entry = {
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      query: '금리',
      searchedAt: '2026-10-16T00:00:00.000Z',
    };
    expect(recentSearchSchema.parse(entry)).toEqual(entry);
  });

  it('names its own shape as search history: no public answer could carry it', () => {
    // The owner-only route answers it; on a public route the `search-history` item refuses
    // these names (registry.test.ts reads every public answer's fields).
    expect(findPrivateField('searchHistory').map((hit) => hit.item)).toContain('search-history');
    expect(findPrivateField('searchedAt').map((hit) => hit.item)).toContain('search-history');
  });
});

describe('recordSearchBodySchema', () => {
  it('takes the GET /markets term, trimmed and bounded the same way', () => {
    expect(
      recordSearchBodySchema.parse({ query: '  금리 인상 ', expectedAccountId: accountId }),
    ).toEqual({ query: '금리 인상', expectedAccountId: accountId });
    expect(recordSearchBodySchema.shape.query).toBe(marketSearchTermSchema);
    expect(marketListQuerySchema.shape.q.unwrap()).toBe(marketSearchTermSchema);
    const term = 'x'.repeat(MARKET_SEARCH_TERM_MAX);
    expect(recordSearchBodySchema.parse({ query: term, expectedAccountId: accountId }).query).toBe(
      term,
    );
  });

  it('refuses a blank or over-long term, and a body without the account', () => {
    for (const query of ['', '   ', 'x'.repeat(MARKET_SEARCH_TERM_MAX + 1)]) {
      expect(
        recordSearchBodySchema.safeParse({ query, expectedAccountId: accountId }).success,
        JSON.stringify(query),
      ).toBe(false);
    }
    expect(recordSearchBodySchema.safeParse({ query: '금리' }).success).toBe(false);
    expect(recordSearchBodySchema.safeParse({ query: '금리', expectedAccountId: '' }).success).toBe(
      false,
    );
  });
});

describe('searchHistoryWriteBodySchema', () => {
  it('is the account on screen and nothing else', () => {
    expect(searchHistoryWriteBodySchema.parse({ expectedAccountId: accountId })).toEqual({
      expectedAccountId: accountId,
    });
    expect(searchHistoryWriteBodySchema.safeParse({}).success).toBe(false);
    expect(Object.keys(searchHistoryWriteBodySchema.shape)).toEqual(['expectedAccountId']);
  });
});
