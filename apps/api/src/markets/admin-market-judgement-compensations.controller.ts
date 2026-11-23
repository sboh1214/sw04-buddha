import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminJudgementCompensationRecipientSchema,
  adminMarketSchema,
  approveJudgementCompensationBodySchema,
  cursorQuerySchema,
  rejectJudgementCompensationBodySchema,
  requestJudgementCompensationBodySchema,
  retractJudgementCompensationBodySchema,
  uuidParamSchema,
  type AdminJudgementCompensationRecipient,
  type AdminMarket,
  type ApproveJudgementCompensationBody,
  type CursorQuery,
  type RejectJudgementCompensationBody,
  type RequestJudgementCompensationBody,
  type RetractJudgementCompensationBody,
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
import { MarketJudgementCompensationService } from './market-judgement-compensation.service.js';

/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-1·144-2·144-4·144-6·144-7·144-12 and
 * 144-15·144-16·144-18): once a market's 판정 오류 사건 is confirmed, an admin without a conflict
 * asks for its compensation — the server computes, per account, what the corrected result would
 * have paid minus what the settlement paid (YES and NO together, above 0, people's accounts only)
 * and freezes the list; the body names no account and no amount — with an internal reason and the
 * reason the compensated members read in their wallets. Another admin, neither the requester nor
 * the paid judgement's registrant nor conflicted, approves it and the same transaction pays every
 * listed account once (a closed account is recorded '탈퇴로 지급 못 함', a restricted one is paid);
 * or rejects it with a reason; the requester may retract it before. Nothing is taken back from
 * anyone. Each write answers the admin detail (`AdminMarket`, its
 * `judgementIncident.compensation` among it). Guards in order: SessionGuard (401 without a
 * session, 403 for a foreign Origin on a mutation), AdminGuard (403 for a member), OnboardedGuard
 * (409 ONBOARDING_REQUIRED, ADR-0072). Every write names the admin on screen
 * (`expectedAccountId`, ADR-0092), refused before anything is read when it is not the cookie's,
 * and writes its `admin_actions` row (admin-audit.test). The per-account list is a read and an
 * operation record (admin-access.test `OPERATION_RECORDS`).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketJudgementCompensationsController {
  constructor(private readonly compensations: MarketJudgementCompensationService) {}

  @Post(':id/judgement-compensations')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestMarketJudgementCompensation',
    summary:
      'Request the compensation of a market’s confirmed judgement incident (보상 요청) for ' +
      'another admin’s approval, with an internal reason and the reason the compensated members ' +
      'read: the server computes the accounts owed and their amounts from the settlement records ' +
      'and freezes them in the request. One request waits at a time, and none is taken once one ' +
      'is approved',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names, from the body, `reason`, `userReason` or `noConflictConfirmed`;
  // FORBIDDEN `market_conflict` for an interested admin; then, in this order, `incident` 'not
  // confirmed', `market` 'held', `compensation` 'pending' or 'paid', `recipients` 'none';
  // APPROVAL_NOT_ALLOWED `{path: ['request'], message: 'no_decider'}` when no admin but the
  // requester and the paid judgement's registrant could approve it.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRequestMarketJudgementCompensation(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: requestJudgementCompensationBodySchema })
    body: RequestJudgementCompensationBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...request } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.compensations.request(admin.id, id, request);
  }

  @Post(':id/judgement-compensations/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveMarketJudgementCompensation',
    summary:
      'Approve a waiting judgement compensation request (보상 승인), with a reason, by an admin ' +
      'who is neither its requester nor the registrant of the paid judgement and has no interest ' +
      'in the market: every listed account is paid its amount once in the same transaction (a ' +
      'closed account is recorded unpaid), each paid member is notified, and nothing is taken ' +
      'back from anyone. Refused whole while the market is held by the ledger reconciliation or ' +
      'any listed account’s balance record left its ledger',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` or `noConflictConfirmed` from the body, then `requestId`
  // 'unknown'. APPROVAL_NOT_ALLOWED `retracted`, `decided`, then `requester`; VALIDATION_ERROR
  // `decider` 'registrant'; FORBIDDEN `market_conflict` (the approver or the requester); then
  // `market` 'held', `recipients` 'stale' or 'blocked' (the count in the message, never which).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminApproveMarketJudgementCompensation(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: approveJudgementCompensationBodySchema })
    body: ApproveJudgementCompensationBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...decision } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.compensations.approve(admin.id, id, requestId, decision);
  }

  @Post(':id/judgement-compensations/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectMarketJudgementCompensation',
    summary:
      'Reject a waiting judgement compensation request (보상 반려), with a reason, by any admin ' +
      'but its requester: nothing is paid, and another request may follow',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` from the body, then `requestId` 'unknown'.
  // APPROVAL_NOT_ALLOWED `retracted`, `decided`, then `requester`.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRejectMarketJudgementCompensation(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: rejectJudgementCompensationBodySchema })
    body: RejectJudgementCompensationBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...decision } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.compensations.reject(admin.id, id, requestId, decision);
  }

  @Post(':id/judgement-compensations/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractMarketJudgementCompensation',
    summary:
      'Retract a waiting judgement compensation request the acting admin made (철회), before ' +
      'anyone decides it; nothing else changes',
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
  adminRetractMarketJudgementCompensation(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: retractJudgementCompensationBodySchema })
    body: RetractJudgementCompensationBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.compensations.retract(admin.id, id, requestId);
  }

  @Get(':id/judgement-compensations/recipients')
  @ApiOperation({
    operationId: 'adminListMarketJudgementCompensationRecipients',
    summary:
      'The accounts a market’s confirmed judgement correction compensates, in account id order: ' +
      'each named, with its amount and where it stands — before an approval the waiting ' +
      'request’s list (or, with none, the accounts owed now), payable, needing a ledger check or ' +
      'closed; once approved, paid or recorded unpaid as closed. An empty page for a market ' +
      'without a confirmed incident',
  })
  // `cursorQuerySchema` has a component id (CursorQuery), so the parameters are declared here
  // (cursor-query.ts).
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminJudgementCompensationRecipientSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketJudgementCompensationRecipients(
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminJudgementCompensationRecipient>> {
    const { items, nextCursor } = await this.compensations.recipients(id, query);
    return new ApiPage(items, { nextCursor });
  }
}
