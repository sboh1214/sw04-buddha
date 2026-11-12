import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  tradingAnomalyQuerySchema,
  tradingAnomalyReportSchema,
  type TradingAnomalyQuery,
  type TradingAnomalyReport,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { TradingAnomaliesService } from './trading-anomalies.service.js';

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/trading-anomalies')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class TradingAnomaliesController {
  constructor(private readonly anomalies: TradingAnomaliesService) {}

  @Get()
  @ApiQuery({ name: 'marketId', required: false, type: String, format: 'uuid' })
  @ApiOperation({
    operationId: 'adminGetTradingAnomalies',
    summary:
      'Read bounded human-pair and round-trip candidates without classifying or taking action',
  })
  @ApiData(tradingAnomalyReportSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  read(
    @Query({ schema: tradingAnomalyQuerySchema }) query: TradingAnomalyQuery,
  ): Promise<TradingAnomalyReport> {
    return this.anomalies.read(query);
  }
}
