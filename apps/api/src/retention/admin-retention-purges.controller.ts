import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  cursorQuerySchema,
  retentionPurgeSchema,
  type CursorQuery,
  type RetentionPurge,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { RetentionPurgesService } from './retention-purges.service.js';

/**
 * 경과 처리 기록 (#184, ADR-0069 decision 4 #184 «종류·건수·시각을 운영 기록으로 남긴다», ADR-0087) for
 * admins: each run's kinds and counts, with the period applied and the run's instant — no personal
 * content. Guards run in order: SessionGuard (401 without a session), AdminGuard (403 for a member —
 * an operational record, N04 §6), then OnboardedGuard (409 for an admin that has not finished the
 * onboarding, ADR-0072). A read: no admin_actions row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/retention-purges')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminRetentionPurgesController {
  constructor(private readonly purges: RetentionPurgesService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListRetentionPurges',
    summary:
      'What the daily retention purge deleted, newest run first: kind, count, the period applied ' +
      '(days) and the run’s instant. A page never ends inside a run: `limit` records, then the ' +
      'rest of the run the last of them belongs to',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(retentionPurgeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<RetentionPurge>> {
    const { items, nextCursor } = await this.purges.list(query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }
}
