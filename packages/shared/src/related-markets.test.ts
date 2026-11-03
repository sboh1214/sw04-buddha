import { describe, expect, it } from 'vitest';
import { adminAccountActorSchema } from './admin-accounts.js';
import { ADMIN_ACTION_TYPES } from './enums.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import {
  PUBLIC_MARKET_STATUSES,
  adminMarketListQuerySchema,
  marketSummarySchema,
} from './market.js';
import {
  RELATED_MARKET_STATUSES,
  isRelatedMarketShown,
  adminRelatedMarketSchema,
  linkRelatedMarketBodySchema,
  relatedMarketPair,
} from './related-markets.js';

const A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('RELATED_MARKET_STATUSES', () => {
  it('is every public status but cancelled (ADR-0093 decision 3, the #174 row)', () => {
    const shown: readonly string[] = RELATED_MARKET_STATUSES;
    expect(PUBLIC_MARKET_STATUSES.filter((status) => !shown.includes(status))).toEqual([
      'cancelled',
    ]);
  });

  it('leaves out a market whose result is VOID, in any status, and a hidden one', () => {
    expect(isRelatedMarketShown({ status: 'settled', resolvedResult: 'YES' })).toBe(true);
    expect(isRelatedMarketShown({ status: 'open', resolvedResult: null })).toBe(true);
    expect(isRelatedMarketShown({ status: 'provisional', resolvedResult: 'VOID' })).toBe(false);
    expect(isRelatedMarketShown({ status: 'settled', resolvedResult: 'VOID' })).toBe(false);
    expect(isRelatedMarketShown({ status: 'cancelled', resolvedResult: null })).toBe(false);
    expect(isRelatedMarketShown({ status: 'review', resolvedResult: null })).toBe(false);
  });
});

describe('relatedMarketPair', () => {
  it('stores the unordered pair once, smaller id first, whichever side it is linked from', () => {
    expect(relatedMarketPair(A, B)).toEqual({ lowMarketId: A, highMarketId: B });
    expect(relatedMarketPair(B, A)).toEqual({ lowMarketId: A, highMarketId: B });
  });

  it('compares the canonical lower-case form, so a case does not make a second pair', () => {
    expect(relatedMarketPair(B.toUpperCase(), A)).toEqual({ lowMarketId: A, highMarketId: B });
  });

  it('is no pair for a market and itself', () => {
    expect(relatedMarketPair(A, A)).toBeUndefined();
    expect(relatedMarketPair(A, A.toUpperCase())).toBeUndefined();
  });
});

describe('linkRelatedMarketBodySchema', () => {
  const account = { expectedAccountId: 'admin-1' } as const;

  it('takes one market id, lower-cased on the way in, and the admin on screen', () => {
    expect(linkRelatedMarketBodySchema.parse({ marketId: B.toUpperCase(), ...account })).toEqual({
      marketId: B,
      ...account,
    });
    expect(
      linkRelatedMarketBodySchema.safeParse({ marketId: 'not-a-uuid', ...account }).success,
    ).toBe(false);
    expect(linkRelatedMarketBodySchema.safeParse({ ...account }).success).toBe(false);
    // ADR-0092: the admin on screen is required.
    expect(linkRelatedMarketBodySchema.safeParse({ marketId: B }).success).toBe(false);
  });
});

describe('adminRelatedMarketSchema', () => {
  it('is the list row with who linked it and when, nothing more (actor and time only)', () => {
    const extra = Object.keys(adminRelatedMarketSchema.shape).filter(
      (key) => !(key in marketSummarySchema.shape),
    );
    expect(extra.sort()).toEqual(['linkedAt', 'linkedBy']);
  });

  it('names the linking admin by id and nickname, as every admin record does (owner decision 2026-10-17)', () => {
    expect(Object.keys(adminRelatedMarketSchema.shape.linkedBy.shape).sort()).toEqual([
      'id',
      'nickname',
    ]);
    expect(adminRelatedMarketSchema.shape.linkedBy).toBe(adminAccountActorSchema);
  });
});

describe('the audit types and the admin search', () => {
  it('records a link and an unlink as their own admin action types (#65)', () => {
    expect(ADMIN_ACTION_TYPES).toContain('market_link');
    expect(ADMIN_ACTION_TYPES).toContain('market_unlink');
    for (const name of ['market_link', 'market_unlink', 'relatedMarketId', 'linkedBy']) {
      expect(findExcludedIdentifier(name, 'api')).toEqual([]);
    }
  });

  it('lets the admin list search titles, trimmed, like the public list', () => {
    expect(adminMarketListQuerySchema.parse({ q: ' 기준금리 ' })).toEqual({
      limit: 20,
      q: '기준금리',
    });
    expect(adminMarketListQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });
});
