import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  cursorQuerySchema,
  orderSchema,
  positionSchema,
  positionsQuerySchema,
  type CursorQuery,
  type Order,
  type Position,
  type PositionsQuery,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { TradeService } from './trade.service.js';

/** `GET /api/v1/me/positions` and `/me/orders` (PLAN 7.2, M3 design 3.5). */
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

  @Get('orders')
  @ApiOperation({
    operationId: 'getMyOrders',
    summary: 'Orders of the account with their fill, newest first',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(orderSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async getOrders(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<Order>> {
    const { items, nextCursor } = await this.trades.listOrders(user.id, query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }
}
