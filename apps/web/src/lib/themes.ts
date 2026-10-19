import {
  THEME_RESULT_STATUSES,
  koreanDateAt,
  type MarketStatus,
  type ThemeStatus,
} from '@buddha/shared';
import { type QueryClient } from '@tanstack/react-query';
import { copy } from '@/copy';
import type { Theme, ThemeResult, ThemeSummary } from './api';
import { type HomeFilters, MARKETS_KEY } from './market-keys';
import type { MarketPage } from './market-live';
import { restartQueries } from './query-client';

/**
 * 테마 (#81, ADR-0088), the public half: query keys, the requests the server pages and the client
 * hooks share, the SSR seeding, and the labels. A module with no `'use client'` directive, for the
 * reason lib/market-keys.ts gives: the server pages seed the cache under these keys, and a server
 * component cannot call anything a client module exports.
 *
 * Owner decisions (ADR-0069 decision 4, the #81 rows): the screen name is '테마', with no notice of
 * what it does not have (the service guide's, #136); visitors come in from the public list, the
 * market detail's links, the explore home and the address alone, signed out too; the period sorts a
 * theme as 예정·진행 중·종료; a draft market is on no public page; the results list is the 판정
 * 완료·정산 완료·무효 markets with their result, and nobody's performance. And of 2026-10-19
 * (ADR-0088): the period is Korean dates shown as '10월 20일 ~ 11월 3일'; a notice is plain text
 * whose web addresses are links, marked 수정됨 once edited; the address is the slug. And of the
 * second round the same day: the home's row is the ongoing themes, else the upcoming ones, with
 * 모든 테마 whenever a theme is public; a period not wholly in this year carries its year; a
 * market detail's theme links carry the status; the introduction's addresses are links too.
 */

// ---- keys ------------------------------------------------------------------------------------

/**
 * Everything public about themes sits under one root, so an admin write can mark it all at once
 * (`applyTheme`, hooks/use-admin-themes.ts). Public: not in `PRIVATE_QUERY_ROOTS`, so the server
 * pages dehydrate it into the HTML every visitor gets.
 */
export const THEMES_KEY = ['themes'] as const;
/** The public list (`/themes`): every published theme, 진행 중 → 예정 → 종료 (the API's order). */
export const THEME_LIST_KEY = [...THEMES_KEY, 'list'] as const;
/** The explore home's row: the first few published themes, one page, never an infinite list. */
export const HOME_THEMES_KEY = [...THEMES_KEY, 'home'] as const;
export const THEME_DETAIL_KEY = [...THEMES_KEY, 'detail'] as const;
export const THEME_RESULTS_KEY = [...THEMES_KEY, 'results'] as const;
/** The themes one market is in, for its detail's links. */
export const MARKET_THEMES_KEY = [...THEMES_KEY, 'market'] as const;

/**
 * A theme's page (`GET /themes/:idOrSlug`), on its lower-cased uuid like every market key
 * (A-M3-29): the server page reads it by the slug of the address and seeds it under the row's id.
 */
export const themeKey = (themeId: string) => [...THEME_DETAIL_KEY, themeId.toLowerCase()] as const;
export const themeResultsKey = (themeId: string) =>
  [...THEME_RESULTS_KEY, themeId.toLowerCase()] as const;
export const marketThemesKey = (marketId: string) =>
  [...MARKET_THEMES_KEY, marketId.toLowerCase()] as const;

/**
 * A theme's markets (`GET /themes/:id/markets`), under the public market lists' root like the
 * search's results and a detail's 관련 시장 (lib/market-keys.ts): every duty `['markets']` carries
 * reaches them by prefix — the card join of query-client.ts, the socket's `market:tick` and
 * `market:status` writes into the cards, a reconnect's re-read (realtime-provider.tsx). The second
 * element is this string, so the key never matches the home's, the search's or 관련 시장's.
 */
export const THEME_MARKETS_KEY = [...MARKETS_KEY, 'theme'] as const;
export const themeMarketsKey = (themeId: string) =>
  [...THEME_MARKETS_KEY, themeId.toLowerCase()] as const;

/**
 * What a market's `market:status` event (realtime-provider.tsx) does to the theme pages' results
 * lists: when the market became 판정 완료·정산 완료·무효, every results list is marked, and the
 * one on screen asks again. The theme page's cards move with the event (they sit under
 * `['markets']`), and without this its results list would go on saying 결과가 나온 시장이 없습니다
 * beside a card marked 판정 완료 until a focus or a remount. A refetch the event cannot spare: it
 * carries no title, slug or decided time, and the market is not in the list yet. Which themes
 * hold the market is the server's to say, so the root of every theme's results is marked; the
 * statuses before a result (열림·마감) mark nothing. `restartQueries`, so a first read still in
 * flight — begun before the transition — is asked again rather than kept.
 */
