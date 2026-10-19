import { createApiClient } from '@buddha/api-client';
import { cache } from 'react';
import {
  type Category,
  type ChargePackage,
  type Market,
  type MarketSummary,
  type Notice,
  type NoticeSummary,
  type Post,
  type PriceSeries,
  type PublicProfile,
  type Theme,
  type ThemeSummary,
  isApiError,
  unwrap,
} from './api';
import {
  type MarketFilters,
  type MarketSearch,
  publicListQuery,
  relatedMarketsQuery,
  searchListQuery,
} from './market-keys';
import {
  type CommunityFilters,
  type PostPage,
  type WriteMarketLookup,
  lookUpWriteMarket,
  postListQuery,
} from './posts';
import {
  type ThemeListPage,
  type ThemeResultPage,
  homeThemesQuery,
  themePageQuery,
} from './themes';
import { type TickRange, ticksQueryFor } from './ticks';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/**
 * Server-side client for PUBLIC reads only (PLAN 11.5). `lib/api.ts`'s client is built with
 * `baseUrl: ''` (api.ts:9) — a relative URL a server component cannot fetch — so the SSR path
 * needs its own client against the API origin, dialled directly like `session.server.ts` does
 * and never through the `/api/*` rewrite, which only exists for the browser.
 *
 * No cookie is ever forwarded, BY DESIGN: a session-scoped route answers 401 here instead of
 * quietly seeding the dehydrated payload — which Next inlines into the HTML and keeps in the
 * client Router Cache — with one account's data. `server-only` is not installed in this
 * workspace; the `.server.ts` suffix is the house boundary marker (session.server.ts).
 *
 * `cache: 'no-store'` typechecks (`ClientOptions extends Omit<RequestInit, 'headers'>`) but is
 * belt-and-braces: Next only marks a scope dynamic when it reads `cache` off fetch's SECOND
 * argument, and openapi-fetch calls `fetch(request, undefined)`, so the option lands on the
 * Request. What actually keeps these routes per-request is `export const dynamic =
 * 'force-dynamic'` on the page.
 */
const serverApi = createApiClient({ baseUrl: API_URL, cache: 'no-store' });

/**
 * `GET /markets/:idOrSlug`, memoised for the lifetime of the request through React `cache`, so
 * `generateMetadata` and the page body cost one round trip rather than two.
 *
 * `null` for NOT_FOUND — a draft included, which is invisible to the public — and for the
 * VALIDATION_ERROR a segment that cannot name a market earns; both are `notFound()` to a
 * visitor, so neither deserves a 500. Any other failure throws and the error boundary shows.
 */
export const fetchMarketServer = cache(async (idOrSlug: string): Promise<Market | null> => {
  try {
    return unwrap(
      await serverApi.GET('/api/v1/markets/{idOrSlug}', { params: { path: { idOrSlug } } }),
    ).data;
  } catch (error) {
    if (isApiError(error, 'NOT_FOUND') || isApiError(error, 'VALIDATION_ERROR')) return null;
    throw error;
  }
});

/**
 * The write page's read of the market `?market=` names (ADR-0073 9-44): `lookUpWriteMarket` over
 * `fetchMarketServer` as it is — none only for the API's «no such market», failed for any other
 * failure, which the write screen keeps its form through. A read that turned failures into null
 * (`.catch(() => null)`) would make them none, and the screen put the picker in a draft's place.
 */
export function lookUpWriteMarketServer(marketId: string | undefined): Promise<WriteMarketLookup> {
  return lookUpWriteMarket(marketId, fetchMarketServer);
}

/**
 * `GET /markets/:id/ticks` for the seeded chart. The whole `PriceSeries` is returned and cached,
 * not just its points: the window and stride the server chose are what let a live `market:tick`
 * be merged into the right edge of the held series.
 *
 * `null` on ANY failure, where `fetchMarketServer` above rethrows what it cannot turn into a 404.
 * The asymmetry is deliberate: the row IS the page, but the series is one region of it, and that
 * region already owns a complete error rung of its own (`series.isLoadingError` → 다시 시도,
 * probability-chart.tsx). Letting the rejection out would 500 the whole route over a failed
 * sub-resource and take the question and the 규칙 — the two things AC 2 reads out of
 * view-source, both of which the page already holds by the time this call runs — down with it,
 * onto Next's own untranslated error screen (there is no `app/error.tsx`). An unseeded ticks key
 * instead lets the chart fetch it on the client and report the failure where it happened, the
 * same way the home page's own public reads degrade.
 *
 * The route takes a uuid only, so a slug-routed page resolves the row first and passes
 * `market.id`. The window is asked for as a DURATION, never as an instant this render computes
 * (`ticksQueryFor`), so the server opens it from its own clock and the answer carries the
 * `from`/`to` the chart is drawn against.
 */
