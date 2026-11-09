import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminMarketConflictsSchema,
  adminMarketConflictWriteSchema,
  declareMarketConflictBodySchema,
  uuidParamSchema,
  type AdminMarketConflicts,
  type AdminMarketConflictWrite,
  type DeclareMarketConflictBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { MarketConflictsService } from './market-conflicts.service.js';

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketConflictsController {
  constructor(private readonly conflicts: MarketConflictsService) {}

  @Get(':id/conflicts')
  @ApiOperation({
    operationId: 'adminGetMarketConflicts',
    summary:
      'Read the acting administrator’s trading interest and immutable declarations for a market',
  })
  @ApiData(adminMarketConflictsSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  get(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<AdminMarketConflicts> {
    return this.conflicts.get(admin.id, id);
  }

  @Post(':id/conflicts')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminDeclareMarketConflict',
    summary:
      'Declare the acting administrator’s interest irrevocably, retracting their pending judgement or correction atomically',
  })
  @ApiData(adminMarketConflictWriteSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  declare(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: declareMarketConflictBodySchema }) body: DeclareMarketConflictBody,
  ): Promise<AdminMarketConflictWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.conflicts.declare(admin.id, id, body.reason);
  }
}
