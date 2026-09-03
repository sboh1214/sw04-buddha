import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminBalanceAdjustResultSchema,
  adminPaymentSchema,
  adminUserQuerySchema,
  adminUserSchema,
  auditFailureSchema,
  balanceAdjustBodySchema,
  cursorQuerySchema,
  type AdminBalanceAdjustResult,
  type AdminPayment,
  type AdminUser,
  type AdminUserQuery,
  type AuditFailure,
  type BalanceAdjustBody,
  type CursorQuery,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_COOKIE } from '../openapi/document.js';
import { AdminService } from './admin.service.js';

const CURSOR_PARAM = { name: 'cursor', required: false, schema: { type: 'string' as const } };
const LIMIT_PARAM = {
  name: 'limit',
  required: false,
  schema: { type: 'integer' as const, minimum: 1, maximum: 100 },
};

/**
 * PLAN 7.3 / 12. Guards run in order, so SessionGuard fills `request.auth` before AdminGuard
 * reads the role (401 without a session, 403 for a non-admin).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_COOKIE)
@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  @ApiOperation({ operationId: 'adminListUsers', summary: 'Search users by email or nickname' })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
  @ApiQuery(CURSOR_PARAM)
  @ApiQuery(LIMIT_PARAM)
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
  @ApiQuery(CURSOR_PARAM)
  @ApiQuery(LIMIT_PARAM)
  @ApiPageOf(adminPaymentSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async listPayments(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminPayment>> {
    const { items, nextCursor } = await this.admin.listPayments(query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }

  @Get('audit-failures')
  @ApiOperation({
    operationId: 'adminListAuditFailures',
    summary: 'Ledger/balance mismatches found by the ledger.audit job',
  })
  @ApiQuery(CURSOR_PARAM)
  @ApiQuery(LIMIT_PARAM)
  @ApiPageOf(auditFailureSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async listAuditFailures(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AuditFailure>> {
    const { items, nextCursor } = await this.admin.listAuditFailures(query.cursor, query.limit);
    return new ApiPage(items, { nextCursor });
  }
}