export async function fetchTicksServer(id: string, range: TickRange): Promise<PriceSeries | null> {
  try {
    return unwrap(
      await serverApi.GET('/api/v1/markets/{id}/ticks', {
        params: { path: { id }, query: ticksQueryFor(range) },
      }),
    ).data;
  } catch {
    return null;
  }
}

/**
 * One page of `GET /markets`, in the `{ items, nextCursor }` shape `useInfiniteQuery` holds, so
 * the server-side prefetch and the client's own `queryFn` produce the same page objects under
 * the same key — and the same request: both send `publicListQuery` (market-keys.ts), the home's
 * status, the order picked, and a category and cursor only when there is one (never a search
 * term: the home does not search, ADR-0066 — the search screen's read is the next function).
 * Pinned per order by api.server.test.ts.
 */
export async function fetchMarketsPageServer(
  filters: MarketFilters,
  cursor?: string,
): Promise<{ items: MarketSummary[]; nextCursor: string | null }> {
  const { data, meta } = unwrap(
    await serverApi.GET('/api/v1/markets', { params: { query: publicListQuery(filters, cursor) } }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/**
 * One page of a search's results (`GET /markets` with the term, #15), in the same page shape and
 * with the same request as the browser's own `queryFn` (`searchListQuery`, hooks/use-markets.ts):
 * the search page reads the first page here and puts it in the HTML when it holds a card (owner
 * decision 2026-10-16, ADR-0066: "서버가 첫 페이지도 그린다"; `seedsSearchResults`). Rejects on
 * failure, which the page's prefetch swallows: the browser then reads the page itself and shows
 * the failure as its own (N02 §3). Pinned per status and order by api.server.test.ts.
 */
export async function fetchMarketSearchPageServer(
  search: MarketSearch,
  cursor?: string,
): Promise<{ items: MarketSummary[]; nextCursor: string | null }> {
  const { data, meta } = unwrap(
    await serverApi.GET('/api/v1/markets', { params: { query: searchListQuery(search, cursor) } }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/**
 * One page of a detail's 관련 시장 (`GET /markets/:id/related`, #65), in the same page shape and with
 * the same request as the browser's `queryFn` (`relatedMarketsQuery`, hooks/use-markets.ts), so the
 * page the detail reads on the server is the page the client picks up. Rejects on failure, which
 * the page's prefetch swallows after one attempt (`prefetchRelatedMarkets`, lib/market-ssr.ts —
 * never retried on the server): the section then reads it in the browser and shows its own
 * failure, and the rest of the detail renders without it.
 */
export async function fetchRelatedMarketsPageServer(
  marketId: string,
  cursor?: string,
): Promise<{ items: MarketSummary[]; nextCursor: string | null }> {
  const { data, meta } = unwrap(
    await serverApi.GET('/api/v1/markets/{id}/related', {
      params: { path: { id: marketId }, query: relatedMarketsQuery(cursor) },
    }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/**
 * Active categories in display order (`GET /categories`, public), both levels flat: the home
 * page's first paint of its headline and sub-category sidebar reads them from this prop.
 */
export async function fetchCategoriesServer(): Promise<Category[]> {
  return unwrap(await serverApi.GET('/api/v1/categories')).data;
}

/**
 * The charge catalogue (`GET /charge-packages`, public — ADR-0026) for the `/charge` guide page
 * (ADR-0044), in the API's display order. Rejects on failure; the page turns that into its own
 * error notice rather than a 500.
 */
export async function fetchChargePackagesServer(): Promise<ChargePackage[]> {
  return unwrap(await serverApi.GET('/api/v1/charge-packages')).data;
}

/**
 * One page of the community list (`GET /posts`, #46), in the same page shape and with the same
 * request as the browser's `queryFn` (`postListQuery`, hooks/use-posts.ts), so the page the server
 * reads is the page the client picks up. Public (N05 §2: 비로그인 열람). Rejects on failure, which
 * the page's prefetch swallows: the list then reads it in the browser and shows its own failure.
 */
export async function fetchPostsPageServer(
  filters: CommunityFilters,
  cursor?: string,
): Promise<PostPage> {
  const { data, meta } = unwrap(
    await serverApi.GET('/api/v1/posts', { params: { query: postListQuery(filters, cursor) } }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/**
 * `GET /posts/:postId` for the post page (#46), memoised for the request like the market row, so
 * `generateMetadata` and the page cost one round trip. `null` for NOT_FOUND — a deleted post with
 * nothing under it is gone (#45-5) — and for the VALIDATION_ERROR a segment that is not a uuid
 * earns; both are a 404 to a visitor. Any other failure throws.
 */
export const fetchPostServer = cache(async (postId: string): Promise<Post | null> => {
  try {
    return unwrap(await serverApi.GET('/api/v1/posts/{postId}', { params: { path: { postId } } }))
      .data;
  } catch (error) {
    if (isApiError(error, 'NOT_FOUND') || isApiError(error, 'VALIDATION_ERROR')) return null;
    throw error;
  }
});

/**
 * `GET /profiles/:publicId` for the public profile page (#41, ADR-0078), memoised for the request
 * like the post, so `generateMetadata` and the page cost one round trip. Public and the same answer
 * for every reader (no cookie rides along, as for every read here). `null` for NOT_FOUND — an
 * unknown public id, anything that cannot be one, and once #140 is there a withdrawn account
 * (#37-16) — which is a 404 to a visitor. Any other failure throws.
 */
export const fetchProfileServer = cache(async (publicId: string): Promise<PublicProfile | null> => {
  try {
    return unwrap(
      await serverApi.GET('/api/v1/profiles/{publicId}', { params: { path: { publicId } } }),
    ).data;
  } catch (error) {
    if (isApiError(error, 'NOT_FOUND')) return null;
    throw error;
  }
});

/**
 * The fixed area's notices (`GET /notices`, #138): every pinned one, the latest pinned first, for
 * the community page to seed under `PINNED_NOTICES_KEY` (the browser's `queryFn` asks the same
 * route). Public, and the same for every visitor. Rejects on failure, which the page's prefetch
 * swallows: the area then reads them in the browser and shows its own failure.
 */
export async function fetchPinnedNoticesServer(): Promise<NoticeSummary[]> {
  return unwrap(await serverApi.GET('/api/v1/notices')).data;
}

/**
 * `GET /notices/:noticeId` for the notice page (#138), memoised for the request like the post, so
 * `generateMetadata` and the page cost one round trip. `null` for NOT_FOUND and for the
 * VALIDATION_ERROR a segment that is not a uuid earns; both are a 404 to a visitor, as a notice
 * that is not pinned is (the API answers it NOT_FOUND, owner decision 2026-10-21). Any other
 * failure throws.
 */
export const fetchNoticeServer = cache(async (noticeId: string): Promise<Notice | null> => {
  try {
    return unwrap(
      await serverApi.GET('/api/v1/notices/{noticeId}', { params: { path: { noticeId } } }),
    ).data;
  } catch (error) {
    if (isApiError(error, 'NOT_FOUND') || isApiError(error, 'VALIDATION_ERROR')) return null;
    throw error;
  }
});

/**
 * 테마 (#81, ADR-0088): a theme's page by the slug of its address (or its id), or `null` for
 * every address that names no published theme — unknown, unpublished, or a segment the route
 * schema refuses — which is one 404 to a visitor, as a market's detail is. React-cached so the
 * metadata and the page share one request.
 */
export const fetchThemeServer = cache(async (idOrSlug: string): Promise<Theme | null> => {
  try {
    return unwrap(
      await serverApi.GET('/api/v1/themes/{idOrSlug}', { params: { path: { idOrSlug } } }),
    ).data;
  } catch (error) {
    if (isApiError(error, 'NOT_FOUND') || isApiError(error, 'VALIDATION_ERROR')) return null;
    throw error;
  }
});

/** One page of the public theme list (`GET /themes`), for `/themes`. */
export async function fetchThemeListPageServer(cursor?: string): Promise<ThemeListPage> {
  const { data, meta } = unwrap(
    await serverApi.GET('/api/v1/themes', { params: { query: themePageQuery(cursor) } }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/** The explore home's ongoing themes: the first page of `GET /themes?status=ongoing`. */
export async function fetchHomeThemesServer(): Promise<ThemeSummary[]> {
  return unwrap(await serverApi.GET('/api/v1/themes', { params: { query: homeThemesQuery() } }))
    .data;
}

/** One page of a theme's markets, the home's card rows. */
export async function fetchThemeMarketsPageServer(
  themeId: string,
  cursor?: string,
): Promise<{ items: MarketSummary[]; nextCursor: string | null }> {
  const { data, meta } = unwrap(
    await serverApi.GET('/api/v1/themes/{id}/markets', {
      params: { path: { id: themeId }, query: themePageQuery(cursor) },
    }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/** One page of a theme's results list. */
export async function fetchThemeResultsPageServer(
  themeId: string,
  cursor?: string,
): Promise<ThemeResultPage> {
  const { data, meta } = unwrap(
    await serverApi.GET('/api/v1/themes/{id}/results', {
      params: { path: { id: themeId }, query: themePageQuery(cursor) },
    }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/** The published themes a market is in, for its detail's links. */
export async function fetchMarketThemesServer(marketId: string): Promise<ThemeSummary[]> {
  return unwrap(
    await serverApi.GET('/api/v1/markets/{id}/themes', { params: { path: { id: marketId } } }),
  ).data;
}
