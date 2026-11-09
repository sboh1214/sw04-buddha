import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminMarketCancelItemSchema,
  adminMarketSchema,
  approveMarketCancelBodySchema,
  cursorQuerySchema,
  rejectMarketCancelBodySchema,
  requestMarketCancelBodySchema,
  retractMarketCancelBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type AdminMarketCancelItem,
  type ApproveMarketCancelBody,
  type CursorQuery,
  type RejectMarketCancelBody,
  type RequestMarketCancelBody,
  type RetractMarketCancelBody,
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
import { MarketCancelService } from './market-cancel.service.js';

/**
 * 시장 취소 of a SCHEDULED market (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로'): one
 * admin asks to cancel a market approved for opening, with a reason (the cancel's public reason),
 * and an admin other than the requester approves it — SCHEDULED → CANCELLED, the result type
 * empty. The operator's only path to CANCELLED: an OPEN or PAUSED market ends by its close or a
 * pause's approved early close, which cancel it when nobody traded. The decisions name the request
 * in the path (`:requestId`), as #114's do: a market may have many over its life, one waiting at a
 * time. Each write answers the admin detail (`AdminMarket`, its `cancel` among it). Guards run in
 * order: SessionGuard (401 without a session, 403 for a foreign Origin on a mutation), AdminGuard
 * (403 for a member), OnboardedGuard (409 ONBOARDING_REQUIRED, ADR-0072). Every write names the
 * admin on screen (`expectedAccountId`, ADR-0092), refused before anything is read when it is not
 * the cookie's, and writes its `admin_actions` row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketCancelsController {
  constructor(private readonly cancels: MarketCancelService) {}

  @Post(':id/cancel-requests')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestMarketCancel',
    summary:
      'Ask to cancel a scheduled market (시장 취소 요청) with a reason — the cancel’s public ' +
      'reason. Another admin decides it; nothing changes until then, the scheduled open is not ' +
      'held, and one request waits per market at a time',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` from the body; then, in this order, `status` 'not scheduled'
  // and `cancel` 'pending' (another request waits); APPROVAL_NOT_ALLOWED `{path: ['request'],
  // message: 'no_decider'}` when no admin but the requester could decide it.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRequestMarketCancel(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: requestMarketCancelBodySchema }) body: RequestMarketCancelBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...request } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.cancels.request(admin.id, id, request);
  }

  @Post(':id/cancel-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveMarketCancel',
    summary:
      'Approve a waiting cancel request (승인) by an admin other than its requester, with a ' +
      'reason: the scheduled market is cancelled without opening (cancelled; no result, ' +
      'judgement or payout), its open and close jobs are removed, and the status is published',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` from the body, then `requestId` 'unknown' (no cancel request of
  // this market). APPROVAL_NOT_ALLOWED's `details[0]` is `{path: ['request'], message}`:
  // `retracted` or `decided` for a request no longer waiting, then `requester`. Then, at the
  // decision, `status` 'not scheduled' (opened, sent back or cancelled since) and `cancel` 'stale'
  // (sent back to a draft and approved again since the request).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminApproveMarketCancel(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: approveMarketCancelBodySchema }) body: ApproveMarketCancelBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...approval } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.cancels.approve(admin.id, id, requestId, approval);
  }

  @Post(':id/cancel-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectMarketCancel',
    summary:
      'Reject a waiting cancel request (반려) by an admin other than its requester, in any ' +
      'status, with a reason; nothing changes and the market stays as it is',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` from the body, then `requestId` 'unknown'. APPROVAL_NOT_ALLOWED
  // as on approve: `retracted` or `decided`, then `requester`.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRejectMarketCancel(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: rejectMarketCancelBodySchema }) body: RejectMarketCancelBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...rejection } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.cancels.reject(admin.id, id, requestId, rejection);
  }

  @Post(':id/cancel-requests/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractMarketCancel',
    summary:
      'Retract a waiting cancel request the acting admin made (철회), in any status, before ' +
      'anyone decides it; nothing changes',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `requestId` 'unknown'. APPROVAL_NOT_ALLOWED `not_requester` for anyone
  // but its requester, `retracted` or `decided` for a request no longer waiting.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRetractMarketCancel(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: retractMarketCancelBodySchema }) body: RetractMarketCancelBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.cancels.retract(admin.id, id, requestId);
  }
}

/**
 * 시장 취소 대기 (#20, ADR-0117): the cancel requests of scheduled markets waiting for another
 * admin's approval or 반려, across markets — the decisions themselves are the market's own routes
 * (AdminMarketCancelsController). Guards as there. A read: no admin_actions row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/market-cancel-requests')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketCancelQueueController {
  constructor(private readonly cancels: MarketCancelService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarketCancelRequests',
    summary:
      'The cancel requests of scheduled markets waiting for a decision, the oldest first, with ' +
      'their market (its status, scheduled open and close too: one still waiting after the open ' +
      'is shown for its 반려 or 철회), the reason, and who asked and when',
  })
  // `cursorQuerySchema` has a component id (CursorQuery), so the parameters are declared here
  // (cursor-query.ts).
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminMarketCancelItemSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketCancelRequests(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminMarketCancelItem>> {
    const { items, nextCursor } = await this.cancels.list(query);
    return new ApiPage(items, { nextCursor });
  }
}
