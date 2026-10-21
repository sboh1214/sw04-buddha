import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminLinkFlagSchema,
  cursorQuerySchema,
  type AdminLinkFlag,
  type CursorQuery,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { LinkReviewService } from './link-review.service.js';

/**
 * 반복 링크 검토 목록 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187) for operators:
 * the posts and comments a repetition rule caught — the link, why and when, and the item as it is
 * now. A list to look at: nothing here acts on an item (hiding, warning and restricting are #50's
 * moderation, where this list moves when that area is built). Guards run in order: SessionGuard
 * (401 without a session), AdminGuard (403 for a member), then OnboardedGuard (409 for an admin
 * that has not finished the onboarding, ADR-0072). A read: no admin_actions row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/link-flags')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminLinkFlagsController {
  constructor(private readonly links: LinkReviewService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListLinkFlags',
    summary:
      'The repeated-link review list, newest first: each post or comment a rule caught (the same ' +
      'person put the link in 3 or more posts and comments within 24 hours, or 3 or more people ' +
      'did), the link, the rule and when, with the item as it is now',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminLinkFlagSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminLinkFlag>> {
    const { items, nextCursor } = await this.links.list(query);
    return new ApiPage(items, { nextCursor });
  }
}
