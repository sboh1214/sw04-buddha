import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminMarketSchema,
  adminMarketSupplementItemSchema,
  approveMarketSupplementBodySchema,
  cursorQuerySchema,
  rejectMarketSupplementBodySchema,
  requestMarketSupplementBodySchema,
  retractMarketSupplementBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type AdminMarketSupplementItem,
  type ApproveMarketSupplementBody,
  type CursorQuery,
  type RejectMarketSupplementBody,
  type RequestMarketSupplementBody,
  type RetractMarketSupplementBody,
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
import { MarketSupplementService } from './market-supplement.service.js';

/**
 * 규칙 보충 (#80, ADR-0101; ADR-0093 decision 2 #172 items 14·15): after the open an OPEN or
 * PAUSED market's title, rule items and close, announcement and zone change by a supplement one
 * admin requests and another approves — the PATCH refuses them ('supplement only while open').
 * The decisions name the request in the path (`:requestId`), as #139's do: a market has many
 * supplement requests over its life, one waiting at a time. Each write answers the admin detail
 * (`AdminMarket`, its `supplement` and `ruleVersions` among it). Guards run in order:
 * SessionGuard (401 without a session, 403 for a foreign Origin on a mutation), AdminGuard (403
 * for a member), OnboardedGuard (409 ONBOARDING_REQUIRED, ADR-0072). Every write names the admin
 * on screen (`expectedAccountId`, ADR-0092), refused before anything is read when it is not the
 * cookie's, and writes its `admin_actions` row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketSupplementsController {
  constructor(private readonly supplements: MarketSupplementService) {}

  @Post(':id/supplements')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestMarketSupplement',
    summary:
      'Request a supplement of an open or paused market’s rules (보충 요청), against its current ' +
      'rule version: the new value of each item to change (the title, a rule item, the close — ' +
      'later only and never while paused —, the announcement or the zone; the scheduled open and ' +
      'judgement are fixed), the reason and the settlement impact review. Another admin decides ' +
      'it; nothing changes until then, and one request waits per market at a time',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names, from the body, `baseVersion`, `changes` ('not a supplement item: …'
  // for another key, 'at least one item is required' for none) or an item's own path
  // (`changes.closeAt`, `changes.primarySource.url`, …), `reason` or `settlementImpact`; then, in
  // this order, `status` 'not open or paused', `ruleVersion` 'none' (opened before rule versions),
  // `closeAt` 'closed' (its close has come, by the clock too: no supplement after the close),
  // `baseVersion` 'stale' (the market moved past it), `supplement` 'pending' (another waits);
  // APPROVAL_NOT_ALLOWED `{path: ['request'], message: 'no_decider'}` when no admin but the
  // requester could decide it; then `changes` 'unchanged' (no item differs from the current
  // version) and the item rules on the items that change, as the open market's PATCH held them
  // until #80: `closeAt` 'fixed while paused', `fallbackCondition` 'no fallback source',
  // RULES_REQUIRED (one detail per rule item it would leave missing that was filled, then
  // `judgementTimeZone`, 'required while open'), `closeAt` 'must be in the future' and 'cannot
  // move earlier while open', both ends of each broken time order rule (the close at or before
  // the scheduled judgement, A2) and the lead close at the gap the market was last checked
  // against, else the setting (both ends named; 'lead-close gap undecided' while it is).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'RULES_REQUIRED',
  )
  adminRequestMarketSupplement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: requestMarketSupplementBodySchema }) body: RequestMarketSupplementBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...request } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.supplements.request(admin.id, id, request);
  }

  @Post(':id/supplements/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveMarketSupplement',
    summary:
      'Approve a waiting supplement (승인) by an admin other than its requester, with a reason: ' +
      'everything it was checked against is checked again, then the market takes the new text ' +
      'and the next rule version — the full text, the changed items and the reason, public in ' +
      'the detail’s history — and its status is republished unchanged for viewers to refetch',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` from the body, then `requestId` 'unknown' (no supplement
  // request of this market). APPROVAL_NOT_ALLOWED's `details[0]` is `{path: ['request'],
  // message}`: `retracted` or `decided` for a request no longer waiting, then `requester`. Then
  // the request's refusals again at the decision, from `status` on (`supplement` and `no_decider`
  // aside); a paused market's close change is `closeAt` 'fixed while paused'.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'RULES_REQUIRED',
  )
  adminApproveMarketSupplement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: approveMarketSupplementBodySchema }) body: ApproveMarketSupplementBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...approval } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.supplements.approve(admin.id, id, requestId, approval);
  }

  @Post(':id/supplements/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectMarketSupplement',
    summary:
      'Reject a waiting supplement (반려) by an admin other than its requester, in any status, ' +
      'with a reason from the list — meaning_change when it would change the market’s meaning, ' +
      'which goes to the pause procedure — and a description; nothing changes',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `rejectReason` or `reason` from the body, then `requestId` 'unknown'.
  // APPROVAL_NOT_ALLOWED as on approve: `retracted` or `decided`, then `requester`.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRejectMarketSupplement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: rejectMarketSupplementBodySchema }) body: RejectMarketSupplementBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...rejection } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.supplements.reject(admin.id, id, requestId, rejection);
  }

  @Post(':id/supplements/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractMarketSupplement',
    summary:
      'Retract a waiting supplement the acting admin requested (철회), in any status, before ' +
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
  adminRetractMarketSupplement(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: retractMarketSupplementBodySchema }) body: RetractMarketSupplementBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.supplements.retract(admin.id, id, requestId);
  }
}

/**
 * 규칙 보충 대기 (#80, ADR-0101): the supplement requests waiting for another admin's approval or
 * 반려, across markets — the decisions themselves are the market's own routes
 * (AdminMarketSupplementsController). Guards as there. A read: no admin_actions row
 * (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/market-supplements')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketSupplementQueueController {
  constructor(private readonly supplements: MarketSupplementService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarketSupplements',
    summary:
      'The supplement requests waiting for a decision, the oldest first, with their market (its ' +
      'status and close too: one still waiting at the close is shown for its 반려 or 철회), who ' +
      'asked and when, the rule version it was written against and the items it changes',
  })
  // `cursorQuerySchema` has a component id (CursorQuery), so the parameters are declared here
  // (cursor-query.ts).
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminMarketSupplementItemSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketSupplements(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminMarketSupplementItem>> {
    const { items, nextCursor } = await this.supplements.list(query);
    return new ApiPage(items, { nextCursor });
  }
}
