import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminMarketMakerMetricsListItemSchema,
  adminMarketMakerMetricsOverviewSchema,
  adminMarketMakerMetricsSchema,
  listMarketMakerMetricsQuerySchema,
  uuidParamSchema,
  type AdminMarketMakerMetrics,
  type AdminMarketMakerMetricsListItem,
  type AdminMarketMakerMetricsOverview,
  type CursorQuery,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { AdminMarketMakerMetricsService } from './market-maker-metrics.service.js';

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketMakerMetricsController {
  constructor(private readonly metrics: AdminMarketMakerMetricsService) {}

  @Get('market-makers')
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiOperation({
    operationId: 'adminListMarketMakerMetrics',
    summary: 'List funded markets and their private current MM risk observations',
  })
  @ApiPageOf(adminMarketMakerMetricsListItemSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: listMarketMakerMetricsQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminMarketMakerMetricsListItem>> {
    const page = await this.metrics.list(query);
    return new ApiPage(page.data, page.meta);
  }

  @Get('market-makers/overview')
  @ApiOperation({
    operationId: 'adminGetMarketMakerMetricsOverview',
    summary: 'Read all funded markets risk totals and treasury in one private snapshot',
  })
  @ApiData(adminMarketMakerMetricsOverviewSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED')
  overview(): Promise<AdminMarketMakerMetricsOverview> {
    return this.metrics.overview();
  }

  @Get('markets/:id/market-maker/metrics')
  @ApiOperation({
    operationId: 'adminGetMarketMakerMetrics',
    summary: 'Read private current market inventory, capital, risk, depth and concentration',
  })
  @ApiData(adminMarketMakerMetricsSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  get(@Param('id', { schema: uuidParamSchema }) id: string): Promise<AdminMarketMakerMetrics> {
    return this.metrics.get(id);
  }
}
