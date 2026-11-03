import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminDisputeListQuerySchema,
  adminDisputeQueueItemSchema,
  adminMarketSchema,
  decideDisputeBodySchema,
  uuidParamSchema,
  type AdminDisputeListQuery,
  type AdminDisputeQueueItem,
  type AdminMarket,
  type DecideDisputeBody,
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
import { MarketDisputeService } from './market-dispute.service.js';

/**
 * 판정 이의의 기각·수용 (#175, ADR-0104; ADR-0093 decision 1 #173 items 2·7): one admin who did not
 * register the dispute's judgement version — its approver may — dismisses a pending dispute
 * (nothing to change) or accepts it (a correction: the market keeps waiting for one, registered
 * and approved through the judgement routes, #176), with a reason the submitter reads. One
 * admin's act, not an approval request: a dismissal is final, and an acceptance is undone only
 * when the correction registered for it is rejected or retracted (back to pending, owner answer
 * 2026-11-02).
 * A dismissal that leaves nothing holding a market past its 이의 기한 has the worker confirm it
 * within seconds (#173 item 7 '모두 기각되면 바로 확정'). Each answers the admin detail
 * (`AdminMarket`, its `disputes` among it). Guards run in order: SessionGuard (401, 403 for a
 * foreign Origin on a mutation), AdminGuard (403 for a member), OnboardedGuard (409
 * ONBOARDING_REQUIRED, ADR-0072). Every write names the admin on screen (`expectedAccountId`,
 * ADR-0092), refused before anything is read when it is not the cookie's, and writes its
 * `admin_actions` row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketDisputesController {
  constructor(private readonly disputes: MarketDisputeService) {}

  @Post(':id/disputes/:disputeId/dismiss')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminDismissMarketDispute',
    summary:
      'Dismiss a pending judgement dispute (기각) by an admin who did not register its judgement ' +
      'version, with a reason the submitter reads; once no dispute holds the market and its ' +
      'dispute deadline has passed, the worker confirms the result within seconds',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` (1–500 characters) from the body. NOT_FOUND: no dispute of
  // that market by that id. FORBIDDEN also for an admin whose role was revoked while this waited
  // on the admin-roles lock. DISPUTE_NOT_ALLOWED's `details.reason`: `retracted` or `decided` for a
  // dispute no longer pending, then `registrant` for the admin who registered its version and
  // `own` for the admin who submitted it (given the role after disputing).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'DISPUTE_NOT_ALLOWED',
  )
  adminDismissMarketDispute(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('disputeId', { schema: uuidParamSchema }) disputeId: string,
    @Body({ schema: decideDisputeBodySchema }) body: DecideDisputeBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...decision } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.disputes.decide(admin.id, id, disputeId, 'dismiss', decision);
  }

  @Post(':id/disputes/:disputeId/accept')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminAcceptMarketDispute',
    summary:
      'Accept a pending judgement dispute (수용) by an admin who did not register its judgement ' +
      'version, with a reason the submitter reads: accepting is a correction, and the market ' +
      'stays provisional — the accepted dispute holding it — until a correction is registered ' +
      'and approved; if another admin rejects that correction or its registrant retracts it, ' +
      'the dispute goes back to pending',
  })
  @ApiData(adminMarketSchema)
  // As on dismiss: VALIDATION_ERROR `reason`; NOT_FOUND; FORBIDDEN for a revoked role;
  // DISPUTE_NOT_ALLOWED `retracted`, `decided`, then `registrant` and `own`.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'DISPUTE_NOT_ALLOWED',
  )
  adminAcceptMarketDispute(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('disputeId', { schema: uuidParamSchema }) disputeId: string,
    @Body({ schema: decideDisputeBodySchema }) body: DecideDisputeBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...decision } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.disputes.decide(admin.id, id, disputeId, 'accept', decision);
  }
}

/**
 * 이의 접수 (#175, ADR-0104; N03 §8): the judgement disputes across markets, in two halves — 검토
 * 대기 (`pending`, the oldest submission first) and 처리됨 (`decided`: dismissed, accepted,
 * retracted or closed by a correction, #176, the latest first) — each with its market (its
 * current judgement version among it), its submitter and its decider. The
 * decisions themselves are the market's own routes (AdminMarketDisputesController), on its admin
 * detail. No price, majority or position (N03 §5). Guards as there. A read: no admin_actions row
 * (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/market-disputes')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketDisputeQueueController {
  constructor(private readonly disputes: MarketDisputeService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarketDisputes',
    summary:
      'Judgement disputes (이의 접수): pending ones the oldest first (status=pending, the ' +
      'default), or those dismissed, accepted, retracted or closed by a correction the latest ' +
      'first (status=decided), each with its market (and its current judgement version), ' +
      'judgement version, submitter, links, reason and decision',
  })
  // No `@ApiQuery`: `adminDisputeListQuerySchema` has no component id, so swagger expands it into
  // the cursor/limit/status parameters itself (cursor-query.ts).
  @ApiPageOf(adminDisputeQueueItemSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarketDisputes(
    @Query({ schema: adminDisputeListQuerySchema }) query: AdminDisputeListQuery,
  ): Promise<ApiPage<AdminDisputeQueueItem>> {
    const { items, nextCursor } = await this.disputes.adminList(query);
    return new ApiPage(items, { nextCursor });
  }
}
