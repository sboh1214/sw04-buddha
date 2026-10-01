import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
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
  smartroPrepareResultSchema,
  uuidParamSchema,
  type ChargeBody,
  type ChargePackage,
  type ChargeResult,
  type CursorQuery,
  type LedgerEntry,
  type Payment,
  type PaymentProviderInfo,
  type RedeemCouponBody,
  type SmartroPrepareResult,
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
import { SmartroPayService } from '../payments/smartro/smartro-pay.service.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { ChargePackageService } from './charge-package.service.js';
import { CouponService, type RedeemResult } from './coupon.service.js';
import { WalletService } from './wallet.service.js';

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

/**
 * `GET /api/v1/payments/provider` (ADR-0042): which charge flow the web offers. Public like the
 * catalogue — it names a PG and a mode, nothing about anyone.
 */
@ApiTags('wallet')
@Controller('payments')
export class PaymentProviderController {
  constructor(private readonly smartro: SmartroPayService) {}

  @Get('provider')
  @ApiOperation({
    operationId: 'getPaymentProvider',
    summary:
      'The configured payment provider: mock (immediate charge) or smartro (payment window, with its SDK URLs)',
  })
  @ApiData(paymentProviderInfoSchema)
  getPaymentProvider(): PaymentProviderInfo {
    return this.smartro.providerInfo();
  }
}

/** The `Idempotency-Key` header of both charge flows (PLAN 5.4). */
const IDEMPOTENCY_KEY_SCHEMA = {
  type: 'string',
  minLength: IDEMPOTENCY_KEY_MIN_LENGTH,
  maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
  pattern: '^[A-Za-z0-9_-]+$',
} as const;

/** `POST /api/v1/payments/charge` (PLAN 7.2, M2) and `/payments/smartro/prepare` (ADR-0042). */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('payments')
@UseGuards(SessionGuard)
export class PaymentsController {
  constructor(
    private readonly wallet: WalletService,
    private readonly smartro: SmartroPayService,
  ) {}

  @Post('charge')
  @HttpCode(200)
  // PLAN 7.5. Per account: the mock provider costs nothing, but the real one will, and
  // A-M2-6 makes this limit a precondition of ever wiring a PG.
  @RateLimit('charge')
  @ApiOperation({
    operationId: 'charge',
    summary:
      'Buy one charge package (mock provider: succeeds immediately). P is never convertible back to cash.',
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
  // answers every call while the configured provider is SmartroPay (no immediate charge).
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

  @Post('smartro/prepare')
  @HttpCode(200)
  // Same bucket as the immediate charge: either way this is where an account buys P.
  @RateLimit('charge')
  @ApiOperation({
    operationId: 'prepareSmartroPayment',
    summary:
      'Reserve a pending SmartroPay payment for one charge package and sign the payment-window form (provider smartro only)',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Client-generated key for this purchase (PLAN 5.4). Re-sent while the payment is still ' +
      'pending and unapproved, it returns a freshly signed form for the SAME payment. ' +
      'DUPLICATE_REQUEST (409) answers a key re-used with a different body, or one whose ' +
      'payment has already been approved or closed (the key is spent).',
    schema: IDEMPOTENCY_KEY_SCHEMA,
  })
  @ApiData(smartroPrepareResultSchema)
  // NOT_FOUND: the configured provider is not SmartroPay, or the package is gone (details name
  // `packageId`). VALIDATION_ERROR with `packageId`: retired, or below the card minimum
  // (CARD_MIN_PRICE_KRW). CONTACT_REQUIRED: no real name / mobile number registered yet.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'PRICE_MOVED',
    'DUPLICATE_REQUEST',
    'CONTACT_REQUIRED',
    'RATE_LIMITED',
  )
  prepareSmartroPayment(
    @CurrentUser() user: SessionUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: chargeBodySchema }) body: ChargeBody,
  ): Promise<SmartroPrepareResult> {
    return this.smartro.prepare(user.id, body, idempotencyKey);
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
  // Not in PLAN 7.5, but a coupon code is a secret short enough to guess and this is the only
  // route that tests one. Per account, like the two PLAN names.
  @RateLimit('coupon')
  @ApiOperation({ operationId: 'redeemCoupon', summary: 'Redeem a coupon code for P' })
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
    summary: 'One of the caller charges (the wallet reads it for the result of a payment window)',
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
