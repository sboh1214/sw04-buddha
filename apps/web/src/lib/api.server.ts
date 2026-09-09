import { createApiClient } from '@buddha/api-client';
import { cache } from 'react';
import {
  type Category,
  type LeaderboardEntry,
  type Market,
  type MarketListItem,
  type PriceSeries,
  isApiError,
  unwrap,
} from './api';
import { type MarketFilters } from './market-keys';
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
 * `GET /markets/:id/ticks` for the seeded chart. The whole `PriceSeries` is returned and cached,
 * not just its points: the window and stride the server chose are what let a live `market:tick`
 * be merged into the right edge of the held series.
 *
 * `null` on ANY failure, where `fetchMarketServer` above rethrows what it cannot turn into a 404.
 * The asymmetry is deliberate: the row IS the page, but the series is one region of it, and that
 * region already owns a complete error rung of its own (`series.isLoadingError` → 다시 시도,
 * probability-chart.tsx). Letting the rejection out would 500 the whole route over a failed
 * sub-resource and take the question and the 정산 기준 — the two things AC 2 reads out of
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
 * the same key. An absent `category`/`q` is omitted rather than sent empty: the API's query
 * schema refuses a blank one, and the filter object is the cache key.
 */
export async function fetchMarketsPageServer(
  filters: MarketFilters,
  cursor?: string,
): Promise<{ items: MarketListItem[]; nextCursor: string | null }> {
  const { data, meta } = unwrap(
    await serverApi.GET('/api/v1/markets', {
      params: {
        query: {
          status: filters.status,
          sort: filters.sort,
          ...(filters.category === undefined ? {} : { category: filters.category }),
          ...(filters.q === undefined ? {} : { q: filters.q }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
    }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/** Active categories in display order (`GET /categories`, public), for the home page's tabs. */
export async function fetchCategoriesServer(): Promise<Category[]> {
  return unwrap(await serverApi.GET('/api/v1/categories')).data;
}

/** The global ranking (`GET /leaderboard`, public; PLAN M6 선택). */
export async function fetchLeaderboardServer(): Promise<LeaderboardEntry[]> {
  return unwrap(await serverApi.GET('/api/v1/leaderboard')).data;
}
