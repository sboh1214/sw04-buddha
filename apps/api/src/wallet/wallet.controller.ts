import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  chargeBodySchema,
  chargeResultSchema,
  cursorQuerySchema,
  ledgerEntrySchema,
  paymentSchema,
  type ChargeBody,
  type ChargeResult,
  type CursorQuery,
  type LedgerEntry,
  type Payment,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { SESSION_COOKIE } from '../openapi/document.js';
import { WalletService } from './wallet.service.js';

/** PLAN 7.2 cursor query, documented once for both listing endpoints. */
const CURSOR_QUERY = [
  { name: 'cursor', required: false, schema: { type: 'string' as const } },
  {
    name: 'limit',
    required: false,
    schema: { type: 'integer' as const, minimum: 1, maximum: 100 },
  },
];

/** `POST /api/v1/payments/charge` (PLAN 7.2, M2). */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_COOKIE)
@Controller('payments')
@UseGuards(SessionGuard)
export class PaymentsController {
  constructor(private readonly wallet: WalletService) {}

  @Post('charge')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'charge',
    summary: 'Buy P (mock provider: succeeds immediately). P is never convertible back to cash.',
  })
  @ApiData(chargeResultSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  charge(
    @CurrentUser() user: SessionUser,
    @Body({ schema: chargeBodySchema }) body: ChargeBody,
  ): Promise<ChargeResult> {
    return this.wallet.charge(user.id, body.amountP);
  }
}

/** `GET /api/v1/me/ledger` and `/me/payments` (PLAN 7.2, M2). */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_COOKIE)
@Controller('me')
@UseGuards(SessionGuard)
export class MeWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('ledger')
  @ApiOperation({ operationId: 'getMyLedger', summary: 'Ledger entries, newest first' })
  @ApiQuery(CURSOR_QUERY[0]!)
  @ApiQuery(CURSOR_QUERY[1]!)
  @ApiPageOf(ledgerEntrySchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async getLedger(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<LedgerEntry>> {
    const { items, nextCursor } = await this.wallet.listLedger(user.id, query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Get('payments')
  @ApiOperation({ operationId: 'getMyPayments', summary: 'Charges, newest first' })
  @ApiQuery(CURSOR_QUERY[0]!)
  @ApiQuery(CURSOR_QUERY[1]!)
  @ApiPageOf(paymentSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async getPayments(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<Payment>> {
    const { items, nextCursor } = await this.wallet.listPayments(
      user.id,
      query.cursor,
      query.limit,
    );
    return new ApiPage(items, { nextCursor });
  }
}
