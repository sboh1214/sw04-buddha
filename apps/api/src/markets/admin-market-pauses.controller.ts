import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminMarketPauseDecisionItemSchema,
  adminMarketSchema,
  approvePauseDecisionBodySchema,
  cursorQuerySchema,
  pauseMarketBodySchema,
  rejectPauseDecisionBodySchema,
  requestPauseDecisionBodySchema,
  retractPauseDecisionBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type AdminMarketPauseDecisionItem,
  type ApprovePauseDecisionBody,
  type CursorQuery,
  type PauseMarketBody,
  type RejectPauseDecisionBody,
  type RequestPauseDecisionBody,
  type RetractPauseDecisionBody,
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
import { MarketPauseService } from './market-pause.service.js';

/**
 * 거래 일시 중단·재개·조기 마감 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4): one admin
 * pauses an OPEN market with a reason (the three of #173 item 3), a note and — for an early result
 * — when it was published; then one admin asks for the next path, 재개 (PAUSED → OPEN) or 조기 마감
 * (PAUSED → CLOSED), and another approves it. An early end of trading is this, never a one-admin
 * close (the interim `POST …/close` is gone). The decisions name the request in the path
 * (`:requestId`), as #80's do: a market has many over its life, one waiting at a time. Each write
 * answers the admin detail (`AdminMarket`, its `pause` among it). Guards run in order: SessionGuard
 * (401 without a session, 403 for a foreign Origin on a mutation), AdminGuard (403 for a member),
 * OnboardedGuard (409 ONBOARDING_REQUIRED, ADR-0072). Every write names the admin on screen
 * (`expectedAccountId`, ADR-0092), refused before anything is read when it is not the cookie's, and
 * writes its `admin_actions` row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketPausesController {
  constructor(private readonly pauses: MarketPauseService) {}

  @Post(':id/pause')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminPauseMarket',
    summary:
      'Pause an open market’s trading (거래 일시 중단) by one admin, at once: one of the three ' +
      'reasons, a note saying what happened (admins only) and, for an early result, when the ' +
      'result was published — not after the pause. The close still comes on schedule; resuming ' +
      'or closing early is another admin’s approval of a next-path request',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names, from the body, `reason`, `note` or `resultPublishedAt` ('required' for
  // early_result, 'only for early_result' otherwise, or not an instant); then, in this order,
  // `status` 'not open' (a paused market included), `closeAt` 'closed' (its close has come, by the
  // clock too) and `resultPublishedAt` 'after the pause'.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminPauseMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: pauseMarketBodySchema }) body: PauseMarketBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...pause } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.pauses.pause(admin.id, id, pause);
  }

  @Post(':id/pause-decisions')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestMarketPauseDecision',
    summary:
      'Ask for a paused market’s next path (재개·조기 마감 요청): the pause the admin saw ' +
      '(refused once it is no longer the current one), resume or close early, the review ' +
      'result for a pause on a basis change (not judgeable: close early only) and the reason. ' +
      'Another admin decides it; nothing changes until then, and one request waits per market ' +
      'at a time',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `pauseId`, `path`, `reviewResult` or `reason` from the body; then, in
  // this order, `status` 'not paused', `closeAt` 'closed' (its close has come, by the clock too),
  // `pause` 'stale' (the body's pause is not the market's current one: resumed and paused again
  // since), `pause` 'pending' (another request waits); APPROVAL_NOT_ALLOWED
  // `{path: ['request'], message: 'no_decider'}` when no admin but the requester could decide it;
  // then `reviewResult` 'required' (a basis_change pause's) or 'only for basis_change', and `path`
  // 'early close only' (resume with not_judgeable).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRequestMarketPauseDecision(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: requestPauseDecisionBodySchema }) body: RequestPauseDecisionBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...request } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.pauses.request(admin.id, id, request);
  }

  @Post(':id/pause-decisions/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveMarketPauseDecision',
    summary:
      'Approve a waiting next path (승인) by an admin other than its requester, with a reason: ' +
      'the market resumes trading (open) or closes early (closed; the scheduled close is kept ' +
      'and the judgement follows), the pause ends, and the status is published',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` from the body, then `requestId` 'unknown' (no next-path request
  // of this market). APPROVAL_NOT_ALLOWED's `details[0]` is `{path: ['request'], message}`:
  // `retracted` or `decided` for a request no longer waiting, then `requester`. Then, at the
  // decision, `status` 'not paused' (closed at its close since), `closeAt` 'closed' and `pause`
  // 'stale' (the request's pause is not the market's current one).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminApproveMarketPauseDecision(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: approvePauseDecisionBodySchema }) body: ApprovePauseDecisionBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...approval } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.pauses.approve(admin.id, id, requestId, approval);
  }

  @Post(':id/pause-decisions/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectMarketPauseDecision',
    summary:
      'Reject a waiting next path (반려) by an admin other than its requester, in any status, ' +
      'with a reason; nothing changes and the market stays as it is',
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
  adminRejectMarketPauseDecision(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: rejectPauseDecisionBodySchema }) body: RejectPauseDecisionBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...rejection } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.pauses.reject(admin.id, id, requestId, rejection);
  }

  @Post(':id/pause-decisions/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractMarketPauseDecision',
    summary:
      'Retract a waiting next path the acting admin requested (철회), in any status, before ' +
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
  adminRetractMarketPauseDecision(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: retractPauseDecisionBodySchema }) body: RetractPauseDecisionBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.pauses.retract(admin.id, id, requestId);
  }
}

/**
 * 일시 중단 결정 대기 (#114, ADR-0102): the next-path requests waiting for another admin's approval
 * or 반려, across markets — the decisions themselves are the market's own routes
 * (AdminMarketPausesController). Guards as there. A read: no admin_actions row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/market-pause-decisions')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketPauseDecisionQueueController {
  constructor(private readonly pauses: MarketPauseService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarketPauseDecisions',
    summary:
      'The next-path requests of paused markets waiting for a decision, the oldest first, with ' +
      'their market (its status and close too: one still waiting at the close is shown for its ' +
      '반려 or 철회), the pause’s reason, the path and review result asked for, and who asked ' +
      'and when',
  })
  // `cursorQuerySchema` has a component id (CursorQuery), so the parameters are declared here
  // (cursor-query.ts).
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminMarketPauseDecisionItemSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketPauseDecisions(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminMarketPauseDecisionItem>> {
    const { items, nextCursor } = await this.pauses.list(query);
    return new ApiPage(items, { nextCursor });
  }
}
