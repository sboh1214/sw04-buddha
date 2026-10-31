import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  FILLS_RECENT_LIMIT,
  MARKET_SLUG_MAX,
  TICKS_MAX_POINTS,
  TICKS_SCAN_MAX,
  categorySchema,
  cursorQuerySchema,
  fillSchema,
  marketListQuerySchema,
  marketSchema,
  marketSummarySchema,
  priceSeriesSchema,
  ticksQuerySchema,
  uuidParamSchema,
  type Category,
  type CursorQuery,
  type Fill,
  type Market,
  type MarketListQuery,
  type MarketSummary,
  type PriceSeries,
  type TicksQuery,
} from '@buddha/shared';
import * as z from 'zod';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { MarketService } from './market.service.js';
import { RelatedMarketsService } from './related-markets.service.js';

/**
 * `GET /markets/:idOrSlug` takes either a uuid or a slug. The slug is NFC-normalised before
 * its length is checked — a decomposed (NFD) spelling of a Korean slug carries two or three
 * code units per syllable — so every stored slug (MARKET_SLUG_MAX characters at most, like
 * the column) is reachable in either spelling; anything longer once normalised is malformed,
 * not merely unknown. The router's own parameter bound is raised to match (fastify-options).
 */
const idOrSlugParamSchema = z
  .string()
  .min(1)
  .normalize('NFC')
  .max(MARKET_SLUG_MAX)
  .describe(
    `A market id (uuid) or slug; a slug is NFC-normalised before the ${String(MARKET_SLUG_MAX)}-character bound, so a decomposed spelling may be longer on the wire`,
  );

// Query parameters: `marketListQuerySchema` and `ticksQuerySchema` carry no `.meta({ id })`,
// and @nestjs/swagger 12 expands such a `@Query({ schema })` object into one parameter per
// field by itself (defaults, enums and lengths included). Declaring `@ApiQuery` on top would
// emit every name twice, which OpenAPI 3.0 forbids — only a query DTO WITH a component id
// (`cursorQuerySchema`, `adminUserQuerySchema`) needs the manual declarations.

/**
 * Public market reads (PLAN 7.1, M3). No guard: PLAN 7.1's "정보 조회 (공개)" routes serve
 * anonymous visitors.
 */
@ApiTags('markets')
@Controller('markets')
export class MarketsController {
  constructor(
    private readonly markets: MarketService,
    private readonly related: RelatedMarketsService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'listMarkets',
    summary:
      'Markets by status (default open; all is every public status), never draft or in review, ' +
      'optionally by category and a title search (q, a case-insensitive partial match); sorted ' +
      'recommended (24-hour volume, then the latest opening; the default), newest (latest ' +
      'opening) or closing (soonest close; with all or an ended status, the markets not closed ' +
      'yet (scheduled, open, paused) first and then the ended ones, latest close first)',
  })
  @ApiPageOf(marketSummarySchema)
  @ApiErrors('VALIDATION_ERROR')
  async listMarkets(
    @Query({ schema: marketListQuerySchema }) query: MarketListQuery,
  ): Promise<ApiPage<MarketSummary>> {
    const { items, nextCursor } = await this.markets.list(query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':idOrSlug')
  @ApiOperation({
    operationId: 'getMarket',
    summary: 'One market by id or slug (a draft or in-review one is NOT_FOUND to the public)',
  })
  @ApiData(marketSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  getMarket(@Param('idOrSlug', { schema: idOrSlugParamSchema }) idOrSlug: string): Promise<Market> {
    return this.markets.getPublic(idOrSlug);
  }

  @Get(':id/fills')
  @ApiOperation({
    operationId: 'listMarketFills',
    summary: `Newest ${String(FILLS_RECENT_LIMIT)} fills, anonymous`,
  })
  @ApiData(fillSchema.array())
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  listMarketFills(@Param('id', { schema: uuidParamSchema }) id: string): Promise<Fill[]> {
    return this.markets.listFills(id);
  }

  /**
   * 관련 시장 (#65, ADR-0068): the markets an admin linked to this one, from either side of the
   * link, in the public list's row and the home's 추천 order. Public (ADR-0061 decision 1, item
   * 18), like the detail it is a section of. `cursorQuerySchema` carries a component id, so its
   * two parameters are declared by hand (the trades controller does the same).
   */
  @Get(':id/related')
  @ApiOperation({
    operationId: 'listRelatedMarkets',
    summary:
      'Markets linked to this one (links are two-way): every public status but cancelled, ' +
      'never one whose result is VOID, sorted recommended (24-hour volume, then the latest ' +
      'opening); a draft, in-review or unknown market is NOT_FOUND',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(marketSummarySchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  async listRelatedMarkets(
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<MarketSummary>> {
    const { items, nextCursor } = await this.related.listPublic(id, query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':id/ticks')
  @ApiOperation({
    operationId: 'listMarketTicks',
    summary:
      `Price series, ascending, at most ${String(TICKS_MAX_POINTS)} points. ` +
      '`raw` returns stored ticks, downsampled from the newest ' +
      `${String(TICKS_SCAN_MAX)} of the range (\`truncated\` says when older ones were left ` +
      'out). `1m`/`1h` sample the probability in force on an absolute grid, coarsening the ' +
      'stride until the window fits; `bucketSeconds` reports the stride served, and the point ' +
      'at `from` carries the last value at or before it, so the left edge is never empty.',
  })
  @ApiData(priceSeriesSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  listMarketTicks(
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Query({ schema: ticksQuerySchema }) query: TicksQuery,
  ): Promise<PriceSeries> {
    return this.markets.listTicks(id, query);
  }
}

/** `GET /categories`: the active ones on both levels, flat, parents first, in display order. */
@ApiTags('markets')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly markets: MarketService) {}

  @Get()
  @ApiOperation({
    operationId: 'listCategories',
    summary:
      'Active categories in display order: top-level rows (parentId null) first, then their sub-categories',
  })
  @ApiData(categorySchema.array())
  listCategories(): Promise<Category[]> {
    return this.markets.listCategories();
  }
}
