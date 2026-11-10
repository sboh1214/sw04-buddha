import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { adminMarketMakerSchema, uuidParamSchema, type AdminMarketMaker } from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { AdminMarketMakerService } from './market-maker.service.js';

@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketMakerController {
  constructor(private readonly marketMaker: AdminMarketMakerService) {}

  @Get(':id/market-maker')
  @ApiOperation({
    operationId: 'adminGetMarketMaker',
    summary: 'Read private bot settings, current readiness and previous runtime observations',
  })
  @ApiData(adminMarketMakerSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  get(@Param('id', { schema: uuidParamSchema }) id: string): Promise<AdminMarketMaker> {
    return this.marketMaker.get(id);
  }
}
