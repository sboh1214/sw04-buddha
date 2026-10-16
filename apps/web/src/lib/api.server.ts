import { createApiClient } from '@buddha/api-client';
import { cache } from 'react';
import {
  type Category,
  type ChargePackage,
  type Market,
  type MarketSummary,
  type PriceSeries,
  isApiError,
  unwrap,
} from './api';
import { type MarketFilters, publicListQuery } from './market-keys';
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
 * status, the order picked, and a category or search term only when there is one.
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
