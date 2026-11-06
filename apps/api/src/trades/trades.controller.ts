import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  positionSchema,
  positionsQuerySchema,
  type Position,
  type PositionsQuery,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { TradeService } from './trade.service.js';

/**
 * `GET /api/v1/me/positions` (PLAN 7.2, M3 design 3.5). The orders and fills are
 * MeOrdersController's (#119).
 */
@ApiTags('trades')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MeTradesController {
  constructor(private readonly trades: TradeService) {}

  @Get('positions')
  @ApiOperation({
    operationId: 'getMyPositions',
    summary:
      'Every position of the account, most recently changed first. status=open keeps the ' +
      'unsettled rows (qty may be 0 after a full sell), status=settled the settled ones; ' +
      'omitted lists all. No cursor: bounded by the markets one account has touched.',
  })
  @ApiData(positionSchema.array())
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  getPositions(
    @CurrentUser() user: SessionUser,
    @Query({ schema: positionsQuerySchema }) query: PositionsQuery,
  ): Promise<Position[]> {
    return this.trades.listPositions(user.id, query.status);
  }
}
