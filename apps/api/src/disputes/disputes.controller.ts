import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createDisputeBodySchema,
  disputeSchema,
  myDisputesQuerySchema,
  uuidParamSchema,
  type CreateDisputeBody,
  type Dispute,
  type MyDisputesQuery,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { DisputeService } from './dispute.service.js';

/**
 * Filing a dispute (PLAN 7.2; M5). Under `markets/` because the objection is addressed to a
 * market; SessionGuard fills `request.auth` (401 without a session) and, this being a
 * mutation, refuses a foreign Origin (403) before the handler runs.
 */
@ApiTags('disputes')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('markets')
@UseGuards(SessionGuard)
export class DisputesController {
  constructor(private readonly disputes: DisputeService) {}

  @Post(':id/disputes')
  @HttpCode(201)
  // Q-M5-1 left abuse to "M6 레이트 리밋 + 시장당 1건": the unique constraint already caps a user
  // at one dispute per market, and this caps how fast they can probe for markets to file on.
  @RateLimit('dispute')
  @ApiOperation({
    operationId: 'fileDispute',
    summary:
      'Object to the proposed result while the market is resolving and its dispute window ' +
      'is open (one per user per market)',
  })
  @ApiData(disputeSchema, 201)
  // NOT_FOUND for an unknown id and for a draft alike; VALIDATION_ERROR names `status` while
  // nothing has been proposed (open/closed); DISPUTE_WINDOW_CLOSED once settled/voided or past
  // `disputeUntil`; DUPLICATE_REQUEST for this user's second filing on the market.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'DISPUTE_WINDOW_CLOSED',
    'DUPLICATE_REQUEST',
    'RATE_LIMITED',
  )
  fileDispute(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: createDisputeBodySchema }) body: CreateDisputeBody,
  ): Promise<Dispute> {
    return this.disputes.file(user.id, id, body);
  }
}

/** The caller's own disputes (PLAN 7.2 `GET /me/disputes`); a second controller on `me/`. */
@ApiTags('disputes')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MyDisputesController {
  constructor(private readonly disputes: DisputeService) {}

  @Get('disputes')
  @ApiOperation({
    operationId: 'listMyDisputes',
    summary: 'My disputes, newest first; `marketId` narrows the list to one market',
  })
  // No `@ApiQuery`: `myDisputesQuerySchema` has no component id, so swagger expands it into
  // the cursor/limit/marketId parameters itself (see markets.controller.ts).
  @ApiPageOf(disputeSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async listMyDisputes(
    @CurrentUser() user: SessionUser,
    @Query({ schema: myDisputesQuerySchema }) query: MyDisputesQuery,
  ): Promise<ApiPage<Dispute>> {
    const { items, nextCursor } = await this.disputes.listMine(user.id, query);
    return new ApiPage(items, { nextCursor });
  }
}
