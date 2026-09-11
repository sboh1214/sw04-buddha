import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  FILLS_RECENT_LIMIT,
  SPARKLINE_BUCKET_HOURS,
  SPARKLINE_WINDOW_HOURS,
  TICKS_MAX_POINTS,
  TICKS_SCAN_MAX,
  decodeKeyset,
  decodeSortCursor,
  encodeKeyset,
  encodeSortCursor,
  mechanismFor,
  parseQuantity,
  serializePAmount,
  tickBucketSeconds,
  uuidParamSchema,
  type Category,
  type Fill,
  type LmsrState,
  type Market,
  type MarketListItem,
  type MarketListQuery,
  type MarketSummary,
  type PriceSeries,
  type PriceTick,
  type TickBucketSeconds,
  type TicksQuery,
} from '@buddha/shared';
import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate, sortKeysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

export type MarketRow = typeof schema.markets.$inferSelect;
type FillRow = typeof schema.fills.$inferSelect;

/**
 * One row of the sampled-grid tick query. It runs through `db.execute`, which hands back the
 * driver's own rows with no ORM mapping: `ts` is a Date (timestamptz), `p_yes_bp` an int4 and
 * `trigger` a PG enum, i.e. a string (packages/db/src/client.ts registers no type parsers).
 */
/**
 * One row of the bucketed tick query. `tsMs` is epoch millis as text, not a Date: drizzle's
 * node-postgres session installs its own timestamp parsers, so a raw `db.execute` never hands
 * back a Date (the same reason `clockTimestamp` reads the clock as millis, clock.ts).
 */
interface SampledRow {
  tsMs: string;
  pYesBp: number;
  trigger: PriceTick['trigger'];
}

/** The category half of every market read: the list card shows slug and name only. */
export interface CategoryRef {
  slug: string;
  nameKo: string;
}

/** Columns every market query selects: the row plus its category (inner join). */
export const marketWithCategory = {
  market: schema.markets,
  category: { slug: schema.categories.slug, nameKo: schema.categories.nameKo },
};

/** `numeric` columns cross drizzle as strings; the engine wants doubles (PLAN 0.2). */
/**
 * Refuses a trade or a quote on a market that is not taking orders (PLAN 5.2, design 3.6):
 * MARKET_NOT_OPEN for any status but `open`, MARKET_CLOSED for an open market whose close
 * time has passed (the M5 close job has not run yet, or is about to). A draft never gets
 * here: `requirePublic` answers NOT_FOUND for it first.
 *
 * One implementation for both routes, and both call it with the database clock (the quote
 * through `requirePublicAt`, the trade with its post-lock `executedAt`), so a quote cannot
 * call a market tradable that `POST /trades` refuses a moment later for the time alone.
 */
export function assertTradable(market: Pick<MarketRow, 'status' | 'closeAt'>, now: Date): void {
  if (market.status !== 'open') {
    throw new AppError('MARKET_NOT_OPEN', { message: `Market is ${market.status}` });
  }
  if (market.closeAt.getTime() <= now.getTime()) {
    throw new AppError('MARKET_CLOSED', { message: 'Market has passed its close time' });
  }
}

export function lmsrStateOf(row: Pick<MarketRow, 'qYes' | 'qNo' | 'liquidityB'>): LmsrState {
  return {
    qYes: parseQuantity(row.qYes),
    qNo: parseQuantity(row.qNo),
    b: parseQuantity(row.liquidityB),
  };
}

/** YES probability in basis points, derived from the stored state (not a column). */
export function pYesBpOf(row: MarketRow): number {
  return mechanismFor(row.mechanism).probabilityBp(lmsrStateOf(row));
}

