import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  THEME_RESULT_STATUSES,
  decodeKeyset,
  encodeKeyset,
  koreanDateAt,
  uuidParamSchema,
  type MarketSummary,
  type Theme,
  type ThemeListQuery,
  type ThemeResult,
  type ThemeResultStatus,
  type ThemeSummary,
} from '@buddha/shared';
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { tupleKeysetPredicate } from '../common/keyset.js';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { marketOrder } from '../markets/market-order.js';
import {
  MarketService,
  isPublicMarket,
  marketWithCategory,
  toMarketSummary,
} from '../markets/market.service.js';
import { type Page } from '../wallet/wallet.service.js';
import {
  themeListCursor,
  themeListOrder,
  themeListPage,
  themeStatusWhere,
  toThemeSummary,
  type ThemeRow,
} from './theme-rows.js';

/**
 * When a result was confirmed: `resolved_at`, stamped by the transition to RESOLVED (ADR-0093
 * decision 3, the #174 row: the result after its confirmation, not the PROVISIONAL publish). The
 * close time stands in for a row whose transition left none (a test factory's; every product
 * path stamps one), so the key is never NULL — a row comparison with a NULL in it is NULL, which
 * would end a page at that market. The results list orders and pages on it.
 */
const decidedAt: SQL = sql`coalesce(${schema.markets.resolvedAt}, ${schema.markets.closeAt})`;

/**
 * 테마 (#81) for everyone, signed in or not (ADR-0069 decision 4, the #81 '들어오는 길' row): the
 * list, a theme's page, its markets and results, and the themes a market is in. Only a published
 * theme is in any of these answers — an unpublished one is NOT_FOUND, as a DRAFT or REVIEW market
 * is — and only a public market (`isPublicMarket`). None of them names who made, edited or
 * published a theme, or carries anything about anyone's trades: the results are the markets' own.
 *
 * A theme's status (예정·진행 중·종료) is read at the Korean date of the database clock, once per
 * request, and both filters and orders the rows (`themeStatusWhere`, `themeListOrder`) and labels
 * them (`themeStatusAt`).
 */
