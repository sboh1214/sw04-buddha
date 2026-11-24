import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { adminObservationMetricsSchema, type AdminObservationMetrics } from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ObservationMetricsService } from './observation-metrics.service.js';

/**
 * 관측 지표 (#96, ADR-0169; #151, ADR-0170) for admins only (95-10 "관리자만 집계값"): the six
 * metrics per KST week over the latest 12 weeks — #96's four, then the two visit-based cohorts
 * #151 appends (관심 등록 후 재방문, 결과 조회, 96-7) — counts and durations of the whole service,
 * no account, market, post, report or visit named (95-6, 95-10). Every admin reads it (ADR-0056 결정
 * 1-2: it is computed from the reports and the moderation records too, N04 §6); guards in order
 * SessionGuard (401), AdminGuard (403 for a member), OnboardedGuard (409, ADR-0072). A read: no
 * query, no body, no `admin_actions` row (admin-audit.test), nothing written (a READ ONLY
 * transaction).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/observation-metrics')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminObservationMetricsController {
  constructor(private readonly metrics: ObservationMetricsService) {}

  @Get()
  @ApiOperation({
    operationId: 'getAdminObservationMetrics',
    summary:
      '관측 지표 (#96, #151): 첫 체결 전환, 정산 후 재참여 (7×24h cohorts), 유효 토론 and 신고 처리 ' +
      '시간 (cases, nearest-rank median and 90th percentile, pending targets), 관심 등록 후 재방문 ' +
      '(first watch, a detail visit on a KST date D+1…D+7) and 결과 조회 (a trader of a market whose ' +
      'provisional result was first published, a visit on D…D+7) per KST week over the latest 12 ' +
      'weeks, newest first, recounted from the records on every read. Bots, and accounts that were ' +
      'admins when they acted, are left out; counts only, no account or item named',
  })
  @ApiData(adminObservationMetricsSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED')
  getAdminObservationMetrics(): Promise<AdminObservationMetrics> {
    return this.metrics.read();
  }
}
