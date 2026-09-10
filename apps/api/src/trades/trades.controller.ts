import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  cursorQuerySchema,
  orderSchema,
  positionSchema,
  positionsQuerySchema,
  tradeBodySchema,
  tradeResultSchema,
  type CursorQuery,
  type Order,
  type Position,
  type PositionsQuery,
  type TradeBody,
  type TradeResult,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { TradeService } from './trade.service.js';

/** `POST /api/v1/trades` (PLAN 5.4, 7.2, M3). */
@ApiTags('trades')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('trades')
@UseGuards(SessionGuard)
export class TradesController {
  constructor(private readonly trades: TradeService) {}

  @Post()
  @HttpCode(200)
  // PLAN 7.5. Per account, not per address: every browser reaches this API through the Next
  // rewrite, so an address here names the web server (rate-limit.tracker.ts). A refusal is safe
  // to retry — the `Idempotency-Key` this route already requires makes the retry the same trade.
  @RateLimit('trade')
  @ApiOperation({
    operationId: 'trade',
    summary:
      'Buy or sell contracts against the AMM at the current LMSR price. A buy carries ' +
      'maxCostP and a sell minProceedsP (PRICE_MOVED when the recomputed amount is past it).',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Client-generated key for this trade (PLAN 5.4). Re-sending it returns the first ' +
      'outcome (order and fill verbatim; balance, position and market current) instead of ' +
      'trading again. DUPLICATE_REQUEST (409, no details) answers a key re-used with different ' +
      'terms: the key is spent.',
    schema: {
      type: 'string',
      minLength: IDEMPOTENCY_KEY_MIN_LENGTH,
      maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
      pattern: '^[A-Za-z0-9_-]+$',
    },
  })
  @ApiData(tradeResultSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field). NOT_FOUND: no
  // such market, a draft, or an account without a balance row. MARKET_NOT_OPEN: any status
  // but open. MARKET_CLOSED: open but past close_at.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'MARKET_NOT_OPEN',
    'MARKET_CLOSED',
    'INSUFFICIENT_BALANCE',
    'INSUFFICIENT_POSITION',
    'PRICE_MOVED',
    'DUPLICATE_REQUEST',
    'RATE_LIMITED',
  )
  trade(
    @CurrentUser() user: SessionUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: tradeBodySchema }) body: TradeBody,
  ): Promise<TradeResult> {
    return this.trades.trade(user.id, body, idempotencyKey);
  }
}

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