export function refreshThemeResultsOnStatus(
  queryClient: QueryClient,
  status: MarketStatus,
): Promise<void> | undefined {
  if (!(THEME_RESULT_STATUSES as readonly MarketStatus[]).includes(status)) return undefined;
  return restartQueries(queryClient, THEME_RESULTS_KEY);
}

// ---- requests --------------------------------------------------------------------------------

/**
 * One page of a theme list, a theme's markets or its results as the API takes it: the cursor only
 * when there is one (the schema refuses a blank one) — one spelling for the server's read and the
 * browser's, as `relatedMarketsQuery` is 관련 시장's.
 */
export function themePageQuery(cursor?: string): { cursor?: string } {
  return cursor === undefined ? {} : { cursor };
}

/**
 * How many themes the home's row shows at most: two rows of three at the content width. The rest
 * are on the list page, which 모든 테마 opens. Chosen by this PR and kept by the owner (2026-10-19,
 * second round, ADR-0088).
 */
export const HOME_THEMES_LIMIT = 6;

/**
 * The home's one request: the first `HOME_THEMES_LIMIT` published themes in the list's order —
 * the ongoing ones first, the soonest to end first, then the upcoming ones, the soonest to start
 * first, then the ended ones (`THEME_LIST_STATUS_ORDER`). One page says all the row needs
 * (`homeThemesRow`): which status leads, its first themes, and whether any theme is public.
 */
export function homeThemesQuery(): { limit: number } {
  return { limit: HOME_THEMES_LIMIT };
}

/** What the home's theme row draws: the leading status's themes, or none but the 모든 테마 link. */
export interface HomeThemesRow {
  /** `ongoing` or `upcoming` over their cards; `null` when every public theme has ended. */
  status: Exclude<ThemeStatus, 'ended'> | null;
  themes: ThemeSummary[];
}

/**
 * The home's theme row out of its one page (owner decision 2026-10-19, second round, ADR-0088):
 * the ongoing themes; when none is ongoing, the upcoming ones; when neither, no card — and 모든
 * 테마 whenever any theme is public, so the list page is always a click away. `null`, no row at
 * all, only when no theme is public. The page is in the list's order, so its first theme's status
 * is the one that leads, and the cards are that status's alone: an upcoming theme never fills a
 * row of ongoing ones.
 */
export function homeThemesRow(page: readonly ThemeSummary[]): HomeThemesRow | null {
  const lead = page[0]?.status;
  if (lead === undefined) return null;
  if (lead === 'ended') return { status: null, themes: [] };
  return { status: lead, themes: page.filter((theme) => theme.status === lead) };
}

/**
 * Whether the home draws its theme row: on 전체 only — not under a category, since a theme is
 * tied to no category (ADR-0069 decision 4, '편성 규칙': 카테고리와 연결하지 않음) and would read as
 * that category's, and not in the 관심 시장 view, which is the member's own list. Chosen by this PR
 * and kept by the owner (2026-10-19, second round, ADR-0088).
 */
export function showsHomeThemes(filters: HomeFilters): boolean {
  return filters.watchlist !== true && filters.category === undefined;
}

// ---- SSR -------------------------------------------------------------------------------------

/** A page of the public theme list (`GET /themes`). */
export interface ThemeListPage {
  items: ThemeSummary[];
  nextCursor: string | null;
}

/** A page of a theme's results (`GET /themes/:id/results`). */
export interface ThemeResultPage {
  items: ThemeResult[];
  nextCursor: string | null;
}

/**
 * The theme page's row, seeded rather than prefetched: the page already read it to decide on its
 * 404, so a prefetch would ask again. Keyed on the row's own id, never the segment as typed.
 */
export function seedTheme(queryClient: QueryClient, theme: Theme): void {
  queryClient.setQueryData(themeKey(theme.id), theme);
}

/**
 * The first page of a theme's markets or results, read on the server under the key the section's
 * own query uses, so the page and its page params dehydrate into the HTML. `retry: false` for the
 * reason `prefetchRelatedMarkets` gives (lib/market-ssr.ts): the server client keeps the app's
 * default retries, and an optional section would otherwise hold the whole page about 3 s on a
 * failing read to end in the same failure. A failure is swallowed and not dehydrated, so the
 * section reads its page in the browser and shows its own failure.
 */
function prefetchSection<Page>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  readPage: (cursor?: string) => Promise<Page>,
): Promise<void> {
  return queryClient.prefetchInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => readPage(pageParam),
    initialPageParam: undefined as string | undefined,
    retry: false,
  });
}

export function prefetchThemeMarkets(
  queryClient: QueryClient,
  themeId: string,
  readPage: (themeId: string, cursor?: string) => Promise<MarketPage>,
): Promise<void> {
  return prefetchSection(queryClient, themeMarketsKey(themeId), (cursor) =>
    readPage(themeId, cursor),
  );
}

