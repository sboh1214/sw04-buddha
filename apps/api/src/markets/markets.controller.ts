import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  FILLS_RECENT_LIMIT,
  MARKET_SLUG_MAX,
  SPARKLINE_MAX_POINTS,
  SPARKLINE_WINDOW_HOURS,
  TICKS_MAX_POINTS,
  TICKS_SCAN_MAX,
  categorySchema,
  fillSchema,
  marketListItemSchema,
  marketListQuerySchema,
  marketSchema,
  priceSeriesSchema,
  quoteBodySchema,
  quoteResultSchema,
  ticksQuerySchema,
  uuidParamSchema,
  type Category,
  type Fill,
  type Market,
  type MarketListItem,
  type MarketListQuery,
  type PriceSeries,
  type QuoteBody,
  type QuoteResult,
  type TicksQuery,
} from '@buddha/shared';
import * as z from 'zod';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { MarketService } from './market.service.js';
import { QuoteService } from './quote.service.js';

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
 * Public market reads and quotes (PLAN 7.1, M3). No guard: PLAN 7.1's "정보 조회 (공개)"
 * routes serve anonymous visitors, and a quote is a price check with no side effect.
 */
@ApiTags('markets')
@Controller('markets')
export class MarketsController {
  constructor(private readonly markets: MarketService) {}

  @Get()
  @ApiOperation({
    operationId: 'listMarkets',
    summary:
      'Markets by status (default open), never drafts; sorted by volume, closing or newest. ' +
      `Each card carries up to ${String(SPARKLINE_MAX_POINTS)} hourly YES samples over the ` +
      `last ${String(SPARKLINE_WINDOW_HOURS)} hours, oldest first.`,
  })
  @ApiPageOf(marketListItemSchema)
  @ApiErrors('VALIDATION_ERROR')
  async listMarkets(
    @Query({ schema: marketListQuerySchema }) query: MarketListQuery,
  ): Promise<ApiPage<MarketListItem>> {
    const { items, nextCursor } = await this.markets.list(query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':idOrSlug')
  @ApiOperation({
    operationId: 'getMarket',
    summary: 'One market by id or slug (a draft is NOT_FOUND to the public)',
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

/** `GET /categories`: the active ones, in display order. */
@ApiTags('markets')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly markets: MarketService) {}

  @Get()
  @ApiOperation({ operationId: 'listCategories', summary: 'Active categories in display order' })
  @ApiData(categorySchema.array())
  listCategories(): Promise<Category[]> {
    return this.markets.listCategories();
  }
}

/** `POST /quotes` (PLAN 7.1): a price check, public and without side effects. */
@ApiTags('markets')
@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotes: QuoteService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    operationId: 'quote',
    summary:
      'Price a buy or sell (mode shares) or the contracts a budget buys (mode spend, buy only)',
  })
  @ApiData(quoteResultSchema)
  // NOT_FOUND: unknown market or a draft. MARKET_NOT_OPEN: any status but open.
  // MARKET_CLOSED: open, but past its close time.
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR', 'MARKET_NOT_OPEN', 'MARKET_CLOSED')
  quote(@Body({ schema: quoteBodySchema }) body: QuoteBody): Promise<QuoteResult> {
    return this.quotes.quote(body);
  }
}
