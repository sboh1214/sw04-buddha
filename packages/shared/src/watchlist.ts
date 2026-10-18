import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { MARKET_SORTS, marketCategoryFilterSchema, publicMarketStatusSchema } from './market.js';

/**
 * 관심 시장 (#89, ADR-0064): the markets an account keeps an eye on, from the detail page's
 * button, gathered in MY. Owner decisions (ADR-0061 decision 3): every public status may be
 * watched, an ended market stays until the member removes it, the list is newest watch first
 * and draws market cards, there is no cap, and nobody but the member sees a watchlist or how
 * many watch a market (#37) — so no public shape here or anywhere carries one (the `watchlist`
 * item of PRIVATE_DATA). Watching never touches an order, a position or a price.
 */

/**
 * What a `market_watch_events` row records (#95): a watch began or ended. One row per actual
 * change of the current state, written in the same transaction; a repeated watch or an unwatch
 * of nothing writes none.
 */
export const WATCH_EVENT_ACTIONS = ['watch', 'unwatch'] as const;
export type WatchEventAction = (typeof WATCH_EVENT_ACTIONS)[number];

/**
 * The orders of `GET /me/watchlist` (ADR-0061 decision 3, the #63 row; ADR-0065): `watched`
 * (최근 관심 등록 순, newest watch first), which only a watchlist has, and the public list's three
 * (`MARKET_SORTS`), ordered by the same rules. `watched` is the default: MY lists by it alone, and
 * the home's 관심 시장 view starts on it.
 */
export const WATCHLIST_SORTS = ['watched', ...MARKET_SORTS] as const;
export type WatchlistSort = (typeof WATCHLIST_SORTS)[number];
export const watchlistSortSchema = z.enum(WATCHLIST_SORTS);
export const DEFAULT_WATCHLIST_SORT = 'watched' satisfies WatchlistSort;

/**
 * `GET /me/watchlist` (no `.meta`: query DTO, expanded per field like `marketListQuerySchema`).
 * The two filters are the ones the home's 관심 시장 view (#63) combines with: a public status
 * (the home asks for `open`), and a category slug resolved like `GET /markets` (a top-level slug
 * includes its sub-categories). Both omitted lists every watched market whatever its status,
 * ended ones included, as MY does.
 */
export const watchlistQuerySchema = cursorQuerySchema.extend({
  status: publicMarketStatusSchema.optional(),
  category: marketCategoryFilterSchema.optional(),
  sort: watchlistSortSchema.default(DEFAULT_WATCHLIST_SORT),
});
export type WatchlistQuery = z.infer<typeof watchlistQuerySchema>;

/**
 * Whether the caller watches one market: the answer of `GET` and `PUT /me/watchlist/:marketId`.
 * The caller's own state only; there is no count of anybody's.
 */
export const watchStateSchema = z.object({ watched: z.boolean() }).meta({ id: 'WatchState' });
export type WatchState = z.infer<typeof watchStateSchema>;

/**
 * `PUT /me/watchlist/:marketId`: the state to set — `true` watches, `false` unwatches — and the
 * account the screen shows (`expectedAccountId`, as on the verification and time-zone bodies,
 * A-PG-24). The cookie decides whose watchlist is written, and a window still showing account A
 * after another one signed in as B would otherwise put the market on B's list while A's button
 * said it was A's. The server refuses the mismatch (403 FORBIDDEN naming the field) before it
 * writes. Both keys are required: a body that forgot `watched` is a 400, never a guess.
 */
export const updateWatchBodySchema = z
  .object({
    watched: z.boolean(),
    /** The signed-in user id the screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'UpdateWatchBody' });
export type UpdateWatchBody = z.infer<typeof updateWatchBodySchema>;
