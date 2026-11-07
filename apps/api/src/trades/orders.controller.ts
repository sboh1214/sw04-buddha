import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IDEMPOTENCY_KEY_HEADER,
  expectedAccountBodySchema,
  idempotencyKeySchema,
  myFillSchema,
  myFillsQuerySchema,
  myOrdersQuerySchema,
  orderSchema,
  placeOrderBodySchema,
  placeOrderResultSchema,
  uuidParamSchema,
  type ExpectedAccountBody,
  type MyFill,
  type MyFillsQuery,
  type MyOrdersQuery,
  type Order,
  type PlaceOrderBody,
  type PlaceOrderResult,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  IDEMPOTENCY_KEY_SCHEMA,
  IdempotencyKey,
} from '../common/decorators/idempotency-key.decorator.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { OrderRateLimitGuard } from './order-rate-limit.guard.js';
import { OrderService } from './order.service.js';

/**
 * 주문 (#119, ADR-0112): a member's order on a market. Owner-only: SessionGuard (401, 403 for a
 * foreign Origin), OnboardedGuard (409 ONBOARDING_REQUIRED, #57-8: an account that has not
 * finished only reads), then the order limit (OrderRateLimitGuard: `order.rate_limit` per account
 * per minute, 429). The request id is the `Idempotency-Key` header, unique per account; the body
 * names the account the screen shows (`expectedAccountId`, ADR-0092), refused before anything is
 * read when it is not the cookie's. OrderService has the rest.
 */
@ApiTags('orders')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('markets')
@UseGuards(SessionGuard, OnboardedGuard, OrderRateLimitGuard)
export class MarketOrdersController {
  constructor(private readonly orders: OrderService) {}

  @Post(':id/orders')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'placeOrder',
    summary:
      'Place an order: buy or sell YES or NO, immediate (ioc: fills what it can now, the rest ' +
      'is cancelled) or limit (gtc: the rest waits), always with a limit price 1–99 — an ' +
      'immediate order’s narrowed to the best opposite quote ± the market’s price-protection ' +
      'width — and a quantity of 1–1,000,000 contracts or, for an immediate buy only, a Coin ' +
      'budget. Answers the order: taken, or rejected with its reason (not an error). The same ' +
      'Idempotency-Key with the same terms answers that order as it stands now (replayed)',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'The request id: client-generated, unique per account. Re-sending it with the same ' +
      'market and terms answers the order it named (replayed: true) and writes nothing; with ' +
      'other terms DUPLICATE_REQUEST (409, the id is spent). A refusal with an error writes no ' +
      'order, so its id may be sent again. GET /me/orders/request/{requestId} reads the order.',
    schema: IDEMPOTENCY_KEY_SCHEMA,
  })
  @ApiData(placeOrderResultSchema)
  // VALIDATION_ERROR: the Idempotency-Key header, or the body (outcome, side, timeInForce,
  // limitPriceCoin 1–99, exactly one of qty 1–1,000,000 and budgetCoin 1–1,000,000 — a budget for
  // an ioc buy only — and no other field). FORBIDDEN: a foreign Origin, `expectedAccountId` not the
  // cookie's, or an admin (who never trades). RESTRICTED: an account restriction stands (#139).
  // NOT_FOUND: no public market of that id. ORDER_INTAKE_CLOSED: intake is closed
  // (`order.accepting`), or an immediate order on a market with no width (path priceProtection) —
  // a market not OPEN, or past its close_at by the DB clock (#120), answers a rejected order first.
  // DUPLICATE_REQUEST: the request id named another order. RATE_LIMITED: `order.rate_limit`.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'RESTRICTED',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ORDER_INTAKE_CLOSED',
    'DUPLICATE_REQUEST',
    'RATE_LIMITED',
  )
  placeOrder(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @IdempotencyKey() requestId: string,
    @Body({ schema: placeOrderBodySchema }) body: PlaceOrderBody,
  ): Promise<PlaceOrderResult> {
    const { expectedAccountId, ...order } = body;
    assertExpectedAccount(user.id, expectedAccountId);
    return this.orders.place(user.id, id, requestId, order);
  }
}

