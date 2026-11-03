import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminMarketSchema,
  recordJudgementDelayBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type RecordJudgementDelayBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { MarketJudgementDelayService } from './market-judgement-delay.service.js';

/**
 * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13, decision 3 '#142 지연
 * 사유'): one admin, alone and at once — no approval request (#173 item 2) — records why a market
 * that reads '판정 지연' is late and when it is next reviewed. A change is a new record: there is
 * no edit and no withdrawal route (owner answer 2026-11-03 (4)), and the earlier records stay as
 * the history `AdminMarket.judgementDelays` shows. The write answers the admin detail. Guards run
 * in order: SessionGuard (401 without a session, 403 for a foreign Origin on a mutation),
 * AdminGuard (403 for a member), OnboardedGuard (409 ONBOARDING_REQUIRED, ADR-0072). It names the
 * admin on screen (`expectedAccountId`, ADR-0092), refused before anything is read when it is not
 * the cookie's, and writes its `admin_actions` row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketJudgementDelaysController {
  constructor(private readonly delays: MarketJudgementDelayService) {}

  @Post(':id/judgement-delays')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRecordMarketJudgementDelay',
    summary:
      'Record why a delayed market’s judgement is late and when it is next reviewed (판정 지연 ' +
      '기록) by one admin, at once: on a closed market past its scheduled judgement or a ' +
      'provisional one a dispute or a waiting correction holds past its dispute deadline, a ' +
      'public reason and a next review time after now and at most 7 days ahead. Each record is ' +
      'a new one — the earlier ones stay as history, none is edited or withdrawn — and the ' +
      'public detail shows the current one without who recorded it. Nothing of the market ' +
      'changes: no status, no result, no scheduled judgement, and the time passing creates ' +
      'nothing',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names, from the body, `reason` (1–500 characters, trimmed) or `nextReviewAt`
  // (an ISO instant in UTC); then, in this order on the database clock read after the market
  // lock, `status` 'not awaiting a judgement' (neither closed nor provisional), `status` 'not
  // delayed' (closed before its scheduled judgement or with none, provisional before its dispute
  // deadline or held by nothing), `nextReviewAt` 'not after now' and `nextReviewAt` 'more than 7
  // days ahead' (exactly 7 × 24 hours is taken).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminRecordMarketJudgementDelay(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: recordJudgementDelayBodySchema }) body: RecordJudgementDelayBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...delay } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.delays.record(admin.id, id, delay);
  }
}
