import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  positionSchema,
  positionsQuerySchema,
  sellableSchema,
  uuidParamSchema,
  type Position,
  type PositionsQuery,
  type Sellable,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { OrderBookService } from './order-book.service.js';
import { TradeService } from './trade.service.js';

/**
 * `GET /api/v1/me/positions` (PLAN 7.2, M3 design 3.5) and a holding's 매도 가능액
 * (`GET /me/markets/:id/sellable`, #179). The orders and fills are MeOrdersController's (#119).
 */
@ApiTags('trades')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MeTradesController {
  constructor(
    private readonly trades: TradeService,
    private readonly books: OrderBookService,
  ) {}

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

  /**
   * 매도 가능액 (#179, ADR-0114; ADR-0107 결정 1 #177 15항, 결정 4 #179 '비로그인 견적': only a
   * holding's sellable figure is behind the sign-in). The session's own holding alone — the caller
   * names a market, never an account. Signed in is enough: a read, so an account sent back to agree
   * to the terms again, a restricted one and an admin read their own. The screen is #67's.
   */
  @Get('markets/:id/sellable')
  @ApiOperation({
    operationId: 'getMySellable',
    summary:
      "The account's holding of a market, YES then NO, with what it may sell now: the " +
      'contracts held, the part in its resting sells (shown apart, never quoted) and the rest ' +
      'quoted as an immediate sell with price protection (null when nothing is free or the ' +
      'market has no width; fewer filled than free means only part can sell now). Zeros when ' +
      'nothing is held; a market not open answers a rejected quote with its reason',
  })
  @ApiData(sellableSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getMySellable(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<Sellable> {
    return this.books.sellable(user.id, id);
  }
}
