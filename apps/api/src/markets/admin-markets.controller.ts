import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminMarketListQuerySchema,
  adminMarketSchema,
  adminRelatedMarketSchema,
  createMarketBodySchema,
  expectedAccountBodySchema,
  expectedAccountQuerySchema,
  linkRelatedMarketBodySchema,
  marketSummarySchema,
  resolveMarketBodySchema,
  updateMarketBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type AdminMarketListQuery,
  type AdminRelatedMarket,
  type CreateMarketBody,
  type ExpectedAccountBody,
  type ExpectedAccountQuery,
  type LinkRelatedMarketBody,
  type MarketSummary,
  type ResolveMarketBody,
  type UpdateMarketBody,
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
import { MarketAdminService } from './market-admin.service.js';
import { RelatedMarketsService } from './related-markets.service.js';

/**
 * Admin market CRUD and transitions (PLAN 7.3, 12; M3). Guards run in order: SessionGuard
 * fills `request.auth` (401 without a session, 403 for a foreign Origin on a mutation),
 * AdminGuard reads the role (403 for a member), OnboardedGuard refuses an admin that has not
 * finished the onboarding (409 ONBOARDING_REQUIRED, ADR-0072).
 *
 * Every write names the admin the screen shows (`expectedAccountId` — in the body, or the query
 * of an unlink, whose DELETE has no body; assertExpectedAccount, ADR-0092): a mismatch with the
 * cookie is refused (403 FORBIDDEN naming the field) before anything is read, locked or written,
 * so a market is never created, edited, opened, closed, judged or linked as an admin the user is
 * not looking at. The services are handed the rest of the body: the account is never stored.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketsController {
  constructor(
    private readonly markets: MarketAdminService,
    private readonly related: RelatedMarketsService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarkets',
    summary:
      'Every market, drafts included, newest first; q narrows it to titles holding the term ' +
      '(a case-insensitive partial match), as the related-market picker searches',
  })
  // No `@ApiQuery`: `adminMarketListQuerySchema` has no component id, so swagger expands it
  // into the cursor/limit/status/q parameters itself (see markets.controller.ts).
  @ApiPageOf(marketSummarySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarkets(
    @Query({ schema: adminMarketListQuerySchema }) query: AdminMarketListQuery,
  ): Promise<ApiPage<MarketSummary>> {
    const { items, nextCursor } = await this.markets.list(query);
    return new ApiPage(items, { nextCursor });
  }

  /**
   * 관련 시장 (#65, ADR-0068): the market's links, every status of the market at the other end —
   * the admin keeps a link whatever either market's state, and the detail filters what it shows.
   * Unpaginated: it is the list the links are managed from, one market's, made by admins.
   */
  @Get(':id/related')
  @ApiOperation({
    operationId: 'adminListRelatedMarkets',
    summary: 'The markets linked to this one, any status, the latest link first, with who linked',
  })
  @ApiData(adminRelatedMarketSchema.array())
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminListRelatedMarkets(
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<AdminRelatedMarket[]> {
    return this.related.listAdmin(id);
  }

  @Post(':id/related')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminLinkRelatedMarket',
    summary:
      'Link another market to this one, two-way, in any status of either; linking a linked ' +
      'pair changes nothing. Answers the links as they stand',
  })
  @ApiData(adminRelatedMarketSchema.array())
  // VALIDATION_ERROR names `marketId` for the market itself; NOT_FOUND names it for an unknown
  // one (an unknown market in the path is a plain NOT_FOUND). FORBIDDEN names `expectedAccountId`
  // for another account's (as on every write here).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminLinkRelatedMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: linkRelatedMarketBodySchema }) body: LinkRelatedMarketBody,
  ): Promise<AdminRelatedMarket[]> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.related.link(admin.id, id, body.marketId);
  }

  @Delete(':id/related/:relatedMarketId')
  @ApiOperation({
    operationId: 'adminUnlinkRelatedMarket',
    summary:
      'Unlink two markets; unlinking a pair that is not linked changes nothing. Answers the ' +
      "path market's links as they stand",
  })
  @ApiData(adminRelatedMarketSchema.array())
  // The link's refusals, naming the path's `relatedMarketId` where the link names the body's
  // `marketId`: VALIDATION_ERROR for the market itself, NOT_FOUND for an unknown one (an unknown
  // market in the first path segment is a plain NOT_FOUND).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminUnlinkRelatedMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('relatedMarketId', { schema: uuidParamSchema }) relatedMarketId: string,
    @Query({ schema: expectedAccountQuerySchema }) query: ExpectedAccountQuery,
  ): Promise<AdminRelatedMarket[]> {
    assertExpectedAccount(admin.id, query.expectedAccountId);
    return this.related.unlink(admin.id, id, relatedMarketId);
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'adminGetMarket',
    summary: 'One market with its exposure, settlement steps and event log',
  })
  @ApiData(adminMarketSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminGetMarket(@Param('id', { schema: uuidParamSchema }) id: string): Promise<AdminMarket> {
    return this.markets.get(id);
  }

  @Post()
  @ApiOperation({
    operationId: 'adminCreateMarket',
    summary: 'Create a draft market (no price until its first fill)',
  })
  @ApiData(adminMarketSchema, 201)
  // NOT_FOUND names `categoryId`; VALIDATION_ERROR names `slug` (taken), `categoryId`
  // (disabled) or `closeAt` (not in the future) besides the body schema's own issues.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminCreateMarket(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: createMarketBodySchema }) body: CreateMarketBody,
  ): Promise<AdminMarket> {
    // The fields alone: the `created` event keeps them as sent.
    const { expectedAccountId, ...fields } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.create(admin.id, fields);
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'adminUpdateMarket',
    summary:
      'Edit a draft (any field) or an open market (text, close time, category; slug ' +
      'refused naming the field, blank rules refused with RULES_REQUIRED); other statuses ' +
      'refuse naming status',
  })
  @ApiData(adminMarketSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'RULES_REQUIRED',
  )
  adminUpdateMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: updateMarketBodySchema }) body: UpdateMarketBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...fields } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.update(admin.id, id, fields);
  }

  @Post(':id/open')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminOpenMarket',
    summary: 'draft → open; refused without rules (RULES_REQUIRED) or with a past closeAt',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `status` (not a draft) or `closeAt` (already past).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'RULES_REQUIRED',
  )
  adminOpenMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.markets.open(admin.id, id);
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminCloseMarket', summary: 'open → closed' })
  @ApiData(adminMarketSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'MARKET_NOT_OPEN',
  )
  adminCloseMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.markets.close(admin.id, id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminResolveMarket',
    summary: 'closed → resolved: record the final result; settlement starts immediately',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `status` for anything but a closed market — a resolved one
  // included: a judgement is final, so neither the same result again nor another is accepted.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminResolveMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: resolveMarketBodySchema }) body: ResolveMarketBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...judgement } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.resolve(admin.id, id, judgement);
  }
}