export function toMarketSummary(row: MarketRow, category: CategoryRef): MarketSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category,
    imageUrl: row.imageUrl,
    status: row.status,
    lastPrice: row.lastPrice,
    pYesBp: pYesBpOf(row),
    volumeP: serializePAmount(row.volumeP),
    tradeCount: row.tradeCount,
    traderCount: row.traderCount,
    closeAt: row.closeAt.toISOString(),
    openAt: row.openAt?.toISOString() ?? null,
    resolvedResult: row.resolvedResult,
    // bigint column read in number mode; on the wire it is a decimal string like every other
    // serial key an event is ordered by (`supersedes`, realtime.ts).
    statusEventId: row.statusEventId === null ? null : String(row.statusEventId),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A card's sparkline ending on the probability that card reports.
 *
 * Not `withLatestSample` (apps/web market-live.ts) moved here, and the difference is the empty
 * case: the client replaces the newest sample of a line it is already drawing, while an empty
 * answer here means the market has no tick in the window at all, and pinning one sample would
 * draw a flat line where the card should draw nothing.
 */
function endingOnRow(sparkline: number[], pYesBp: number): number[] {
  return sparkline.length === 0 ? sparkline : [...sparkline.slice(0, -1), pYesBp];
}

/** Public detail (PLAN 7.1): no LMSR state, liquidity, reserve or author. */
export function toMarket(row: MarketRow, category: CategoryRef): Market {
  return {
    ...toMarketSummary(row, category),
    description: row.description,
    rules: row.rules,
    resolutionSource: row.resolutionSource,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    disputeUntil: row.disputeUntil?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
  };
}

