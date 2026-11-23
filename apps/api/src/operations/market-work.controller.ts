import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminMarketWorkEntrySchema,
  adminMarketWorkQuerySchema,
  uuidParamSchema,
  type AdminMarketWorkEntry,
  type AdminMarketWorkQuery,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { MarketWorkService } from './market-work.service.js';

/**
 * 시장별 작업 이력 (#145, ADR-0164): `/admin/markets/[id]/work-history`'s list. Every admin reads it
 * (ADR-0056 결정 1-2: "운영 목록·작업 이력(#145)"); guards in order SessionGuard (401), AdminGuard
 * (403 for a member — operation records, N04 §6), OnboardedGuard (409, ADR-0072). Reads only.
 * The query DTO extends the cursor query with no component id, so swagger expands it itself.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketWorkController {
  constructor(private readonly work: MarketWorkService) {}

  @Get(':id/work-history')
  @ApiOperation({
    operationId: 'adminListMarketWorkHistory',
    summary:
      '시장별 작업 이력 (145-5): the market’s admin actions, approval requests and decisions, the ' +
      'records bound to it and its system events (actor null, 시스템), oldest first, each with ' +
      'its actor, time and reason or the basis that stands for one; `kind` keeps one of 수정·' +
      '중단·판정·지급·그 밖. Bot controls and themes are not in it; an unknown market is empty',
  })
  @ApiPageOf(adminMarketWorkEntrySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketWorkHistory(
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Query({ schema: adminMarketWorkQuerySchema }) query: AdminMarketWorkQuery,
  ): Promise<ApiPage<AdminMarketWorkEntry>> {
    const page = await this.work.history(id, query);
    return new ApiPage(page.data, page.meta);
  }
}