/**
 * `/api/v1/me/orders`, `/me/fills` (#119, ADR-0112): the caller's own orders — rejected ones
 * included — and fills, and the cancel of a waiting one (#178, ADR-0113). Owner-only: the session
 * decides whose rows are read or cancelled, and another account's order is NOT_FOUND (N04 §7). A
 * fill is shown as the caller's own order took it, the counterparty anonymous: no other order,
 * account or account type (ADR-0107 결정 5 '#179·#119'). Signed in is enough: an account sent back
 * to agree to the terms again still reads its own, and cancels its own as it retracts its own
 * proposal (ADR-0089).
 */
@ApiTags('orders')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MeOrdersController {
  constructor(private readonly orders: OrderService) {}

  @Get('orders')
  @ApiOperation({
    operationId: 'getMyOrders',
    summary:
      "The account's orders, newest first, rejected ones included, each with what filled and " +
      'its state and reason; marketId narrows to one market, state=live to the waiting and ' +
      'partly filled ones, state=ended to the rest',
  })
  @ApiPageOf(orderSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async getMyOrders(
    @CurrentUser() user: SessionUser,
    @Query({ schema: myOrdersQuerySchema }) query: MyOrdersQuery,
  ): Promise<ApiPage<Order>> {
    const { items, nextCursor } = await this.orders.listMine(user.id, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get('orders/request/:requestId')
  @ApiOperation({
    operationId: 'getMyOrderByRequest',
    summary:
      'The account’s order its request id (the Idempotency-Key it was sent with) named — what ' +
      'became of a request whose answer was lost. NOT_FOUND when it named none',
  })
  @ApiData(orderSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getMyOrderByRequest(
    @CurrentUser() user: SessionUser,
    @Param('requestId', { schema: idempotencyKeySchema }) requestId: string,
  ): Promise<Order> {
    return this.orders.mineByRequest(user.id, requestId);
  }

  @Get('orders/:id')
  @ApiOperation({
    operationId: 'getMyOrder',
    summary: 'One of the account’s orders; another account’s is NOT_FOUND',
  })
  @ApiData(orderSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getMyOrder(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<Order> {
    return this.orders.mine(user.id, id);
  }

  /**
   * 주문 취소 (#178, ADR-0113; ADR-0107 결정 1 #177 7·9항): the whole remaining quantity of one of
   * the account's waiting or partly filled orders, ended in this request — no 'cancel requested'
   * state on the server — and answered in its final state, as `GET /me/orders/:id` would. Signed
   * in is enough: not the order limit (`order.rate_limit` counts submissions only, #177 9항), nor
   * the intake (`order.accepting`), nor the onboarding, nor an account restriction (N02 §9 stops
   * new orders, not their cancel) — nor the admin role, for an order placed before the grant. The
   * body names the account the screen shows (`expectedAccountId`, ADR-0092), refused before
   * anything is read when it is not the cookie's.
   */
  @Post('orders/:id/cancel')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'cancelMyOrder',
    summary:
      'Cancel one of the account’s waiting or partly filled orders: its whole remaining ' +
      'quantity at once, inside this request (no "requested" state), its lock released and what ' +
      'filled kept. Answers the order in its final state; one that had ended answers as it is. ' +
      'Another account’s is NOT_FOUND; MARKET_NOT_OPEN while its market is held for a ledger ' +
      'failure (the recovery approval ends it: cancelled, reason paused, at a resume or early ' +
      'close; expired when the market closed before its recovery, #93). Not counted by the ' +
      'order rate limit, and open while order intake is closed',
  })
  @ApiData(orderSchema)
  // FORBIDDEN: a foreign Origin, or `expectedAccountId` not the cookie's. MARKET_NOT_OPEN: the
  // order's market is paused for a ledger failure (or closed before its recovery), details
  // `[{path: ['market'], message: 'paused'}]`; nothing is written.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'MARKET_NOT_OPEN')
  cancelMyOrder(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<Order> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.orders.cancel(user.id, id);
  }

  @Get('fills')
  @ApiOperation({
    operationId: 'getMyFills',
    summary:
      "The account's fills, newest first, each as its own order took it: the order, outcome, " +
      'side, quantity, price per contract and Coin, the recorded YES price and the fee (0). ' +
      'The counterparty is never named; marketId narrows to one market',
  })
  @ApiPageOf(myFillSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async getMyFills(
    @CurrentUser() user: SessionUser,
    @Query({ schema: myFillsQuerySchema }) query: MyFillsQuery,
  ): Promise<ApiPage<MyFill>> {
    const { items, nextCursor } = await this.orders.listMyFills(user.id, query);
    return new ApiPage(items, { nextCursor });
  }
}
