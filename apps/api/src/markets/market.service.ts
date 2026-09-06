import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  FILLS_RECENT_LIMIT,
  TICKS_MAX_POINTS,
  decodeKeyset,
  decodeSortCursor,
  encodeKeyset,
  encodeSortCursor,
  mechanismFor,
  parseQuantity,
  serializePAmount,
  uuidParamSchema,
  type Category,
  type Fill,
  type LmsrState,
  type Market,
  type MarketListQuery,
  type MarketSummary,
  type PriceTick,
  type TicksQuery,
} from '@buddha/shared';
import { and, asc, desc, eq, gt, gte, ilike, lt, lte, ne, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

export type MarketRow = typeof schema.markets.$inferSelect;
type FillRow = typeof schema.fills.$inferSelect;

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
    createdAt: row.createdAt.toISOString(),
  };
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
  async list(query: MarketListQuery): Promise<Page<MarketSummary>> {
    const { markets, categories } = schema;
    const { cursor, limit } = query;
    const filters = [
      eq(markets.status, query.status),
      query.category ? eq(categories.slug, query.category) : undefined,
      query.q ? ilike(markets.title, likePattern(query.q)) : undefined,
    ];

    let where;
    let order;
    let nextCursorOf: (row: MarketRow) => string;
    switch (query.sort) {
      case 'newest': {
        const keyset = decodeKeyset(cursor, 'uuid');
        where = keyset
          ? or(
              lt(markets.createdAt, keyset.createdAt),
              and(eq(markets.createdAt, keyset.createdAt), lt(markets.id, keyset.id)),
            )
          : undefined;
        order = [desc(markets.createdAt), desc(markets.id)];
        nextCursorOf = (row) => encodeKeyset({ createdAt: row.createdAt, id: row.id });
        break;
      }
      case 'closing': {
        // Soonest first: the same encoding as `newest`, with `close_at` as the timestamp half
        // and the comparison flipped.
        const keyset = decodeKeyset(cursor, 'uuid');
        where = keyset
          ? or(
              gt(markets.closeAt, keyset.createdAt),
              and(eq(markets.closeAt, keyset.createdAt), gt(markets.id, keyset.id)),
            )
          : undefined;
        order = [asc(markets.closeAt), asc(markets.id)];
        nextCursorOf = (row) => encodeKeyset({ createdAt: row.closeAt, id: row.id });
        break;
      }
      case 'volume': {
        const keyset = decodeSortCursor(cursor, 'int', 'uuid');
        const volume = keyset ? BigInt(keyset.value) : undefined;
        where =
          keyset && volume !== undefined
            ? or(
                lt(markets.volumeP, volume),
                and(eq(markets.volumeP, volume), lt(markets.id, keyset.id)),
              )
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
    return {
      items: kept.map((row) => toMarketSummary(row.market, row.category)),
      nextCursor: hasMore && last ? nextCursorOf(last.market) : null,
    };
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
   * id and for a draft alike.
   */
  async requirePublic(marketId: string): Promise<MarketRow> {
    const [row] = await this.db
      .select()
      .from(schema.markets)
      .where(and(eq(schema.markets.id, marketId), ne(schema.markets.status, 'draft')))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
    return row;
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
   * Price history, downsampled IN SQL to at most TICKS_MAX_POINTS + 2 rows: the window ranks
   * every tick of the range by (ts, id), and the outer query keeps the first, the last and
   * every `ceil(count / TICKS_MAX_POINTS)`-th row, ascending. Node never holds the full
   * series (a busy market writes a tick per trade). `resolution` is accepted and served as
   * raw until M4 buckets it.
   */
  async listTicks(marketId: string, query: TicksQuery): Promise<PriceTick[]> {
    await this.requirePublic(marketId);
    const { priceTicks } = schema;
    const ranked = this.db
      .select({
        id: priceTicks.id,
        ts: priceTicks.ts,
        pYesBp: priceTicks.pYesBp,
        trigger: priceTicks.trigger,
        rn: sql<number>`row_number() over (order by ${priceTicks.ts}, ${priceTicks.id})`.as('rn'),
        cnt: sql<number>`count(*) over ()`.as('cnt'),
      })
      .from(priceTicks)
      .where(
        and(
          eq(priceTicks.marketId, marketId),
          query.from ? gte(priceTicks.ts, new Date(query.from)) : undefined,
          query.to ? lte(priceTicks.ts, new Date(query.to)) : undefined,
        ),
      )
      .as('ranked');
    // `cnt` is cast, not the literal: a `${n}.0` would reach Postgres as `$1.0`.
    const stride = sql`greatest(1, ceil(${ranked.cnt}::numeric / ${TICKS_MAX_POINTS}))::bigint`;
    const rows = await this.db
      .select({ ts: ranked.ts, pYesBp: ranked.pYesBp, trigger: ranked.trigger })
      .from(ranked)
      .where(
        or(eq(ranked.rn, 1), eq(ranked.rn, ranked.cnt), sql`(${ranked.rn} - 1) % ${stride} = 0`),
      )
      .orderBy(asc(ranked.ts), asc(ranked.id));
    return rows.map((row) => ({
      ts: row.ts.toISOString(),
      pYesBp: row.pYesBp,
      trigger: row.trigger,
    }));
  }

  /** Active categories in display order. */
  async listCategories(): Promise<Category[]> {
    const rows = await this.db
      .select({
        id: schema.categories.id,
        slug: schema.categories.slug,
        nameKo: schema.categories.nameKo,
        sortOrder: schema.categories.sortOrder,
      })
      .from(schema.categories)
      .where(eq(schema.categories.isActive, true))
      .orderBy(asc(schema.categories.sortOrder), asc(schema.categories.id));
    return rows;
  }
}
