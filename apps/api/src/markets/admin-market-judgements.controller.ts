import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminMarketJudgementQueueItemSchema,
  adminMarketSchema,
  approveJudgementBodySchema,
  cursorQuerySchema,
  registerJudgementBodySchema,
  rejectJudgementBodySchema,
  retractJudgementBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type AdminMarketJudgementQueueItem,
  type ApproveJudgementBody,
  type CursorQuery,
  type RegisterJudgementBody,
  type RejectJudgementBody,
  type RetractJudgementBody,
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
import { MarketJudgementService } from './market-judgement.service.js';

/**
 * 판정 등록과 별도 검토자 승인 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·4·5·9, decision 3
 * the #152 rows): one admin registers a CLOSED market's judgement — the result (YES, NO or VOID),
 * the rule's source, the evidence and the description — and another approves it, which publishes
 * the provisional result (CLOSED → PROVISIONAL) and fixes the dispute deadline; the worker
 * confirms it once that has passed (PROVISIONAL → RESOLVED). A 반려 leaves the market CLOSED to be
 * registered again. The interim one-admin `POST …/resolve` is gone. The decisions name the
 * registration in the path (`:requestId`), as #80's and #114's do: a market has many over its
 * life, one waiting at a time. Each write answers the admin detail (`AdminMarket`, its `judgement`
 * among it). Guards run in order: SessionGuard (401 without a session, 403 for a foreign Origin on
 * a mutation), AdminGuard (403 for a member), OnboardedGuard (409 ONBOARDING_REQUIRED, ADR-0072).
 * Every write names the admin on screen (`expectedAccountId`, ADR-0092), refused before anything
 * is read when it is not the cookie's, and writes its `admin_actions` row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketJudgementsController {
  constructor(private readonly judgements: MarketJudgementService) {}

  @Post(':id/judgements')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRegisterMarketJudgement',
    summary:
      'Register a closed market’s judgement (판정 등록) for another admin’s approval: the result ' +
      '(YES, NO or VOID), the rules’ source by its priority (0 the primary, 1–3 a fallback with ' +
      'the reason the primary could not be used; none for a VOID alone, with its reason), 1–5 ' +
      'evidence links, when the evidence was collected (not after now) and what was confirmed. ' +
      'Nothing changes until the approval; one registration waits per market at a time',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names, from the body, `result`, `source` ('required' for a YES or NO with
  // none), `fallbackReason` ('required' for a fallback source, 'only for a fallback source'
  // otherwise), `voidReason` ('required' for a VOID, 'only for VOID' otherwise), `evidence.links`
  // (1–5 http(s) links; 'duplicate' at `evidence.links.<index>`), `evidence.collectedAt` or
  // `description`; then, in this order, `status` 'not closed', `judgement` 'pending' (another
  // registration waits); APPROVAL_NOT_ALLOWED `{path: ['request'], message: 'no_decider'}` when no
  // admin but the registrant could approve it; then `disputeWindow` 'undecided' (the release
  // setting market.dispute_window has no value), `source` 'unknown' (the rules have no source of
  // that priority), `result` 'void only' (YES or NO on a market closed early as not judgeable) and
  // `evidence.collectedAt` 'after now'.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRegisterMarketJudgement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: registerJudgementBodySchema }) body: RegisterJudgementBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...registration } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.judgements.register(admin.id, id, registration);
  }

  @Post(':id/judgements/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveMarketJudgement',
    summary:
      'Approve a waiting judgement (승인) by an admin other than its registrant, with a reason ' +
      '— before the scheduled judgement time also confirming the NO condition’s event deadline: ' +
      'the provisional result is published (closed → provisional) and the dispute deadline ' +
      'fixed (now plus the dispute window); the worker confirms the result once it has passed',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` or `eventDeadlineConfirmed` from the body, then `requestId`
  // 'unknown' (no judgement registration of this market). APPROVAL_NOT_ALLOWED's `details[0]` is
  // `{path: ['request'], message}`: `retracted` or `decided` for a registration no longer waiting,
  // then `requester`. Then `status` 'not closed', `disputeWindow` 'undecided' and, at the
  // decision, `eventDeadlineConfirmed` 'required' (before the scheduled judgement time, false).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminApproveMarketJudgement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: approveJudgementBodySchema }) body: ApproveJudgementBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...approval } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.judgements.approve(admin.id, id, requestId, approval);
  }

  @Post(':id/judgements/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectMarketJudgement',
    summary:
      'Reject a waiting judgement (반려) by an admin other than its registrant, in any status, ' +
      'with a reason; the market stays as it is — a closed one is registered again, by any admin',
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
  adminRejectMarketJudgement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: rejectJudgementBodySchema }) body: RejectJudgementBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...rejection } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.judgements.reject(admin.id, id, requestId, rejection);
  }

  @Post(':id/judgements/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractMarketJudgement',
    summary:
      'Retract a waiting judgement the acting admin registered (철회), in any status, before ' +
      'anyone decides it; nothing changes',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `requestId` 'unknown'. APPROVAL_NOT_ALLOWED `not_requester` for anyone
  // but its registrant, `retracted` or `decided` for a registration no longer waiting.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRetractMarketJudgement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: retractJudgementBodySchema }) body: RetractJudgementBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.judgements.retract(admin.id, id, requestId);
  }
}

/**
 * 판정 승인 대기 (#152, ADR-0103): the judgement registrations waiting for another admin's approval
 * or 반려, across markets — the decisions themselves are the market's own routes
 * (AdminMarketJudgementsController). Guards as there. A read: no admin_actions row
 * (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/market-judgements')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketJudgementQueueController {
  constructor(private readonly judgements: MarketJudgementService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarketJudgements',
    summary:
      'The judgement registrations waiting for approval, the oldest first, with their market ' +
      '(its status, close and scheduled judgement time too: one still waiting once the market ' +
      'left closed is shown for its 반려 or 철회), the result registered, and who registered it ' +
      'and when',
  })
  // `cursorQuerySchema` has a component id (CursorQuery), so the parameters are declared here
  // (cursor-query.ts).
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminMarketJudgementQueueItemSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketJudgements(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminMarketJudgementQueueItem>> {
    const { items, nextCursor } = await this.judgements.list(query);
    return new ApiPage(items, { nextCursor });
  }
}