@Injectable()
export class ThemesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketService,
  ) {}

  /**
   * `GET /themes`: the published themes, or those of one status, in the public order (owner
   * decision 2026-10-19): 진행 중 by the soonest end, 예정 by the soonest start, 종료 by the latest
   * end, keyset-paged on `(rank, key, id)` with the first page's Korean date pinned in the cursor
   * (`themeListPage`). The explore home reads the first few of every status and keeps the
   * leading status's (ADR-0088).
   */
  async list(query: ThemeListQuery): Promise<Page<ThemeSummary>> {
    const { themes } = schema;
    const now = await clockTimestamp(this.db);
    const page = themeListPage(query.cursor, now);
    const order = themeListOrder(page.today);
    const rows = await this.db
      .select({ theme: themes, ...order.fields })
      .from(themes)
      .where(
        and(
          isNotNull(themes.publishedAt),
          query.status === undefined ? undefined : themeStatusWhere(query.status, page.today),
          page.after,
        ),
      )
      .orderBy(...order.orderBy)
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toThemeSummary(row.theme, now)),
      nextCursor:
        hasMore && last
          ? themeListCursor(page.today, { rank: last.rank, key: last.key, id: last.theme.id })
          : null,
    };
  }

  /**
   * `GET /themes/:idOrSlug`: a published theme's page — its introduction and the notices it
   * shows, the newest first. The page's address is the slug (owner decision 2026-10-19); the id
   * reaches it too, as a market's does. Hidden notices are left out; an unpublished or unknown
   * theme is NOT_FOUND.
   */
  async get(idOrSlug: string): Promise<Theme> {
    const parsedId = uuidParamSchema.safeParse(idOrSlug);
    const { themes, themeNotices } = schema;
    const { theme, now } = await this.requirePublished(
      parsedId.success ? eq(themes.id, parsedId.data) : eq(themes.slug, idOrSlug.normalize('NFC')),
    );
    const notices = await this.db
      .select()
      .from(themeNotices)
      .where(and(eq(themeNotices.themeId, theme.id), isNull(themeNotices.hiddenAt)))
      .orderBy(desc(themeNotices.createdAt), desc(themeNotices.id));
    return {
      ...toThemeSummary(theme, now),
      intro: theme.intro,
      notices: notices.map((notice) => ({
        id: notice.id,
        title: notice.title,
        body: notice.body,
        createdAt: notice.createdAt.toISOString(),
        editedAt: notice.editedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * `GET /themes/:id/markets`: the markets in a published theme, every public status — a DRAFT or
   * REVIEW one is never shown (ADR-0069 decision 4, the #81 '편성 규칙' row) and a CANCELLED one
   * or one whose result is VOID is (owner decision 2026-10-19, moved onto the new statuses by
   * ADR-0093 decision 3) — as the home's cards. The order is the one every list that can hold
   * ended markets uses (`marketOrder`'s 마감 임박 over every public status, ADR-0066): the markets
   * not closed yet first, the soonest to close first, then the ended ones, the most recently
   * closed first — the markets a visitor can take part in come first.
   */
  async listMarkets(
    themeId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<MarketSummary>> {
    await this.requirePublished(eq(schema.themes.id, themeId));
    const { markets, categories } = schema;
    const order = marketOrder(this.db, 'closing', cursor, undefined);
    const rows = await this.db
      .select({ ...marketWithCategory, order: order.fields })
      .from(markets)
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(and(inTheme(this.db, themeId), isPublicMarket(), order.after))
      .orderBy(...order.orderBy)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toMarketSummary(row.market, row.category)),
      nextCursor: hasMore && last ? order.cursorOf(last) : null,
    };
  }

  /**
   * `GET /themes/:id/results`: the theme's markets whose result is confirmed — 결과 확정·지급
   * 중·지급 완료 (`THEME_RESULT_STATUSES`) — each with that result (YES·NO·VOID), the most
   * recently confirmed first, keyset-paged on `(decided, id)`. A PROVISIONAL result, which may
   * still be corrected, is not in it, and a CANCELLED market has no result (ADR-0093 decision 3,
   * the #174 row). The markets' own outcome only: nobody's trades, performance or PnL.
   */
  async listResults(
    themeId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<ThemeResult>> {
    await this.requirePublished(eq(schema.themes.id, themeId));
    const { markets } = schema;
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select({
        id: markets.id,
        slug: markets.slug,
        title: markets.title,
        status: markets.status,
        resolvedResult: markets.resolvedResult,
        decidedAtMs: sql<string>`(extract(epoch FROM ${decidedAt}) * 1000)::bigint::text`,
      })
      .from(markets)
      .where(
        and(
          inTheme(this.db, themeId),
          inArray(markets.status, [...THEME_RESULT_STATUSES]),
          // Every path into these statuses writes the result; a row without one (a test
          // factory's) has nothing to list.
          isNotNull(markets.resolvedResult),
          keyset
            ? tupleKeysetPredicate([
                { key: decidedAt, value: keyset.createdAt.toISOString(), cast: 'timestamptz' },
                { key: markets.id, value: keyset.id, cast: 'uuid' },
              ])
            : undefined,
        ),
      )
      .orderBy(desc(decidedAt), desc(markets.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => ({
        marketId: row.id,
        slug: row.slug,
        title: row.title,
        // Narrowed by the WHERE above: a status of THEME_RESULT_STATUSES, with a result.
        status: row.status as ThemeResultStatus,
        result: row.resolvedResult!,
        decidedAt: new Date(Number(row.decidedAtMs)).toISOString(),
      })),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: new Date(Number(last.decidedAtMs)), id: last.id })
          : null,
    };
  }

  /**
   * `GET /markets/:id/themes`: the published themes a public market is in, for the links on its
   * detail, in the public list's order (진행 중 → 예정 → 종료). Every status of theme: a 종료 theme
   * is still where the market was gathered. A DRAFT, REVIEW or unknown market is NOT_FOUND, as on
   * every sub-resource of a detail.
   */
  async listForMarket(marketId: string): Promise<ThemeSummary[]> {
    await this.markets.requirePublic(marketId);
    const { themes, themeMarkets } = schema;
    const now = await clockTimestamp(this.db);
    const order = themeListOrder(koreanDateAt(now));
    const rows = await this.db
      .select({ theme: themes })
      .from(themes)
      .where(
        and(
          isNotNull(themes.publishedAt),
          inArray(
            themes.id,
            this.db
              .select({ id: themeMarkets.themeId })
              .from(themeMarkets)
              .where(eq(themeMarkets.marketId, marketId)),
          ),
        ),
      )
      .orderBy(...order.orderBy);
    return rows.map((row) => toThemeSummary(row.theme, now));
  }

  /**
   * The published theme `where` names and the database clock, or NOT_FOUND — for an unknown theme
   * and an unpublished one alike, so a public reader cannot tell a theme being prepared from none.
   */
  private async requirePublished(where: SQL): Promise<{ theme: ThemeRow; now: Date }> {
    const { themes } = schema;
    const now = await clockTimestamp(this.db);
    const [theme] = await this.db
      .select()
      .from(themes)
      .where(and(where, isNotNull(themes.publishedAt)))
      .limit(1);
    if (!theme) throw new AppError('NOT_FOUND', { message: 'Theme not found' });
    return { theme, now };
  }
}

/** The markets in one theme, as a predicate on `markets.id` (the primary key's leading column). */
function inTheme(db: Db, themeId: string) {
  const { markets, themeMarkets } = schema;
  return inArray(
    markets.id,
    db
      .select({ id: themeMarkets.marketId })
      .from(themeMarkets)
      .where(eq(themeMarkets.themeId, themeId)),
  );
}
