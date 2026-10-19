import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  createProposalBodySchema,
  cursorQuerySchema,
  proposalSchema,
  proposalWriteBodySchema,
  uuidParamSchema,
  type CreateProposalBody,
  type CursorQuery,
  type Proposal,
  type ProposalWriteBody,
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
import { ProposalsService } from './proposals.service.js';

/**
 * `/api/v1/me/proposals` (#77): the caller's 시장 제안 — submitting one, 내 제안 and the 철회 of a 접수
 * one. Owner-only routes: the session decides whose proposals are read or written, and another
 * account's proposal is NOT_FOUND (ADR-0069 decision 4 #77: only the proposer and the operators see
 * one). Submitting is open to accounts that finished the onboarding (OnboardedGuard: #57-8 leaves
 * the rest only reading) and are not restricted (the hook in proposal-restrictions.ts, #139 and
 * #185). Retracting one's own 접수 proposal, like reading one's own, is the session alone (owner
 * decision 2026-10-19, as #46's own-post delete): neither the onboarding nor a restriction (#45-12)
 * refuses it. Counted like the other owner routes: the per-address bucket every route has. The
 * limits that bound how many proposals there are — PROPOSAL_LIMITS, per verified number, for
 * members — are the service's, from the database.
 *
 * Every write names the account the screen shows (`expectedAccountId`, assertExpectedAccount, as
 * every owner write since A-PG-24): a window still showing account A after another one signed in as
 * B would otherwise propose as B, or retract B's proposal. The retract is a POST with that body: the
 * account id kept out of the address (ADR-0064).
 */
@ApiTags('proposals')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me/proposals')
@UseGuards(SessionGuard)
export class MeProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get()
  @ApiOperation({
    operationId: 'getMyProposals',
    summary:
      "The account's market proposals, newest first, each with its status, the operators' " +
      'reason or memo, and the market it led to once that market is public',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(proposalSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async list(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<Proposal>> {
    const { items, nextCursor } = await this.proposals.list(user.id, query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'getMyProposal',
    summary: "One of the account's proposals (another account's is NOT_FOUND)",
  })
  @ApiData(proposalSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  get(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<Proposal> {
    return this.proposals.get(user.id, id);
  }

  /**
   * Submits a proposal, 접수 (ADR-0069 decision 4 #77). Refused for an account that has not
   * finished the onboarding (the guard, before the body is read), under a restriction (the hook),
   * for a date before today in Korea or a category that is not active, and past a member's limits.
   */
  @Post()
  @UseGuards(OnboardedGuard)
  @ApiOperation({
    operationId: 'createMyProposal',
    summary:
      'Propose a market: question, the date its result is known, YES condition, expected ' +
      'sources, optional background and category; starts as submitted',
  })
  @ApiData(proposalSchema, 201)
  // FORBIDDEN: a mutation whose Origin is not ours, or a body whose `expectedAccountId` is not the
  // cookie's account (nothing written). ONBOARDING_REQUIRED: the onboarding is not done.
  // VERIFICATION_REQUIRED: the 본인확인 record went away while the request ran (a withdrawal).
  // VALIDATION_ERROR: the form, a date before today (Korea), a category that is not active.
  // PROPOSAL_LIMITED: the verified number's waiting or daily proposals (a member's: an operator's
  // account is exempt, owner decision 2026-10-19). RATE_LIMITED is every route's address bucket,
  // named here beside the other 429 so the document keeps both.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'VERIFICATION_REQUIRED',
    'PROPOSAL_LIMITED',
    'RATE_LIMITED',
  )
  create(
    @CurrentUser() user: SessionUser,
    @Body({ schema: createProposalBodySchema }) body: CreateProposalBody,
  ): Promise<Proposal> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.proposals.create(user.id, body);
  }

  /**
   * 접수 → 철회. Signed in is enough — no OnboardedGuard (owner decision 2026-10-19, ADR-0089): an
   * account that has not finished the onboarding, or that a terms revision sent back to agree
   * again, still takes its own 접수 proposal back, as it still deletes its own post (#46,
   * ADR-0073). No restriction refuses it either (#45-12).
   */
  @Post(':id/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'retractMyProposal',
    summary:
      'Retract one of the account’s proposals while it is submitted, signed in whatever the ' +
      'onboarding (VALIDATION_ERROR naming status once the review started or it was decided or ' +
      'retracted)',
  })
  @ApiData(proposalSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  retract(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: proposalWriteBodySchema }) body: ProposalWriteBody,
  ): Promise<Proposal> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.proposals.retract(user.id, id);
  }
}