/** Anonymous (PLAN 7.1): the order and its owner never leave the server. */
export function toFill(row: FillRow): Fill {
  return {
    id: row.id.toString(),
    outcome: row.outcome,
    side: row.side,
    qty: row.qty,
    amountP: serializePAmount(row.amountP),
    priceAvgBp: row.priceAvgBp,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `%`, `_` and `\` in a search term are literal characters, not LIKE wildcards. */
function likePattern(q: string): string {
  return `%${q.replaceAll(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

/**
 * Public market reads (PLAN 5.2, 7.1; M3). A draft is invisible on every public route — the
 * list never returns one and the detail, fills, ticks and quote routes answer NOT_FOUND for
 * one, the same as for an id that does not exist: only admins know a draft exists.
 */
@Injectable()
export class MarketService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Keyset-paginated per sort (design 1.5): newest = (created_at DESC, id DESC) and closing =
   * (close_at ASC, id ASC) reuse the `<millis>_<uuid>` keyset; volume = (volume_p DESC,
   * id DESC) carries a bigint, so it uses the sort cursor. A cursor that does not decode
   * serves the first page rather than a 500 (see decodeKeyset).
   */
  async list(query: MarketListQuery): Promise<Page<MarketListItem>> {
    const { markets, categories } = schema;
    const { cursor, limit } = query;
    const filters = [
      eq(markets.status, query.status),
      query.category ? this.inCategory(query.category) : undefined,
      query.q ? ilike(markets.title, likePattern(query.q)) : undefined,
    ];

    let where;
    let order;
    let nextCursorOf: (row: MarketRow) => string;
    switch (query.sort) {
      case 'newest': {
        const keyset = decodeKeyset(cursor, 'uuid');
        where = keyset ? keysetPredicate(markets.createdAt, markets.id, keyset, 'uuid') : undefined;
        order = [desc(markets.createdAt), desc(markets.id)];
        nextCursorOf = (row) => encodeKeyset({ createdAt: row.createdAt, id: row.id });
        break;
      }
      case 'closing': {
        // Soonest first: the same encoding as `newest`, with `close_at` as the timestamp half
        // and the comparison flipped — `after` rather than `before`, because this is the one
        // ascending page in the API.
        const keyset = decodeKeyset(cursor, 'uuid');
        where = keyset
          ? keysetPredicate(markets.closeAt, markets.id, keyset, 'uuid', 'after')
          : undefined;
        order = [asc(markets.closeAt), asc(markets.id)];
        nextCursorOf = (row) => encodeKeyset({ createdAt: row.closeAt, id: row.id });
        break;
      }
      case 'volume': {
        const keyset = decodeSortCursor(cursor, 'int', 'uuid');
        where = keyset
          ? sortKeysetPredicate(markets.volumeP, markets.id, keyset, 'bigint', 'uuid')
          : undefined;
        order = [desc(markets.volumeP), desc(markets.id)];
        nextCursorOf = (row) => encodeSortCursor(serializePAmount(row.volumeP), row.id);
        break;
      }
    }

    const rows = await this.db
      .select(marketWithCategory)
      .from(markets)
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(and(...filters, where))
      .orderBy(...order)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    // The sparkline is fetched for the page the keyset already produced, so the card query
    // above stays exactly what the M3 keyset tests pin.
    const spark = await this.sparklinesFor(kept.map((row) => row.market.id));
    return {
      items: kept.map((row) => ({
        ...toMarketSummary(row.market, row.category),
        // The line has to end where the badge says it does. The rows above and the samples
        // here are two statements and therefore two snapshots, so a trade committing between
        // them left the card carrying the old probability beside a line already drawn to the
        // new one. Ending the line on the ROW's own probability makes the pair consistent by
        // construction rather than by timing.
        sparkline: endingOnRow(spark.get(row.market.id) ?? [], pYesBpOf(row.market)),
      })),
      nextCursor: hasMore && last ? nextCursorOf(last.market) : null,
    };
  }

  /**
   * `?category=<slug>` on either level of the two-level tree: a top-level slug lists every
   * market filed under any of its sub-categories (and under itself, should an admin file one
   * there), a leaf slug lists its own. A predicate on `markets.category_id` rather than a second
   * join on the aliased parent row, so the card query keeps the exact shape the M3 keyset tests
   * pin and `markets_category_id_status_idx` still applies; the inner selects touch a table of
   * ~30 rows. An unknown slug resolves to an empty set, which is the empty page it always was.
   */
  private inCategory(slug: string) {
    const { markets, categories } = schema;
    const named = this.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, slug));
    return inArray(
      markets.categoryId,
      this.db
        .select({ id: categories.id })
        .from(categories)
        .where(or(eq(categories.slug, slug), inArray(categories.parentId, named))),
    );
  }

  /**
   * Hourly as-of samples for one page of cards (PLAN 11.4). One correlated LIMIT-1 seek per
   * bucket on `price_ticks_market_id_ts_id_idx`: SPARKLINE_MAX_POINTS x page size seeks,
   * bounded whatever the markets' history — unlike a `ts >= now() - 24h` scan, whose cost
   * grows with trade volume on an anonymous route (A-M3-20). An hour without a trade carries
   * the previous value forward for free, and a market opened through the admin transition or
   * the seed carries the `open` tick that path writes, so its card is a flat line rather than
   * an empty one; only a market with no tick at all comes back with an empty array.
   *
   * A separate statement, not a lateral on the paging query: Postgres applies that query's
   * LIMIT above the join, so a lateral there would run once per market the filter matches
   * rather than once per card. Passing the ids the page already produced makes the bound
   * structural.
   *
   * `now()` is the statement timestamp and is STABLE, so both ends of the grid and every
   * bucket come from one instant; `make_interval(hours => $n)` binds the constants instead of
   * concatenating an interval literal, and no `date_trunc` is involved (its result depends on
   * the session TimeZone GUC, which createDb never sets).
   */
  private async sparklinesFor(ids: string[]): Promise<Map<string, number[]>> {
    if (ids.length === 0) return new Map();
    const { markets, priceTicks } = schema;
    // `array_remove(…, null::int)` drops the leading buckets older than the market's first
    // tick, so the array's LENGTH says where the series starts (0 bp is a real probability, so
    // they must not be zero-filled).
    //
    // The inner column names are written out rather than interpolated as drizzle columns: in a
    // `.select({...})` field map a `sql` fragment renders a column UNQUALIFIED (`"p_yes_bp"`,
    // `"id"`), so `${priceTicks.marketId} = ${markets.id}` came out as `"market_id" = "id"` and
    // bound the correlation to `price_ticks.id` (`operator does not exist: uuid = bigint`). The
    // inner relation is aliased `pt` and the correlation names `markets.id` explicitly, so every
    // reference is unambiguous. The names follow `casing: 'snake_case'` (packages/db client.ts).
    const sparkline = sql<number[] | null>`(
      select array_remove(
        array_agg(
          (select pt.p_yes_bp
             from ${priceTicks} pt
            where pt.market_id = markets.id
              and pt.ts <= g.bucket
            order by pt.ts desc, pt.id desc
            limit 1)
          order by g.bucket
        ),
        null::int
      )
      from generate_series(
        now() - make_interval(hours => ${SPARKLINE_WINDOW_HOURS}),
        now(),
        make_interval(hours => ${SPARKLINE_BUCKET_HOURS})
      ) as g(bucket)
    )`;
    const rows = await this.db
      .select({ id: markets.id, sparkline })
      .from(markets)
      .where(inArray(markets.id, ids));
    return new Map(rows.map((row): [string, number[]] => [row.id, row.sparkline ?? []]));
  }

  /**
   * `GET /markets/:idOrSlug`: a uuid-shaped parameter is an id, anything else a slug (which
   * `marketSlugSchema` keeps from ever looking like a uuid). The slug is NFC-normalised like
   * the stored one, so a decomposed Korean URL still finds the market.
   */
  async getPublic(idOrSlug: string): Promise<Market> {
    const { markets, categories } = schema;
    // The id branch goes through the schema's value, not just its verdict: lower-cased like
    // every request-supplied uuid (api/uuid.ts), so the row is read by its canonical id. The
    // slug arrives NFC from the route schema already and is normalised again below, so the
    // invariant holds for a caller that bypasses the pipe (an M4 subscription, say).
    const parsedId = uuidParamSchema.safeParse(idOrSlug);
    const [row] = await this.db
      .select(marketWithCategory)
      .from(markets)
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(
        and(
          parsedId.success
            ? eq(markets.id, parsedId.data)
            : eq(markets.slug, idOrSlug.normalize('NFC')),
          ne(markets.status, 'draft'),
        ),
      )
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
    return toMarket(row.market, row.category);
  }

  /**
   * The market row for a public sub-resource (fills, ticks, quotes): NOT_FOUND for an unknown
   * id and for a draft alike — with the database clock read in the same statement, so a
   * caller that decides on time (`assertTradable`) uses the clock `POST /trades` will use
   * and not the API host's, at no extra round trip (clock.ts, A-M3-16). Epoch millis as
   * text, like `clockTimestamp`: no driver-side date parser is involved.
   */
  async requirePublicAt(marketId: string): Promise<{ market: MarketRow; now: Date }> {
    const [row] = await this.db
      .select({
        market: schema.markets,
        nowMs: sql<string>`(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text`,
      })
      .from(schema.markets)
      .where(and(eq(schema.markets.id, marketId), ne(schema.markets.status, 'draft')))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
    const ms = Number(row.nowMs);
    if (!Number.isSafeInteger(ms)) {
      throw new AppError('INTERNAL', { message: 'clock_timestamp() returned no value' });
    }
    return { market: row.market, now: new Date(ms) };
  }

  async requirePublic(marketId: string): Promise<MarketRow> {
    return (await this.requirePublicAt(marketId)).market;
  }

  /** Newest FILLS_RECENT_LIMIT fills, anonymous (PLAN 7.1). */
  async listFills(marketId: string): Promise<Fill[]> {
    await this.requirePublic(marketId);
    const rows = await this.db
      .select()
      .from(schema.fills)
      .where(eq(schema.fills.marketId, marketId))
      .orderBy(desc(schema.fills.createdAt), desc(schema.fills.id))
      .limit(FILLS_RECENT_LIMIT);
    return rows.map(toFill);
  }

  /**
   * Price history for the chart (PLAN 7.1, 11.4). At most TICKS_MAX_POINTS points, ascending.
   *
   * `raw` is the stored ticks of the range, downsampled by the newest-anchored stride
   * (A-M3-25) over the newest TICKS_SCAN_MAX rows (A-M3-20); it now reports `truncated`,
   * which a client previously could not tell (Q-M3-8 (1)).
   *
   * `1m`/`1h` are a sampled grid instead: for each of at most TICKS_MAX_POINTS boundaries the
   * query reads the last tick at or before it (one index descent each), so the cost is bounded
   * by the ANSWER, not by the market's tick count, and the row cap does not apply. That also
   * settles the two things bucketing usually needs extra machinery for: a bucket with no trade
   * repeats the value in force (dropped again below as a duplicate), and the boundary at
   * `from` looks back past `from`, so the chart's left edge is never empty.
   *
   * The stride is coarsened until the window fits (`tickBucketSeconds`) rather than striped,
   * so points stay evenly spaced; `bucketSeconds` reports what was served. A bucketed answer
   * is never `truncated`: its grid spans the whole window it echoes (ADR-0029).
   */
  async listTicks(marketId: string, query: TicksQuery): Promise<PriceSeries> {
    // The row and the DB clock in one statement, as every public sub-resource reads them: the
    // window's open end is `now` as the database sees it and its start defaults to the
    // market's own opening, so no probe query is needed.
    const { market, now } = await this.requirePublicAt(marketId);
    // Close the window first, then clamp its start DOWN to it. `ticksQuerySchema` only orders
    // the two bounds when both are given, so a defaulted one can still invert the window — a
    // `to` older than the market's opening (a client paging backwards through history), or a
    // `from` from a clock running fast against an omitted `to`. Restoring the invariant by
    // moving `to` UP instead would answer a window NEWER than the one asked for: the grid
    // would pin a boundary at the opening and serve a point after the caller's `to`, while
    // `raw` — which filters on the untouched `query.to` — answered nothing for the same
    // request. Clamping down keeps both resolutions describing the same window.
    const to = new Date(query.to ? Date.parse(query.to) : now.getTime());
    // A RELATIVE range is opened from `to` — the DATABASE's own instant — so the window a client
    // asked for is the window it gets whatever its clock says. `from` names an absolute instant
    // and is kept for a caller that really means one; a client deriving it from `Date.now()` was
    // measuring one end of the window on its machine and the other on this one, and the span came
    // out wrong by the skew (A-M4-35). The two are mutually exclusive at the schema.
    const requestedFrom = query.from
      ? new Date(query.from)
      : query.windowSeconds !== undefined
        ? new Date(to.getTime() - query.windowSeconds * 1_000)
        : (market.openAt ?? market.createdAt);
    const from = new Date(Math.min(requestedFrom.getTime(), to.getTime()));
    // The window the CALLER named is a FILTER; a defaulted one is only a description. Those are
    // different jobs and the raw path has to be handed the first, not left to re-derive it: it
    // filtered on `query.from` alone, so a RELATIVE window — which names its start just as
    // definitely, only by duration — bounded nothing. `?windowSeconds=3600` echoed one hour and
    // served the newest TICKS_SCAN_MAX ticks of the market's whole history, points hours older
    // than the `from` beside them. Reachable on the DEFAULT resolution: `resolution` defaults to
    // `raw` (market.ts), which is the one value `tickBucketSeconds` answers 0 for.
    //
    // `market.openAt` deliberately stays OUT of the filter. No tick can predate a market's
    // opening — the 'open' tick is written in the same transaction that stamps `openAt` — so
    // flooring there would only make the answer depend on a bound it cannot need, and the suite
    // pins that reading outright ("`from` older than the bound is a filter, not a floor").
    const filterFrom =
      query.from !== undefined
        ? new Date(query.from)
        : query.windowSeconds !== undefined
          ? from
          : undefined;
    const bucketSeconds = tickBucketSeconds(query.resolution, to.getTime() - from.getTime());
    if (bucketSeconds === 0) {
      return this.rawSeries(marketId, query.resolution, filterFrom, from, to, market.tradeCount);
    }
    // Even the coarsest stride cannot cover a window this wide (about ten years). Trim the old
    // end rather than overrun the documented cap; the narrowed `from` in the response is what
    // says so. `truncated` stays false and keeps the raw path's verified meaning — "points
    // older than the served ones exist INSIDE the served window but were left out" — which no
    // bucketed answer can hit: the boundary at `start` looks back past `start`, so the oldest
    // point returned is always the window's own left edge. Reporting the trim here instead
    // would assert dropped history without ever probing for it.
    const maxSpanMs = bucketSeconds * 1_000 * (TICKS_MAX_POINTS - 2);
    const start = new Date(Math.max(from.getTime(), to.getTime() - maxSpanMs));
    return {
      resolution: query.resolution,
      bucketSeconds,
      from: start.toISOString(),
      to: to.toISOString(),
      truncated: false,
      // From `requirePublicAt` above — the same statement that produced the LIVE `to`, and
      // deliberately BEFORE the sampling statement below. An earlier snapshot can only LAG the
      // points, and lagging is the harmless direction; a counter read after them could claim a
      // trade they predate (packages/shared market.ts states which way that fails). When the
      // CALLER pinned `to`, this is still the counter at answer time — the schema says so, and
      // says why the row cannot answer otherwise.
      tradeCount: market.tradeCount,
      points: await this.sampleTicks(marketId, start, to, bucketSeconds),
    };
  }

  /**
   * The probability in force at every boundary of the absolute `bucketSeconds` grid over
   * [from, to]. Exact, not an approximation: the series is a step function (the LMSR state
   * holds between trades), so the last tick at or before a boundary IS the value there.
   */
  private async sampleTicks(
    marketId: string,
    from: Date,
    to: Date,
    bucketSeconds: TickBucketSeconds,
  ): Promise<PriceTick[]> {
    // The stride is a BOUND PARAMETER, not interpolated SQL: make_interval takes seconds, so
    // no interval text ever reaches the parser and no whitelist table is needed.
    const stride = sql`make_interval(secs => ${bucketSeconds}::double precision)`;
    const start = sql`${from.toISOString()}::timestamptz`;
    const end = sql`${to.toISOString()}::timestamptz`;
    // Every clause is load-bearing:
    // - `union`, not `union all`: a `from`/`to` that already sits on the grid collapses into
    //   the generated boundary, so the count stays <= TICKS_MAX_POINTS and `lag` has a total
    //   order.
    // - the origin is spelled with its offset: a bare `timestamptz '1970-01-01'` is read in
    //   the session TimeZone GUC, which createDb never sets, and the grid would then shift for
    //   every stride the server's offset does not divide.
    // - `date_bin(stride, from, epoch) + stride` is the first grid point strictly after
    //   `from` in both the on-grid and the mid-bucket case, so the explicit `from` boundary is
    //   never shadowed and every returned `ts` lies inside [from, to].
    // - `cross join lateral`, not `left join`: boundaries before the market's first tick
    //   produce no row and vanish, so a tickless market answers with no points at all.
    // - `order by p.ts desc, p.id desc limit 1` is the exact prefix of
    //   price_ticks_market_id_ts_id_idx, i.e. one backward index descent per boundary.
    // - `previous_bp is distinct from p_yes_bp or rn = cnt` keeps the first row (`lag` is
    //   NULL, hence distinct), every change and the last row: lossless for a step curve, and
    //   a flat 24 h window costs two points instead of 288.
    // `db.execute` hands back the driver result, read as `clockTimestamp` reads it (clock.ts) —
    // and the boundary comes back as epoch millis for the same reason it does there: drizzle's
    // node-postgres session replaces the driver's timestamptz parser, so a raw `execute` yields
    // the wire string rather than a Date and `new Date(<pg text>)` would be at the mercy of the
    // host's non-ISO date parsing.
    const result: unknown = await this.db.execute(sql`
      with boundaries as (
        select ${start} as b
        union
        select g from generate_series(
          date_bin(${stride}, ${start}, timestamptz '1970-01-01 00:00:00+00') + ${stride},
          ${end},
          ${stride}
        ) as g
        union
        select ${end}
      ),
      sampled as (
        select boundaries.b as ts, tick.p_yes_bp, tick.trigger
        from boundaries
        cross join lateral (
          select p.p_yes_bp, p.trigger
          from price_ticks p
          where p.market_id = ${marketId}::uuid and p.ts <= boundaries.b
          order by p.ts desc, p.id desc
          limit 1
        ) as tick
      ),
      shaped as (
        select ts, p_yes_bp, trigger,
               lag(p_yes_bp) over (order by ts) as previous_bp,
               row_number() over (order by ts) as rn,
               count(*) over () as cnt
        from sampled
      )
      select (extract(epoch FROM ts) * 1000)::bigint::text as "tsMs",
             p_yes_bp as "pYesBp",
             trigger
      from shaped
      where previous_bp is distinct from p_yes_bp or rn = cnt
      order by ts
    `);
    const rows = (result as { rows?: SampledRow[] }).rows ?? [];
    return rows.map((row) => ({
      ts: new Date(Number(row.tsMs)).toISOString(),
      pYesBp: row.pYesBp,
      trigger: row.trigger,
    }));
  }

  /**
   * `resolution=raw`: the stored ticks of the range, downsampled IN SQL to at most
   * TICKS_MAX_POINTS rows (PLAN 7.1). The window ranks the ticks by (ts, id), and the outer
   * query keeps a grid anchored at the NEWEST tick — it and every
   * `ceil(count / TICKS_MAX_POINTS)`-th row walking back from it, at most
   * TICKS_MAX_POINTS - 1 of them — plus the oldest row, ascending.
   *
   * Anchoring the grid at the newest end is what makes the cap exact. Anchored at the oldest
   * row instead, the grid holds up to TICKS_MAX_POINTS rows and the newest tick — the live
   * right edge of a chart, which the route promises to keep — falls off the stride, so the
   * answer carried one row too many for 190 of the possible counts (from 1,000 ticks up).
   * The unevenly spaced gap is now the first one, at the left edge, where nothing is live.
   * Node never holds the full series (a busy market writes a tick per trade), and neither does
   * the window: only the newest TICKS_SCAN_MAX ticks of the range are ranked — a backward
   * index scan with a LIMIT on (market_id, ts, id), so an anonymous request costs the same on
   * a market with a million ticks as on one with ten thousand.
   *
   * The WHERE floors on the window the CALLER named — `filterFrom`, which is `query.from` or the
   * instant `windowSeconds` counts back from — and never on a defaulted one, so a defaulted
   * `from` describes what the answer covers while a requested one bounds it. `listTicks` decides
   * which is which; taking `filterFrom` as a parameter rather than re-reading `query` is what
   * stops this WHERE and the `truncated` probe below drifting apart from it again.
   */
  private async rawSeries(
    marketId: string,
    resolution: TicksQuery['resolution'],
    filterFrom: Date | undefined,
    from: Date,
    to: Date,
    tradeCount: number,
  ): Promise<PriceSeries> {
    const { priceTicks } = schema;
    const recent = this.db
      .select({
        id: priceTicks.id,
        ts: priceTicks.ts,
        pYesBp: priceTicks.pYesBp,
        trigger: priceTicks.trigger,
      })
      .from(priceTicks)
      .where(
        and(
          eq(priceTicks.marketId, marketId),
          filterFrom ? gte(priceTicks.ts, filterFrom) : undefined,
          // The window's own end, not `query.to`. `listTicks` closes the window on the database
          // clock when the caller sends no `to`, and this statement runs afterwards under its
          // own snapshot — so filtering on the REQUEST let a trade committing in between answer
          // with `ts` past the `to` this response echoes, and past the `tradeCount` read with
          // it. The bucketed path never had the gap: its grid is built from the same `to`.
          lte(priceTicks.ts, to),
        ),
      )
      .orderBy(desc(priceTicks.ts), desc(priceTicks.id))
      .limit(TICKS_SCAN_MAX)
      .as('recent');
    const ranked = this.db
      .select({
        id: recent.id,
        ts: recent.ts,
        pYesBp: recent.pYesBp,
        trigger: recent.trigger,
        rn: sql<number>`row_number() over (order by ${recent.ts}, ${recent.id})`.as('rn'),
        cnt: sql<number>`count(*) over ()`.as('cnt'),
      })
      .from(recent)
      .as('ranked');
    // `cnt` is cast, not the literal: a `${n}.0` would reach Postgres as `$1.0`.
    const stride = sql`greatest(1, ceil(${ranked.cnt}::numeric / ${TICKS_MAX_POINTS}))::bigint`;
    const rows = await this.db
      .select({
        id: ranked.id,
        ts: ranked.ts,
        pYesBp: ranked.pYesBp,
        trigger: ranked.trigger,
        cnt: ranked.cnt,
      })
      .from(ranked)
      .where(
        or(
          // The oldest row, and the grid running back from the newest: offset 0 (the newest
          // tick itself) up to (TICKS_MAX_POINTS - 2) strides, so at most TICKS_MAX_POINTS - 1
          // rows, and the oldest adds at most one more.
          eq(ranked.rn, 1),
          sql`(${ranked.cnt} - ${ranked.rn}) % ${stride} = 0
              and ${ranked.cnt} - ${ranked.rn} <= ${stride} * ${TICKS_MAX_POINTS - 2}`,
        ),
      )
      .orderBy(asc(ranked.ts), asc(ranked.id));
    const first = rows[0];
    // `cnt >= TICKS_SCAN_MAX` is the cheap pre-filter, not the answer: exactly at the cap the
    // range may hold nothing older. Confirm with one index descent, and only then — the extra
    // statement never runs on a market below the bound.
    const truncated =
      first !== undefined &&
      Number(first.cnt) >= TICKS_SCAN_MAX &&
      (await this.hasOlderTick(marketId, first.ts, first.id, filterFrom));
    return {
      resolution,
      bucketSeconds: 0,
      from: from.toISOString(),
      to: to.toISOString(),
      truncated,
      // Handed down from `listTicks`, which read it beside `to` — see the bucketed return.
      tradeCount,
      points: rows.map((row) => ({
        ts: row.ts.toISOString(),
        pYesBp: row.pYesBp,
        trigger: row.trigger,
      })),
    };
  }

  /**
   * Does a tick inside the requested range predate the first served point? One index probe on
   * (market_id, ts, id) via a row comparison, which is why the served point's id is carried:
   * ticks can share a millisecond, and `ts <` alone would call such a pair truncation.
   */
  private async hasOlderTick(
    marketId: string,
    ts: Date,
    id: number,
    filterFrom: Date | undefined,
  ): Promise<boolean> {
    const { priceTicks } = schema;
    const [row] = await this.db
      .select({ one: sql<number>`1` })
      .from(priceTicks)
      .where(
        and(
          eq(priceTicks.marketId, marketId),
          sql`(${priceTicks.ts}, ${priceTicks.id}) < (${ts.toISOString()}::timestamptz, ${id}::bigint)`,
          filterFrom ? gte(priceTicks.ts, filterFrom) : undefined,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Active categories, both levels, flat: parents in display order, then their leaves in
   * theirs — `parent_id` NULLS FIRST puts every top-level row ahead of every leaf, and the leaf
   * order within a parent is `sort_order`. A client groups leaves under parents by `parentId`
   * (web `groupCategories`); a leaf whose parent an admin retired is left out here rather than
   * handed over as an orphan the tree could not place.
   */
  async listCategories(): Promise<Category[]> {
    const { categories } = schema;
    const activeParents = this.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.isActive, true), sql`${categories.parentId} is null`));
    const rows = await this.db
      .select({
        id: categories.id,
        slug: categories.slug,
        nameKo: categories.nameKo,
        sortOrder: categories.sortOrder,
        parentId: categories.parentId,
      })
      .from(categories)
      .where(
        and(
          eq(categories.isActive, true),
          or(sql`${categories.parentId} is null`, inArray(categories.parentId, activeParents)),
        ),
      )
      .orderBy(
        sql`${categories.parentId} nulls first`,
        asc(categories.sortOrder),
        asc(categories.id),
      );
    return rows;
  }
}
