import { RECENT_PERIODS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { MY_HISTORY_PATH } from './my';
import {
  DEFAULT_HISTORY_FILTERS,
  HISTORY_KINDS,
  HISTORY_PAGE,
  historyFiltersFromSearchParams,
  historyListFilters,
  historyMarketTitle,
  isHistoryFiltered,
  myHistoryPath,
} from './my-history';

/**
 * 거래·정산 이력's address (#124, ADR-0143 결정 6): `/my/history?kind=&period=&market=`,
 * normalised once on the server and written by every control of the screen.
 */

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('historyFiltersFromSearchParams', () => {
  it('opens on 주문, the whole history and no market', () => {
    expect(historyFiltersFromSearchParams({})).toEqual({ kind: 'orders' });
    expect(DEFAULT_HISTORY_FILTERS).toEqual({ kind: 'orders' });
    expect(HISTORY_KINDS).toEqual(['orders', 'fills', 'settlements']);
    expect(HISTORY_PAGE).toBe(20);
  });

  it('takes each kind, each fixed period and a market uuid, lower-cased', () => {
    for (const kind of HISTORY_KINDS) {
      expect(historyFiltersFromSearchParams({ kind }).kind).toBe(kind);
    }
    for (const period of RECENT_PERIODS) {
      expect(historyFiltersFromSearchParams({ period })).toEqual({ kind: 'orders', period });
    }
    expect(
      historyFiltersFromSearchParams({
        kind: 'settlements',
        period: '30d',
        market: MARKET.toUpperCase(),
      }),
    ).toEqual({ kind: 'settlements', period: '30d', market: MARKET });
  });

  it('drops what the API would refuse instead of sending it', () => {
    // An unknown kind is 주문; `all`, a day count and a date are no period; a slug is no market.
    expect(
      historyFiltersFromSearchParams({ kind: 'trades', period: 'all', market: 'rate-cut-2026' }),
    ).toEqual({ kind: 'orders' });
    for (const period of ['', '7', '7D', '1d', '2026-11-01']) {
      expect(historyFiltersFromSearchParams({ period }), period).toEqual({ kind: 'orders' });
    }
    expect(historyFiltersFromSearchParams({ market: '' })).toEqual({ kind: 'orders' });
  });

  it('reads the first value of a repeated parameter', () => {
    expect(
      historyFiltersFromSearchParams({
        kind: ['fills', 'settlements'],
        period: ['7d', '90d'],
        market: [MARKET, 'x'],
      }),
    ).toEqual({ kind: 'fills', period: '7d', market: MARKET });
    // The first value decides: a refused one is not replaced by the second.
    expect(historyFiltersFromSearchParams({ period: ['all', '7d'] })).toEqual({ kind: 'orders' });
  });
});

describe('myHistoryPath', () => {
  it('leaves every default out of the address', () => {
    expect(myHistoryPath({})).toBe(MY_HISTORY_PATH);
    expect(myHistoryPath({ kind: 'orders' })).toBe('/my/history');
  });

  it('writes what is picked, the market lower-cased', () => {
    expect(myHistoryPath({ kind: 'fills' })).toBe('/my/history?kind=fills');
    expect(myHistoryPath({ kind: 'orders', period: '7d' })).toBe('/my/history?period=7d');
    expect(
      myHistoryPath({ kind: 'settlements', period: '90d', market: MARKET.toUpperCase() }),
    ).toBe(`/my/history?kind=settlements&period=90d&market=${MARKET}`);
    // #34's 이력 연결: one market's history, 주문 first.
    expect(myHistoryPath({ market: MARKET })).toBe(`/my/history?market=${MARKET}`);
  });

  it('round-trips through the normaliser', () => {
    for (const kind of HISTORY_KINDS) {
      for (const period of [undefined, ...RECENT_PERIODS]) {
        for (const market of [undefined, MARKET]) {
          const filters = {
            kind,
            ...(period === undefined ? {} : { period }),
            ...(market === undefined ? {} : { market }),
          };
          const query = new URL(myHistoryPath(filters), 'https://x.invalid').searchParams;
          expect(historyFiltersFromSearchParams(Object.fromEntries(query))).toEqual(filters);
        }
      }
    }
  });
});

describe('isHistoryFiltered and historyListFilters', () => {
  it('says a filter is on for a period or a market, never for the kind', () => {
    expect(isHistoryFiltered({})).toBe(false);
    expect(isHistoryFiltered(historyFiltersFromSearchParams({ kind: 'fills' }))).toBe(false);
    expect(isHistoryFiltered({ period: '7d' })).toBe(true);
    expect(isHistoryFiltered({ market: MARKET })).toBe(true);
  });

  it('hands a list the two filters alone', () => {
    const filters = historyFiltersFromSearchParams({ kind: 'fills', period: '7d', market: MARKET });
    expect(historyListFilters(filters)).toEqual({ period: '7d', market: MARKET });
    expect(historyListFilters(historyFiltersFromSearchParams({ kind: 'fills' }))).toEqual({});
  });
});

describe('historyMarketTitle', () => {
  it('reads nothing with no market picked', async () => {
    let reads = 0;
    const read = () => {
      reads += 1;
      return Promise.resolve({ title: '기준금리 인하?' });
    };
    await expect(historyMarketTitle(undefined, read)).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  it('gives the title of a public market', async () => {
    await expect(
      historyMarketTitle(MARKET, (id) => Promise.resolve({ title: `시장 ${id}` })),
    ).resolves.toBe(`시장 ${MARKET}`);
  });

  it("gives none for a market that is not public: the chip says '고른 시장'", async () => {
    await expect(historyMarketTitle(MARKET, () => Promise.resolve(null))).resolves.toBeUndefined();
  });

  it('gives none when the read throws, never the throw: the app has no error.tsx', async () => {
    // `fetchMarketServer` throws everything but the API's 404 and 400 (a 5xx, a 429, no route).
    await expect(
      historyMarketTitle(MARKET, () => Promise.reject(new Error('upstream'))),
    ).resolves.toBeUndefined();
  });
});
