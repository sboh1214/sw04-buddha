import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type RecentSearch } from './api';
import { afterSearchHistoryWrite, searchHistoryFailureMessage } from './search-history';

const entry = (id: string, query: string): RecentSearch => ({
  id,
  query,
  searchedAt: '2026-10-16T00:00:00.000Z',
});

const LIST = [entry('a', '금리'), entry('b', '환율'), entry('c', '유가')];

describe('afterSearchHistoryWrite', () => {
  it('drops the one entry a delete names, and keeps the others in their order', () => {
    expect(
      afterSearchHistoryWrite(LIST, { kind: 'delete', id: 'b', expectedAccountId: 'u' }),
    ).toEqual([entry('a', '금리'), entry('c', '유가')]);
    // An entry no longer on the list (another tab deleted it): nothing changes.
    expect(
      afterSearchHistoryWrite(LIST, { kind: 'delete', id: 'z', expectedAccountId: 'u' }),
    ).toEqual(LIST);
  });

  it('leaves nothing for a delete-all', () => {
    expect(afterSearchHistoryWrite(LIST, { kind: 'clear', expectedAccountId: 'u' })).toEqual([]);
  });
});

describe('searchHistoryFailureMessage', () => {
  it('says the delete did not happen, or that the session is another account’s now', () => {
    expect(searchHistoryFailureMessage(new TypeError('Failed to fetch'))).toBe(
      copy.recentSearchDeleteFailed,
    );
    expect(
      searchHistoryFailureMessage(
        new ApiError(403, {
          code: 'FORBIDDEN',
          message: 'x',
          details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
        }),
      ),
    ).toBe(copy.sessionChanged);
    // A CSRF 403 names no field: it is not "another account".
    expect(
      searchHistoryFailureMessage(new ApiError(403, { code: 'FORBIDDEN', message: 'x' })),
    ).toBe(copy.recentSearchDeleteFailed);
  });
});
