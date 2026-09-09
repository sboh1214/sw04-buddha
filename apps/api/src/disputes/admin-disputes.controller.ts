import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminDisputeSchema,
  adminDisputesQuerySchema,
  reviewDisputeBodySchema,
  uuidParamSchema,
  type AdminDispute,
  type AdminDisputesQuery,
  type ReviewDisputeBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { DisputeService } from './dispute.service.js';

/**
 * Admin dispute list and review (PLAN 7.3, 12; M5). Guards run in order: SessionGuard fills
 * `request.auth` (401 without a session, 403 for a foreign Origin on the PATCH), AdminGuard
 * reads the role (403 for a member).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/disputes')
@UseGuards(SessionGuard, AdminGuard)
export class AdminDisputesController {
  constructor(private readonly disputes: DisputeService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListDisputes',
    summary: 'Every dispute, newest first; `status` and `marketId` narrow the list',
  })
  // No `@ApiQuery`: `adminDisputesQuerySchema` has no component id, so swagger expands it
  // into the cursor/limit/status/marketId parameters itself (see markets.controller.ts).
  @ApiPageOf(adminDisputeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async adminListDisputes(
    @Query({ schema: adminDisputesQuerySchema }) query: AdminDisputesQuery,
  ): Promise<ApiPage<AdminDispute>> {
    const { items, nextCursor } = await this.disputes.listAdmin(query);
    return new ApiPage(items, { nextCursor });
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'adminReviewDispute',
    summary:
      'Accept or reject a dispute with a note (revisable; accepting does not change the ' +
      'market result — use POST /admin/markets/:id/resolve for that)',
  })
  @ApiData(adminDisputeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminReviewDispute(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: reviewDisputeBodySchema }) body: ReviewDisputeBody,
  ): Promise<AdminDispute> {
    return this.disputes.review(admin.id, id, body);
  }
}
