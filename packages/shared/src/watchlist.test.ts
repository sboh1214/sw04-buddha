import { describe, expect, it } from 'vitest';
import { MARKET_SORTS, PUBLIC_MARKET_STATUSES, marketListQuerySchema } from './market.js';
import { findPrivateField } from './guards/private-data.js';
import {
  DEFAULT_WATCHLIST_SORT,
  WATCHLIST_SORTS,
  WATCH_EVENT_ACTIONS,
  updateWatchBodySchema,
  watchStateSchema,
  watchlistQuerySchema,
} from './watchlist.js';

describe('WATCH_EVENT_ACTIONS', () => {
  it('records a watch and its end, nothing else (#95)', () => {
    expect(WATCH_EVENT_ACTIONS).toEqual(['watch', 'unwatch']);
  });
});

describe('watchlistQuerySchema', () => {
  it('pages newest watch first with no filter by default: every public status, ended ones too', () => {
    // No status default, unlike `GET /markets` (open): an ended market stays on the list until
    // the member removes it (ADR-0061 decision 3, #89).
    expect(watchlistQuerySchema.parse({})).toEqual({ limit: 20, sort: 'watched' });
    expect(
      watchlistQuerySchema.parse({
        status: 'closed',
        category: ' weather ',
        sort: 'closing',
        limit: '5',
        cursor: 'c',
      }),
    ).toEqual({ status: 'closed', category: 'weather', sort: 'closing', limit: 5, cursor: 'c' });
    for (const status of PUBLIC_MARKET_STATUSES) {
      expect(watchlistQuerySchema.parse({ status }).status).toBe(status);
    }
  });

  it('takes a public status only and the category slug GET /markets takes', () => {
    expect(watchlistQuerySchema.safeParse({ status: 'draft' }).success).toBe(false);
    expect(watchlistQuerySchema.safeParse({ category: '' }).success).toBe(false);
    expect(watchlistQuerySchema.safeParse({ category: 'x'.repeat(51) }).success).toBe(false);
    expect(watchlistQuerySchema.shape.category.unwrap()).toBe(
      marketListQuerySchema.shape.category.unwrap(),
    );
  });

  it('orders by the newest watch by default, or by any public order (#63, ADR-0065)', () => {
    // ADR-0061 decision 3, the #63 row: 추천 · 신규 · 마감 임박 and 최근 관심 등록 순, which a
    // watchlist alone has and which it starts on. The public three are the same values, so the
    // home passes the select's value through unchanged.
    expect(WATCHLIST_SORTS).toEqual(['watched', ...MARKET_SORTS]);
    expect(DEFAULT_WATCHLIST_SORT).toBe('watched');
    for (const sort of WATCHLIST_SORTS) {
      expect(watchlistQuerySchema.parse({ sort }).sort).toBe(sort);
    }
    expect(watchlistQuerySchema.safeParse({ sort: 'volume' }).success).toBe(false);
    // `watched` is the watchlist's own: the public list does not know it.
    expect(marketListQuerySchema.safeParse({ sort: 'watched' }).success).toBe(false);
    expect(Object.keys(watchlistQuerySchema.shape).sort()).toEqual(
      ['category', 'cursor', 'limit', 'sort', 'status'].sort(),
    );
  });
});

describe('watchStateSchema', () => {
  it('is the caller’s own yes or no, and no count', () => {
    expect(watchStateSchema.parse({ watched: true })).toEqual({ watched: true });
    expect(watchStateSchema.safeParse({ watched: 'yes' }).success).toBe(false);
    expect(Object.keys(watchStateSchema.shape)).toEqual(['watched']);
  });

  it('names what PRIVATE_DATA keeps out of every public shape (#37)', () => {
    // The owner-only answer may say it; a public one never may (ADR-0064).
    expect(findPrivateField('watched').map((hit) => hit.item)).toEqual(['watchlist']);
  });
});

describe('updateWatchBodySchema', () => {
  const account = { expectedAccountId: 'user-1' };

  it('sets the state either way', () => {
    expect(updateWatchBodySchema.parse({ watched: true, ...account })).toEqual({
      watched: true,
      ...account,
    });
    expect(updateWatchBodySchema.parse({ watched: false, ...account })).toEqual({
      watched: false,
      ...account,
    });
  });

  it('requires the state, so a forgotten field is never read as either', () => {
    for (const body of [account, { watched: null, ...account }, { watched: 'true', ...account }]) {
      const parsed = updateWatchBodySchema.safeParse(body);
      expect({ body, success: parsed.success }).toEqual({ body, success: false });
      expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['watched']]);
    }
  });

  it('requires the account the screen shows, as the verification and time-zone bodies do (A-PG-24)', () => {
    for (const body of [
      { watched: true },
      { watched: true, expectedAccountId: '' },
      { watched: true, expectedAccountId: 'a'.repeat(256) },
      { watched: true, expectedAccountId: 7 },
    ]) {
      const parsed = updateWatchBodySchema.safeParse(body);
      expect({ body, success: parsed.success }).toEqual({ body, success: false });
      expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    }
  });
});
