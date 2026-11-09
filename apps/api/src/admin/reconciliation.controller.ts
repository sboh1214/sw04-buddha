import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  decideReconciliationRecoveryBodySchema,
  expectedAccountBodySchema,
  reconciliationHoldDetailSchema,
  reconciliationHoldsQuerySchema,
  reconciliationResultSchema,
  reconciliationResultsQuerySchema,
  reconciliationRunSchema,
  requestReconciliationRecoveryBodySchema,
  runReconciliationBodySchema,
  uuidParamSchema,
  type DecideReconciliationRecoveryBody,
  type ExpectedAccountBody,
  type ReconciliationHoldDetail,
  type ReconciliationHoldsQuery,
  type ReconciliationResult,
  type ReconciliationResultsQuery,
  type ReconciliationRun,
  type RequestReconciliationRecoveryBody,
  type RunReconciliationBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ReconciliationService } from './reconciliation.service.js';

/** Evidence is admin-only. Every mutation records its action with the observed or approved work. */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/reconciliation')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('results')
  @ApiOperation({
    operationId: 'adminListReconciliationResults',
    summary: 'List immutable reconciliation results, newest first, optionally for one target',
  })
  @ApiPageOf(reconciliationResultSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listResults(
    @Query({ schema: reconciliationResultsQuerySchema }) query: ReconciliationResultsQuery,
  ): Promise<ApiPage<ReconciliationResult>> {
    const page = await this.reconciliation.listResults(query);
    return new ApiPage(page.items, { nextCursor: page.nextCursor });
  }

  @Get('holds')
  @ApiOperation({
    operationId: 'adminListReconciliationHolds',
    summary:
      'List reconciliation holds with their latest evidence and recovery requests; active holds by default',
  })
  @ApiPageOf(reconciliationHoldDetailSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listHolds(
    @Query({ schema: reconciliationHoldsQuerySchema }) query: ReconciliationHoldsQuery,
  ): Promise<ApiPage<ReconciliationHoldDetail>> {
    const page = await this.reconciliation.listHolds(query);
    return new ApiPage(page.items, { nextCursor: page.nextCursor });
  }

  @Get('holds/:holdId')
  @ApiOperation({
    operationId: 'adminGetReconciliationHold',
    summary: 'Read a hold, its latest check, target and recovery history',
  })
  @ApiData(reconciliationHoldDetailSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getHold(
    @Param('holdId', { schema: uuidParamSchema }) holdId: string,
  ): Promise<ReconciliationHoldDetail> {
    return this.reconciliation.getHold(holdId);
  }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRunReconciliation',
    summary: 'Recheck a market, account or total supply; a clean check does not release a hold',
  })
  @ApiData(reconciliationRunSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  run(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: runReconciliationBodySchema }) body: RunReconciliationBody,
  ): Promise<ReconciliationRun> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.reconciliation.run(admin.id, body.target);
  }

  @Post('holds/:holdId/recovery-requests')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestReconciliationRecovery',
    summary:
      'Request recovery of a clean, active hold; paused markets use their existing resume or early-close approval',
  })
  @ApiData(reconciliationHoldDetailSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  request(
    @CurrentUser() admin: SessionUser,
    @Param('holdId', { schema: uuidParamSchema }) holdId: string,
    @Body({ schema: requestReconciliationRecoveryBodySchema })
    body: RequestReconciliationRecoveryBody,
  ): Promise<ReconciliationHoldDetail> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.reconciliation.request(admin.id, holdId, body.failureResultId, body.reason);
  }

  @Post('holds/:holdId/recovery-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveReconciliationRecovery',
    summary:
      'Recheck and recover a hold with another administrator’s approval, atomically ending deferred orders',
  })
  @ApiData(reconciliationHoldDetailSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  approve(
    @CurrentUser() admin: SessionUser,
    @Param('holdId', { schema: uuidParamSchema }) holdId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: decideReconciliationRecoveryBodySchema })
    body: DecideReconciliationRecoveryBody,
  ): Promise<ReconciliationHoldDetail> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.reconciliation.approve(admin.id, holdId, requestId, body.reason);
  }

  @Post('holds/:holdId/recovery-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectReconciliationRecovery',
    summary: 'Reject another administrator’s pending recovery request without releasing the hold',
  })
  @ApiData(reconciliationHoldDetailSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  reject(
    @CurrentUser() admin: SessionUser,
    @Param('holdId', { schema: uuidParamSchema }) holdId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: decideReconciliationRecoveryBodySchema })
    body: DecideReconciliationRecoveryBody,
  ): Promise<ReconciliationHoldDetail> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.reconciliation.reject(admin.id, holdId, requestId, body.reason);
  }

  @Post('holds/:holdId/recovery-requests/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractReconciliationRecovery',
    summary: 'Retract the acting administrator’s pending recovery request',
  })
  @ApiData(reconciliationHoldDetailSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  retract(
    @CurrentUser() admin: SessionUser,
    @Param('holdId', { schema: uuidParamSchema }) holdId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<ReconciliationHoldDetail> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.reconciliation.retract(admin.id, holdId, requestId);
  }
}
