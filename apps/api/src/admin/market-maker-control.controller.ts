import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  cursorQuerySchema,
  decideMarketMakerControlBodySchema,
  expectedAccountBodySchema,
  marketMakerControlExecutionSchema,
  marketMakerControlRequestSchema,
  marketMakerControlRequestsQuerySchema,
  marketMakerControlWriteSchema,
  requestMarketMakerControlBodySchema,
  uuidParamSchema,
  type CursorQuery,
  type DecideMarketMakerControlBody,
  type ExpectedAccountBody,
  type MarketMakerControlRequestsQuery,
  type RequestMarketMakerControlBody,
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
import { MarketMakerControlService } from './market-maker-control.service.js';

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets/:marketId/market-maker')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class MarketMakerControlController {
  constructor(private readonly controls: MarketMakerControlService) {}
  @Get('control-requests')
  @ApiOperation({
    operationId: 'adminListMarketMakerControls',
    summary: 'Read fixed market maker control requests',
  })
  @ApiPageOf(marketMakerControlRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Query({ schema: marketMakerControlRequestsQuerySchema })
    query: MarketMakerControlRequestsQuery,
  ) {
    const page = await this.controls.list(query, marketId);
    return new ApiPage(page.items, { nextCursor: page.nextCursor });
  }
  @Get('control-requests/:requestId')
  @ApiOperation({
    operationId: 'adminGetMarketMakerControl',
    summary: 'Read a request and current private market maker snapshot',
  })
  @ApiData(marketMakerControlWriteSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  get(
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
  ) {
    return this.controls.get(marketId, requestId);
  }

  @Get('control-history')
  @ApiOperation({
    operationId: 'adminListMarketMakerControlHistory',
    summary: 'Read actual immutable controls',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(marketMakerControlExecutionSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async history(
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ) {
    const page = await this.controls.history(marketId, query);
    return new ApiPage(page.items, { nextCursor: page.nextCursor });
  }
  @Post('control-requests')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestMarketMakerControl',
    summary: 'Request a fixed two-person market maker control',
  })
  @ApiData(marketMakerControlWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'MARKET_MAKER_CONTROL_NOT_ALLOWED',
    'TRANSACTION_BUSY',
  )
  request(
    @CurrentUser() admin: SessionUser,
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Body({ schema: requestMarketMakerControlBodySchema }) body: RequestMarketMakerControlBody,
  ) {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.controls.request(admin.id, marketId, body);
  }
  @Post('control-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveMarketMakerControl',
    summary: 'Approve and atomically execute the fixed control',
  })
  @ApiData(marketMakerControlWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'MARKET_MAKER_CONTROL_NOT_ALLOWED',
    'TRANSACTION_BUSY',
  )
  approve(
    @CurrentUser() admin: SessionUser,
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: decideMarketMakerControlBodySchema }) body: DecideMarketMakerControlBody,
  ) {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.controls.approve(admin.id, marketId, requestId, body.reason);
  }
  @Post('control-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectMarketMakerControl',
    summary: 'Reject a pending control without touching assets',
  })
  @ApiData(marketMakerControlWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'MARKET_MAKER_CONTROL_NOT_ALLOWED',
    'TRANSACTION_BUSY',
  )
  reject(
    @CurrentUser() admin: SessionUser,
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: decideMarketMakerControlBodySchema }) body: DecideMarketMakerControlBody,
  ) {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.controls.reject(admin.id, marketId, requestId, body.reason);
  }
  @Post('control-requests/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractMarketMakerControl',
    summary: 'Retract the current administrator’s pending control',
  })
  @ApiData(marketMakerControlWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'MARKET_MAKER_CONTROL_NOT_ALLOWED',
    'TRANSACTION_BUSY',
  )
  retract(
    @CurrentUser() admin: SessionUser,
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ) {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.controls.retract(admin.id, marketId, requestId);
  }
}

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/market-maker/control-requests')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AllMarketMakerControlsController {
  constructor(private readonly controls: MarketMakerControlService) {}
  @Get()
  @ApiOperation({
    operationId: 'adminListAllMarketMakerControls',
    summary: 'Read pending or completed control requests across markets',
  })
  @ApiPageOf(marketMakerControlRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: marketMakerControlRequestsQuerySchema })
    query: MarketMakerControlRequestsQuery,
  ) {
    const page = await this.controls.list(query);
    return new ApiPage(page.items, { nextCursor: page.nextCursor });
  }
}
