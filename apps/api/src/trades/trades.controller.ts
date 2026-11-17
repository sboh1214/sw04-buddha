import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  mySettlementSchema,
  mySettlementsQuerySchema,
  positionSchema,
  positionsQuerySchema,
  sellableSchema,
  uuidParamSchema,
  type MySettlement,
  type MySettlementsQuery,
  type Position,
  type PositionsQuery,
  type Sellable,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { OrderBookService } from './order-book.service.js';
import { TradeService } from './trade.service.js';

/**
 * `GET /api/v1/me/positions` (PLAN 7.2, M3 design 3.5), a holding's 매도 가능액
 * (`GET /me/markets/:id/sellable`, #179) and the account's settlement records
 * (`GET /me/settlements`, #124). The orders and fills are MeOrdersController's (#119).
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
   * 정산 기록 (#124, ADR-0143; ADR-0135 G1, N04 §3, N05 §4): the session's own records alone — the
   * caller names no account, and another account's market id or cursor reads an empty list.
   * Signed in is enough: a read, so a restricted account (N02 §9), one sent back to agree to the
   * terms again and an admin read their own. No single-record route.
   */
  @Get('settlements')
  @ApiOperation({
    operationId: 'getMySettlements',
    summary:
      "The account's settlement records, most recently paid first: per market and contract " +
      'the result (YES, NO or VOID), the contracts held at settlement, their remaining cost, ' +
      'the payout per contract (100 for the winning contract, 0 for the losing one, 50 for ' +
      'VOID), the payout (0 included) and the settlement P&L (payout minus remaining cost), ' +
      'with when the result was confirmed and when this payout completed. Read from the ' +
      'permanent records, so a later correction never changes a line. marketId narrows to one ' +
      'market, period (7d, 30d, 90d) to the payouts of the last N × 24 hours',
  })
  @ApiPageOf(mySettlementSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async getMySettlements(
    @CurrentUser() user: SessionUser,
    @Query({ schema: mySettlementsQuerySchema }) query: MySettlementsQuery,
  ): Promise<ApiPage<MySettlement>> {
    const { items, nextCursor } = await this.trades.listMySettlements(user.id, query);
    return new ApiPage(items, { nextCursor });
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
      'nothing is held; a market not open, or past its trading close, answers a rejected quote ' +
      'with its reason',
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
