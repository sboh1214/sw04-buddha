import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminMarketReviewItemSchema,
  cursorQuerySchema,
  type AdminMarketReviewItem,
  type CursorQuery,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { MarketAdminService } from './market-admin.service.js';

/**
 * 검수 대기 (#78, ADR-0099): the markets submitted for review that wait for another admin's
 * approval or 반려 — the decisions themselves are the market's own routes
 * (`/admin/markets/:id/approve`, `reject`, `revert`). Guards run in order: SessionGuard (401
 * without a session), AdminGuard (403 for a member), OnboardedGuard (409 ONBOARDING_REQUIRED for an
 * admin that has not finished the onboarding, ADR-0072). A read: no admin_actions row
 * (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/market-reviews')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketReviewsController {
  constructor(private readonly markets: MarketAdminService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarketReviews',
    summary:
      'The markets waiting for review (REVIEW, with their pending request), the oldest ' +
      'submission first: who submitted and when, who created the market, its category, ' +
      'scheduled open and close',
  })
  // `cursorQuerySchema` has a component id (CursorQuery), so the parameters are declared here
  // (cursor-query.ts).
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminMarketReviewItemSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketReviews(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminMarketReviewItem>> {
    const { items, nextCursor } = await this.markets.listReviews(query);
    return new ApiPage(items, { nextCursor });
  }
}
