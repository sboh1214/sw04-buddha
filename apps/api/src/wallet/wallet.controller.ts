import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  chargeBodySchema,
  chargePackageSchema,
  chargeResultSchema,
  couponSchema,
  cursorQuerySchema,
  ledgerEntrySchema,
  paymentSchema,
  redeemCouponBodySchema,
  type ChargeBody,
  type ChargePackage,
  type ChargeResult,
  type CursorQuery,
  type LedgerEntry,
  type Payment,
  type RedeemCouponBody,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ChargePackageService } from './charge-package.service.js';
import { CouponService, type RedeemResult } from './coupon.service.js';
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

/**
 * The charge catalogue (ADR-0026). Public on purpose: prices and discounts are what a visitor
 * needs to decide whether to sign up, and the list holds no personal data.
 */
@ApiTags('wallet')
@Controller('charge-packages')
export class ChargePackagesController {
  constructor(private readonly packages: ChargePackageService) {}

  @Get()
  @ApiOperation({
    operationId: 'listChargePackages',
    summary: 'Charge packages on sale, cheapest discount first',
  })
  @ApiData(chargePackageSchema.array())
  listPackages(): Promise<ChargePackage[]> {
    return this.packages.listActive();
  }
}

/** `POST /api/v1/payments/charge` (PLAN 7.2, M2). */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('payments')
@UseGuards(SessionGuard)
export class PaymentsController {
  constructor(private readonly wallet: WalletService) {}

  @Post('charge')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'charge',
    summary:
      'Buy one charge package (mock provider: succeeds immediately). P is never convertible back to cash.',
  })
  @ApiData(chargeResultSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR', 'PRICE_MOVED')
  charge(
    @CurrentUser() user: SessionUser,
    @Body({ schema: chargeBodySchema }) body: ChargeBody,
  ): Promise<ChargeResult> {
    return this.wallet.charge(user.id, body);
  }
}

/** `POST /api/v1/coupons/redeem` (ADR-0026). */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('coupons')
@UseGuards(SessionGuard)
export class CouponsController {
  constructor(private readonly coupons: CouponService) {}

  @Post('redeem')
  @HttpCode(200)
  @ApiOperation({ operationId: 'redeemCoupon', summary: 'Redeem a coupon code for P' })
  @ApiData(
    couponSchema
      .pick({ code: true, amountP: true })
      .extend({ balance: chargeResultSchema.shape.balance, ledgerEntry: ledgerEntrySchema })
      .meta({ id: 'RedeemCouponResult' }),
  )
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR', 'DUPLICATE_REQUEST')
  async redeem(
    @CurrentUser() user: SessionUser,
    @Body({ schema: redeemCouponBodySchema }) body: RedeemCouponBody,
  ): Promise<{
    code: string;
    amountP: string;
    balance: RedeemResult['balance'];
    ledgerEntry: RedeemResult['ledgerEntry'];
  }> {
    const result = await this.coupons.redeem(user.id, body.code);
    return {
      code: result.coupon.code,
      amountP: result.coupon.amountP,
      balance: result.balance,
      ledgerEntry: result.ledgerEntry,
    };
  }
}

/** `GET /api/v1/me/ledger` and `/me/payments` (PLAN 7.2, M2). */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
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
