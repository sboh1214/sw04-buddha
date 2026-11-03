import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminProposalListQuerySchema,
  adminProposalSchema,
  adoptProposalBodySchema,
  expectedAccountBodySchema,
  linkProposalMarketBodySchema,
  proposalInternalMemoBodySchema,
  rejectProposalBodySchema,
  uuidParamSchema,
  type AdminProposal,
  type AdminProposalListQuery,
  type AdoptProposalBody,
  type ExpectedAccountBody,
  type LinkProposalMarketBody,
  type ProposalInternalMemoBody,
  type RejectProposalBody,
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
import { AdminProposalsService } from './admin-proposals.service.js';

/**
 * The operators' review of 시장 제안 (#77, ADR-0069 decision 4 #77), and the later link of a market
 * to a proposal adopted with none (owner decision 2026-10-19). Guards in the order every
 * /admin route runs them (admin-access.test.ts): SessionGuard, AdminGuard, then OnboardedGuard
 * (ADR-0072). Each move writes its `admin_actions` row in its transaction (admin-audit.test.ts).
 * A move the status does not allow is VALIDATION_ERROR naming `status`.
 *
 * Every write names the admin the screen shows (`expectedAccountId`, assertExpectedAccount,
 * ADR-0092): a mismatch with the cookie is refused (403 FORBIDDEN naming the field) before the
 * proposal is locked or a draft market made, so a proposal is never moved, linked or annotated as
 * an admin the user is not looking at.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/proposals')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminProposalsController {
  constructor(private readonly proposals: AdminProposalsService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListProposals',
    summary: 'Market proposals, newest first, every status unless status narrows it',
  })
  // No `@ApiQuery`: `adminProposalListQuerySchema` has no component id, so swagger expands it
  // into the cursor/limit/status parameters itself (see markets.controller.ts).
  @ApiPageOf(adminProposalSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListProposals(
    @Query({ schema: adminProposalListQuerySchema }) query: AdminProposalListQuery,
  ): Promise<ApiPage<AdminProposal>> {
    const { items, nextCursor } = await this.proposals.list(query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'adminGetProposal',
    summary: 'One proposal with its proposer, who started the review and decided it, and when',
  })
  @ApiData(adminProposalSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminGetProposal(@Param('id', { schema: uuidParamSchema }) id: string): Promise<AdminProposal> {
    return this.proposals.get(id);
  }

  @Post(':id/review')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminStartProposalReview', summary: 'submitted → reviewing' })
  @ApiData(adminProposalSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminStartProposalReview(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminProposal> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.proposals.startReview(admin.id, id);
  }

  @Post(':id/adopt')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminAdoptProposal',
    summary:
      'reviewing → adopted, final: an optional memo for the proposer, and optionally a draft ' +
      'market made from the proposal or an existing market. Opens nothing and grants nothing',
  })
  @ApiData(adminProposalSchema)
  // NOT_FOUND names `market.marketId` (an unknown market) or `market.categoryId` (an unknown
  // category); VALIDATION_ERROR names `status`, `market.categoryId` ('required': none, or the
  // proposal's wished category that has sub-categories; `subcategories` for such a category the
  // operator gave; `inactive` or `parent_inactive` for a hidden one or one under a hidden parent,
  // whoever named it — #17) or `market.closeAt` (not in the future) besides the body schema's
  // own issues.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminAdoptProposal(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: adoptProposalBodySchema }) body: AdoptProposalBody,
  ): Promise<AdminProposal> {
    const { expectedAccountId, ...adoption } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.proposals.adopt(admin.id, id, adoption);
  }

  /**
   * A market for a proposal adopted with none, later and once (owner decision 2026-10-19,
   * ADR-0089): a draft made from the proposal or an existing market, as at the 채택. The status
   * stays adopted; who linked it and when are kept and recorded (`proposal_link`).
   */
  @Post(':id/market')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminLinkProposalMarket',
    summary:
      'Link a market to a proposal adopted without one, once: a draft market made from the ' +
      'proposal or an existing market. The status stays adopted. Opens nothing and grants nothing',
  })
  @ApiData(adminProposalSchema)
  // NOT_FOUND names `market.marketId` or `market.categoryId` as the adoption's does;
  // VALIDATION_ERROR names `status` (not adopted), `market` ('already linked': it has a market,
  // from the adoption or an earlier link), `market.categoryId` or `market.closeAt`.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminLinkProposalMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: linkProposalMarketBodySchema }) body: LinkProposalMarketBody,
  ): Promise<AdminProposal> {
    const { expectedAccountId, ...link } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.proposals.linkMarket(admin.id, id, link);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectProposal',
    summary:
      'submitted or reviewing → rejected, final: a reason from the list and an explanation ' +
      'for the proposer; a duplicate names the existing market',
  })
  @ApiData(adminProposalSchema)
  // NOT_FOUND names `duplicateMarketId` (an unknown market).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminRejectProposal(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: rejectProposalBodySchema }) body: RejectProposalBody,
  ): Promise<AdminProposal> {
    const { expectedAccountId, ...rejection } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.proposals.reject(admin.id, id, rejection);
  }

  @Put(':id/internal-memo')
  @ApiOperation({
    operationId: 'adminSetProposalInternalMemo',
    summary: "Set or clear the operators' internal memo (never shown to the proposer), any status",
  })
  @ApiData(adminProposalSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminSetProposalInternalMemo(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: proposalInternalMemoBodySchema }) body: ProposalInternalMemoBody,
  ): Promise<AdminProposal> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.proposals.setInternalMemo(admin.id, id, body.memo);
  }
}
