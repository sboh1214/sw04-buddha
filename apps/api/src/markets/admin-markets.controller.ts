import {
  Body,
  Controller,
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
  createMarketBodySchema,
  marketSummarySchema,
  resolveMarketBodySchema,
  updateMarketBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type AdminMarketListQuery,
  type CreateMarketBody,
  type MarketSummary,
  type ResolveMarketBody,
  type UpdateMarketBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { MarketAdminService } from './market-admin.service.js';

/**
 * Admin market CRUD and transitions (PLAN 7.3, 12; M3). Guards run in order: SessionGuard
 * fills `request.auth` (401 without a session, 403 for a foreign Origin on a mutation),
 * AdminGuard reads the role (403 for a member).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard)
export class AdminMarketsController {
  constructor(private readonly markets: MarketAdminService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListMarkets',
    summary: 'Every market, drafts included, newest first',
  })
  // No `@ApiQuery`: `adminMarketListQuerySchema` has no component id, so swagger expands it
  // into the cursor/limit/status parameters itself (see markets.controller.ts).
  @ApiPageOf(marketSummarySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async adminListMarkets(
    @Query({ schema: adminMarketListQuerySchema }) query: AdminMarketListQuery,
  ): Promise<ApiPage<MarketSummary>> {
    const { items, nextCursor } = await this.markets.list(query.status, query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'adminGetMarket',
    summary: 'One market with its exposure, settlement steps and event log',
  })
  @ApiData(adminMarketSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
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
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminCreateMarket(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: createMarketBodySchema }) body: CreateMarketBody,
  ): Promise<AdminMarket> {
    return this.markets.create(admin.id, body);
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
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'RULES_REQUIRED')
  adminUpdateMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: updateMarketBodySchema }) body: UpdateMarketBody,
  ): Promise<AdminMarket> {
    return this.markets.update(admin.id, id, body);
  }

  @Post(':id/open')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminOpenMarket',
    summary: 'draft → open; refused without rules (RULES_REQUIRED) or with a past closeAt',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `status` (not a draft) or `closeAt` (already past).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'RULES_REQUIRED')
  adminOpenMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<AdminMarket> {
    return this.markets.open(admin.id, id);
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminCloseMarket', summary: 'open → closed' })
  @ApiData(adminMarketSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'MARKET_NOT_OPEN')
  adminCloseMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<AdminMarket> {
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
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminResolveMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: resolveMarketBodySchema }) body: ResolveMarketBody,
  ): Promise<AdminMarket> {
    return this.markets.resolve(admin.id, id, body);
  }
}
