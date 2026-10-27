import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { adminSmsStatusSchema, type AdminSmsStatus } from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { SmsStatusService } from './sms-status.service.js';

/**
 * SMS 발송 현황 (#183, owner decision 2026-10-18, second round, ADR-0070) for admins: the counts of
 * the 본인확인 texts — sent against the service's daily 500, never answered for, refused — over
 * the last 24 hours and the last seven Korean days. Guards run in order: SessionGuard (401 without
 * a session), AdminGuard (403 for a member), then OnboardedGuard (409 for an admin that has not
 * finished the onboarding, ADR-0072). A read: no admin_actions row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/sms')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminSmsStatusController {
  constructor(private readonly status: SmsStatusService) {}

  @Get('status')
  @ApiOperation({
    operationId: 'adminSmsStatus',
    summary:
      'Counts of the verification texts: sent (against the daily service limit), unanswered and refused, in the last 24 hours and per Korean day for seven days',
  })
  @ApiData(adminSmsStatusSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED')
  read(): Promise<AdminSmsStatus> {
    return this.status.status();
  }
}
