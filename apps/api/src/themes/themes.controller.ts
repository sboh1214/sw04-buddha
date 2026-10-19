import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  MARKET_SLUG_MAX,
  cursorQuerySchema,
  marketSummarySchema,
  themeListQuerySchema,
  themeResultSchema,
  themeSchema,
  themeSummarySchema,
  uuidParamSchema,
  type CursorQuery,
  type MarketSummary,
  type Theme,
  type ThemeListQuery,
  type ThemeResult,
  type ThemeSummary,
} from '@buddha/shared';
import * as z from 'zod';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { ThemesService } from './themes.service.js';

/**
 * `GET /themes/:idOrSlug` takes a uuid or the slug that is the page's address (owner decision
 * 2026-10-19), NFC-normalised before its bound as `GET /markets/:idOrSlug`'s is, the bound a
 * slug's own (`themeSlugSchema`, a market slug's). Anything longer once normalised is malformed.
 */
const idOrSlugParamSchema = z
  .string()
  .min(1)
  .normalize('NFC')
  .max(MARKET_SLUG_MAX)
  .describe(
    `A theme id (uuid) or slug; a slug is NFC-normalised before the ${String(MARKET_SLUG_MAX)}-character bound`,
  );

/**
 * 테마 (#81) in public: no guard, signed out too (ADR-0069 decision 4, the #81 '들어오는 길' row).
 * Only published themes and markets that are not drafts. `cursorQuerySchema` carries a component
 * id, so the sub-lists declare its two parameters by hand (as `GET /markets/:id/related` does);
 * `themeListQuerySchema` has none and swagger expands it by itself.
 */
@ApiTags('themes')
@Controller('themes')
export class ThemesController {
  constructor(private readonly themes: ThemesService) {}

  @Get()
  @ApiOperation({
    operationId: 'listThemes',
    summary:
      'Published themes: ongoing ones by the soonest end, then upcoming ones by the soonest ' +
      'start, then ended ones by the latest end; status narrows them to one of the three, read ' +
      'on the Korean date (both dates of the period are in it)',
  })
  @ApiPageOf(themeSummarySchema)
  @ApiErrors('VALIDATION_ERROR')
  async listThemes(
    @Query({ schema: themeListQuerySchema }) query: ThemeListQuery,
  ): Promise<ApiPage<ThemeSummary>> {
    const { items, nextCursor } = await this.themes.list(query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':idOrSlug')
  @ApiOperation({
    operationId: 'getTheme',
    summary:
      "A published theme's page by slug or id: introduction, period and status, and its shown " +
      'notices, newest first; an unpublished or unknown theme is NOT_FOUND',
  })
  @ApiData(themeSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  getTheme(@Param('idOrSlug', { schema: idOrSlugParamSchema }) idOrSlug: string): Promise<Theme> {
    return this.themes.get(idOrSlug);
  }

  @Get(':id/markets')
  @ApiOperation({
    operationId: 'listThemeMarkets',
    summary:
      "The theme's markets in every public status, voided ones too (never drafts): open ones " +
      'first, soonest close first, then the ended ones, latest close first',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(marketSummarySchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  async listThemeMarkets(
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<MarketSummary>> {
    const { items, nextCursor } = await this.themes.listMarkets(id, query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':id/results')
  @ApiOperation({
    operationId: 'listThemeResults',
    summary:
      "The theme's resolved, settled and voided markets with their result (YES or NO; none when " +
      'voided), the most recently decided first',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(themeResultSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  async listThemeResults(
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<ThemeResult>> {
    const { items, nextCursor } = await this.themes.listResults(id, query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }
}

/**
 * The themes a market is in, for the links on its detail (ADR-0069 decision 4, '시장 상세의 소속
 * 묶음 링크'). Under `/markets` like the detail's other sections, but here: the themes module reads
 * the market (MarketService), so the markets module cannot read the themes without a cycle.
 */
@ApiTags('themes')
@Controller('markets')
export class MarketThemesController {
  constructor(private readonly themes: ThemesService) {}

  @Get(':id/themes')
  @ApiOperation({
    operationId: 'listMarketThemes',
    summary:
      'The published themes this market is in, any status, in the public list order; a draft ' +
      'or unknown market is NOT_FOUND',
  })
  @ApiData(themeSummarySchema.array())
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  listMarketThemes(@Param('id', { schema: uuidParamSchema }) id: string): Promise<ThemeSummary[]> {
    return this.themes.listForMarket(id);
  }
}
