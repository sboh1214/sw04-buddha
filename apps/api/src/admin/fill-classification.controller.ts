import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  cursorQuerySchema,
  adminClassifiableFillSchema,
  classificationFillIdSchema,
  decideFillClassificationBodySchema,
  retractFillClassificationBodySchema,
  fillClassificationSchema,
  fillClassificationRequestSchema,
  fillClassificationListQuerySchema,
  fillClassificationWriteSchema,
  requestFillClassificationBodySchema,
  uuidParamSchema,
  type CursorQuery,
  type DecideFillClassificationBody,
  type RetractFillClassificationBody,
  type FillClassificationListQuery,
  type RequestFillClassificationBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import type { SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { FillClassificationService } from './fill-classification.service.js';

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/fills/:fillId')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class FillClassificationController {
  constructor(private readonly classifications: FillClassificationService) {}
  @Get()
  @ApiOperation({
    operationId: 'adminGetClassifiableFill',
    summary: 'Read one immutable fill and its internal classification',
  })
  @ApiData(adminClassifiableFillSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR', 'NOT_FOUND')
  fill(@Param('fillId', { schema: classificationFillIdSchema }) fillId: string) {
    return this.classifications.fill(fillId);
  }
  @Get('classification-requests')
  @ApiOperation({
    operationId: 'adminListFillClassifications',
    summary: 'Read fixed fill classification requests',
  })
  @ApiPageOf(fillClassificationRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Param('fillId', { schema: classificationFillIdSchema }) fillId: string,
    @Query({ schema: fillClassificationListQuerySchema })
    query: FillClassificationListQuery,
  ) {
    const page = await this.classifications.list(query, fillId);
    return new ApiPage(page.items, { nextCursor: page.nextCursor });
  }
  @Get('classification-requests/:requestId')
  @ApiOperation({
    operationId: 'adminGetFillClassification',
    summary: 'Read a request and current internal classification snapshot',
  })
  @ApiData(fillClassificationWriteSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  get(
    @Param('fillId', { schema: classificationFillIdSchema }) fillId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
  ) {
    return this.classifications.get(fillId, requestId);
  }

  @Get('classification-history')
  @ApiOperation({
    operationId: 'adminListFillClassificationHistory',
    summary: 'Read actual immutable classifications',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(fillClassificationSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async history(
    @Param('fillId', { schema: classificationFillIdSchema }) fillId: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ) {
    const page = await this.classifications.history(fillId, query);
    return new ApiPage(page.items, { nextCursor: page.nextCursor });
  }
  @Post('classification-requests')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestFillClassification',
    summary: 'Request a fixed two-person fill classification',
  })
  @ApiData(fillClassificationWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'FILL_CLASSIFICATION_NOT_ALLOWED',
    'TRANSACTION_BUSY',
  )
  request(
    @CurrentUser() admin: SessionUser,
    @Param('fillId', { schema: classificationFillIdSchema }) fillId: string,
    @Body({ schema: requestFillClassificationBodySchema }) body: RequestFillClassificationBody,
  ) {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.classifications.request(admin.id, fillId, body);
  }
  @Post('classification-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveFillClassification',
    summary: 'Approve and atomically execute the fixed classification',
  })
  @ApiData(fillClassificationWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'FILL_CLASSIFICATION_NOT_ALLOWED',
    'TRANSACTION_BUSY',
  )
  approve(
    @CurrentUser() admin: SessionUser,
    @Param('fillId', { schema: classificationFillIdSchema }) fillId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: decideFillClassificationBodySchema }) body: DecideFillClassificationBody,
  ) {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.classifications.approve(admin.id, fillId, requestId, body.reason);
  }
  @Post('classification-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectFillClassification',
    summary: 'Reject a pending classification without touching assets',
  })
  @ApiData(fillClassificationWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'FILL_CLASSIFICATION_NOT_ALLOWED',
    'TRANSACTION_BUSY',
  )
  reject(
    @CurrentUser() admin: SessionUser,
    @Param('fillId', { schema: classificationFillIdSchema }) fillId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: decideFillClassificationBodySchema }) body: DecideFillClassificationBody,
  ) {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.classifications.reject(admin.id, fillId, requestId, body.reason);
  }
  @Post('classification-requests/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractFillClassification',
    summary: 'Retract the current administrator’s pending classification',
  })
  @ApiData(fillClassificationWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'FILL_CLASSIFICATION_NOT_ALLOWED',
    'TRANSACTION_BUSY',
  )
  retract(
    @CurrentUser() admin: SessionUser,
    @Param('fillId', { schema: classificationFillIdSchema }) fillId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: retractFillClassificationBodySchema }) body: RetractFillClassificationBody,
  ) {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.classifications.retract(admin.id, fillId, requestId);
  }
}

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/fill-classifications/requests')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AllFillClassificationsController {
  constructor(private readonly classifications: FillClassificationService) {}
  @Get()
  @ApiOperation({
    operationId: 'adminListAllFillClassifications',
    summary: 'Read pending or completed classification requests across markets',
  })
  @ApiPageOf(fillClassificationRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: fillClassificationListQuerySchema })
    query: FillClassificationListQuery,
  ) {
    const page = await this.classifications.list(query);
    return new ApiPage(page.items, { nextCursor: page.nextCursor });
  }
}