export function prefetchThemeResults(
  queryClient: QueryClient,
  themeId: string,
  readPage: (themeId: string, cursor?: string) => Promise<ThemeResultPage>,
): Promise<void> {
  return prefetchSection(queryClient, themeResultsKey(themeId), (cursor) =>
    readPage(themeId, cursor),
  );
}

/**
 * The list page's first page. The list IS that page, so its read keeps the app's default retries,
 * as the home's market list does (app/page.tsx); a failure is still swallowed and the browser reads
 * it and shows its own failure.
 */
export function prefetchThemeList(
  queryClient: QueryClient,
  readPage: (cursor?: string) => Promise<ThemeListPage>,
): Promise<void> {
  return queryClient.prefetchInfiniteQuery({
    queryKey: THEME_LIST_KEY,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => readPage(pageParam),
    initialPageParam: undefined as string | undefined,
  });
}

/**
 * The home's theme row and a market detail's theme links: a few links beside the page's own
 * content, so one attempt on the server (`retry: false`, as above) and the browser reads them when
 * that failed.
 */
export function prefetchHomeThemes(
  queryClient: QueryClient,
  read: () => Promise<ThemeSummary[]>,
): Promise<void> {
  return queryClient.prefetchQuery({ queryKey: HOME_THEMES_KEY, queryFn: read, retry: false });
}

export function prefetchMarketThemes(
  queryClient: QueryClient,
  marketId: string,
  read: (marketId: string) => Promise<ThemeSummary[]>,
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: marketThemesKey(marketId),
    queryFn: () => read(marketId),
    retry: false,
  });
}

// ---- labels ----------------------------------------------------------------------------------

/** 예정·진행 중·종료 (ADR-0069 decision 4, '진행 기간'), the API's status read at its own clock. */
export const THEME_STATUS_LABEL: Record<ThemeStatus, string> = {
  upcoming: copy.themeStatusUpcoming,
  ongoing: copy.themeStatusOngoing,
  ended: copy.themeStatusEnded,
};

/**
 * The status badge's look. The label says what it is; the look only repeats it (colour is never
 * alone, PLAN 11.2): the brand colour while it is on, as an open market's badge; gray otherwise,
 * outlined while it is still to come so 예정 and 종료 do not look alike at a glance. Orange is
 * left out: on the market badges it means waiting on someone (MARKET_STATUS_PALETTE).
 */
export const THEME_STATUS_BADGE: Record<
  ThemeStatus,
  { colorPalette: 'brand' | 'gray'; variant: 'subtle' | 'outline' }
> = {
  upcoming: { colorPalette: 'gray', variant: 'outline' },
  ongoing: { colorPalette: 'brand', variant: 'subtle' },
  ended: { colorPalette: 'gray', variant: 'subtle' },
};

/** Between a period's two ends: `10월 20일 ~ 11월 3일`. */
export const THEME_PERIOD_SEPARATOR = ' ~ ';

/** A `YYYY-MM-DD` date as its three numbers. */
function dateParts(date: string): { year: number; month: number; day: number } {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return { year, month, day };
}

/**
 * A theme's period as the page writes it (owner decision 2026-10-19): `10월 20일 ~ 11월 3일`. The
 * dates are Korean dates, not instants, so they are written as they are, whatever the reader's
 * time zone (ADR-0063 is about instants). A one-day theme is its one date (this PR's choice).
 *
 * The year (owner decision 2026-10-19, second round): written when a date is not in this year —
 * `2025년 10월 20일 ~ 11월 3일` — on the start, and on the end too when the end's year is another
 * (`2026년 12월 20일 ~ 2027년 1월 3일`, never read backwards); nowhere while both are this year's.
 * This year is the Korean date's at `now`, which the caller takes from the read that brought the
 * theme (the query's `dataUpdatedAt`) rather than from the clock in a render: the server's HTML
 * and the hydrating browser then write the same text, as the home's countdowns are measured
 * against their read (app/page.tsx).
 */
export function formatThemePeriod(
  period: { startDate: string; endDate: string },
  now: number,
): string {
  const thisYear = Number(koreanDateAt(now).slice(0, 4));
  const start = dateParts(period.startDate);
  const end = dateParts(period.endDate);
  const startYear = start.year !== thisYear || end.year !== thisYear;
  const endYear = end.year !== start.year;
  const write = ({ year, month, day }: typeof start, withYear: boolean) =>
    `${withYear ? `${String(year)}${copy.dateYearSuffix} ` : ''}${String(month)}${copy.dateMonthSuffix} ${String(day)}${copy.dateDaySuffix}`;
  if (period.startDate === period.endDate) return write(start, startYear);
  return `${write(start, startYear)}${THEME_PERIOD_SEPARATOR}${write(end, endYear)}`;
}

