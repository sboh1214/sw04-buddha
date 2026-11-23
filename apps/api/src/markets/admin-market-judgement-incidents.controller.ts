import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminMarketJudgementIncidentQueueItemSchema,
  adminMarketSchema,
  confirmJudgementIncidentBodySchema,
  cursorQuerySchema,
  dismissJudgementIncidentBodySchema,
  registerJudgementIncidentBodySchema,
  retractJudgementIncidentBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type AdminMarketJudgementIncidentQueueItem,
  type ConfirmJudgementIncidentBody,
  type CursorQuery,
  type DismissJudgementIncidentBody,
  type RegisterJudgementIncidentBody,
  type RetractJudgementIncidentBody,
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
import { MarketJudgementIncidentService } from './market-judgement-incident.service.js';

/**
 * 판정 오류 사건 (#144 part 1, ADR-0165; owner answers 144-3·144-4·144-5·144-8·144-13·144-14):
 * once a market's result is confirmed (RESOLVED, SETTLING or SETTLED, with no deadline) an admin
 * registers what went wrong with the paid result — the correct result, 오류 내용 and its evidence
 * — and another admin, neither the registrant nor the paid judgement version's registrant nor
 * conflicted on the market, confirms it once the market is SETTLED (오류 확인) or dismisses it (기각),
 * each with a reason; the registrant may retract it before. A confirmation writes the market's one
 * permanent incident: the public judging record then shows its 판정 정정 (the corrected result, the
 * paid one, 오류 내용, the evidence and the confirmation's instant — never an identity or the
 * reviewer's reason), and the detail's result line, the theme results and the related markets
 * follow the corrected result, while the market row, its judgements and its settlement records
 * stay as they were paid. No Coin moves. The decisions name the registration in the path
 * (`:requestId`), as a judgement's do. Each write answers the admin detail (`AdminMarket`, its
 * `judgementIncident` among it). Guards in order: SessionGuard (401 without a session, 403 for a
 * foreign Origin on a mutation), AdminGuard (403 for a member), OnboardedGuard (409
 * ONBOARDING_REQUIRED, ADR-0072). Every write names the admin on screen (`expectedAccountId`,
 * ADR-0092), refused before anything is read when it is not the cookie's, and writes its
 * `admin_actions` row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketJudgementIncidentsController {
  constructor(private readonly incidents: MarketJudgementIncidentService) {}

  @Post(':id/judgement-incidents')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRegisterMarketJudgementIncident',
    summary:
      'Register a judgement incident (판정 오류 사건 등록) on a market whose result is confirmed ' +
      '(resolved, settling or settled; no deadline) for another admin’s review: the correct ' +
      'result (not the paid one), what went wrong, 1–5 evidence links and when the evidence was ' +
      'collected (not after now). Nothing else changes and nothing is public until another admin ' +
      'confirms it; one registration waits per market at a time, and none is taken once one is ' +
      'confirmed',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names, from the body, `noConflictConfirmed`, `correctedResult`,
  // `description` or `evidence` (`links` 1–5 http(s) links, 'duplicate' at `evidence.links.<n>`;
  // `collectedAt`); FORBIDDEN `market_conflict` for an interested admin; then, in this order,
  // `status` 'not result confirmed', `judgement` 'legacy' (no judgement version), `correctedResult`
  // 'same result', `evidence.collectedAt` 'after now', `incident` 'confirmed' or 'pending';
  // APPROVAL_NOT_ALLOWED `{path: ['request'], message: 'no_decider'}` when no admin but the
  // registrant and the paid judgement's registrant could decide it.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRegisterMarketJudgementIncident(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: registerJudgementIncidentBodySchema }) body: RegisterJudgementIncidentBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...registration } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.incidents.register(admin.id, id, registration);
  }

  @Post(':id/judgement-incidents/:requestId/confirm')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminConfirmMarketJudgementIncident',
    summary:
      'Confirm a waiting judgement incident (오류 확인) on a settled market, with a reason, by an ' +
      'admin who is neither its registrant nor the registrant of the paid judgement and has no ' +
      'interest in the market: the market’s one permanent incident is written and the public ' +
      'judging record shows the correction; the paid result, the judgement versions and the ' +
      'settlement records stay as they are, and no Coin moves',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` or `noConflictConfirmed` from the body, then `requestId`
  // 'unknown'. APPROVAL_NOT_ALLOWED `retracted`, `decided`, then `requester`; VALIDATION_ERROR
  // `decider` 'registrant'; FORBIDDEN `market_conflict` (the decider or the registrant); then
  // `status` 'not settled' or 'not result confirmed', and `incident` 'confirmed'.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminConfirmMarketJudgementIncident(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: confirmJudgementIncidentBodySchema }) body: ConfirmJudgementIncidentBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...decision } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.incidents.confirm(admin.id, id, requestId, decision);
  }

  @Post(':id/judgement-incidents/:requestId/dismiss')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminDismissMarketJudgementIncident',
    summary:
      'Dismiss a waiting judgement incident (기각) on a market whose result is confirmed, with a ' +
      'reason, by an admin who could confirm it: nothing public changes, and another incident ' +
      'may be registered',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` or `noConflictConfirmed` from the body, then `requestId`
  // 'unknown'. APPROVAL_NOT_ALLOWED `retracted`, `decided`, then `requester`; VALIDATION_ERROR
  // `decider` 'registrant'; FORBIDDEN `market_conflict`; then `status` 'not result confirmed'.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminDismissMarketJudgementIncident(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: dismissJudgementIncidentBodySchema }) body: DismissJudgementIncidentBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...decision } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.incidents.dismiss(admin.id, id, requestId, decision);
  }

  @Post(':id/judgement-incidents/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractMarketJudgementIncident',
    summary:
      'Retract a waiting judgement incident the acting admin registered (철회), in any status, ' +
      'before anyone decides it; nothing else changes',
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
  adminRetractMarketJudgementIncident(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: retractJudgementIncidentBodySchema }) body: RetractJudgementIncidentBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.incidents.retract(admin.id, id, requestId);
  }
}

/**
 * 판정 오류 사건 검토 대기 (#144, ADR-0165): the incident registrations waiting for another admin's
 * 오류 확인 or 기각, across markets — the decisions themselves are the market's own routes
 * (AdminMarketJudgementIncidentsController). Guards as there. A read: no admin_actions row
 * (admin-audit.test); an operation record (admin-access.test `OPERATION_RECORDS`).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/market-judgement-incidents')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketJudgementIncidentQueueController {
  constructor(private readonly incidents: MarketJudgementIncidentService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarketJudgementIncidents',
    summary:
      'The judgement incidents waiting for review, the oldest first, with their market (its ' +
      'status: a confirmation waits for settled), the paid and the corrected result, and who ' +
      'registered it and when',
  })
  // `cursorQuerySchema` has a component id (CursorQuery), so the parameters are declared here
  // (cursor-query.ts).
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminMarketJudgementIncidentQueueItemSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketJudgementIncidents(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminMarketJudgementIncidentQueueItem>> {
    const { items, nextCursor } = await this.incidents.list(query);
    return new ApiPage(items, { nextCursor });
  }
}
