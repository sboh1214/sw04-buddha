import { type RecentPeriod, mySettlementsQuerySchema } from '@buddha/shared';
import { MY_HISTORY_PATH } from './my';

/**
 * 거래·정산 이력 (#124, ADR-0143) as its screen reads the URL: `/my/history?kind=&period=&market=`.
 * Pure functions of the address, kept out of `app/my` so the node test runner reaches them (the
 * rule `lib/my.ts` states) and free of `'use client'`, so the server page normalises the address
 * once and hands the result down — the client never derives it a second time.
 */

/** 기록 종류 (ADR-0135 G1·G2): the three lists, one shown at a time. */
export const HISTORY_KINDS = ['orders', 'fills', 'settlements'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** The list the tab opens on. */
export const DEFAULT_HISTORY_KIND: HistoryKind = 'orders';

/** A page of each history list, 20 at a time (the API's default page); a /my preview's too. */
export const HISTORY_PAGE = 20;

/** The two filters the three lists share: they are each list's cache key and its request. */
export interface HistoryListFilters {
  /** `7d`·`30d`·`90d`; absent is the whole history (there is no `all` value). */
  period?: RecentPeriod;
  /** One market's records: its canonical lower-cased uuid. */
  market?: string;
}

/** The screen's address, normalised: the list shown and the filters on every list. */
export interface HistoryFilters extends HistoryListFilters {
  kind: HistoryKind;
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = { kind: DEFAULT_HISTORY_KIND };

/** What Next hands the page: a repeated parameter arrives as an array. */
export interface HistorySearchParams {
  kind?: string | string[];
  period?: string | string[];
  market?: string | string[];
}

/** Normalised by the API's own query schema, never by a local copy of it. */
const { marketId: marketParam, period: periodParam } = mySettlementsQuerySchema.shape;

/** A repeated parameter's first value is the one the screen's controls wrote. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The address as the screen's filters. A value the API would refuse is dropped, never sent: an
 * unknown `kind` is 주문, an unknown `period` the whole history, and a `market` that is no uuid no
 * market filter at all — so a hand-edited link opens a list rather than a 400.
 */
export function historyFiltersFromSearchParams(searchParams: HistorySearchParams): HistoryFilters {
  const kind = first(searchParams.kind);
  const period = periodParam.safeParse(first(searchParams.period));
  const market = marketParam.safeParse(first(searchParams.market));
  return {
    kind: HISTORY_KINDS.find((known) => known === kind) ?? DEFAULT_HISTORY_KIND,
    ...(period.success && period.data !== undefined ? { period: period.data } : {}),
    ...(market.success && market.data !== undefined ? { market: market.data } : {}),
  };
}

/**
 * The filters as a path, with what is not the default only: `/my/history`, or `/my/history?…`.
 * Every way the screen moves writes it — a tab, the period, a market picked or let go, a row's
 * '이 시장만 보기' — and it is the address #34's 이력 연결 opens (`myHistoryPath({ market })`).
 */
export function myHistoryPath(filters: Partial<HistoryFilters>): string {
  const query = new URLSearchParams();
  if (filters.kind !== undefined && filters.kind !== DEFAULT_HISTORY_KIND) {
    query.set('kind', filters.kind);
  }
  if (filters.period !== undefined) query.set('period', filters.period);
  if (filters.market !== undefined) query.set('market', filters.market.toLowerCase());
  const search = query.toString();
  return search === '' ? MY_HISTORY_PATH : `${MY_HISTORY_PATH}?${search}`;
}

/** Whether a filter is on: an empty list then says no record matched, not that none exists. */
export function isHistoryFiltered(filters: HistoryListFilters): boolean {
  return filters.period !== undefined || filters.market !== undefined;
}

/** The two filters alone, as a list's key and request take them. */
export function historyListFilters(filters: HistoryListFilters): HistoryListFilters {
  return {
    ...(filters.period === undefined ? {} : { period: filters.period }),
    ...(filters.market === undefined ? {} : { market: filters.market.toLowerCase() }),
  };
}

/**
 * The title of the market `?market=` names, for the filter's chip — the one thing the history's
 * page reads on the server, and public. `read` is `fetchMarketServer`, which answers null for a
 * market that is not public and THROWS any other failure; the app has no `error.tsx`, so a throw
 * let out would take the whole tab down over a chip's label. Caught here (`lookUpWriteMarket`'s
 * shape, ADR-0073 9-44): no title, and the chip says '고른 시장'. The lists are filtered either way.
 */
export async function historyMarketTitle(
  marketId: string | undefined,
  read: (id: string) => Promise<{ title: string } | null>,
): Promise<string | undefined> {
  if (marketId === undefined) return undefined;
  try {
    return (await read(marketId))?.title;
  } catch {
    return undefined;
  }
}
