import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminTreasurySchema,
  cursorQuerySchema,
  decideTreasuryIssueBodySchema,
  expectedAccountBodySchema,
  requestTreasuryIssueBodySchema,
  treasuryIssuanceSchema,
  treasuryIssueRequestSchema,
  treasuryIssueRequestsQuerySchema,
  treasuryIssueWriteSchema,
  uuidParamSchema,
  type AdminTreasury,
  type CursorQuery,
  type DecideTreasuryIssueBody,
  type ExpectedAccountBody,
  type RequestTreasuryIssueBody,
  type TreasuryIssuance,
  type TreasuryIssueRequest,
  type TreasuryIssueRequestsQuery,
  type TreasuryIssueWrite,
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
import { TreasuryService } from './treasury.service.js';

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/treasury')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminGetTreasury',
    summary: 'Read the operating treasury and total issued Coin',
  })
  @ApiData(adminTreasurySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED')
  get(): Promise<AdminTreasury> {
    return this.treasury.getTreasury();
  }

  @Get('issue-requests')
  @ApiOperation({
    operationId: 'adminListTreasuryIssueRequests',
    summary: 'List fixed-amount treasury issuance requests',
  })
  @ApiPageOf(treasuryIssueRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: treasuryIssueRequestsQuerySchema }) query: TreasuryIssueRequestsQuery,
  ): Promise<ApiPage<TreasuryIssueRequest>> {
    const { items, nextCursor } = await this.treasury.listRequests(query);
    return new ApiPage(items, { nextCursor });
  }

  @Get('issue-requests/:id')
  @ApiOperation({
    operationId: 'adminGetTreasuryIssueRequest',
    summary: 'Read an issuance request and its immutable amount',
  })
  @ApiData(treasuryIssueRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  detail(@Param('id', { schema: uuidParamSchema }) id: string): Promise<TreasuryIssueRequest> {
    return this.treasury.getRequest(id);
  }

  @Get('history')
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiOperation({
    operationId: 'adminListTreasuryIssuances',
    summary: 'List completed approval-bound treasury issuances',
  })
  @ApiPageOf(treasuryIssuanceSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async history(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<TreasuryIssuance>> {
    const { items, nextCursor } = await this.treasury.history(query);
    return new ApiPage(items, { nextCursor });
  }

  @Post('issue-requests')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestTreasuryIssue',
    summary: 'Request a fixed Coin issuance for another administrator to decide',
  })
  @ApiData(treasuryIssueWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  request(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: requestTreasuryIssueBodySchema }) body: RequestTreasuryIssueBody,
  ): Promise<TreasuryIssueWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.treasury.request(admin.id, body);
  }

  @Post('issue-requests/:id/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveTreasuryIssue',
    summary: 'Approve and mint the requested amount atomically',
  })
  @ApiData(treasuryIssueWriteSchema)
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
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: decideTreasuryIssueBodySchema }) body: DecideTreasuryIssueBody,
  ): Promise<TreasuryIssueWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.treasury.approve(admin.id, id, body.reason);
  }

  @Post('issue-requests/:id/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectTreasuryIssue',
    summary: 'Reject another administrator’s issuance request without changing Coin',
  })
  @ApiData(treasuryIssueWriteSchema)
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
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: decideTreasuryIssueBodySchema }) body: DecideTreasuryIssueBody,
  ): Promise<TreasuryIssueWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.treasury.reject(admin.id, id, body.reason);
  }

  @Post('issue-requests/:id/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractTreasuryIssue',
    summary: 'Retract the acting administrator’s pending issuance request',
  })
  @ApiData(treasuryIssueWriteSchema)
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
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<TreasuryIssueWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.treasury.retract(admin.id, id);
  }
}
