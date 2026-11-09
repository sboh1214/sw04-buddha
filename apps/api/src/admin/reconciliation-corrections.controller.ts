import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  decideReconciliationRecoveryBodySchema,
  expectedAccountBodySchema,
  reconciliationCorrectionDetailSchema,
  reconciliationCorrectionRequestSchema,
  reconciliationCorrectionRequestsQuerySchema,
  reconciliationNumericIdSchema,
  requestReconciliationCorrectionBodySchema,
  uuidParamSchema,
  type DecideReconciliationRecoveryBody,
  type ExpectedAccountBody,
  type ReconciliationCorrectionDetail,
  type ReconciliationCorrectionRequest,
  type ReconciliationCorrectionRequestsQuery,
  type RequestReconciliationCorrectionBody,
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
import { ReconciliationCorrectionService } from './reconciliation-corrections.service.js';

/** A correction changes Coin only with fresh evidence and another administrator's approval. */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/reconciliation')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class ReconciliationCorrectionsController {
  constructor(private readonly corrections: ReconciliationCorrectionService) {}

  @Get('results/:resultId/corrections')
  @ApiOperation({
    operationId: 'adminGetReconciliationCorrections',
    summary: 'Read fixed correction candidates and requests for a failed reconciliation result',
  })
  @ApiData(reconciliationCorrectionDetailSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getDetail(
    @Param('resultId', { schema: reconciliationNumericIdSchema }) resultId: string,
  ): Promise<ReconciliationCorrectionDetail> {
    return this.corrections.getDetail(Number(resultId));
  }

  @Get('correction-requests')
  @ApiOperation({
    operationId: 'adminListReconciliationCorrectionRequests',
    summary: 'List correction requests, including requests waiting for treasury funds',
  })
  @ApiPageOf(reconciliationCorrectionRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listRequests(
    @Query({ schema: reconciliationCorrectionRequestsQuerySchema })
    query: ReconciliationCorrectionRequestsQuery,
  ): Promise<ApiPage<ReconciliationCorrectionRequest>> {
    const { items, nextCursor } = await this.corrections.listRequests(query);
    return new ApiPage(items, { nextCursor });
  }

  @Post('results/:resultId/correction-requests')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestReconciliationCorrection',
    summary: 'Request one server-calculated correction with separate internal and member reasons',
  })
  @ApiData(reconciliationCorrectionDetailSchema)
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
    @Param('resultId', { schema: reconciliationNumericIdSchema }) resultId: string,
    @Body({ schema: requestReconciliationCorrectionBodySchema })
    body: RequestReconciliationCorrectionBody,
  ): Promise<ReconciliationCorrectionDetail> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.corrections.request(admin.id, Number(resultId), body);
  }

  @Post('results/:resultId/correction-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveReconciliationCorrection',
    summary: 'Revalidate and apply a correction atomically; insufficient treasury keeps it pending',
  })
  @ApiData(reconciliationCorrectionDetailSchema)
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
    @Param('resultId', { schema: reconciliationNumericIdSchema }) resultId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: decideReconciliationRecoveryBodySchema })
    body: DecideReconciliationRecoveryBody,
  ): Promise<ReconciliationCorrectionDetail> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.corrections.approve(admin.id, Number(resultId), requestId, body.reason);
  }

  @Post('results/:resultId/correction-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectReconciliationCorrection',
    summary: 'Reject another administrator’s pending correction without changing Coin',
  })
  @ApiData(reconciliationCorrectionDetailSchema)
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
    @Param('resultId', { schema: reconciliationNumericIdSchema }) resultId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: decideReconciliationRecoveryBodySchema })
    body: DecideReconciliationRecoveryBody,
  ): Promise<ReconciliationCorrectionDetail> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.corrections.reject(admin.id, Number(resultId), requestId, body.reason);
  }

  @Post('results/:resultId/correction-requests/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractReconciliationCorrection',
    summary: 'Retract the acting administrator’s pending correction without changing Coin',
  })
  @ApiData(reconciliationCorrectionDetailSchema)
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
    @Param('resultId', { schema: reconciliationNumericIdSchema }) resultId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<ReconciliationCorrectionDetail> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.corrections.retract(admin.id, Number(resultId), requestId);
  }
}
