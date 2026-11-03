import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  cursorQuerySchema,
  myDisputeSchema,
  myMarketDisputeSchema,
  retractDisputeBodySchema,
  submitDisputeBodySchema,
  uuidParamSchema,
  type CursorQuery,
  type MyDispute,
  type MyMarketDispute,
  type RetractDisputeBody,
  type SubmitDisputeBody,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { MarketDisputeService } from './market-dispute.service.js';

/**
 * 판정 이의 제출 (#175, ADR-0104; ADR-0093 decision 1 #173 items 5·6·15): a member disputes a
 * PROVISIONAL market's provisional result before its 이의 기한 — the deadline and the link are
 * public (`Market.disputeDeadline`, `disputeOpen`), the submission is the member's. Owner-only:
 * SessionGuard (401, 403 for a foreign Origin), then OnboardedGuard (409 ONBOARDING_REQUIRED, #57
 * item 8: an account that has not finished only reads). No restriction refuses it (#173 item 6:
 * 계정 제한 중에도 낼 수 있다; ADR-0069 #45-12). The body names the account the screen shows
 * (`expectedAccountId`, ADR-0092), refused before anything is read when it is not the cookie's.
 * Not 제재 이의, which goes by email (ADR-0084).
 */
@ApiTags('disputes')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('markets')
@UseGuards(SessionGuard, OnboardedGuard)
export class MarketDisputesController {
  constructor(private readonly disputes: MarketDisputeService) {}

  @Post(':id/disputes')
  @ApiOperation({
    operationId: 'submitMarketDispute',
    summary:
      'Dispute a provisional result (판정 이의) while the dispute deadline is ahead: the ' +
      'judgement version the screen showed, 1–5 evidence links and a reason (1–2,000 ' +
      'characters), by a member with a fill on the market (either side); one per member and ' +
      'judgement version, a retracted one included. Answers the dispute, pending; the market ' +
      'stays provisional past its deadline until every dispute is dismissed or retracted',
  })
  @ApiData(myDisputeSchema, 201)
  // VALIDATION_ERROR names, from the body, `judgementVersion`, `links` (1–5 http(s) links of at
  // most 500 characters; 'duplicate' at `links.<index>`, compared trimmed) or `reason`. FORBIDDEN:
  // a foreign Origin, or `expectedAccountId` not the cookie's account. NOT_FOUND: no public market
  // of that id. DISPUTE_NOT_ALLOWED's `details.reason`, in this order: `not_provisional`,
  // `stale_version` (the body's version is not the market's current one), `deadline_passed`,
  // `admin`, `no_fill` (no fill on the market, on either side), `duplicate`.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'DISPUTE_NOT_ALLOWED',
  )
  submitMarketDispute(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: submitDisputeBodySchema }) body: SubmitDisputeBody,
  ): Promise<MyDispute> {
    const { expectedAccountId, ...dispute } = body;
    assertExpectedAccount(user.id, expectedAccountId);
    return this.disputes.submit(user.id, id, dispute);
  }
}

/**
 * `/api/v1/me/disputes` (#175, ADR-0104): the caller's 판정 이의 — MY 판정 이의, the dispute screen's
 * standing on one market, and the 철회 of a pending one. Owner-only routes: the session decides
 * whose disputes are read or written, and another account's dispute is NOT_FOUND (#173 item 13:
 * the submitter and the body are the submitter's and the operators' alone). Each shows the
 * status, the decision's reason and time (#173 item 7), never who decided it. Signed in is enough
 * — no OnboardedGuard (ADR-0089's precedent for the 철회 of one's own proposal): an account a
 * terms revision sent back to agree again still reads and takes back its own dispute. No
 * restriction refuses the 철회 either.
 */
@ApiTags('disputes')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me/disputes')
@UseGuards(SessionGuard)
export class MeDisputesController {
  constructor(private readonly disputes: MarketDisputeService) {}

  @Get()
  @ApiOperation({
    operationId: 'getMyDisputes',
    summary:
      "The account's judgement disputes (판정 이의), newest first, each with its market (and " +
      'its current judgement version: a dispute of an older one was answered by a correction), ' +
      'the links and reason it submitted, its status, the decision’s reason and time — or when ' +
      'a correction closed it — and whether it may still be retracted',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(myDisputeSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async getMyDisputes(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<MyDispute>> {
    const { items, nextCursor } = await this.disputes.listMine(user.id, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get('markets/:marketId')
  @ApiOperation({
    operationId: 'getMyMarketDispute',
    summary:
      'The dispute screen’s state of one market: whether the account may dispute its current ' +
      'judgement version now (eligible, or the first reason a submission would be refused for), ' +
      'that version, and the account’s dispute of it whatever its status',
  })
  @ApiData(myMarketDisputeSchema)
  // NOT_FOUND: no public market of that id.
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getMyMarketDispute(
    @CurrentUser() user: SessionUser,
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
  ): Promise<MyMarketDispute> {
    return this.disputes.myMarketDispute(user.id, marketId);
  }

  @Post(':disputeId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'retractMyDispute',
    summary:
      'Retract one of the account’s disputes (철회) while it is pending and its deadline is ' +
      'ahead, signed in whatever the onboarding; it stays the one of its judgement version',
  })
  @ApiData(myDisputeSchema)
  // FORBIDDEN: a foreign Origin, or `expectedAccountId` not the cookie's account. NOT_FOUND: no
  // dispute of the account by that id. DISPUTE_NOT_ALLOWED's `details.reason`: `retracted`,
  // `decided` (dismissed, accepted or closed by a correction), then `deadline_passed`.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'DISPUTE_NOT_ALLOWED')
  retractMyDispute(
    @CurrentUser() user: SessionUser,
    @Param('disputeId', { schema: uuidParamSchema }) disputeId: string,
    @Body({ schema: retractDisputeBodySchema }) body: RetractDisputeBody,
  ): Promise<MyDispute> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.disputes.retract(user.id, disputeId);
  }
}
