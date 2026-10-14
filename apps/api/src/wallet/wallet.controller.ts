import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  chargeBodySchema,
  chargePackageSchema,
  chargeResultSchema,
  couponSchema,
  cursorQuerySchema,
  ledgerEntrySchema,
  paymentProviderInfoSchema,
  paymentSchema,
  redeemCouponBodySchema,
  uuidParamSchema,
  type ChargeBody,
  type ChargePackage,
  type ChargeResult,
  type CursorQuery,
  type LedgerEntry,
  type Payment,
  type PaymentProviderInfo,
  type RedeemCouponBody,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { PaidCoinSalesGuard } from '../payments/paid-coin-sales.guard.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../payments/payments-config.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { ChargePackageService } from './charge-package.service.js';
import { CouponService, type RedeemResult } from './coupon.service.js';
import { WalletService } from './wallet.service.js';

/**
 * The charge catalogue (ADR-0026). Public on purpose: prices and discounts are what a visitor
 * needs to decide whether to sign up, and the list holds no personal data. Closed with the rest
 * of paid Coin while it is off (PaidCoinSalesGuard, ADR-0049).
 */
@ApiTags('wallet')
@Controller('charge-packages')
@UseGuards(PaidCoinSalesGuard)
export class ChargePackagesController {
  constructor(private readonly packages: ChargePackageService) {}

  @Get()
  @ApiOperation({
    operationId: 'listChargePackages',
    summary:
      'Charge packages on sale, cheapest discount first. Closed while paid Coin is off: 404 (ADR-0049)',
  })
  @ApiData(chargePackageSchema.array())
  @ApiErrors('NOT_FOUND')
  listPackages(): Promise<ChargePackage[]> {
    return this.packages.listActive();
  }
}

/**
 * `GET /api/v1/payments/provider` (ADR-0042): which charge flow the web offers. Public like the
 * catalogue — it names a provider, nothing about anyone — and closed with it.
 */
@ApiTags('wallet')
@Controller('payments')
@UseGuards(PaidCoinSalesGuard)
export class PaymentProviderController {
  constructor(@Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig) {}

  @Get('provider')
  @ApiOperation({
    operationId: 'getPaymentProvider',
    summary:
      'The configured payment provider (mock: immediate charge). Closed while paid Coin is off: 404 (ADR-0049)',
  })
  @ApiData(paymentProviderInfoSchema)
  @ApiErrors('NOT_FOUND')
  getPaymentProvider(): PaymentProviderInfo {
    return { provider: this.config.provider };
  }
}

/** The `Idempotency-Key` header of the charge (PLAN 5.4). */
const IDEMPOTENCY_KEY_SCHEMA = {
  type: 'string',
  minLength: IDEMPOTENCY_KEY_MIN_LENGTH,
  maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
  pattern: '^[A-Za-z0-9_-]+$',
} as const;

/**
 * `POST /api/v1/payments/charge` (PLAN 7.2, M2). PaidCoinSalesGuard first: while paid Coin is
 * off the 404 answers before SessionGuard, signed in or not.
 */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('payments')
@UseGuards(PaidCoinSalesGuard, SessionGuard)
export class PaymentsController {
  constructor(private readonly wallet: WalletService) {}

  @Post('charge')
  @HttpCode(200)
  // PLAN 7.5. Per account: the mock provider costs nothing, but the real one will, and
  // A-M2-6 makes this limit a precondition of ever wiring a PG.
  @RateLimit('charge')
  @ApiOperation({
    operationId: 'charge',
    summary:
      'Buy one charge package (mock provider: succeeds immediately). P is never convertible back to cash. Closed while paid Coin is off: 404 (ADR-0049)',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Client-generated key for this purchase (PLAN 5.4). Re-sending it returns the first ' +
      'outcome instead of charging again. DUPLICATE_REQUEST (409) answers a key whose first ' +
      'request is still running (details name Idempotency-Key: keep the key and retry) and a ' +
      'key re-used with a different body (no details: the key is spent).',
    schema: IDEMPOTENCY_KEY_SCHEMA,
  })
  @ApiData(chargeResultSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field). NOT_FOUND also
  // answers every call while paid Coin is off, or while the configured provider has no
  // immediate charge.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'PRICE_MOVED',
    'DUPLICATE_REQUEST',
    'RATE_LIMITED',
  )
  charge(
    @CurrentUser() user: SessionUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: chargeBodySchema }) body: ChargeBody,
  ): Promise<ChargeResult> {
    return this.wallet.charge(user.id, body, idempotencyKey);
  }
}

/** `POST /api/v1/coupons/redeem` (ADR-0026); closed like the charge while paid Coin is off. */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('coupons')
@UseGuards(PaidCoinSalesGuard, SessionGuard)
export class CouponsController {
  constructor(private readonly coupons: CouponService) {}

  @Post('redeem')
  @HttpCode(200)
  // Not in PLAN 7.5, but a coupon code is a secret short enough to guess and this is the only
  // route that tests one. Per account, like the two PLAN names.
  @RateLimit('coupon')
  @ApiOperation({
    operationId: 'redeemCoupon',
    summary: 'Redeem a coupon code for P. Closed while paid Coin is off: 404 (ADR-0049)',
  })
  @ApiData(
    couponSchema
      .pick({ code: true, amountP: true })
      .extend({ balance: chargeResultSchema.shape.balance, ledgerEntry: ledgerEntrySchema })
      .meta({ id: 'RedeemCouponResult' }),
  )
  // FORBIDDEN: a foreign Origin (SessionGuard's CSRF check), or a body whose `expectedAccountId`
  // is not the cookie's account (details name the field).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'DUPLICATE_REQUEST',
    'RATE_LIMITED',
  )
  async redeem(
    @CurrentUser() user: SessionUser,
    @Body({ schema: redeemCouponBodySchema }) body: RedeemCouponBody,
  ): Promise<{
    code: string;
    amountP: string;
    balance: RedeemResult['balance'];
    ledgerEntry: RedeemResult['ledgerEntry'];
  }> {
    // A one-use or capped coupon redeemed for the wrong account cannot be given back by the
    // user. Here rather than in CouponService.redeem because this handler is its only caller
    // and the service takes the resolved account; the charge keeps its check in the service
    // because the replay lookup there must come after it.
    assertExpectedAccount(user.id, body.expectedAccountId);
    const result = await this.coupons.redeem(user.id, body.code);
    return {
      code: result.coupon.code,
      amountP: result.coupon.amountP,
      balance: result.balance,
      ledgerEntry: result.ledgerEntry,
    };
  }
}

/** `GET /api/v1/me/ledger`, `/me/payments` (PLAN 7.2, M2) and `/me/payments/:id` (ADR-0042). */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MeWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('ledger')
  @ApiOperation({ operationId: 'getMyLedger', summary: 'Ledger entries, newest first' })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
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
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
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

  @Get('payments/:id')
  @ApiOperation({
    operationId: 'getMyPayment',
    summary: 'One of the caller charges',
  })
  @ApiData(paymentSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getPayment(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<Payment> {
    return this.wallet.getPayment(user.id, id);
  }
}
