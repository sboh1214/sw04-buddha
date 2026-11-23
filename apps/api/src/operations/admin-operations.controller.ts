import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminAwaitingJudgementMarketSchema,
  adminClosingMarketSchema,
  adminOperationsClosingQuerySchema,
  adminOperationsFailureSchema,
  adminOperationsFailuresQuerySchema,
  adminOperationsJudgementsQuerySchema,
  adminSettlementRetryBodySchema,
  adminSettlementRetryResultSchema,
  uuidParamSchema,
  type AdminAwaitingJudgementMarket,
  type AdminClosingMarket,
  type AdminOperationsClosingQuery,
  type AdminOperationsFailure,
  type AdminOperationsFailuresQuery,
  type AdminOperationsJudgementsQuery,
  type AdminSettlementRetryBody,
  type AdminSettlementRetryResult,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { AdminOperationsService } from './admin-operations.service.js';
import { SettlementRetryService } from './settlement-retry.service.js';

/**
 * 운영 대기열 (#145, ADR-0163): the operators' three queue lists of `/admin/operations`. Every
 * admin reads them (ADR-0056 결정 1-2: "운영 목록·작업 이력(#145)"); guards in order SessionGuard
 * (401), AdminGuard (403 for a member — operation records, N04 §6), OnboardedGuard (409,
 * ADR-0072). Reads only (AC 3): no `admin_actions` row (admin-audit.test), each list in a READ
 * ONLY transaction, and the time passing changes nothing.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/operations')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminOperationsController {
  constructor(private readonly operations: AdminOperationsService) {}

  @Get('closing')
  @ApiOperation({
    operationId: 'adminListOperationsClosingMarkets',
    summary:
      '마감 예정 (145-1): open and paused markets whose scheduled close is at most the chosen ' +
      'window ahead (24h, 3d or 7d; 24h by default), nearest close first. A market whose close ' +
      'time passed before its close ran stays listed with `overdue`',
  })
  @ApiPageOf(adminClosingMarketSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListOperationsClosingMarkets(
    @Query({ schema: adminOperationsClosingQuerySchema }) query: AdminOperationsClosingQuery,
  ): Promise<ApiPage<AdminClosingMarket>> {
    const page = await this.operations.closing(query);
    return new ApiPage(page.data, page.meta);
  }

  @Get('judgements')
  @ApiOperation({
    operationId: 'adminListOperationsAwaitingJudgements',
    summary:
      '판정 대기·지연 (145-2): every closed market, and every provisional one a dispute or a ' +
      'correction holds past its dispute deadline, by scheduled judgement (none last), each with ' +
      'its stage, its current 판정 지연 기록, 갱신 대기 and the long-delay deadline; ' +
      '`filter=delayed` keeps the rows that read 판정 지연. Reading changes nothing',
  })
  @ApiPageOf(adminAwaitingJudgementMarketSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListOperationsAwaitingJudgements(
    @Query({ schema: adminOperationsJudgementsQuerySchema }) query: AdminOperationsJudgementsQuery,
  ): Promise<ApiPage<AdminAwaitingJudgementMarket>> {
    const page = await this.operations.judgements(query);
    return new ApiPage(page.data, page.meta);
  }

  @Get('failures')
  @ApiOperation({
    operationId: 'adminListOperationsFailures',
    summary:
      '정산 실패 (145-4, 145-8): settling markets whose payout failed or waits on a ledger hold ' +
      '(the public 지급 지연), markets an automatic transition left untouched for 30 minutes ' +
      '(처리 멈춤) and settled or cancelled markets whose bot recall failed, oldest first',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminOperationsFailureSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListOperationsFailures(
    @Query({ schema: adminOperationsFailuresQuerySchema }) query: AdminOperationsFailuresQuery,
  ): Promise<ApiPage<AdminOperationsFailure>> {
    const page = await this.operations.failures(query);
    return new ApiPage(page.data, page.meta);
  }
}

/**
 * 정산 다시 시도 (#145, ADR-0163; 145-7, 145-14): one admin with a reason, at once — no approval
 * request. It names the admin on screen (`expectedAccountId`, ADR-0092), refused before anything
 * is read when it is not the cookie's, and writes `market_settlement_retry` (admin-audit.test):
 * `settled` with the payout, or `failed` with the step's attempt in the failure record's own
 * transaction.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminSettlementRetriesController {
  constructor(private readonly retries: SettlementRetryService) {}

  @Post(':id/settlement-retries')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetryMarketSettlement',
    summary:
      'Run one payout attempt of a settling market now (정산 다시 시도), by one admin with a ' +
      'reason: the same checks as the worker’s automatic retry every minute, nothing of the ' +
      'payout or the checks changeable. 200 answers the attempt’s outcome — `settled`, or ' +
      '`failed` with the step’s error and attempts — and both are recorded with the reason',
  })
  @ApiData(adminSettlementRetryResultSchema)
  // VALIDATION_ERROR names `reason` (1–500 characters, trimmed) from the body, or `status` 'not
  // settling' (nothing recorded). TRANSACTION_BUSY: the market's lock was not had before the
  // attempt began (another run of its payout holds it); nothing recorded.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'TRANSACTION_BUSY',
  )
  adminRetryMarketSettlement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: adminSettlementRetryBodySchema }) body: AdminSettlementRetryBody,
  ): Promise<AdminSettlementRetryResult> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.retries.retry(admin.id, id, body.reason);
  }
}
