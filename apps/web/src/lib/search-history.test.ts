import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type RecentSearch } from './api';
import {
  afterSearchHistoryWrite,
  searchHistoryFailureMessage,
  undoSearchHistoryWrite,
} from './search-history';

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

describe('undoSearchHistoryWrite', () => {
  const at = (id: string, query: string, searchedAt: string): RecentSearch => ({
    id,
    query,
    searchedAt,
  });
  const a = at('a', '금리', '2026-10-16T03:00:00.000Z');
  const b = at('b', '환율', '2026-10-16T02:00:00.000Z');
  const c = at('c', '유가', '2026-10-16T01:00:00.000Z');
  const before = [a, b, c];

  it('puts back only what the failed write hid, at its old place', () => {
    // A second delete (of b) is still in flight and has hidden b: undoing the delete of a must
    // not bring b back with it.
    expect(undoSearchHistoryWrite([c], [a], before)).toEqual([a, c]);
    expect(undoSearchHistoryWrite([], [a, b, c], before)).toEqual(before);
    expect(undoSearchHistoryWrite([a, c], [b], before)).toEqual(before);
  });

  it('keeps the old places even where the list held a tie in another order', () => {
    const same = '2026-10-16T00:00:00.000Z';
    const x = at('x', '하나', same);
    const y = at('y', '둘', same);
    expect(undoSearchHistoryWrite([y], [x], [x, y])).toEqual([x, y]);
  });

  it('adds nothing twice: an entry already back, or its term back under a newer search', () => {
    expect(undoSearchHistoryWrite([a, c], [a], before)).toEqual([a, c]);
    const again = at('a2', '금리', '2026-10-16T04:00:00.000Z');
    expect(undoSearchHistoryWrite([again], [a], before)).toEqual([again]);
  });

  it('goes by the server order once a read brought entries the press did not see', () => {
    const fresh = at('d', '물가', '2026-10-16T05:00:00.000Z');
    expect(undoSearchHistoryWrite([fresh, c], [b], before)).toEqual([fresh, b, c]);
    const same = '2026-10-16T00:00:00.000Z';
    // A tie of times: the larger id first, as the server orders it.
    expect(
      undoSearchHistoryWrite([at('x', '하나', same)], [at('y', '둘', same)], [at('y', '둘', same)]),
    ).toEqual([at('y', '둘', same), at('x', '하나', same)]);
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
