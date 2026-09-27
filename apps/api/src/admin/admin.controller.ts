import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminBalanceAdjustResultSchema,
  chargePackageSchema,
  couponSchema,
  createChargePackageBodySchema,
  createCouponBodySchema,
  updateChargePackageBodySchema,
  updateCouponBodySchema,
  adminPaymentSchema,
  adminUserQuerySchema,
  adminUserSchema,
  auditFailureSchema,
  balanceAdjustBodySchema,
  cursorQuerySchema,
  refundPaymentBodySchema,
  uuidParamSchema,
  type AdminBalanceAdjustResult,
  type AdminPayment,
  type AdminUser,
  type AdminUserQuery,
  type AuditFailure,
  type BalanceAdjustBody,
  type ChargePackage,
  type Coupon,
  type CreateChargePackageBody,
  type CreateCouponBody,
  type CursorQuery,
  type RefundPaymentBody,
  type UpdateChargePackageBody,
  type UpdateCouponBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ChargePackageService } from '../wallet/charge-package.service.js';
import { CouponService } from '../wallet/coupon.service.js';
import { AdminService } from './admin.service.js';
import { PaymentRefundService } from './payment-refund.service.js';

/**
 * PLAN 7.3 / 12. Guards run in order, so SessionGuard fills `request.auth` before AdminGuard
 * reads the role (401 without a session, 403 for a non-admin).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly packages: ChargePackageService,
    private readonly coupons: CouponService,
    private readonly refunds: PaymentRefundService,
  ) {}

  // --- charge packages (ADR-0026): the catalogue users buy from -----------------------
  @Get('charge-packages')
  @ApiOperation({
    operationId: 'adminListChargePackages',
    summary: 'Every charge package, active or not',
  })
  @ApiData(chargePackageSchema.array())
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN')
  listChargePackages(): Promise<ChargePackage[]> {
    return this.packages.listAll();
  }

  @Post('charge-packages')
  @ApiOperation({ operationId: 'adminCreateChargePackage', summary: 'Add a charge package' })
  @ApiData(chargePackageSchema, 201)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  createChargePackage(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: createChargePackageBodySchema }) body: CreateChargePackageBody,
  ): Promise<ChargePackage> {
    return this.packages.create(admin.id, body);
  }

  @Patch('charge-packages/:id')
  @ApiOperation({
    operationId: 'adminUpdateChargePackage',
    summary: 'Change the amount, price, order or availability',
  })
  @ApiData(chargePackageSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  updateChargePackage(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: updateChargePackageBodySchema }) body: UpdateChargePackageBody,
  ): Promise<ChargePackage> {
    return this.packages.update(admin.id, id, body);
  }

  @Delete('charge-packages/:id')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'adminDeleteChargePackage',
    summary: 'Remove a package (past payments keep their own amount and price)',
  })
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  async deleteChargePackage(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<void> {
    await this.packages.remove(admin.id, id);
  }

  // --- coupons (ADR-0026): P grants an admin hands out ---------------------------------
  @Get('coupons')
  @ApiOperation({ operationId: 'adminListCoupons', summary: 'Coupons, newest first' })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(couponSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async listCoupons(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<Coupon>> {
    const { items, nextCursor } = await this.coupons.list(query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Post('coupons')
  @ApiOperation({
    operationId: 'adminCreateCoupon',
    summary: 'Issue a coupon (the code is generated when omitted)',
  })
  @ApiData(couponSchema, 201)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  createCoupon(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: createCouponBodySchema }) body: CreateCouponBody,
  ): Promise<Coupon> {
    return this.coupons.create(admin.id, body);
  }

  @Patch('coupons/:id')
  @ApiOperation({
    operationId: 'adminUpdateCoupon',
    summary: 'Disable a coupon or change its cap, expiry or memo',
  })
  @ApiData(couponSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  updateCoupon(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: updateCouponBodySchema }) body: UpdateCouponBody,
  ): Promise<Coupon> {
    return this.coupons.update(admin.id, id, body);
  }

  @Get('users')
  @ApiOperation({ operationId: 'adminListUsers', summary: 'Search users by email or nickname' })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminUserSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async listUsers(
    @Query({ schema: adminUserQuerySchema }) query: AdminUserQuery,
  ): Promise<ApiPage<AdminUser>> {
    const { items, nextCursor } = await this.admin.listUsers(query.q, query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Post('users/:id/balance-adjust')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminAdjustBalance',
    summary: 'Credit or debit P with a mandatory reason (ADMIN_ADJUST)',
  })
  @ApiData(adminBalanceAdjustResultSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'INSUFFICIENT_BALANCE',
  )
  adjustBalance(
    @CurrentUser() admin: SessionUser,
    @Param('id') userId: string,
    @Body({ schema: balanceAdjustBodySchema }) body: BalanceAdjustBody,
  ): Promise<AdminBalanceAdjustResult> {
    return this.admin.adjustBalance(admin.id, userId, body.amountP, body.memo);
  }

  @Get('payments')
  @ApiOperation({ operationId: 'adminListPayments', summary: 'Charges, newest first' })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminPaymentSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async listPayments(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminPayment>> {
    const { items, nextCursor } = await this.admin.listPayments(query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Post('payments/:id/refund')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRefundPayment',
    summary:
      'Refund an unused charge within 7 days of its approval: claw back all its P, then cancel the whole KRW at the provider (retry a refunding one)',
  })
  @ApiData(adminPaymentSchema)
  // INSUFFICIENT_BALANCE: part of the P was used. REFUND_NOT_ALLOWED: details[0].message is
  // `window_closed`, `status` or `provider`. PAYMENT_GATEWAY_REFUSED: the PG said no and the P
  // was restored. PAYMENT_GATEWAY_ERROR: no answer; the payment stays `refunding` for a retry.
  // DUPLICATE_REQUEST (details[0].message `in progress`): a retry while the last attempt is
  // still waiting on the PG.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'INSUFFICIENT_BALANCE',
    'DUPLICATE_REQUEST',
    'REFUND_NOT_ALLOWED',
    'PAYMENT_GATEWAY_REFUSED',
    'PAYMENT_GATEWAY_ERROR',
  )
  refundPayment(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: refundPaymentBodySchema }) body: RefundPaymentBody,
  ): Promise<AdminPayment> {
    return this.refunds.refund(admin.id, id, body.reason);
  }

  @Get('audit-failures')
  @ApiOperation({
    operationId: 'adminListAuditFailures',
    summary: 'Ledger/balance mismatches found by the ledger.audit job',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(auditFailureSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async listAuditFailures(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AuditFailure>> {
    const { items, nextCursor } = await this.admin.listAuditFailures(query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }
}