/** Between a theme's name and its status in a market detail's link: `노벨상 주간 · 진행 중`. */
export const THEME_LINK_SEPARATOR = ' · ';

/**
 * A market detail's link to a theme it is in (owner decision 2026-10-19, second round): the
 * theme's name and its status, `노벨상 주간 · 진행 중`, so a visitor sees an ended theme for what
 * it is before opening it. Ended themes are linked too: the market was gathered there.
 */
export function themeLinkLabel(theme: Pick<ThemeSummary, 'name' | 'status'>): string {
  return `${theme.name}${THEME_LINK_SEPARATOR}${THEME_STATUS_LABEL[theme.status]}`;
}

/**
 * One row's result as the results list writes it (ADR-0069 decision 4, '결과 목록': YES·NO·무효):
 * the contract's label for a judged market, 무효 for a voided one, which has none.
 */
export function themeResultLabel(row: Pick<ThemeResult, 'result'>): string {
  if (row.result === 'YES') return copy.yes;
  if (row.result === 'NO') return copy.no;
  return copy.themeResultVoided;
}

/** The address of a theme's page: its slug (owner decision 2026-10-19). */
export function themePath(slug: string): string {
  return `/themes/${slug}`;
}

/**
 * The slug a route segment names, as the API takes it: a Korean slug may reach the segment still
 * percent-encoded, and decoding a segment that is already decoded changes nothing — a slug holds
 * no `%`. A segment that does not decode (a stray `%`) is passed as it is, and the API answers it
 * as an unknown theme rather than the page failing.
 */
export function themeSlugParam(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---- linked text ---------------------------------------------------------------------------

/** A run of a notice's or an introduction's text: words as they are, or a web address to link. */
export type LinkedTextPart =
  { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

/** The characters a URL is made of in ASCII: RFC 3986's unreserved, reserved and `%`. */
const URL_ASCII = "A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=%";

/**
 * A web address in a notice or an introduction: `http://` or `https://` and URL characters.
 * Korean text written right after an address ends it, as a space does, so '주소는
 * https://example.com에서' and '…/a에서' link the address alone. But a path segment may itself
 * be Korean — a wiki title, a news article's, a Korean theme or market slug here
 * (`/themes/2026-선거`) — so letters and digits of any script go on in the address where an ASCII
 * run ends on `/`, `-`, `_`, `=` or `(`: a Korean particle hardly follows those, while a Korean
 * segment, word, query value or a wiki title's `_(동음이의)` does. Without that, 'https://ko.wikipedia.org/wiki/제22대_국회의원_선거'
 * linked '…/wiki/' alone, a different page. The price: a particle written right after a Korean
 * segment ('…/2026-선거에서') is linked with it, which no rule can tell from the segment. A choice
 * of this PR (ADR-0088 decision 6, and a question for the owner in 결과 4).
 */
const URL_IN_TEXT = new RegExp(
  `https?:\\/\\/[${URL_ASCII}]+(?:(?<=[/\\-_=(])[\\p{L}\\p{N}\\p{M}]+[${URL_ASCII}]*)*`,
  'gu',
);

/**
 * Punctuation that closes a sentence rather than an address: `https://example.com.` and
 * `(https://example.com)` link the address without the dot or the parenthesis. A `)` stays when
 * the address opened one of its own, as a wiki path does.
 */
function trimAddress(candidate: string): string {
  let address = candidate;
  for (;;) {
    const last = address.at(-1);
    if (last === undefined) return address;
    if ('.,!?;:\'"'.includes(last)) {
      address = address.slice(0, -1);
      continue;
    }
    if (last === ')' && address.split('(').length <= address.split(')').length - 1) {
      address = address.slice(0, -1);
      continue;
    }
    return address;
  }
}

/**
 * A notice's or a theme introduction's text split into runs, its web addresses as links (owner
 * decisions 2026-10-19: a notice is plain text with auto-linked URLs, and of the second round, the
 * introduction likewise). Only `http:` and `https:` addresses that parse as URLs are linked —
 * never another scheme, so no `javascript:` can become a link. Line breaks stay in the text runs;
 * the page keeps them (`white-space: pre-wrap`).
 */
export function linkedTextParts(text: string): LinkedTextPart[] {
  const parts: LinkedTextPart[] = [];
  let rest = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const address = trimAddress(match[0]);
    if (!URL.canParse(address)) continue;
    const at = match.index;
    if (at > rest) parts.push({ kind: 'text', text: text.slice(rest, at) });
    parts.push({ kind: 'link', text: address, href: address });
    rest = at + address.length;
  }
  if (rest < text.length) parts.push({ kind: 'text', text: text.slice(rest) });
  return parts;
}
